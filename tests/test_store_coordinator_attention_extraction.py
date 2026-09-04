from __future__ import annotations

import ast
import hashlib
import importlib
import inspect
import json
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


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "list_needs_attention",
    "_needs_attention_locked",
    "get_job_activity",
    "_session_revision",
    "_pending_resolution_projection",
    "_current_session_approvals",
    "pending_answer_detail",
)


class CoordinatorAttentionExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="coordinator_attention_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.coordinator.attention"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.CoordinatorAttentionMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        source = parent / "source"
        writer = self.facade.Store(source, parent / "legacy.json")
        writer.initialize()
        answer = writer.put_answer({
            "key": "authorization.answer",
            "question": "Authorization?",
            "state": "confirmed",
            "value": "PRIVATE AUTHORIZATION VALUE",
            "fieldClass": "authorization",
        })
        session = writer.save_session("attention-job", {
            "status": "active",
            "step": "questions",
            "attemptRevision": 1,
            "pendingFields": [{
                "question": "Private authorization question?",
                "state": "missing",
                "answerKey": answer["key"],
                "sensitive": False,
                "fieldClass": "authorization",
                "matchConfidence": "high",
                "matchReasonCodes": ["field_class_match"],
            }],
        })
        job = writer.create_job({
            "id": "attention-job",
            "url": "https://example.com/jobs/attention",
            "role": "Private role",
            "company": "Private company",
            "priority": 4,
        })
        job = writer.transition_job(job["id"], "needs_info", job["revision"])
        writer.append_history({
            "applicationId": job["id"],
            "event": "reviewed",
            "status": "needs_info",
            "ats": "greenhouse",
        })
        writer._ensure_coordinator_files()
        self.reference = session["pendingFields"][0]["reference"]
        self.answer_key = answer["key"]
        self.original = self.facade.Store(
            clone_store_root(source, parent / "original"), parent / "legacy.json"
        )
        self.extracted = self.composed(
            clone_store_root(source, parent / "extracted"), parent / "legacy.json"
        )

    def assert_read_parity(self, method, *args):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        expected = getattr(self.original, method)(*args)
        actual = getattr(self.extracted, method)(*args)
        self.assertEqual(actual, expected)
        self.assertEqual(
            before,
            [snapshot_tree(store.root) for store in (self.original, self.extracted)],
        )
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return actual

    def test_exact_plain_mixin_contract_inventory_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["coordinator.attention"],
            {"CoordinatorAttentionMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)
        tree = ast.parse(inspect.getsource(self.leaf))
        imported = {
            node.module
            for node in ast.walk(tree)
            if isinstance(node, ast.ImportFrom) and node.module
        }
        self.assertEqual(imported, {"__future__", "typing"})

    def test_attention_activity_and_pending_detail_are_exact_and_nonmutating(self):
        attention = self.assert_read_parity("list_needs_attention")
        activity = self.assert_read_parity("get_job_activity", "attention-job")
        detail = self.assert_read_parity(
            "pending_answer_detail", "attention-job", self.reference
        )
        self.assertRegex(attention["snapshotSignature"], r"^[a-f0-9]{64}$")
        self.assertGreater(activity["session"]["revision"], 0)
        self.assertLessEqual(activity["session"]["revision"], 2**53 - 1)
        self.assertEqual(
            activity["session"]["pendingInformation"][0]["answerKey"],
            self.answer_key,
        )
        self.assertEqual(detail["value"], "PRIVATE AUTHORIZATION VALUE")
        redacted = json.dumps({"attention": attention, "activity": activity})
        for forbidden in (
            "PRIVATE AUTHORIZATION VALUE",
            "Private authorization question?",
            "Private role",
            "Private company",
        ):
            self.assertNotIn(forbidden, redacted)

    def test_redirect_revision_approval_and_ineligible_projection_match(self):
        answers = self.extracted._load_answers_document()
        answer = answers["answers"][self.answer_key]
        field = {
            "reference": self.reference,
            "answerKey": self.answer_key,
            "state": "missing",
            "sensitive": False,
        }
        eligible = self.extracted._pending_resolution_projection(field, answers)
        self.assertTrue(eligible["resolutionEligible"])
        self.assertEqual(eligible["answerRevision"], answer["revision"])
        self.assertFalse(self.extracted._pending_resolution_projection(
            {**field, "sensitive": True}, answers
        )["resolutionEligible"])
        approval = {
            "reference": self.reference,
            "answerKey": self.answer_key,
            "answerRevision": answer["revision"],
        }
        current = self.extracted._current_session_approvals(
            {"pendingFields": [field], "approvals": [approval]}, answers
        )
        self.assertEqual(current, [approval])
        approval["answerRevision"] += 1
        self.assertEqual(self.extracted._current_session_approvals(
            {"pendingFields": [field], "approvals": [approval]}, answers
        ), [])

    def test_errors_and_runtime_patches_do_not_mutate_store(self):
        before = snapshot_tree(self.extracted.root)
        for args, message in (
            (("missing-job",), "job does not exist"),
            (("attention-job", "invalid"), "pending question reference is invalid"),
            (("attention-job", "pending_" + "0" * 32), "stale"),
        ):
            method = "get_job_activity" if len(args) == 1 else "pending_answer_detail"
            with self.assertRaisesRegex(self.facade.StoreError, message):
                getattr(self.extracted, method)(*args)
            self.assertEqual(snapshot_tree(self.extracted.root), before)

        with mock.patch.object(
            self.facade, "_safe_session_id", wraps=self.facade._safe_session_id
        ) as safe_id:
            self.extracted.get_job_activity("attention-job")
        self.assertGreaterEqual(safe_id.call_count, 1)
        self.assertIn(mock.call("attention-job"), safe_id.call_args_list)

        with mock.patch.object(self.facade, "_canonical_json", return_value="late"):
            expected = int(hashlib.sha256(b"late").hexdigest()[:13], 16) + 1
            self.assertEqual(self.mixin._session_revision({"ignored": True}), expected)

    def test_root_local_reload_does_not_cross_bind_runtime(self):
        other_facade = load_module(name="coordinator_attention_second_root")
        other_leaf = importlib.import_module(
            f"{other_facade._PACKAGE_NAME}.domains.coordinator.attention"
        )
        self.assertIsNot(other_leaf, self.leaf)
        other_leaf._bind_runtime(lambda: vars(other_facade))
        with mock.patch.object(other_facade, "_canonical_json", return_value="other"):
            other_value = other_leaf.CoordinatorAttentionMixin._session_revision({})
        self.assertEqual(
            other_value, int(hashlib.sha256(b"other").hexdigest()[:13], 16) + 1
        )
        self.assertEqual(
            self.mixin._session_revision({}), self.facade.Store._session_revision({})
        )


if __name__ == "__main__":
    unittest.main()
