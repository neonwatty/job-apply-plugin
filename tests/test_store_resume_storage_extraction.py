from __future__ import annotations

import importlib
import inspect
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
from tests.support.resume_file_clock import fixed_staged_resume_mtime
from tests.test_store_loader_isolation import copy_plugin, direct_module


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "_load_resumes_document", "_managed_resume_path", "_resume_path",
    "_resume_for_acquisition", "_private_file_digest",
    "_managed_resume_observation", "_new_resume_content_revision",
    "_recover_resume_files_locked", "_stage_resume_import",
    "_temporary_resume_source", "_staged_resume", "_install_staged_resume",
)


class ResumeStorageExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="resume_storage_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.resumes.storage"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.ResumeStorageMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)

    def stores(self, label: str):
        seed = self.parent / f"{label}-seed"
        self.facade.Store(seed, self.parent / "legacy.json").initialize()
        return (
            self.facade.Store(
                clone_store_root(seed, self.parent / f"{label}-original"),
                self.parent / "legacy.json",
            ),
            self.composed(
                clone_store_root(seed, self.parent / f"{label}-extracted"),
                self.parent / "legacy.json",
            ),
        )

    def test_exact_plain_mixin_contract_inventory_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        for name in ("_private_file_digest", "_new_resume_content_revision"):
            self.assertIsInstance(inspect.getattr_static(self.mixin, name), staticmethod)
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["resumes.storage"],
            {"ResumeStorageMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_create_update_and_recovery_match_immutable_facade_oracle(self):
        stores = self.stores("lifecycle")
        source = self.parent / "resume.txt"
        source.write_text("private resume content", encoding="utf-8")
        fixed_clock = "2026-09-04T12:00:00Z"
        with (
            fixed_staged_resume_mtime(self.facade, stores),
            mock.patch.object(self.facade, "utc_now", return_value=fixed_clock),
            mock.patch.object(
                self.facade.secrets, "token_urlsafe", return_value="A" * 43
            ),
        ):
            created = [store.create_resume({
                "id": "resume-main", "label": "Main", "path": str(source),
            }) for store in stores]
        self.assertEqual(created[0], created[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        for store, record in zip(stores, created):
            path = store.resume_files_path / record["managedFile"]
            self.assertEqual(record["observedModifiedAt"], self.facade._resume_modified_at(path.stat()))
            self.assertEqual(path.read_bytes(), b"private resume content")
            if os.name != "nt":
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                self.assertEqual(store.resume_files_path.stat().st_mode & 0o777, 0o700)

        replacement = self.parent / "replacement.pdf"
        replacement.write_bytes(b"%PDF-1.7\nreplacement content")
        with (
            fixed_staged_resume_mtime(self.facade, stores),
            mock.patch.object(self.facade, "utc_now", return_value=fixed_clock),
            mock.patch.object(
                self.facade.secrets, "token_urlsafe", return_value="B" * 43
            ),
        ):
            updated = [store.update_resume(
                "resume-main", {"path": str(replacement)}, created[index]["revision"]
            ) for index, store in enumerate(stores)]
        self.assertEqual(updated[0], updated[1])
        for store, record in zip(stores, updated):
            path = store.resume_files_path / record["managedFile"]
            self.assertEqual(record["observedModifiedAt"], self.facade._resume_modified_at(path.stat()))
        self.assertNotEqual(updated[0]["managedFile"], created[0]["managedFile"])
        self.assertNotEqual(updated[0]["digest"], created[0]["digest"])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

        failed = self.parent / "failed.txt"
        failed.write_text("failed replacement", encoding="utf-8")
        before_failure = [snapshot_tree(store.root) for store in stores]
        for store in stores:
            with mock.patch.object(
                self.facade, "atomic_write_json", side_effect=OSError("synthetic")
            ):
                with self.assertRaises(OSError):
                    store.update_resume(
                        "resume-main", {"path": str(failed)}, updated[0]["revision"]
                    )
        self.assertEqual(
            [snapshot_tree(store.root) for store in stores], before_failure
        )

        for store in stores:
            canonical = store.resume_files_path / updated[0]["managedFile"]
            quarantine = store.resume_files_path / (
                f".{updated[0]['managedFile']}.fixed.quarantine"
            )
            os.replace(canonical, quarantine)
        for store in stores:
            store.initialize()
            canonical = store.resume_files_path / updated[0]["managedFile"]
            self.assertEqual(canonical.read_bytes(), replacement.read_bytes())
            self.assertFalse(list(store.resume_files_path.glob(".*.quarantine")))
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

    def test_staged_clock_rejects_foreign_non_temp_and_symlink_paths(self):
        stores = self.stores("mtime-boundary")
        directory = stores[0].resume_files_path
        foreign = self.parent / "foreign.tmp"
        non_temp = directory / "canonical.txt"
        for path in (foreign, non_temp):
            path.write_bytes(b"unchanged synthetic content")
        with fixed_staged_resume_mtime(self.facade, stores):
            for path in (foreign, non_temp):
                before = (path.read_bytes(), path.stat().st_mtime_ns)
                with self.assertRaisesRegex(AssertionError, "unexpected path"):
                    self.facade._validate_resume_bytes(path, ".txt")
                self.assertEqual((path.read_bytes(), path.stat().st_mtime_ns), before)
            # Simulate the symlink result without requiring Windows privileges
            # to create links; rejection must precede utime and validation.
            candidate = directory / "linked.tmp"
            with mock.patch.object(Path, "is_symlink", return_value=True), \
                 mock.patch.object(os, "utime") as touch:
                with self.assertRaisesRegex(AssertionError, "unexpected path"):
                    self.facade._validate_resume_bytes(candidate, ".txt")
                touch.assert_not_called()

    def test_real_staged_mtime_is_fixed_before_observation(self):
        stores = self.stores("mtime-regression")
        source = self.parent / "mtime.txt"
        source.write_bytes(b"synthetic staged timing")
        private_directories = [store.resume_files_path for store in stores]
        original_mode = self.facade._set_private_mode
        divergent_times = []

        def stamp_different_creation_time(path, mode):
            original_mode(path, mode)
            if path.parent in private_directories and path.suffix == ".tmp":
                index = private_directories.index(path.parent)
                instant = 1_725_451_100_000_000_000 + index * 60_000_000_000
                os.utime(path, ns=(instant, instant))
                divergent_times.append(path.stat().st_mtime_ns)

        with (
            mock.patch.object(self.facade, "_set_private_mode", side_effect=stamp_different_creation_time),
            fixed_staged_resume_mtime(self.facade, stores),
            mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T12:00:00Z"),
            mock.patch.object(self.facade.secrets, "token_urlsafe", return_value="A" * 43),
        ):
            records = [store.create_resume({
                "id": "mtime-resume", "label": "Synthetic", "path": str(source),
            }) for store in stores]
        self.assertEqual(len(divergent_times), 2)
        self.assertNotEqual(divergent_times[0], divergent_times[1])
        self.assertEqual(records[0], records[1])
        for store, record in zip(stores, records):
            installed = store.resume_files_path / record["managedFile"]
            self.assertEqual(record["observedModifiedAt"], self.facade._resume_modified_at(installed.stat()))
            self.assertEqual(installed.read_bytes(), source.read_bytes())
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

    def test_symlink_source_and_failed_metadata_write_leave_exact_tree_unchanged(self):
        stores = self.stores("failures")
        target = self.parent / "target.txt"
        target.write_text("secret", encoding="utf-8")
        link = self.parent / "link.txt"
        try:
            link.symlink_to(target)
        except OSError:
            self.skipTest("symlinks unavailable")
        for store in stores:
            with self.assertRaisesRegex(self.facade.StoreError, "readable regular file"):
                store.create_resume({"id": "bad", "label": "Bad", "path": str(link)})
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

        source = self.parent / "good.txt"
        source.write_text("good", encoding="utf-8")
        before = [snapshot_tree(store.root) for store in stores]
        for store in stores:
            with mock.patch.object(
                self.facade, "atomic_write_json", side_effect=OSError("synthetic")
            ):
                with self.assertRaises(OSError):
                    store.create_resume({
                        "id": "rollback", "label": "Rollback", "path": str(source),
                    })
        self.assertEqual([snapshot_tree(store.root) for store in stores], before)

    def test_runtime_binding_is_root_local_late_bound_and_reload_safe(self):
        root_a = copy_plugin(self.parent / "plugin-a")
        root_b = copy_plugin(self.parent / "plugin-b")

        def load(root, name):
            facade = direct_module(root / "scripts" / "job-apply-store.py", name)
            leaf = importlib.import_module(
                f"{facade._PACKAGE_NAME}.domains.resumes.storage"
            )
            leaf._bind_runtime(lambda: vars(facade))
            return facade, leaf

        first, first_leaf = load(root_a, "resume_storage_root_a")
        second, second_leaf = load(root_b, "resume_storage_root_b")
        self.assertIs(first_leaf._RUNTIME_PROVIDER(), vars(first))
        self.assertIs(second_leaf._RUNTIME_PROVIDER(), vars(second))
        self.assertIsNot(first_leaf, second_leaf)
        first.secrets = mock.Mock(token_urlsafe=mock.Mock(return_value="A" * 43))
        second.secrets = mock.Mock(token_urlsafe=mock.Mock(return_value="B" * 43))
        self.assertEqual(first_leaf.ResumeStorageMixin._new_resume_content_revision(), "content_" + "A" * 43)
        self.assertEqual(second_leaf.ResumeStorageMixin._new_resume_content_revision(), "content_" + "B" * 43)
        reloaded, reloaded_leaf = load(root_a, "resume_storage_root_a_reloaded")
        self.assertIsNot(reloaded_leaf, first_leaf)
        self.assertIs(reloaded_leaf._RUNTIME_PROVIDER(), vars(reloaded))
        self.assertIs(second_leaf._RUNTIME_PROVIDER(), vars(second))


if __name__ == "__main__":
    unittest.main()
