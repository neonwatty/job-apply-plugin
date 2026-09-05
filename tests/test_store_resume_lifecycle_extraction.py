from __future__ import annotations

import importlib
import inspect
import tempfile
import unittest
import uuid
from contextlib import ExitStack
from datetime import datetime
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


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "trash_resume",
    "restore_resume",
    "_set_resume_deleted",
    "delete_resume",
)


class ResumeLifecycleExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="resume_lifecycle_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.resumes.lifecycle"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.ResumeLifecycleMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        self.inputs = parent / "inputs"
        self.inputs.mkdir()
        secrets_patch = mock.patch.object(
            self.facade.secrets, "token_urlsafe", return_value="a" * 43
        )
        uuid_patch = mock.patch.object(
            self.facade.uuid,
            "uuid4",
            return_value=uuid.UUID("00000000-0000-4000-8000-000000000001"),
        )
        secrets_patch.start()
        uuid_patch.start()
        self.addCleanup(secrets_patch.stop)
        self.addCleanup(uuid_patch.stop)
        # Paired operations compare durable timestamps from both Store clocks.
        now = "2026-09-04T20:00:00Z"
        clock = lambda: datetime.fromisoformat(now.replace("Z", "+00:00"))
        timestamp_patch = mock.patch.object(self.facade, "utc_now", return_value=now)
        timestamp_patch.start()
        self.addCleanup(timestamp_patch.stop)
        source = parent / "source"
        self.facade.Store(source, parent / "legacy.json", clock=clock).initialize()
        self.original = self.facade.Store(
            clone_store_root(source, parent / "original"), parent / "legacy.json", clock=clock
        )
        self.extracted = self.composed(
            clone_store_root(source, parent / "extracted"), parent / "legacy.json", clock=clock
        )

    def call_both(self, operation):
        stores = (self.original, self.extracted)
        with fixed_staged_resume_mtime(self.facade, stores):
            values = [operation(store) for store in stores]
        self.assertEqual(values[0], values[1])
        for store, value in zip(stores, values):
            if isinstance(value, dict) and "managedFile" in value:
                installed = store.resume_files_path / value["managedFile"]
                self.assertEqual(value["observedModifiedAt"], self.facade._resume_modified_at(installed.stat()))
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return values[0]

    def assert_same_error(self, operation):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        messages = []
        for store in (self.original, self.extracted):
            with self.assertRaises(self.facade.StoreError) as raised:
                operation(store)
            messages.append(str(raised.exception))
        self.assertEqual(messages[0], messages[1])
        self.assertEqual(
            before,
            [snapshot_tree(store.root) for store in (self.original, self.extracted)],
        )
        return messages[0]

    def create(self, resume_id: str, default: bool = False):
        source = self.inputs / f"{resume_id}.txt"
        source.write_text(f"content for {resume_id}", encoding="utf-8")
        return self.call_both(
            lambda store: store.create_resume(
                {
                    "id": resume_id,
                    "label": resume_id,
                    "path": str(source),
                    "default": default,
                }
            )
        )

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["resumes.lifecycle"],
            {"ResumeLifecycleMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_unbound_lifecycle_runtime_uses_shared_canonical_validator(self):
        resume = self.create("canonical-lifecycle")
        self.leaf._bind_runtime(lambda: {})
        try:
            trashed = self.extracted.trash_resume(
                resume["id"], resume["revision"]
            )
        finally:
            self.leaf._bind_runtime(lambda: vars(self.facade))
        self.assertIsNotNone(trashed["deletedAt"])

    def test_trash_restore_noop_and_delete_are_byte_equivalent(self):
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T20:00:00Z"
        ):
            first = self.create("first", default=True)
            self.create("second")
            trashed = self.call_both(
                lambda store: store.trash_resume("first", first["revision"])
            )
            no_op = self.call_both(
                lambda store: store.trash_resume("first", trashed["revision"])
            )
            restored = self.call_both(
                lambda store: store.restore_resume("first", trashed["revision"])
            )
            trashed_again = self.call_both(
                lambda store: store.trash_resume("first", restored["revision"])
            )
            deleted = self.call_both(
                lambda store: store.delete_resume("first", trashed_again["revision"])
            )
            absent = self.call_both(lambda store: store.delete_resume("first", 999))
        self.assertEqual(no_op, trashed)
        self.assertFalse(restored["default"])
        self.assertEqual(deleted, {"deleted": True, "id": "first"})
        self.assertEqual(absent, {"deleted": False, "id": "first"})

    def test_job_references_stale_revisions_and_delete_guards_are_noops(self):
        resume = self.create("assigned", default=True)
        for store in (self.original, self.extracted):
            store.create_job(
                {
                    "id": "job-assigned",
                    "url": "https://example.com/jobs/assigned",
                    "resumeId": resume["id"],
                }
            )
        self.assertIn(
            "assigned",
            self.assert_same_error(
                lambda store: store.trash_resume("assigned", resume["revision"])
            ),
        )
        for store in (self.original, self.extracted):
            job = store.get_job("job-assigned")
            store.update_job("job-assigned", {"resumeId": None}, job["revision"])
        other = self.create("other")
        self.call_both(
            lambda store: store.set_default_resume("other", other["revision"])
        )
        for store in (self.original, self.extracted):
            job = store.get_job("job-assigned")
            job = store.update_job(
                "job-assigned", {"resumeId": "assigned"}, job["revision"]
            )
            store.trash_job("job-assigned", job["revision"])
        current_revision = self.original.get_resume("assigned")["revision"]
        trashed = self.call_both(
            lambda store: store.trash_resume("assigned", current_revision)
        )
        self.assertIn(
            "revision conflict",
            self.assert_same_error(lambda store: store.restore_resume("assigned", 1)),
        )
        self.assertIn(
            "referenced",
            self.assert_same_error(
                lambda store: store.delete_resume("assigned", trashed["revision"])
            ),
        )

    def test_trash_closes_open_request_in_same_journaled_operation(self):
        resume = self.create("requested")
        requests = []
        for store in (self.original, self.extracted):
            requests.append(
                store.create_resume_extraction_request(
                    "requested", resume["revision"]
                )
            )
        self.assertEqual(requests[0], requests[1])
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T21:00:00Z"
        ):
            spies = []
            with ExitStack() as stack:
                for store in (self.original, self.extracted):
                    spies.append(
                        stack.enter_context(
                            mock.patch.object(
                                store,
                                "_commit_extraction_operation_locked",
                                wraps=store._commit_extraction_operation_locked,
                            )
                        )
                    )
                trashed = self.call_both(
                    lambda store: store.trash_resume(
                        "requested", resume["revision"]
                    )
                )
        for spy in spies:
            self.assertEqual(spy.call_count, 1)
            arguments = spy.call_args.args
            self.assertEqual(arguments[:3], ("resume-request-close", None, None))
            self.assertEqual(
                next(iter(arguments[3]["requests"].values()))["status"],
                "cancelled",
            )
            self.assertEqual(arguments[4]["resumes"][resume["id"]], trashed)
        for store in (self.original, self.extracted):
            request = store.get_resume_extraction_request(requests[0]["requestId"])
            self.assertEqual(request["status"], "cancelled")
            self.assertIsNone(store._load_extraction_journal()["operation"])

    def test_delete_metadata_failure_restores_private_file_and_tree(self):
        source = self.inputs / "failure.txt"
        source.write_text("private resume bytes", encoding="utf-8")
        resume = self.extracted.create_resume(
            {"id": "failure", "label": "Failure", "path": str(source)}
        )
        trashed = self.extracted.trash_resume("failure", resume["revision"])
        before = snapshot_tree(self.extracted.root)
        with mock.patch.object(
            self.facade, "atomic_write_json", side_effect=OSError("synthetic")
        ):
            with self.assertRaisesRegex(OSError, "synthetic"):
                self.extracted.delete_resume("failure", trashed["revision"])
        self.assertEqual(snapshot_tree(self.extracted.root), before)
        self.assertNotIn("private resume bytes", repr(trashed))


if __name__ == "__main__":
    unittest.main()
