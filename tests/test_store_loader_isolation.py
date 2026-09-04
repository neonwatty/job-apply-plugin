from __future__ import annotations

import contextlib
import hashlib
import importlib
import importlib.util
import inspect
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path

from tests.support.store_facade_contract import ROOT, load_module, private_package_keys


IGNORED_COPY_NAMES = {
    ".git", ".worktrees", ".superpowers", "node_modules", "__pycache__",
    ".pytest_cache",
}

CANONICAL_NAMES = {
    "job_apply_store",
    "job_apply_accounts",
    "job_apply_account_flows_macos",
    "job_apply_account_flows",
    "job_apply_trusted_fill",
    "job_apply_credentials",
    "job_apply_credentials_macos",
    "job_apply_credentials_portable_runtime",
    "job_apply_account_executor",
    "job_apply_password_account_flows",
    "job_apply_account_canary_executor",
    "job_apply_form_readiness",
    "job_apply_answer_match",
    "qa",
    "qa.contracts",
    "qa.contracts_model",
    "qa.contracts_fixture",
    "qa.contracts_flow",
    "qa.contracts_observation",
}

IMPLEMENTATION_SUFFIXES = {
    "",
    ".constants",
    ".errors",
    ".io",
    ".normalization",
    ".base",
    ".validation",
    ".validation.profile_answers",
    ".validation.sessions",
    ".validation.jobs_resumes",
    ".validation.extraction",
    ".validation.accounts",
}

COMPANION_SUFFIXES = {
    ".job_apply_accounts",
    ".job_apply_account_flows_macos",
    ".job_apply_account_flows",
    ".job_apply_trusted_fill",
    ".job_apply_credentials",
    ".job_apply_credentials_macos",
    ".job_apply_account_executor",
    ".job_apply_password_account_flows",
    ".job_apply_account_canary_executor",
    ".job_apply_form_readiness",
    ".job_apply_answer_match",
}


def ignore_copy(_directory, names):
    return [name for name in names if name in IGNORED_COPY_NAMES]


def copy_plugin(destination: Path) -> Path:
    shutil.copytree(ROOT, destination, ignore=ignore_copy)
    return destination


