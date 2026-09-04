from __future__ import annotations

import importlib
import inspect
import json
import tempfile
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


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/extractions/journal.py"
METHODS = {
    "_load_extractions_document",
    "_load_extraction_requests_document",
    "_load_extraction_journal",
    "_ensure_extraction_files_locked",
    "_ensure_extraction_requests_file_locked",
    "_roll_forward_extraction_locked",
    "_commit_extraction_operation_locked",
}
NOW = "2026-09-04T12:00:00Z"


class StoreExtractionJournalDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_extraction_journal_domain_contract")
        cls.domain = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.extractions.journal"
        )
        cls.domain._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.domain.ExtractionJournalMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_plain_leaf_owns_exact_contract_and_has_no_facade_dependency(self):
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertEqual(
            {name for name, value in vars(self.mixin).items() if inspect.isfunction(value)},
            METHODS,
        )
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        self.assertNotIn("super(", source)

    def test_initialization_and_loads_are_byte_equivalent(self):
        seeds = []
        for name, owner in (("facade", self.facade.Store), ("leaf", self.composed)):
            store = owner(self.home / name, self.home / f"{name}-legacy.json")
            with mock.patch.object(self.facade, "utc_now", return_value=NOW):
                store.initialize()
                with self.facade.exclusive_file_lock(store.store_lock_path):
                    store._ensure_extraction_requests_file_locked()
            self.assertEqual(store._load_extraction_journal()["operation"], None)
            self.assertEqual(store._load_extractions_document()["proposals"], {})
            self.assertEqual(store._load_extraction_requests_document()["requests"], {})
            seeds.append(store)
        assert_store_trees_equal(self, seeds[0].root, seeds[1].root)
        for store in seeds:
            for path in (
                store.resume_extractions_path,
                store.resume_extraction_requests_path,
                store.resume_extraction_journal_path,
            ):
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_invalid_journal_is_rejected_without_mutating_any_bytes(self):
        store = self.composed(self.home / "invalid", self.home / "legacy.json")
        store.initialize()
        with self.facade.exclusive_file_lock(store.store_lock_path):
            store._ensure_extraction_files_locked()
        document = json.loads(store.resume_extraction_journal_path.read_text())
        document["operation"] = {
            "kind": "request-close",
            "operationId": "operation-invalid",
            "profileDocument": None,
            "proposalsDocument": None,
        }
        store.resume_extraction_journal_path.write_text(json.dumps(document))
        before = snapshot_tree(store.root)
        with self.assertRaisesRegex(self.facade.StoreError, "journal operation"):
            store._load_extraction_journal()
        self.assertEqual(snapshot_tree(store.root), before)

    def test_roll_forward_replays_in_order_and_recovers_after_each_boundary(self):
        paths = ("profile", "proposals", "requests", "resumes", "clear")
        for boundary in paths:
            with self.subTest(boundary=boundary):
                root = self.home / boundary
                original = self.facade.Store(root, self.home / f"{boundary}.json")
                original.initialize()
                with self.facade.exclusive_file_lock(original.store_lock_path):
                    original._ensure_extraction_requests_file_locked()
                recovered = self.composed(root, self.home / f"{boundary}.json")
                writes = []
                real_write = self.facade.atomic_write_json
                failed = False

                def fail_once(path, payload):
                    nonlocal failed
                    writes.append(path)
                    target = {
                        "profile": recovered.profile_path,
                        "proposals": recovered.resume_extractions_path,
                        "requests": recovered.resume_extraction_requests_path,
                        "resumes": recovered.resumes_path,
                        "clear": recovered.resume_extraction_journal_path,
                    }[boundary]
                    is_clear = (
                        path == recovered.resume_extraction_journal_path
                        and payload.get("operation") is None
                    )
                    if not failed and path == target and (boundary != "clear" or is_clear):
                        failed = True
                        raise OSError("injected boundary")
                    return real_write(path, payload)

                profile = recovered._load_profile_document()
                proposals = recovered._load_extractions_document()
                requests = recovered._load_extraction_requests_document()
                resumes = recovered._load_resumes_document()
                with mock.patch.object(self.facade, "atomic_write_json", side_effect=fail_once):
                    with self.assertRaises(OSError):
                        with self.facade.exclusive_file_lock(recovered.store_lock_path):
                            recovered._commit_extraction_operation_locked(
                                "request-complete", profile, proposals, requests, resumes
                            )
                repaired = self.composed(root, self.home / f"{boundary}.json")
                repaired.initialize()
                self.assertIsNone(repaired._load_extraction_journal()["operation"])
                expected_order = [
                    repaired.resume_extraction_journal_path,
                    repaired.profile_path,
                    repaired.resume_extractions_path,
                    repaired.resume_extraction_requests_path,
                    repaired.resumes_path,
                    repaired.resume_extraction_journal_path,
                ]
                self.assertEqual(writes, expected_order[: len(writes)])

    def test_runtime_binding_is_live_across_two_root_local_facades(self):
        second = load_module(name="store_extraction_journal_second_root")
        package = importlib.import_module(
            f"{second._PACKAGE_NAME}.domains.extractions.journal"
        )
        self.assertIsNot(package, self.domain)
        package._bind_runtime(lambda: vars(second))
        first_class = composed_store_class(self.facade.Store, self.mixin)
        second_class = composed_store_class(second.Store, package.ExtractionJournalMixin)
        first = first_class(self.home / "first-root", self.home / "first.json")
        second_store = second_class(self.home / "second-root", self.home / "second.json")
        first.initialize()
        second_store.initialize()
        with (
            mock.patch.object(self.facade, "utc_now", return_value="2026-01-01T00:00:00Z"),
            mock.patch.object(second, "utc_now", return_value="2026-02-02T00:00:00Z"),
        ):
            with self.facade.exclusive_file_lock(first.store_lock_path):
                first._ensure_extraction_files_locked()
            with second.exclusive_file_lock(second_store.store_lock_path):
                second_store._ensure_extraction_files_locked()
        first_doc = json.loads(first.resume_extractions_path.read_text())
        second_doc = json.loads(second_store.resume_extractions_path.read_text())
        self.assertEqual(first_doc["metadata"]["createdAt"], "2026-01-01T00:00:00Z")
        self.assertEqual(second_doc["metadata"]["createdAt"], "2026-02-02T00:00:00Z")
        self.assertIsNot(package._runtime(), self.domain._runtime())


if __name__ == "__main__":
    unittest.main()
