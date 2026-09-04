from __future__ import annotations

import importlib
import inspect
import shutil
import sys
import tempfile
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_domain_import_direction,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    source_inventory,
)
from tests.support.store_facade_contract import ROOT, load_module
from tests.support.store_case import STORE_MODULE


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "_load_automation_settings_document",
    "_load_employer_accounts_document",
    "_load_account_operation_journal",
    "_ensure_account_control_documents",
    "get_automation_settings",
    "update_automation_settings",
    "copy_profile_email_to_automation_settings",
    "automation_capability",
)


class AccountSettingsExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = STORE_MODULE
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.accounts.settings"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.AccountSettingsMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["accounts.settings"],
            {"AccountSettingsMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_settings_are_byte_equivalent_revisioned_and_private(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            seed = root / "seed"
            clock = lambda: datetime(2026, 9, 4, 20, 0, tzinfo=timezone.utc)
            self.facade.Store(seed, clock=clock).initialize()
            original = self.facade.Store(clone_store_root(seed, root / "original"), clock=clock)
            extracted = self.composed(clone_store_root(seed, root / "extracted"), clock=clock)
            patch = {
                "enabled": True,
                "automaticAccountCreation": True,
                "signupEmail": "private@example.invalid",
                "passwordStrategy": "unique_per_realm",
            }
            values = [store.update_automation_settings(patch, 1, public=True) for store in (original, extracted)]
            self.assertEqual(values[0], values[1])
            self.assertNotIn("signupEmail", values[1])
            self.assertNotIn("private", repr(values[1]))
            assert_store_trees_equal(self, original.root, extracted.root)
            before = [path.read_bytes() for path in (original.automation_settings_path, extracted.automation_settings_path)]
            for store in (original, extracted):
                with self.assertRaisesRegex(self.facade.StoreError, "revision conflict"):
                    store.update_automation_settings({"enabled": False}, 1)
            self.assertEqual(before, [path.read_bytes() for path in (original.automation_settings_path, extracted.automation_settings_path)])
            self.leaf._bind_runtime(lambda: {})
            try:
                canonical = extracted.get_automation_settings(public=True)
            finally:
                self.leaf._bind_runtime(lambda: vars(self.facade))
            self.assertEqual(canonical, values[1])

    def test_canonical_runtime_is_root_local_serialized_and_restores_ambient_state(self):
        with tempfile.TemporaryDirectory() as temporary:
            roots = []
            for name in ("plugin-a", "plugin-b"):
                root = Path(temporary) / name
                shutil.copytree(ROOT, root, ignore=shutil.ignore_patterns(".git", ".worktrees", "node_modules", "__pycache__"))
                roots.append(root)
            facades = [
                load_module(root / "scripts" / "job-apply-store.py", f"account_root_{index}")
                for index, root in enumerate(roots)
            ]
            runtimes = [
                importlib.import_module(f"{module._PACKAGE_NAME}.accounts_runtime")
                for module in facades
            ]
            sentinel = types.ModuleType("job_apply_accounts")
            prior = sys.modules.get("job_apply_accounts")
            original_path = list(sys.path)
            sys.modules["job_apply_accounts"] = sentinel
            try:
                calls = [(runtime, name) for runtime in runtimes for name in (
                    "job_apply_accounts", "job_apply_credentials", "job_apply_account_flows"
                )]
                with ThreadPoolExecutor(max_workers=6) as pool:
                    modules = list(pool.map(lambda item: item[0].companion(item[1]), calls))
                self.assertIs(sys.modules["job_apply_accounts"], sentinel)
                self.assertEqual(sys.path, original_path)
            finally:
                if prior is None:
                    sys.modules.pop("job_apply_accounts", None)
                else:
                    sys.modules["job_apply_accounts"] = prior
            expected_roots = [roots[0]] * 3 + [roots[1]] * 3
            self.assertTrue(all(
                Path(module.__file__).resolve().is_relative_to(root.resolve())
                for module, root in zip(modules, expected_roots)
            ))
            self.assertIsNot(modules[0], modules[3])
            prefixes = tuple(runtime._PACKAGE_NAME + "." for runtime in runtimes)
            private = [name for name in sys.modules if name.startswith(prefixes)]
            self.assertEqual(len(private), len(set(private)))
            old_a = modules[0]
            reloaded = load_module(
                roots[0] / "scripts" / "job-apply-store.py", "account_root_reload"
            )
            fresh_runtime = importlib.import_module(
                f"{reloaded._PACKAGE_NAME}.accounts_runtime"
            )
            self.assertNotIn(
                f"{fresh_runtime._PACKAGE_NAME}.job_apply_accounts", sys.modules
            )
            fresh_a = fresh_runtime.companion("job_apply_accounts")
            self.assertIsNot(fresh_a, old_a)
            self.assertIs(
                sys.modules[f"{fresh_runtime._PACKAGE_NAME}.job_apply_accounts"],
                fresh_a,
            )
            with ThreadPoolExecutor(max_workers=8) as pool:
                same_root = list(pool.map(
                    lambda _index: fresh_runtime.companion(
                        "job_apply_form_readiness"
                    ),
                    range(16),
                ))
            self.assertTrue(all(module is same_root[0] for module in same_root))


if __name__ == "__main__":
    unittest.main()
