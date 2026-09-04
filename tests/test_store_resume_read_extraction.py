from __future__ import annotations

import importlib
import inspect
import tempfile
import unittest
from pathlib import Path

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_domain_import_direction,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
    source_inventory,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "read_resume_content", "resolve_resume", "get_resume", "list_resumes",
    "check_resume",
)


class ResumeReadExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="resume_read_extraction_contract")
        package = cls.facade._PACKAGE_NAME
        cls.storage_leaf = importlib.import_module(f"{package}.domains.resumes.storage")
        cls.read_leaf = importlib.import_module(f"{package}.domains.resumes.read")
        cls.storage_leaf._bind_runtime(lambda: vars(cls.facade))
        cls.read_leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.read_leaf.ResumeReadMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        source = self.parent / "seed"
        writer = self.facade.Store(source, self.parent / "legacy.json")
        writer.initialize()
        content = self.parent / "resume.txt"
        content.write_text("verified resume bytes", encoding="utf-8")
        self.record = writer.create_resume({
            "id": "resume-main", "label": "Main", "path": str(content),
        })
        trashed_source = self.parent / "old.txt"
        trashed_source.write_text("old", encoding="utf-8")
        trashed = writer.create_resume({
            "id": "resume-old", "label": "Old", "path": str(trashed_source),
        })
        writer.trash_resume(trashed["id"], trashed["revision"])
        self.original = self.facade.Store(
            clone_store_root(source, self.parent / "original"), self.parent / "legacy.json"
        )
        self.extracted = self.composed(
            clone_store_root(source, self.parent / "extracted"), self.parent / "legacy.json"
        )

    def test_exact_plain_mixin_contract_inventory_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["resumes.read"],
            {"ResumeReadMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def parity(self, name, *args):
        original_before = snapshot_tree(self.original.root)
        extracted_before = snapshot_tree(self.extracted.root)
        expected = getattr(self.original, name)(*args)
        actual = getattr(self.extracted, name)(*args)
        if name == "resolve_resume":
            self.assertEqual({**actual, "path": None}, {**expected, "path": None})
        else:
            self.assertEqual(actual, expected)
        self.assertEqual(snapshot_tree(self.original.root), original_before)
        self.assertEqual(snapshot_tree(self.extracted.root), extracted_before)
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return actual

    def test_all_reads_match_facade_oracle_without_writes(self):
        self.parity("get_resume", "resume-main")
        self.parity("get_resume", "resume-old")
        self.parity("get_resume", "resume-old", True)
        self.parity("list_resumes")
        self.parity("list_resumes", True, False)
        self.parity("list_resumes", False, True)
        self.parity("check_resume", "resume-main")
        resolved = self.parity("resolve_resume")
        self.assertEqual(Path(resolved["path"]).read_bytes(), b"verified resume bytes")
        record, content = self.parity("read_resume_content", "resume-main")
        self.assertEqual(record["id"], "resume-main")
        self.assertEqual(content, b"verified resume bytes")

    def test_tamper_and_symlink_fail_closed_without_persisting(self):
        for store in (self.original, self.extracted):
            managed = store.resume_files_path / self.record["managedFile"]
            managed.write_text("tampered", encoding="utf-8")
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        for store in (self.original, self.extracted):
            with self.assertRaisesRegex(self.facade.StoreError, "unavailable"):
                store.read_resume_content("resume-main")
            with self.assertRaisesRegex(self.facade.StoreError, "unavailable"):
                store.resolve_resume("resume-main")
        self.assertEqual(
            [snapshot_tree(store.root) for store in (self.original, self.extracted)], before
        )


if __name__ == "__main__":
    unittest.main()