def direct_module(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"spec unavailable for {path.name}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def implementation_package_name(plugin_root: Path) -> str:
    implementation = (plugin_root / "scripts" / "job_apply_store").resolve()
    return "_job_apply_store_parts_" + hashlib.sha256(str(implementation).encode()).hexdigest()


@contextlib.contextmanager
def canonical_state(mode: str):
    saved_path = list(sys.path)
    saved = {
        name: value for name, value in sys.modules.items()
        if name in CANONICAL_NAMES or any(name.startswith(prefix + ".") for prefix in CANONICAL_NAMES)
    }
    for name in tuple(sys.modules):
        if name in CANONICAL_NAMES or any(name.startswith(prefix + ".") for prefix in CANONICAL_NAMES):
            del sys.modules[name]
    sentinels = {}
    try:
        if mode == "poisoned":
            for name in CANONICAL_NAMES:
                sentinel = types.ModuleType(name)
                sentinel.poisoned_root = True
                sentinels[name] = sentinel
                sys.modules[name] = sentinel
        elif mode == "present":
            sys.path.insert(0, str((ROOT / "scripts").resolve()))
            sys.path.insert(0, str(ROOT.resolve()))
            # Existing canonical packages are real but must remain irrelevant to copies.
            try:
                importlib.import_module("job_apply_store")
            except ModuleNotFoundError:
                pass
            importlib.import_module("qa.contracts")
            sentinels = {
                name: value for name, value in sys.modules.items()
                if name == "job_apply_store" or name.startswith("job_apply_store.")
                or name == "qa" or name.startswith("qa.")
            }
        elif mode != "cleared":
            raise AssertionError(f"unknown canonical mode {mode}")
        yield sentinels
        for name, value in sentinels.items():
            if name in sys.modules:
                assert sys.modules[name] is value
    finally:
        for name in tuple(sys.modules):
            if name in CANONICAL_NAMES or any(name.startswith(prefix + ".") for prefix in CANONICAL_NAMES):
                del sys.modules[name]
        sys.modules.update(saved)
        sys.path[:] = saved_path


class StoreLoaderIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.root_a = copy_plugin(root / "plugin-a")
        self.root_b = copy_plugin(root / "plugin-b")

    def tearDown(self):
        self.temporary.cleanup()

    def load_store(self, root: Path, name: str):
        return load_module(root / "scripts" / "job-apply-store.py", name)

    def assert_root_local(self, module, root: Path):
        scripts = (root / "scripts").resolve()
        self.assertEqual(Path(module.__file__).resolve().parent, scripts)
        for leaf in (module._constants, module._errors, module._io, module._normalization, module._base):
            self.assertTrue(Path(leaf.__file__).resolve().is_relative_to(scripts))
        for companion_name in (
            "ACCOUNTS_MODULE", "CREDENTIALS_MODULE", "FORM_READINESS_MODULE",
            "ANSWER_MATCH_MODULE",
        ):
            companion = getattr(module, companion_name)
            self.assertEqual(Path(companion.__file__).resolve().parent, scripts)
        account_source = Path(inspect.getsourcefile(module.ACCOUNTS_MODULE.WorkdayRealmAdapter)).resolve()
        self.assertEqual(account_source.parent, scripts)
        base_source = Path(inspect.getsourcefile(module.Store.__mro__[1])).resolve()
        self.assertTrue(base_source.is_relative_to(scripts))

    def test_complete_roots_are_isolated_in_both_orders_and_canonical_states(self):
        for mode in ("poisoned", "present", "cleared"):
            for reverse in (False, True):
                with self.subTest(mode=mode, reverse=reverse), canonical_state(mode) as canonical:
                    roots = (self.root_b, self.root_a) if reverse else (self.root_a, self.root_b)
                    first = self.load_store(roots[0], f"arbitrary_{mode}_{reverse}_first")
                    first_class = first.Store
                    first_constant = first.ANSWER_STATES
                    second = self.load_store(roots[1], f"arbitrary_{mode}_{reverse}_second")
                    self.assertNotEqual(first._PACKAGE_NAME, second._PACKAGE_NAME)
                    self.assertIs(first.Store, first_class)
                    self.assertIs(first.ANSWER_STATES, first_constant)
                    self.assertIsNot(first.Store, second.Store)
                    self.assertIsNot(first.ANSWER_STATES, second.ANSWER_STATES)
                    self.assert_root_local(first, roots[0])
                    self.assert_root_local(second, roots[1])
                    for name, value in canonical.items():
                        self.assertIs(sys.modules.get(name), value)

    def test_reexecution_discards_stale_patches_and_module_keys_stay_bounded(self):
        first = self.load_store(self.root_a, "reload_first")
        other = self.load_store(self.root_b, "reload_other")
        other_keys = private_package_keys(other._PACKAGE_NAME)
        other_companion_keys = private_package_keys(other._COMPANION_PACKAGE_NAME)
        first.ANSWER_STATES.add("stale-patch")
        first.atomic_write_json = lambda *_args, **_kwargs: None

        second = self.load_store(self.root_a, "reload_second")
        self.assertNotIn("stale-patch", second.ANSWER_STATES)
        self.assertIsNot(first.ANSWER_STATES, second.ANSWER_STATES)
        self.assertIsNot(first.atomic_write_json, second.atomic_write_json)
        self.assertEqual(
            private_package_keys(second._PACKAGE_NAME),
            {second._PACKAGE_NAME + suffix for suffix in IMPLEMENTATION_SUFFIXES},
        )
        self.assertEqual(
            private_package_keys(second._COMPANION_PACKAGE_NAME),
            {
                second._COMPANION_PACKAGE_NAME + suffix
                for suffix in COMPANION_SUFFIXES
            },
        )
        self.assertEqual(private_package_keys(other._PACKAGE_NAME), other_keys)
        self.assertEqual(
            private_package_keys(other._COMPANION_PACKAGE_NAME),
            other_companion_keys,
        )

    def test_partial_import_failure_cleans_only_failed_root_children(self):
        healthy = self.load_store(self.root_b, "healthy_store")
        healthy_keys = private_package_keys(healthy._PACKAGE_NAME)
        healthy_companion_keys = private_package_keys(healthy._COMPANION_PACKAGE_NAME)
        failure_leaf = self.root_a / "scripts" / "job_apply_store" / "validation" / "jobs_resumes.py"
        source = failure_leaf.read_text(encoding="utf-8")
        marker = "from __future__ import annotations\n"
        self.assertIn(marker, source)
        failure_leaf.write_text(source.replace(marker, marker + "raise RuntimeError('partial Store import')\n", 1), encoding="utf-8")
        failed_name = implementation_package_name(self.root_a)
        with self.assertRaisesRegex(RuntimeError, "partial Store import"):
            self.load_store(self.root_a, "failed_store")
        self.assertEqual(private_package_keys(failed_name), set())
        self.assertEqual(private_package_keys(healthy._PACKAGE_NAME), healthy_keys)

        failure_leaf.write_text(source, encoding="utf-8")
        companion = self.root_a / "scripts" / "job_apply_form_readiness.py"
        companion_source = companion.read_text(encoding="utf-8")
        self.assertIn(marker, companion_source)
        companion.write_text(
            companion_source.replace(
                marker, marker + "raise RuntimeError('partial companion import')\n", 1
            ),
            encoding="utf-8",
        )
        failed_companions = "_job_apply_store_companions_" + hashlib.sha256(
            str((self.root_a / "scripts").resolve()).encode()
        ).hexdigest()
        with self.assertRaisesRegex(RuntimeError, "partial companion import"):
            self.load_store(self.root_a, "failed_companion_store")
        self.assertEqual(private_package_keys(failed_name), set())
        self.assertEqual(private_package_keys(failed_companions), set())
        self.assertEqual(private_package_keys(healthy._PACKAGE_NAME), healthy_keys)
        self.assertEqual(
            private_package_keys(healthy._COMPANION_PACKAGE_NAME),
            healthy_companion_keys,
        )

    def test_task_attempt_and_workspace_loaders_select_the_adjacent_store(self):
        with canonical_state("poisoned"):
            for root, suffix in ((self.root_a, "a"), (self.root_b, "b")):
                with self.subTest(root=suffix):
                    scripts = root / "scripts"
                    task = direct_module(scripts / "job-apply-task.py", f"copied_task_{suffix}")
                    attempt = direct_module(scripts / "job-apply-attempt.py", f"copied_attempt_{suffix}")
                    workspace = direct_module(scripts / "job-apply-workspace.py", f"copied_workspace_{suffix}")
                    stores = [task.load_store_module(), attempt.load_store_module(), workspace.STORE_MODULE]
                    for store in stores:
                        self.assertEqual(Path(store.__file__).resolve().parent, scripts.resolve())
                        self.assertTrue(Path(store._constants.__file__).resolve().is_relative_to(scripts.resolve()))


if __name__ == "__main__":
    unittest.main()
