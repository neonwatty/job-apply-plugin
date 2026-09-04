from __future__ import annotations

import ast
import importlib
import inspect
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.support.store_facade_contract import ROOT, SCRIPT, load_module


ANSWER_METHODS = {
    "_reject_answer_collisions", "put_answer", "update_answer", "observe_answer",
    "review_answer", "trash_answer", "restore_answer", "_set_answer_deleted",
    "delete_answer", "_merged_observation_field", "_apply_answer_merge_locked",
    "_rewrite_session_answer_key", "merge_answers",
    "_preview_answer_cleanup_document", "preview_answer_cleanup",
    "approve_answer_cleanup",
}
JOB_METHODS = {
    "_load_jobs_document", "_require_active_resume", "create_job", "get_job",
    "list_jobs", "update_job", "transition_job", "trash_job", "restore_job",
    "_set_job_deleted", "delete_job", "_task_job_projection", "task_snapshot",
    "intake_task_job", "select_task_job_ready", "owner_beta_overview",
    "_owner_beta_overview_locked", "_preflight_job_record", "preflight_job",
    "_job_upsert_payload", "_canonical_upsert_input", "_upsert_token",
    "_deterministic_job_id", "_normalize_upsert_item", "_source_identity",
    "_plan_job_upsert", "_upsert_result", "preview_job_upsert",
    "commit_job_upsert", "_read_legacy_search_file",
    "_parse_legacy_search_report", "_discover_legacy_jobs",
    "_migration_jobs_snapshot", "_selected_legacy_items", "_legacy_jobs_token",
    "_plan_legacy_jobs", "_legacy_result", "preview_legacy_jobs",
    "commit_legacy_jobs",
}
HELPERS = {
    "_job_origin", "_nonempty_job_value", "_normalized_job_source",
    "_job_observation_source", "_job_field_provenance",
    "_agent_may_update_job_field", "_migration_may_update_job_field",
    "_reject_supplied_migration_provenance",
    "_validate_migration_provenance_replacement", "_stamp_job_provenance",
}


class StoreWaveBIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_wave_b_integration")
        package = cls.facade._PACKAGE_NAME
        cls.modules = (
            importlib.import_module(f"{package}.domains.answers.mutations"),
            importlib.import_module(f"{package}.domains.answers.merge"),
            importlib.import_module(f"{package}.domains.answers.cleanup"),
            importlib.import_module(f"{package}.domains.jobs.crud"),
            importlib.import_module(f"{package}.domains.jobs.overview"),
            importlib.import_module(f"{package}.domains.jobs.upsert"),
            importlib.import_module(f"{package}.domains.jobs.legacy"),
        )
        cls.mixins = tuple(
            getattr(module, name)
            for module, name in zip(cls.modules, (
                "AnswerMutationMixin", "AnswerMergeMixin", "AnswerCleanupMixin",
                "JobCrudMixin", "JobOverviewMixin", "JobUpsertMixin",
                "JobLegacyMixin",
            ))
        )

    def test_exact_mro_method_ownership_and_extracted_counts(self):
        self.assertEqual((len(ANSWER_METHODS), len(JOB_METHODS)), (16, 39))
        expected = (
            self.facade.Store,
            self.facade._profile_domain.ProfileStoreMixin,
            self.facade._profile_facts_domain.ProfileFactsStoreMixin,
            self.facade._answer_read_domain.AnswerReadMixin,
            *self.mixins,
            self.facade._coordinator_persistence_domain.CoordinatorPersistenceMixin,
            self.facade._coordinator_claims_domain.CoordinatorClaimsMixin,
            self.facade._coordinator_attention_domain.CoordinatorAttentionMixin,
            self.facade._coordinator_progress_domain.CoordinatorProgressMixin,
            self.facade._coordinator_approvals_domain.CoordinatorApprovalsMixin,
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
        self.assertEqual(self.facade.Store.__mro__[:len(expected)], expected)
        owned = (
            ANSWER_METHODS & set(vars(self.mixins[0])),
            ANSWER_METHODS & set(vars(self.mixins[1])),
            ANSWER_METHODS & set(vars(self.mixins[2])),
            JOB_METHODS & set(vars(self.mixins[3])),
            JOB_METHODS & set(vars(self.mixins[4])),
            JOB_METHODS & set(vars(self.mixins[5])),
            JOB_METHODS & set(vars(self.mixins[6])),
        )
        self.assertEqual(set().union(*owned), ANSWER_METHODS | JOB_METHODS)
        self.assertEqual(sum(map(len, owned)), 55)
        for mixin, names in zip(self.mixins, owned):
            for name in names:
                with self.subTest(name=name):
                    self.assertIs(
                        inspect.getattr_static(self.facade.Store, name),
                        inspect.getattr_static(mixin, name),
                    )

    def test_facade_has_no_duplicate_methods_or_job_helper_bodies(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        top_functions = {
            node.name for node in tree.body if isinstance(node, ast.FunctionDef)
        }
        store = next(
            node for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "Store"
        )
        direct = {
            node.name for node in store.body if isinstance(node, ast.FunctionDef)
        }
        self.assertFalse((ANSWER_METHODS | JOB_METHODS) & direct)
        self.assertFalse(HELPERS & top_functions)
        for name in HELPERS:
            with self.subTest(name=name):
                self.assertIs(
                    getattr(self.facade, name),
                    getattr(self.facade._normalization, name),
                )

    def test_late_runtime_binding_and_facade_operations_are_live(self):
        for module in (*self.modules[:3], *self.modules[5:]):
            self.assertIs(module._RUNTIME_PROVIDER(), vars(self.facade))
        with tempfile.TemporaryDirectory() as temporary:
            store = self.facade.Store(Path(temporary) / "store")
            fixed = "2026-09-04T20:00:00Z"
            with mock.patch.object(self.facade, "utc_now", return_value=fixed):
                answer = store.put_answer({
                    "question": "Are you authorized?",
                    "state": "confirmed",
                    "value": "Yes",
                })
                job = store.create_job({
                    "id": "job-one",
                    "url": "HTTPS://Example.invalid:443/jobs/1#apply",
                    "role": "Engineer",
                })
            self.assertEqual(answer["createdAt"], fixed)
            self.assertEqual(job["createdAt"], fixed)
            self.assertEqual(job["normalizedUrl"], "https://example.invalid/jobs/1")
            self.assertEqual(store.get_job("job-one"), job)
            self.assertEqual(store.list_jobs(), [job])


if __name__ == "__main__":
    unittest.main()
