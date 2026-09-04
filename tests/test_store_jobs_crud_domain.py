from __future__ import annotations

import ast
import importlib
import inspect
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
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


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/jobs/crud.py"
METHODS = {
    "_load_jobs_document", "_require_active_resume", "create_job", "get_job",
    "list_jobs", "update_job", "transition_job", "trash_job", "restore_job",
    "_set_job_deleted", "delete_job",
}


class JobCrudDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_jobs_crud_domain_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.jobs.crud"
        )
        cls.mixin = cls.leaf.JobCrudMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def stores(self):
        original = self.facade.Store(self.home / "original", self.home / "legacy")
        original.initialize()
        clone_store_root(original.root, self.home / "extracted")
        extracted = self.composed(self.home / "extracted", self.home / "other")
        return original, extracted

    def both(self, stores, operation):
        results = [operation(store) for store in stores]
        self.assertEqual(results[0], results[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        return results[0]

    def both_error(self, stores, operation):
        before = [snapshot_tree(store.root) for store in stores]
        errors = []
        for store in stores:
            with self.assertRaises(self.facade.StoreError) as raised:
                operation(store)
            errors.append(str(raised.exception))
        self.assertEqual(errors[0], errors[1])
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])
        return errors[0]

    def test_exact_plain_leaf_contract_and_direction(self):
        owned = {
            name for name, value in vars(self.mixin).items()
            if inspect.isfunction(value) or isinstance(value, staticmethod)
        }
        self.assertEqual(owned, METHODS)
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        self.assertLessEqual(len(DOMAIN_PATH.read_bytes().splitlines()), 500)
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        tree = ast.parse(source)
        self.assertNotIn("__init__", owned)
        self.assertFalse(any(
            isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "super" for node in ast.walk(tree)
        ))

    def test_normalization_provenance_noops_and_revisions_are_exact(self):
        stores = self.stores()
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T12:00:00Z"
        ):
            created = self.both(stores, lambda store: store.create_job({
                "id": "acme", "url": " HTTPS://Jobs.Example:443/a#apply ",
                "role": "Engineer", "priority": 4,
            }))
            self.assertEqual(created["normalizedUrl"], "https://jobs.example/a")
            self.assertEqual(created["provenance"]["/role"]["origin"], "human")
            updated = self.both(stores, lambda store: store.update_job(
                "acme", {"role": "", "location": "Remote"}, 1
            ))
            self.assertEqual(updated["revision"], 2)
            before = [snapshot_tree(store.root) for store in stores]
            noop = [store.update_job("acme", {"role": "Agent"}, 2, "agent") for store in stores]
            self.assertEqual(noop, [updated, updated])
            self.assertEqual(before, [snapshot_tree(store.root) for store in stores])
            self.assertEqual(
                self.both_error(stores, lambda store: store.create_job({
                    "id": "duplicate", "url": "https://jobs.example/a"
                })),
                "active job URL already exists",
            )
            self.assertEqual(
                self.both_error(stores, lambda store: store.update_job(
                    "acme", {"notes": "stale"}, 1
                )),
                "job revision conflict",
            )
        self.assertEqual(
            self.both(stores, lambda store: store.list_jobs())[0]["id"], "acme"
        )

    def test_transition_trash_restore_delete_and_guards_are_exact(self):
        stores = self.stores()
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
        content_revision = stores[0]._new_resume_content_revision()
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T13:00:00Z"
        ), mock.patch.object(
            self.facade.Store,
            "_new_resume_content_revision",
            return_value=content_revision,
        ):
            self.both(stores, lambda store: store.replace_profile(
                {"firstName": "Ada"}, 1, "user"
            ))
            self.both(stores, lambda store: store.create_resume({
                "id": "resume", "label": "Resume", "path": str(resume_path)
            }))
            job = self.both(stores, lambda store: store.create_job({
                "id": "guarded", "url": "https://example.invalid/guarded",
                "resumeId": "resume",
            }))
            ready = self.both(stores, lambda store: store.transition_job(
                "guarded", "ready", job["revision"]
            ))
            self.assertEqual(
                self.both_error(stores, lambda store: store.transition_job(
                    "guarded", "in_progress", ready["revision"]
                )),
                "in_progress requires atomic job-acquire",
            )
            trashed = self.both(stores, lambda store: store.trash_job(
                "guarded", ready["revision"]
            ))
            self.assertEqual(
                self.both(stores, lambda store: store.trash_job(
                    "guarded", trashed["revision"]
                )),
                trashed,
            )
            restored = self.both(stores, lambda store: store.restore_job(
                "guarded", trashed["revision"]
            ))
            trashed = self.both(stores, lambda store: store.trash_job(
                "guarded", restored["revision"]
            ))
            self.both(stores, lambda store: store.save_session(
                "guarded", {"status": "active", "answerKeys": [], "pendingFields": []}
            ))
            self.assertIn("nonterminal", self.both_error(
                stores, lambda store: store.delete_job("guarded", trashed["revision"])
            ))

    def test_live_claim_and_missing_resume_block_mutations(self):
        for index, store_type in enumerate((self.facade.Store, self.composed)):
            with self.subTest(store=store_type.__name__):
                root = self.home / f"claim-{index}"
                store = store_type(root, self.home / f"legacy-{index}")
                resume_path = self.home / f"claim-{index}.pdf"
                resume_path.write_bytes(b"%PDF-1.7\nclaim")
                with mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T14:00:00Z"):
                    revision = store.inspect_profile()["revision"]
                    store.replace_profile({"firstName": "Ada"}, revision, "user")
                    with mock.patch.object(
                        store,
                        "_new_resume_content_revision",
                        return_value=store._new_resume_content_revision(),
                    ):
                        store.create_resume({"id": "r", "label": "R", "path": str(resume_path)})
                    job = store.create_job({"id": "j", "url": "https://e.invalid/j", "resumeId": "r"})
                    ready = store.transition_job("j", "ready", job["revision"])
                fixed = uuid.UUID("00000000-0000-4000-8000-000000000007")
                with mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed), mock.patch.object(
                    self.facade.secrets, "token_urlsafe", return_value="fixed-token"
                ):
                    acquired = store.acquire_ready_job("j", "owner", ready["revision"])
                before = snapshot_tree(root)
                with self.assertRaisesRegex(self.facade.StoreError, "claimed"):
                    store.trash_job("j", acquired["job"]["revision"])
                self.assertEqual(snapshot_tree(root), before)

        stores = self.stores()
        resume_path = self.home / "gone.pdf"
        resume_path.write_bytes(b"%PDF-1.7\ngone")
        content_revision = stores[0]._new_resume_content_revision()
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T15:00:00Z"
        ), mock.patch.object(
            self.facade.Store,
            "_new_resume_content_revision",
            return_value=content_revision,
        ):
            self.both(stores, lambda store: store.create_resume(
                {"id": "gone", "label": "Gone", "path": str(resume_path)}
            ))
            job = self.both(stores, lambda store: store.create_job(
                {"id": "restore", "url": "https://e.invalid/restore", "resumeId": "gone"}
            ))
            trashed = self.both(stores, lambda store: store.trash_job("restore", job["revision"]))
            self.both(stores, lambda store: store.trash_resume("gone", 1))
            self.assertEqual(
                self.both_error(stores, lambda store: store.restore_job(
                    "restore", trashed["revision"]
                )),
                "assigned resume does not exist",
            )

    def test_same_revision_race_and_write_failure_preserve_store(self):
        for index, store_type in enumerate((self.facade.Store, self.composed)):
            store = store_type(self.home / f"race-{index}", self.home / f"l-{index}")
            store.initialize()
            job = store.create_job({"id": "race", "url": "https://e.invalid/race"})
            def update(value):
                try:
                    return store.update_job("race", {"role": value}, job["revision"])
                except self.facade.StoreError as error:
                    return str(error)
            with ThreadPoolExecutor(max_workers=2) as executor:
                results = list(executor.map(update, ("Ada", "Grace")))
            self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
            self.assertEqual(results.count("job revision conflict"), 1)

        stores = self.stores()
        for store in stores:
            with self.facade.exclusive_file_lock(store.store_lock_path):
                pass
        before = [snapshot_tree(store.root) for store in stores]
        with mock.patch.object(
            self.facade, "atomic_write_json", side_effect=OSError("stop")
        ):
            for store in stores:
                with self.assertRaisesRegex(OSError, "stop"):
                    store.create_job({"id": "fail", "url": "https://e.invalid/fail"})
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])
        self.assertEqual([list(store.root.glob(".*.tmp")) for store in stores], [[], []])

    def test_trash_preserves_the_two_distinct_wall_clock_reads(self):
        stores = self.stores()
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T16:00:00Z"
        ):
            job = self.both(stores, lambda store: store.create_job(
                {"id": "dual-clock", "url": "https://e.invalid/dual-clock"}
            ))
        results = []
        for store in stores:
            with mock.patch.object(self.facade, "utc_now", side_effect=[
                "2026-09-04T16:00:01Z", "2026-09-04T16:00:02Z",
            ]):
                results.append(store.trash_job("dual-clock", job["revision"]))
        self.assertEqual(results[0], results[1])
        self.assertEqual(results[0]["deletedAt"], "2026-09-04T16:00:01Z")
        self.assertEqual(results[0]["updatedAt"], "2026-09-04T16:00:02Z")
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

    def test_late_patches_and_corrupt_documents_do_not_rewrite(self):
        store = self.composed(self.home / "late", self.home / "legacy-late")
        store.initialize()
        normalize = mock.Mock(wraps=self.facade.normalize_job_url)
        write = mock.Mock(wraps=self.facade.atomic_write_json)
        with mock.patch.object(self.facade, "normalize_job_url", normalize), mock.patch.object(
            self.facade, "atomic_write_json", write
        ):
            store.create_job({"id": "late", "url": "https://e.invalid/late"})
        self.assertEqual(normalize.call_count, 1)
        self.assertEqual(write.call_count, 1)
        store.jobs_path.write_text('{"schemaVersion":2}', encoding="utf-8")
        before = snapshot_tree(store.root)
        with self.assertRaisesRegex(self.facade.StoreError, "future schemaVersion 2"):
            store.get_job("late")
        self.assertEqual(snapshot_tree(store.root), before)


if __name__ == "__main__":
    unittest.main()
