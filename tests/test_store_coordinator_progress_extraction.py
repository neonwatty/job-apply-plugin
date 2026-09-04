from __future__ import annotations

import importlib
import inspect
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from tests.support import store_fixtures
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
    "resolve_pending_answer",
    "save_claim_progress",
    "handoff_claimed_job",
)
NOW = "2026-09-04T20:00:00Z"
FIXED_UUID = uuid.UUID("12345678-1234-5678-1234-567812345678")


class CoordinatorProgressExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="coordinator_progress_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.coordinator.progress"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.CoordinatorProgressMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        source = parent / "source"
        writer = self.facade.Store(source, parent / "legacy.json")
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            writer.initialize()
            writer.replace_profile(
                {"firstName": "Ada"},
                writer.inspect_profile()["revision"],
                "user",
            )
            resume_path = parent / "resume.pdf"
            resume_path.write_bytes(b"%PDF-1.7\nprogress-contract")
            writer.create_resume({
                "id": "default-resume",
                "label": "Default",
                "path": str(resume_path),
            })
            job = writer.create_job({
                "id": "job",
                "url": "https://example.com/jobs/progress",
                "role": "Engineer",
                "company": "Acme",
            })
            ready = writer.transition_job("job", "ready", job["revision"])
            with mock.patch.object(
                writer, "_new_claim_token", return_value="fixed-claim-token"
            ):
                acquired = writer.acquire_ready_job(
                    "job", "contract-agent", ready["revision"]
                )
        self.token = acquired["token"]
        self.attempt_revision = acquired["job"]["revision"]
        self.original = self.facade.Store(
            clone_store_root(source, parent / "original"), parent / "legacy.json"
        )
        self.extracted = self.composed(
            clone_store_root(source, parent / "extracted"), parent / "legacy.json"
        )

    def _call_both(self, operation):
        with (
            mock.patch.object(self.facade, "utc_now", return_value=NOW),
            mock.patch.object(self.facade.uuid, "uuid4", return_value=FIXED_UUID),
        ):
            values = [operation(store) for store in (self.original, self.extracted)]
        self.assertEqual(values[0], values[1])
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return values[0]

    def _assert_same_error(self, operation):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        errors = []
        for store in (self.original, self.extracted):
            with self.assertRaises(self.facade.StoreError) as raised:
                operation(store)
            errors.append(str(raised.exception))
        self.assertEqual(errors[0], errors[1])
        self.assertEqual(before, [snapshot_tree(store.root) for store in (self.original, self.extracted)])
        return errors[0]

    def _pending_input(self):
        return {
            "status": "active",
            "step": "questions",
            "answerKeys": [],
            "pendingFields": [{
                "question": "Authorized to work?",
                "state": "missing",
                "answerKey": "authorization.answer",
                "sensitive": False,
            }],
        }

    def _prepare_resolution(self):
        pending = self._pending_input()
        self._call_both(
            lambda store: store.save_claim_progress("job", self.token, pending)
        )
        blocked = self._call_both(lambda store: store.handoff_claimed_job(
            "job", self.token, "needs_info", pending, self.attempt_revision
        ))
        answer = self._call_both(lambda store: store.put_answer({
            "key": "authorization.answer",
            "question": "Authorized to work?",
            "state": "confirmed",
            "value": "PRIVATE-YES",
        }))
        activities = [store.get_job_activity("job") for store in (self.original, self.extracted)]
        self.assertEqual(activities[0], activities[1])
        return blocked, answer, activities[0]

    def test_exact_contract_inventory_lifecycle_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["coordinator.progress"],
            {"CoordinatorProgressMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_preintegration_differential_matches_frozen_outcome_oracle(self):
        blocked, answer, activity = self._prepare_resolution()
        self.assertEqual(
            {
                "jobStatus": blocked["job"]["status"],
                "claim": blocked["claim"],
                "sessionStatus": blocked["session"]["status"],
                "history": [item["event"] for item in self.original.read_history()],
            },
            {
                "jobStatus": "needs_info",
                "claim": None,
                "sessionStatus": "active",
                "history": ["job-started", "job-blocked"],
            },
        )
        reference = activity["session"]["pendingInformation"][0]["reference"]
        resolved = self._call_both(lambda store: store.resolve_pending_answer(
            "job",
            reference,
            blocked["job"]["revision"],
            activity["session"]["revision"],
            answer["revision"],
            owner_confirmed=True,
        ))
        self.assertEqual(
            {
                "job": resolved["job"],
                "pendingInformation": resolved["session"]["pendingInformation"],
                "resolved": resolved["resolved"],
                "ready": resolved["ready"],
            },
            {
                "job": {"id": "job", "status": "ready", "revision": 5},
                "pendingInformation": [],
                "resolved": True,
                "ready": True,
            },
        )
        for store in (self.original, self.extracted):
            durable = b"".join(
                path.read_bytes()
                for path in (
                    store.jobs_path,
                    store._session_path("job"),
                    store.history_path,
                    store.coordinator_path,
                    store.coordinator_journal_path,
                )
            ).decode("utf-8")
            self.assertNotIn("PRIVATE-YES", durable)

    def test_stale_sensitive_and_status_errors_are_exact_noops(self):
        self.assertIn("unsupported", self._assert_same_error(
            lambda store: store.handoff_claimed_job(
                "job", self.token, "submitted", {}, self.attempt_revision
            )
        ))
        self.assertIn("remain active", self._assert_same_error(
            lambda store: store.save_claim_progress(
                "job", self.token, {"status": "review"}
            )
        ))
        sensitive_answers = []
        for store in (self.original, self.extracted):
            sensitive_answers.append(store.put_answer({
                "key": "sensitive.answer",
                "state": "sensitive",
                "value": "NEVER-DURABLE",
            }, remember_sensitive=True))
        self.assertEqual(sensitive_answers[0], sensitive_answers[1])
        pending = self._pending_input()
        pending["pendingFields"][0].update({
            "answerKey": "sensitive.answer", "sensitive": True,
        })
        self._call_both(
            lambda store: store.save_claim_progress("job", self.token, pending)
        )
        blocked = self._call_both(lambda store: store.handoff_claimed_job(
            "job", self.token, "needs_info", pending, self.attempt_revision
        ))
        activity = self.original.get_job_activity("job")
        reference = activity["session"]["pendingInformation"][0]["reference"]
        self.assertIn("owner confirmation", self._assert_same_error(
            lambda store: store.resolve_pending_answer(
                "job", reference, blocked["job"]["revision"],
                activity["session"]["revision"], sensitive_answers[0]["revision"]
            )
        ))
        self.assertIn("job revision conflict", self._assert_same_error(
            lambda store: store.resolve_pending_answer(
                "job", reference, blocked["job"]["revision"] + 1,
                activity["session"]["revision"], sensitive_answers[0]["revision"], True
            )
        ))
        self.assertIn("sensitive", self._assert_same_error(
            lambda store: store.resolve_pending_answer(
                "job", reference, blocked["job"]["revision"],
                activity["session"]["revision"], sensitive_answers[0]["revision"], True
            )
        ))

    def test_resolution_race_has_one_winner_and_never_copies_value(self):
        blocked, answer, activity = self._prepare_resolution()
        reference = activity["session"]["pendingInformation"][0]["reference"]
        gate = threading.Barrier(2)

        def resolve(_):
            gate.wait()
            try:
                return self.extracted.resolve_pending_answer(
                    "job", reference, blocked["job"]["revision"],
                    activity["session"]["revision"], answer["revision"], True
                )
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(resolve, range(2)))
        self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
        self.assertEqual(sum("conflict" in item for item in outcomes if isinstance(item, str)), 1)
        durable = b"".join(
            path.read_bytes()
            for path in (
                self.extracted.jobs_path,
                self.extracted._session_path("job"),
                self.extracted.history_path,
                self.extracted.coordinator_path,
                self.extracted.coordinator_journal_path,
            )
        ).decode("utf-8")
        self.assertNotIn("PRIVATE-YES", durable)

    def test_atomic_progress_failure_preserves_exact_bytes_modes_and_temp_cleanup(self):
        before = snapshot_tree(self.extracted.root)
        with mock.patch.object(self.facade.os, "replace", side_effect=OSError("boom")):
            with self.assertRaisesRegex(OSError, "boom"):
                self.extracted.save_claim_progress(
                    "job", self.token, self._pending_input()
                )
        self.assertEqual(snapshot_tree(self.extracted.root), before)
        session_dir = self.extracted.sessions_path
        self.assertEqual(list(session_dir.glob(".*.tmp")), [])

    def test_bound_canonical_two_root_and_reload_runtime_isolation(self):
        canonical_writer = mock.Mock(wraps=self.leaf.io.atomic_write_json)
        self.leaf._bind_runtime(lambda: {
            **vars(self.leaf), "atomic_write_json": canonical_writer,
        })
        try:
            self.extracted.save_claim_progress(
                "job", self.token, self._pending_input()
            )
        finally:
            self.leaf._bind_runtime(lambda: vars(self.facade))
        self.assertEqual(canonical_writer.call_count, 1)

        other_facade = load_module(name="coordinator_progress_other_root")
        other_leaf = importlib.import_module(
            f"{other_facade._PACKAGE_NAME}.domains.coordinator.progress"
        )
        self.assertIsNot(other_leaf, self.leaf)
        first = object()
        second = object()
        self.leaf._bind_runtime(lambda: {"uuid": first})
        other_leaf._bind_runtime(lambda: {"uuid": second})
        self.assertIs(self.leaf._late("uuid"), first)
        self.assertIs(other_leaf._late("uuid"), second)
        importlib.reload(other_leaf)
        self.assertIs(other_leaf._late("uuid"), other_leaf.uuid)
        self.assertIs(self.leaf._late("uuid"), first)
        self.leaf._bind_runtime(lambda: vars(self.facade))


if __name__ == "__main__":
    unittest.main()
