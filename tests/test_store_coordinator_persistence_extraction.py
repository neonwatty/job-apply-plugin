from __future__ import annotations

import importlib
import inspect
import json
import shutil
import tempfile
import unittest
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
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
from tests.support.store_result_contract import normalize_store_result


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "_ensure_coordinator_files_locked",
    "_ensure_coordinator_files",
    "_load_coordinator_document",
    "_load_coordinator_journal",
    "_history_event_for_operation",
    "_history_event_is_idempotent_locked",
    "_append_history_event_idempotent_locked",
    "_repair_pending_history_tail_locked",
    "_roll_forward_locked",
    "_commit_coordinator_operation_locked",
)


class CoordinatorPersistenceExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="coordinator_persistence_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.coordinator.persistence"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.CoordinatorPersistenceMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        source = self.parent / "source"
        self.facade.Store(source, self.parent / "legacy.json").initialize()
        self.original = self.facade.Store(
            clone_store_root(source, self.parent / "original"),
            self.parent / "legacy.json",
        )
        self.extracted = self.composed(
            clone_store_root(source, self.parent / "extracted"),
            self.parent / "legacy.json",
        )

    def _make_ready_job(self, store, label: str):
        store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=store.inspect_profile()["revision"],
            source="user",
        )
        resume_path = self.parent / f"{label}.pdf"
        resume_path.write_bytes(b"%PDF-1.7\ncoordinator persistence")
        store.create_resume({
            "id": f"{label}-resume",
            "label": "Default",
            "path": str(resume_path),
        })
        job = store.create_job({
            "id": f"{label}-job",
            "url": f"https://example.com/jobs/{label}",
            "role": "Engineer",
            "company": "Example",
        })
        return store.transition_job(job["id"], "ready", job["revision"])

    def _fresh_extracted(self, label: str):
        store = self.composed(
            self.parent / label, self.parent / f"{label}-legacy.json"
        )
        store.initialize()
        store._ensure_coordinator_files()
        return store

    def _write_coordinator_operation(self, store, operation):
        self.facade.atomic_write_json(
            store.coordinator_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )

    @staticmethod
    def _claim(job_id: str, claim_id: str):
        return {
            "claimId": claim_id,
            "jobId": job_id,
            "ownerLabel": "golden-agent",
            "tokenHash": "a" * 64,
            "acquiredAt": "2026-09-04T20:00:00Z",
            "heartbeatAt": "2026-09-04T20:00:00Z",
            "expiresAt": "2026-09-04T20:05:00Z",
        }

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        source = inspect.getsource(self.mixin)
        self.assertNotIn("super(", source)
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["coordinator.persistence"],
            {"CoordinatorPersistenceMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_acquire_is_byte_and_mode_equivalent_without_nested_locking(self):
        source = self.parent / "acquire-source"
        instant = datetime(2026, 9, 4, 20, tzinfo=timezone.utc)
        writer = self.facade.Store(source, self.parent / "legacy.json", clock=lambda: instant)
        with (
            mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T20:00:00Z"),
            mock.patch.object(self.facade.secrets, "token_urlsafe", return_value="A" * 43),
        ):
            writer.initialize()
            ready = self._make_ready_job(writer, "same")
        stores = (
            self.facade.Store(
                clone_store_root(source, self.parent / "acquire-original"),
                self.parent / "legacy.json",
                clock=lambda: instant,
            ),
            self.composed(
                clone_store_root(source, self.parent / "acquire-extracted"),
                self.parent / "legacy.json",
                clock=lambda: instant,
            ),
        )
        original_lock = self.facade.exclusive_file_lock
        depth = {id(store): 0 for store in stores}

        @contextmanager
        def tracked_lock(path):
            owner = next(store for store in stores if store.store_lock_path == path)
            key = id(owner)
            self.assertEqual(depth[key], 0)
            depth[key] += 1
            try:
                with original_lock(path):
                    yield
            finally:
                depth[key] -= 1

        results = []
        for store in stores:
            with (
                mock.patch.object(
                    self.facade, "utc_now", return_value="2026-09-04T20:00:00Z"
                ),
                mock.patch.object(
                    self.facade.uuid,
                    "uuid4",
                    side_effect=[
                        uuid.UUID("11111111-1111-4111-8111-111111111111"),
                        uuid.UUID("22222222-2222-4222-8222-222222222222"),
                    ],
                ),
                mock.patch.object(
                    self.facade.secrets, "token_urlsafe", return_value="A" * 43
                ),
                mock.patch.object(
                    self.facade, "exclusive_file_lock", side_effect=tracked_lock
                ),
            ):
                results.append(
                    store.acquire_ready_job(
                        ready["id"], "test-agent", ready["revision"]
                    )
                )
        for result in results:
            self.assertEqual(result["job"]["updatedAt"], "2026-09-04T20:00:00Z")
            self.assertEqual(result["claim"]["acquiredAt"], "2026-09-04T20:00:00Z")
        self.assertEqual(
            normalize_store_result(results[0], stores[0].root),
            normalize_store_result(results[1], stores[1].root),
        )
        self.assertEqual(depth, {id(store): 0 for store in stores})
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        self.assertIsNone(stores[1]._load_coordinator_journal()["operation"])
        self.assertEqual(stores[1].read_history()[0]["event"], "job-started")

    def test_partial_history_append_rolls_back_and_fsyncs(self):
        self.extracted._ensure_coordinator_files()
        before = self.extracted.history_path.read_bytes()
        event = {
            "schemaVersion": 1,
            "eventId": "partial-event",
            "applicationId": "partial-job",
            "event": "job-started",
            "status": "in_progress",
            "answerKeys": [],
            "at": "2026-09-04T20:00:00Z",
        }
        real_write = self.facade.os.write
        calls = {"count": 0}

        def interrupted(descriptor, value):
            calls["count"] += 1
            if calls["count"] == 1:
                return real_write(descriptor, value[:5])
            raise OSError("synthetic partial append")

        with (
            mock.patch.object(self.facade.os, "write", side_effect=interrupted),
            mock.patch.object(
                self.facade.os, "fsync", wraps=self.facade.os.fsync
            ) as fsync,
        ):
            with self.assertRaisesRegex(OSError, "partial append"):
                self.extracted._append_history_event_idempotent_locked(event)
        self.assertEqual(self.extracted.history_path.read_bytes(), before)
        self.assertGreaterEqual(fsync.call_count, 1)

    def test_pending_partial_tail_repairs_then_rolls_forward_exactly_once(self):
        ready = self._make_ready_job(self.extracted, "recover")
        self.extracted._ensure_coordinator_files()
        now = "2026-09-04T20:30:00Z"
        operation_id = "recovery-operation"
        event = self.extracted._history_event_for_operation(
            operation_id, ready, "job-started", "in_progress", now
        )
        operation = {
            "kind": "acquire",
            "operationId": operation_id,
            "jobId": ready["id"],
            "sourceStatus": "ready",
            "targetStatus": "in_progress",
            "expectedRevision": ready["revision"],
            "at": now,
            "historyEvent": event,
            "resultClaim": {
                "claimId": "recovery-claim",
                "jobId": ready["id"],
                "ownerLabel": "test-agent",
                "tokenHash": "a" * 64,
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": "2026-09-04T20:35:00Z",
            },
        }
        self.facade.atomic_write_json(
            self.extracted.coordinator_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        self.extracted.history_path.write_bytes(b'{"partial":"PRIVATE PATH VALUE"')
        with mock.patch.object(
            self.facade.os, "fsync", wraps=self.facade.os.fsync
        ) as fsync:
            self.extracted._repair_pending_history_tail_locked()
        self.assertEqual(self.extracted.history_path.read_bytes(), b"")
        self.assertGreaterEqual(fsync.call_count, 1)
        self.extracted._roll_forward_locked()
        first = snapshot_tree(self.extracted.root)
        self.extracted._roll_forward_locked()
        self.assertEqual(snapshot_tree(self.extracted.root), first)
        self.assertEqual(self.extracted.get_job(ready["id"])["status"], "in_progress")
        self.assertEqual(self.extracted.read_history(), [event])
        self.assertIsNone(self.extracted._load_coordinator_journal()["operation"])
        self.assertNotIn(
            "PRIVATE PATH VALUE",
            json.dumps(self.extracted._load_coordinator_journal()),
        )

    def test_golden_answer_merge_and_resolution_roll_forward_branches(self):
        merge = self._fresh_extracted("golden-merge")
        winner = merge.put_answer({
            "question": "Canonical salary?", "state": "confirmed", "value": "100"
        })
        source = merge.put_answer({
            "question": "Expected salary?", "state": "confirmed", "value": "200"
        })
        merge_operation = {
            "kind": "answer_merge",
            "operationId": "golden-merge-operation",
            "at": "2026-09-04T20:00:00Z",
            "winnerKey": winner["key"],
            "sourceKey": source["key"],
            "expectedWinnerRevision": winner["revision"],
            "expectedSourceRevision": source["revision"],
            "sessions": [],
            "resultClaim": None,
        }
        self._write_coordinator_operation(merge, merge_operation)
        merge._roll_forward_locked()
        document = merge._load_answers_document()
        self.assertNotIn(source["key"], document["answers"])
        self.assertEqual(
            document["redirects"][source["key"]]["targetKey"], winner["key"]
        )
        self.assertEqual(
            document["answers"][winner["key"]]["revision"],
            winner["revision"] + 1,
        )
        self.assertIsNone(merge._load_coordinator_journal()["operation"])

        resolution = self._fresh_extracted("golden-resolution")
        job = resolution.create_job({
            "id": "resolution-job", "url": "https://example.com/resolution"
        })
        job = resolution.transition_job(job["id"], "needs_info", job["revision"])
        session = resolution._build_session(job["id"], {
            "status": "active", "step": "questions", "pendingFields": []
        }, now="2026-09-04T20:00:00Z")
        self.facade.atomic_write_json(resolution._session_path(job["id"]), session)
        resolution_operation = {
            "kind": "answer_resolution",
            "operationId": "golden-resolution-operation",
            "jobId": job["id"],
            "at": "2026-09-04T20:00:00Z",
            "answerKey": "golden-answer",
            "expectedJobRevision": job["revision"],
            "expectedSessionRevision": resolution._session_revision(session),
            "expectedAnswerRevision": 1,
            "sourceStatus": "needs_info",
            "targetStatus": "ready",
            "session": session,
            "resultClaim": None,
        }
        self._write_coordinator_operation(resolution, resolution_operation)
        self.leaf._bind_runtime(lambda: vars(self.leaf))
        try:
            self.assertEqual(
                resolution._load_coordinator_journal()["operation"]["kind"],
                "answer_resolution",
            )
            resolution._roll_forward_locked()
        finally:
            self.leaf._bind_runtime(lambda: vars(self.facade))
        resolved = resolution.get_job(job["id"])
        self.assertEqual(
            (resolved["status"], resolved["revision"]),
            ("ready", job["revision"] + 1),
        )
        self.assertEqual(resolution.load_session(job["id"]), session)
        self.assertIsNone(resolution._load_coordinator_journal()["operation"])

    def test_golden_handoff_and_recovery_roll_forward_branches(self):
        handoff = self._fresh_extracted("golden-handoff")
        job = handoff.create_job({
            "id": "handoff-job", "url": "https://example.com/handoff"
        })
        jobs = handoff._load_jobs_document()
        active = dict(jobs["jobs"][job["id"]])
        active.update({
            "status": "in_progress", "revision": 2,
            "updatedAt": "2026-09-04T20:00:00Z",
        })
        jobs["jobs"][job["id"]] = active
        jobs["metadata"]["updatedAt"] = active["updatedAt"]
        self.facade.atomic_write_json(handoff.jobs_path, jobs)
        session = handoff._build_session(job["id"], {
            "status": "active", "step": "questions", "pendingFields": []
        }, now="2026-09-04T20:00:00Z")
        self.facade.atomic_write_json(handoff._session_path(job["id"]), session)
        event = handoff._history_event_for_operation(
            "golden-handoff-operation", active, "job-blocked", "needs_info",
            "2026-09-04T20:01:00Z",
        )
        operation = {
            "kind": "handoff",
            "operationId": "golden-handoff-operation",
            "jobId": job["id"],
            "at": "2026-09-04T20:01:00Z",
            "historyEvent": event,
            "resultClaim": None,
            "sourceStatus": "in_progress",
            "targetStatus": "needs_info",
            "expectedRevision": 2,
            "session": session,
        }
        self._write_coordinator_operation(handoff, operation)
        handoff._roll_forward_locked()
        changed = handoff.get_job(job["id"])
        self.assertEqual((changed["status"], changed["revision"]), ("needs_info", 3))
        self.assertEqual(handoff.read_history(), [event])
        self.assertIsNone(handoff._load_coordinator_document()["claim"])

        recovery = self._fresh_extracted("golden-recovery")
        recovered_job = recovery.create_job({
            "id": "recovery-job", "url": "https://example.com/recovery"
        })
        recovery_event = recovery._history_event_for_operation(
            "golden-recovery-operation", recovered_job, "claim-recovered",
            "in_progress", "2026-09-04T20:02:00Z",
        )
        claim = self._claim(recovered_job["id"], "golden-recovery-claim")
        self._write_coordinator_operation(recovery, {
            "kind": "recover",
            "operationId": "golden-recovery-operation",
            "jobId": recovered_job["id"],
            "at": "2026-09-04T20:02:00Z",
            "historyEvent": recovery_event,
            "resultClaim": claim,
        })
        recovery._roll_forward_locked()
        self.assertEqual(recovery.get_job(recovered_job["id"]), recovered_job)
        self.assertEqual(recovery.read_history(), [recovery_event])
        self.assertEqual(recovery._load_coordinator_document()["claim"], claim)
        self.assertIsNone(recovery._load_coordinator_journal()["operation"])

    def test_late_runtime_and_two_root_reload_isolation(self):
        with mock.patch.object(
            self.facade, "read_json_object", wraps=self.facade.read_json_object
        ) as reader:
            self.extracted._ensure_coordinator_files()
            self.extracted._load_coordinator_document()
        self.assertGreaterEqual(reader.call_count, 2)

        roots = []
        modules = []
        for index in range(2):
            root = self.parent / f"copy-{index}"
            scripts = root / "scripts"
            shutil.copytree(ROOT / "scripts", scripts)
            module = load_module(
                scripts / "job-apply-store.py", name=f"coordinator_root_{index}"
            )
            leaf = importlib.import_module(
                f"{module._PACKAGE_NAME}.domains.coordinator.persistence"
            )
            leaf._bind_runtime(lambda module=module: vars(module))
            roots.append(root)
            modules.append((module, leaf))
        self.assertNotEqual(modules[0][0]._PACKAGE_NAME, modules[1][0]._PACKAGE_NAME)
        self.assertIsNot(modules[0][1], modules[1][1])
        for index, (module, leaf) in enumerate(modules):
            store_type = composed_store_class(module.Store, leaf.CoordinatorPersistenceMixin)
            store = store_type(roots[index] / "store", roots[index] / "legacy.json")
            store.initialize()
            store._ensure_coordinator_files()
            self.assertEqual(store._load_coordinator_document()["claim"], None)


if __name__ == "__main__":
    unittest.main()
