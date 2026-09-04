from __future__ import annotations

import importlib
import inspect
import json
import shutil
import tempfile
import types
import typing
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
METHODS = ("preview_grouped_approval", "approve_grouped_approval")


class CoordinatorApprovalsExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="coordinator_approvals_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.coordinator.approvals"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.CoordinatorApprovalsMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)
        source = self.parent / "source"
        writer = self.facade.Store(source, self.parent / "legacy.json")
        writer.initialize()
        writer.replace_profile(
            {"firstName": "Ada"},
            writer.inspect_profile()["revision"],
            "user",
        )
        resume_path = self.parent / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\ngrouped approval")
        writer.create_resume({
            "id": "default-resume",
            "label": "Default",
            "path": str(resume_path),
        })
        job = writer.create_job({
            "id": "approval-job",
            "url": "https://example.com/jobs/approval",
            "role": "Engineer",
            "company": "Acme",
            "ats": "greenhouse",
        })
        ready = writer.transition_job(job["id"], "ready", job["revision"])
        self.answers = [
            writer.put_answer({
                "question": f"Stored field {index}?",
                "state": "confirmed",
                "value": f"PRIVATE APPROVAL VALUE {index}",
                "scope": {"ats": "greenhouse"},
                "fieldClass": "authorization",
            })
            for index in (1, 2)
        ]
        acquired = writer.acquire_ready_job(
            ready["id"], "approval-agent", ready["revision"]
        )
        handed = writer.handoff_claimed_job(
            ready["id"],
            acquired["token"],
            "needs_info",
            {
                "status": "active",
                "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [
                    {
                        "question": f"Stored field {index}?",
                        "state": "missing",
                        "answerKey": answer["key"],
                        "sensitive": False,
                        "fieldClass": "authorization",
                        "scope": {"ats": "greenhouse"},
                        "matchConfidence": "exact",
                        "matchReasonCodes": [
                            "match_exact", "scope_match", "field_class_match",
                            "sensitivity_match",
                        ],
                    }
                    for index, answer in enumerate(self.answers, 1)
                ],
            },
            acquired["job"]["revision"],
        )
        activity = writer.get_job_activity(ready["id"])
        references = [
            field["reference"]
            for field in activity["session"]["pendingInformation"]
        ]
        self.job_id = ready["id"]
        self.job_revision = handed["job"]["revision"]
        self.session_revision = activity["session"]["revision"]
        self.decisions = [
            {
                "reference": reference,
                "answerKey": answer["key"],
                "currentUse": True,
                "remember": False,
                "policyMode": "strict",
                "useAuthority": "accepted_record",
                "allowedSensitiveFieldClasses": [],
            }
            for reference, answer in zip(references, self.answers)
        ]
        self.original = self.facade.Store(
            clone_store_root(source, self.parent / "original"),
            self.parent / "legacy.json",
        )
        self.extracted = self.composed(
            clone_store_root(source, self.parent / "extracted"),
            self.parent / "legacy.json",
        )

    def preview(self, store, decisions=None):
        return store.preview_grouped_approval(
            self.job_id,
            self.job_revision,
            self.session_revision,
            self.decisions if decisions is None else decisions,
        )

    def test_exact_plain_mixin_contract_direction_and_resolved_hints(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["coordinator.approvals"],
            {"CoordinatorApprovalsMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)
        for name in METHODS:
            hints = typing.get_type_hints(getattr(self.mixin, name))
            self.assertEqual(hints["return"], dict[str, typing.Any])

    def test_preview_is_deterministic_value_free_and_differential(self):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        originals = [self.preview(store) for store in (self.original, self.extracted)]
        reordered = self.preview(self.extracted, list(reversed(self.decisions)))
        self.assertEqual(originals[0], originals[1])
        self.assertEqual(originals[1], reordered)
        self.assertEqual(
            before,
            [snapshot_tree(store.root) for store in (self.original, self.extracted)],
        )
        serialized = json.dumps(originals[0])
        self.assertNotIn("PRIVATE APPROVAL VALUE", serialized)
        self.assertTrue(
            originals[0]["previewToken"].startswith("grouped-approval-v1.")
        )
        self.assertFalse(originals[0]["mutated"])

    def test_approve_matches_oracle_exact_bytes_and_modes(self):
        previews = [self.preview(store) for store in (self.original, self.extracted)]
        results = [
            store.approve_grouped_approval(
                self.job_id,
                self.job_revision,
                self.session_revision,
                self.decisions,
                preview["previewToken"],
                owner_confirmed=True,
            )
            for store, preview in zip((self.original, self.extracted), previews)
        ]
        self.assertEqual(results[0], results[1])
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        serialized = self.extracted._session_path(self.job_id).read_text()
        self.assertNotIn("PRIVATE APPROVAL VALUE", serialized)

    def test_tamper_invalid_and_policy_failure_are_private_noops(self):
        before = snapshot_tree(self.extracted.root)
        preview = self.preview(self.extracted)
        with self.assertRaisesRegex(self.facade.StoreError, "preview is stale"):
            self.extracted.approve_grouped_approval(
                self.job_id,
                self.job_revision,
                self.session_revision,
                self.decisions,
                preview["previewToken"] + "tampered",
                owner_confirmed=True,
            )
        self.assertEqual(snapshot_tree(self.extracted.root), before)
        with self.assertRaisesRegex(self.facade.StoreError, "owner confirmation"):
            self.extracted.approve_grouped_approval(
                self.job_id,
                self.job_revision,
                self.session_revision,
                self.decisions,
                preview["previewToken"],
            )
        with mock.patch.object(
            self.facade.ANSWER_MATCH_MODULE,
            "evaluate_reuse",
            side_effect=RuntimeError("PRIVATE POLICY FAILURE"),
        ):
            with self.assertRaisesRegex(
                self.facade.StoreError, "grouped approval policy is invalid"
            ) as raised:
                self.preview(self.extracted)
        self.assertNotIn("PRIVATE POLICY FAILURE", str(raised.exception))
        self.assertEqual(snapshot_tree(self.extracted.root), before)

    def test_answer_revision_race_is_rechecked_without_session_mutation(self):
        preview = self.preview(self.extracted)
        session_before = self.extracted._session_path(self.job_id).read_bytes()
        original_preview = self.extracted.preview_grouped_approval

        def preview_then_change(*args, **kwargs):
            result = original_preview(*args, **kwargs)
            current = self.extracted.get_answer(self.answers[0]["key"])
            self.extracted.update_answer(
                current["key"],
                {"aliases": ["authorization eligibility"]},
                current["revision"],
            )
            return result

        with mock.patch.object(
            self.extracted,
            "preview_grouped_approval",
            side_effect=preview_then_change,
        ), self.assertRaisesRegex(
            self.facade.StoreError, "grouped approval state changed"
        ):
            self.extracted.approve_grouped_approval(
                self.job_id,
                self.job_revision,
                self.session_revision,
                self.decisions,
                preview["previewToken"],
                owner_confirmed=True,
            )
        self.assertEqual(
            self.extracted._session_path(self.job_id).read_bytes(), session_before
        )

    def test_runtime_binding_is_canonical_and_root_local(self):
        calls = []
        original_canonical = self.facade._canonical_json

        def canonical(value):
            calls.append(value)
            return original_canonical(value)

        with mock.patch.object(self.facade, "_canonical_json", side_effect=canonical):
            self.preview(self.extracted)
        self.assertGreaterEqual(len(calls), 1)

        other_root = self.parent / "other-code-root"
        shutil.copytree(ROOT / "scripts", other_root / "scripts")
        other = load_module(
            script=other_root / "scripts" / "job-apply-store.py",
            name="coordinator_approvals_second_root",
        )
        other_leaf = importlib.import_module(
            f"{other._PACKAGE_NAME}.domains.coordinator.approvals"
        )
        self.assertIsNot(other_leaf, self.leaf)
        self.assertNotEqual(other._PACKAGE_NAME, self.facade._PACKAGE_NAME)
        other_leaf._bind_runtime(lambda: vars(other))
        sentinel = types.SimpleNamespace(evaluate_reuse=mock.Mock())
        with mock.patch.object(other, "ANSWER_MATCH_MODULE", sentinel):
            self.assertIs(other_leaf._late("ANSWER_MATCH_MODULE"), sentinel)
            self.assertIsNot(self.leaf._late("ANSWER_MATCH_MODULE"), sentinel)
        reloaded = importlib.reload(other_leaf)
        self.assertIs(
            reloaded._late("_canonical_json"),
            reloaded._CANONICAL_RUNTIME["_canonical_json"],
        )


if __name__ == "__main__":
    unittest.main()
