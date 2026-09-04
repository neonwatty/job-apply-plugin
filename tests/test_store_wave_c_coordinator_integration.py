from __future__ import annotations

import ast
import importlib
import inspect
import json
import tempfile
import typing
import unittest
from pathlib import Path

from tests.support.store_domain_contract import assert_domain_import_direction
from tests.support.store_facade_contract import ROOT, SCRIPT, load_module


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHOD_GROUPS = (
    (
        "_ensure_coordinator_files_locked", "_ensure_coordinator_files",
        "_load_coordinator_document", "_load_coordinator_journal",
        "_history_event_for_operation", "_history_event_is_idempotent_locked",
        "_append_history_event_idempotent_locked",
        "_repair_pending_history_tail_locked", "_roll_forward_locked",
        "_commit_coordinator_operation_locked",
    ),
    (
        "_token_hash", "_new_claim_token", "_public_claim", "_parse_time",
        "claim_status", "_require_claim_locked", "_require_job_unclaimed_locked",
        "acquire_ready_job", "restart_reviewed_job", "heartbeat_claim",
        "recover_claim",
    ),
    (
        "list_needs_attention", "_needs_attention_locked", "get_job_activity",
        "_session_revision", "_pending_resolution_projection",
        "_current_session_approvals", "pending_answer_detail",
    ),
    ("resolve_pending_answer", "save_claim_progress", "handoff_claimed_job"),
    ("preview_grouped_approval", "approve_grouped_approval"),
)


class StoreWaveCCoordinatorIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_wave_c_coordinator_integration")
        package = cls.facade._PACKAGE_NAME
        cls.modules = tuple(
            importlib.import_module(f"{package}.domains.coordinator.{name}")
            for name in ("persistence", "claims", "attention", "progress", "approvals")
        )
        cls.mixins = tuple(
            getattr(module, class_name)
            for module, class_name in zip(
                cls.modules,
                (
                    "CoordinatorPersistenceMixin", "CoordinatorClaimsMixin",
                    "CoordinatorAttentionMixin", "CoordinatorProgressMixin",
                    "CoordinatorApprovalsMixin",
                ),
            )
        )

    def test_exact_mro_ownership_count_hints_and_direction(self):
        expected_prefix = (
            self.facade.Store,
            self.facade._profile_domain.ProfileStoreMixin,
            self.facade._profile_facts_domain.ProfileFactsStoreMixin,
            self.facade._answer_read_domain.AnswerReadMixin,
            self.facade._answer_mutation_domain.AnswerMutationMixin,
            self.facade._answer_merge_domain.AnswerMergeMixin,
            self.facade._answer_cleanup_domain.AnswerCleanupMixin,
            self.facade._job_crud_domain.JobCrudMixin,
            self.facade._job_overview_domain.JobOverviewMixin,
            self.facade._job_upsert_domain.JobUpsertMixin,
            self.facade._job_legacy_domain.JobLegacyMixin,
            *self.mixins,
            self.facade._resumes_storage_domain.ResumeStorageMixin,
            self.facade._resumes_read_domain.ResumeReadMixin,
            self.facade._resumes_mutations_domain.ResumeMutationMixin,
            self.facade._resumes_lifecycle_domain.ResumeLifecycleMixin,
            self.facade._extractions_journal_domain.ExtractionJournalMixin,
            self.facade._extractions_requests_domain.ExtractionRequestMixin,
            self.facade._extractions_proposals_domain.ExtractionProposalMixin,
            self.facade._sessions_history_domain.SessionHistoryMixin,
            self.facade._sessions_readiness_domain.SessionReadinessMixin,
            self.facade._sessions_document_domain.SessionDocumentMixin,
            self.facade._sessions_lifecycle_domain.SessionLifecycleMixin,
            self.facade._base.StoreBase,
        )
        self.assertEqual(self.facade.Store.__mro__[: len(expected_prefix)], expected_prefix)
        self.assertEqual(sum(map(len, METHOD_GROUPS)), 33)
        self.assertEqual(len(set().union(*(set(group) for group in METHOD_GROUPS))), 33)
        for mixin, names in zip(self.mixins, METHOD_GROUPS):
            self.assertEqual(sum(mixin is owner for owner in self.facade.Store.__mro__), 1)
            for name in names:
                with self.subTest(mixin=mixin.__name__, method=name):
                    self.assertIs(
                        inspect.getattr_static(self.facade.Store, name),
                        inspect.getattr_static(mixin, name),
                    )
        for name in METHOD_GROUPS[-1]:
            self.assertEqual(
                typing.get_type_hints(getattr(self.facade.Store, name))["return"],
                dict[str, typing.Any],
            )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_facade_has_no_duplicates_and_runtime_is_root_local(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        store = next(
            node for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "Store"
        )
        direct = {
            node.name for node in store.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        self.assertFalse(set().union(*(set(group) for group in METHOD_GROUPS)) & direct)
        for module in self.modules:
            self.assertTrue(module.__name__.startswith(self.facade._PACKAGE_NAME + "."))
            self.assertIs(module._RUNTIME_PROVIDER(), vars(self.facade))

    def test_facade_claim_progress_attention_recovery_and_approval_contracts(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            store = self.facade.Store(parent / "store", parent / "legacy.json")
            store.initialize()
            store.replace_profile(
                {"firstName": "Ada"}, store.inspect_profile()["revision"], "user"
            )
            resume_path = parent / "resume.pdf"
            resume_path.write_bytes(b"%PDF-1.7\nwave-c-integration")
            store.create_resume({
                "id": "default-resume", "label": "Default", "path": str(resume_path),
            })
            job = store.create_job({
                "id": "coordinator-job",
                "url": "https://example.com/jobs/coordinator",
                "role": "Engineer",
                "ats": "greenhouse",
            })
            ready = store.transition_job(job["id"], "ready", job["revision"])
            answer = store.put_answer({
                "key": "authorization.answer",
                "question": "Authorized to work?",
                "state": "confirmed",
                "value": "PRIVATE-WAVE-C-VALUE",
                "scope": {"ats": "greenhouse"},
                "fieldClass": "authorization",
            })
            acquired = store.acquire_ready_job(
                ready["id"], "integration-agent", ready["revision"]
            )
            pending = {
                "status": "active",
                "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Authorized to work?",
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
                }],
            }
            saved = store.save_claim_progress(ready["id"], acquired["token"], pending)
            self.assertEqual(saved["status"], "active")
            handed = store.handoff_claimed_job(
                ready["id"], acquired["token"], "needs_info", pending,
                acquired["job"]["revision"],
            )
            self.assertEqual(handed["job"]["status"], "needs_info")
            self.assertIsNone(store.claim_status()["claim"])
            self.assertIsNone(store._load_coordinator_journal()["operation"])
            attention = store.list_needs_attention()
            self.assertEqual(attention["items"][0]["reasonCode"], "needs_information")
            activity = store.get_job_activity(ready["id"])
            reference = activity["session"]["pendingInformation"][0]["reference"]
            decisions = [{
                "reference": reference,
                "answerKey": answer["key"],
                "currentUse": True,
                "remember": False,
                "policyMode": "strict",
                "useAuthority": "accepted_record",
                "allowedSensitiveFieldClasses": [],
            }]
            preview = store.preview_grouped_approval(
                ready["id"], handed["job"]["revision"],
                activity["session"]["revision"], decisions,
            )
            self.assertFalse(preview["mutated"])
            approved = store.approve_grouped_approval(
                ready["id"], handed["job"]["revision"],
                activity["session"]["revision"], decisions,
                preview["previewToken"], owner_confirmed=True,
            )
            self.assertTrue(approved["approved"])
            coordinator_projection = "".join(
                path.read_text(encoding="utf-8")
                for path in (
                    store.coordinator_path,
                    store.coordinator_journal_path,
                    store._session_path(ready["id"]),
                )
            )
            self.assertNotIn("PRIVATE-WAVE-C-VALUE", coordinator_projection)


if __name__ == "__main__":
    unittest.main()
