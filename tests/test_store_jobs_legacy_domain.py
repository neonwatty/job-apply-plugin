from __future__ import annotations

import importlib
import inspect
import os
import stat
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/jobs/legacy.py"
METHODS = {
    "_read_legacy_search_file",
    "_parse_legacy_search_report",
    "_discover_legacy_jobs",
    "_migration_jobs_snapshot",
    "_selected_legacy_items",
    "_legacy_jobs_token",
    "_plan_legacy_jobs",
    "_legacy_result",
    "preview_legacy_jobs",
    "commit_legacy_jobs",
}
NOW = "2026-09-04T13:00:00Z"
REPORT = """# Job Search Results

### 1. Staff Engineer — Acme Corp (Score: 92)
- **Source**: LinkedIn
- **Location**: Remote
- **Description**: Reliable systems.
- **URL**: https://example.com/jobs/staff#apply

### 2. Missing Link — Example Co (Score: 75)
- **Source**: Hacker News
"""


class StoreJobsLegacyDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_jobs_legacy_domain_contract")
        package = cls.facade._PACKAGE_NAME
        cls.upsert = importlib.import_module(f"{package}.domains.jobs.upsert")
        cls.legacy = importlib.import_module(f"{package}.domains.jobs.legacy")
        cls.upsert._bind_runtime(lambda: vars(cls.facade))
        cls.legacy._bind_runtime(lambda: vars(cls.facade))
        cls.upsert_mixin = cls.upsert.JobUpsertMixin
        cls.mixin = cls.legacy.JobLegacyMixin
        cls.legacy_composed = composed_store_class(cls.facade.Store, cls.mixin)
        cls.composed = composed_store_class(
            cls.facade.Store, cls.mixin, cls.upsert_mixin
        )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.legacy_root = self.home / self.facade.LEGACY_SEARCH_ROOT

    def tearDown(self):
        self.temporary.cleanup()

    def write_report(self, text: str = REPORT, name: str = "search-2026-09-04.md"):
        self.legacy_root.mkdir(exist_ok=True)
        path = self.legacy_root / name
        path.write_text(text, encoding="utf-8")
        return path

    def paired_stores(self):
        seed = self.facade.Store(self.home / "seed", self.home / "legacy.json")
        seed.initialize()
        left_root = clone_store_root(seed.root, self.home / "left")
        right_root = clone_store_root(seed.root, self.home / "right")
        return (
            self.facade.Store(left_root, self.home / "left-legacy.json"),
            self.composed(right_root, self.home / "right-legacy.json"),
        )

    def assert_equivalent(self, stores, operation):
        outcomes = [operation(store) for store in stores]
        self.assertEqual(outcomes[0], outcomes[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        return outcomes[0]

    def home_patch(self):
        return mock.patch.object(self.facade.Path, "home", return_value=self.home)

    def test_plain_leaf_owns_exact_contract_and_static_descriptors(self):
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertEqual(
            {
                name
                for name, value in vars(self.mixin).items()
                if inspect.isfunction(value) or isinstance(value, staticmethod)
            },
            METHODS,
        )
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.legacy_composed, METHODS
        )
        for name in METHODS - {
            "_discover_legacy_jobs",
            "_migration_jobs_snapshot",
            "_plan_legacy_jobs",
            "preview_legacy_jobs",
            "commit_legacy_jobs",
        }:
            self.assertIsInstance(inspect.getattr_static(self.mixin, name), staticmethod)
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        self.assertNotIn("super(", source)

    def test_missing_store_discovery_and_selected_preview_do_not_mutate(self):
        self.write_report()
        store = self.composed(self.home / "missing-store", self.home / "legacy.json")
        with self.home_patch(), mock.patch.object(self.facade, "utc_now", return_value=NOW):
            discovery = store.preview_legacy_jobs([])
            before = store.root.exists()
            valid = next(item for item in discovery["items"] if item["state"] == "valid")
            preview = store.preview_legacy_jobs([valid["itemId"]])
        self.assertFalse(before)
        self.assertFalse(store.root.exists())
        self.assertFalse(preview["committed"])
        self.assertEqual(preview["summary"]["create"], 1)
        self.assertNotIn(str(self.home), repr(preview))

    def test_valid_invalid_rerun_and_provenance_match_cloned_store_bytes(self):
        self.write_report()
        stores = self.paired_stores()
        with self.home_patch(), mock.patch.object(self.facade, "utc_now", return_value=NOW):
            discovery = self.assert_equivalent(
                stores, lambda store: store.preview_legacy_jobs([])
            )
            self.assertEqual([item["state"] for item in discovery["items"]], ["valid", "invalid"])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.assert_equivalent(
                stores, lambda store: store.preview_legacy_jobs(selected)
            )
            created = self.assert_equivalent(
                stores,
                lambda store: store.commit_legacy_jobs(selected, preview["token"]),
            )
            replay_preview = self.assert_equivalent(
                stores, lambda store: store.preview_legacy_jobs(selected)
            )
            replay = self.assert_equivalent(
                stores,
                lambda store: store.commit_legacy_jobs(
                    selected, replay_preview["token"]
                ),
            )
        self.assertEqual(created["summary"]["create"], 1)
        self.assertFalse(replay["committed"])
        job = stores[1].get_job(created["decisions"][0]["id"])
        self.assertEqual(job["provenance"]["/role"]["origin"], "migration")
        self.assertEqual(job["legacySources"][0]["relativePath"], "search-2026-09-04.md")

    def test_source_drift_rejects_token_without_mutating_store(self):
        report = self.write_report()
        store = self.composed(self.home / "store", self.home / "legacy.json")
        store.initialize()
        with self.home_patch(), mock.patch.object(self.facade, "utc_now", return_value=NOW):
            discovery = store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = store.preview_legacy_jobs(selected)
            with self.facade.exclusive_file_lock(store.store_lock_path):
                pass
            before = snapshot_tree(store.root)
            report.write_text(REPORT + "\nchanged\n", encoding="utf-8")
            with self.assertRaisesRegex(self.facade.StoreError, "drifted"):
                store.commit_legacy_jobs(selected, preview["token"])
        self.assertEqual(snapshot_tree(store.root), before)

    @unittest.skipIf(os.name == "nt", "POSIX symlink contract")
    def test_symlink_report_is_rejected_without_path_leakage(self):
        self.legacy_root.mkdir()
        private = self.home / "private.txt"
        private.write_text("secret", encoding="utf-8")
        (self.legacy_root / "search-link.md").symlink_to(private)
        store = self.composed(self.home / "store", self.home / "legacy.json")
        with self.home_patch():
            with self.assertRaises(self.facade.StoreError) as raised:
                store.preview_legacy_jobs([])
        self.assertNotIn(str(self.home), str(raised.exception))
        self.assertFalse(store.root.exists())

    def test_limits_utf8_and_windows_fallback_match_facade_errors(self):
        probes = (
            (b"\xff", {}, "UTF-8"),
            (REPORT.encode("utf-8"), {"LEGACY_SEARCH_MAX_FILE_BYTES": 8}, "byte limit"),
            (REPORT.encode("utf-8"), {"LEGACY_SEARCH_MAX_ENTRIES": 0}, "entry limit"),
        )
        for index, (content, patches, message) in enumerate(probes):
            with self.subTest(case=index):
                root = self.home / f"case-{index}"
                root.mkdir()
                (root / "search-case.md").write_bytes(content)
                store = self.composed(self.home / f"store-{index}", self.home / "legacy.json")
                with mock.patch.object(self.facade.Path, "home", return_value=root.parent), mock.patch.object(
                    self.facade, "LEGACY_SEARCH_ROOT", root.name
                ):
                    stack = [mock.patch.object(self.facade, name, value) for name, value in patches.items()]
                    for patcher in stack:
                        patcher.start()
                    try:
                        with self.assertRaisesRegex(self.facade.StoreError, message):
                            store.preview_legacy_jobs([])
                    finally:
                        for patcher in reversed(stack):
                            patcher.stop()

        self.write_report()
        store = self.composed(self.home / "windows", self.home / "legacy.json")
        original_open = self.facade.os.open
        open_spy = mock.Mock(wraps=original_open)
        with self.home_patch(), mock.patch.object(
            self.facade.os, "name", "nt"
        ), mock.patch.object(self.facade.os, "open", open_spy):
            discovery = store.preview_legacy_jobs([])
        self.assertEqual(discovery["items"][0]["state"], "valid")
        self.assertTrue(any(call.args and isinstance(call.args[0], Path) for call in open_spy.call_args_list))

    def test_read_race_and_constant_time_token_rejection_are_observed(self):
        store = self.composed(self.home / "race", self.home / "legacy.json")
        original = self.facade.os.fstat
        # POSIX opens the directory first; Windows uses a pathname instead.
        # Inject at the first report descriptor, independent of call counts.
        for platform_name in dict.fromkeys((os.name, "nt")):
            with self.subTest(platform_name=platform_name):
                report = self.write_report()
                injected = False

                def drifting_fstat(descriptor):
                    nonlocal injected
                    value = original(descriptor)
                    if not injected and stat.S_ISREG(value.st_mode):
                        injected = True
                        report.write_text(REPORT + "\nrace\n", encoding="utf-8")
                    return value

                platform_os = types.SimpleNamespace(**vars(self.facade.os))
                platform_os.name = platform_name
                platform_os.fstat = drifting_fstat
                with self.home_patch(), mock.patch.object(self.facade, "os", platform_os):
                    with self.assertRaisesRegex(self.facade.StoreError, "changed during discovery"):
                        store.preview_legacy_jobs([])
                self.assertTrue(injected)

        self.write_report()
        with self.home_patch():
            discovery = store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
        compare = mock.Mock(wraps=self.facade.hmac.compare_digest)
        with self.home_patch(), mock.patch.object(self.facade.hmac, "compare_digest", compare):
            with self.assertRaisesRegex(self.facade.StoreError, "drifted"):
                store.commit_legacy_jobs(selected, "legacy-jobs-v1.bad")
        compare.assert_called_once()


if __name__ == "__main__":
    unittest.main()
