"""Explicit import, runtime-binding, and mixin order for the Store facade."""

from __future__ import annotations

import importlib
from types import ModuleType
from typing import Any, Callable


_DOMAIN_IMPORTS = (
    ("_profile_domain", "domains.profile", "ProfileStoreMixin"),
    ("_profile_facts_domain", "domains.profile_facts", "ProfileFactsStoreMixin"),
    ("_answer_read_domain", "domains.answers.read", "AnswerReadMixin"),
    ("_answer_mutation_domain", "domains.answers.mutations", "AnswerMutationMixin"),
    ("_answer_merge_domain", "domains.answers.merge", "AnswerMergeMixin"),
    ("_answer_cleanup_domain", "domains.answers.cleanup", "AnswerCleanupMixin"),
    ("_job_crud_domain", "domains.jobs.crud", "JobCrudMixin"),
    ("_job_overview_domain", "domains.jobs.overview", "JobOverviewMixin"),
    ("_job_upsert_domain", "domains.jobs.upsert", "JobUpsertMixin"),
    ("_job_legacy_domain", "domains.jobs.legacy", "JobLegacyMixin"),
    (
        "_coordinator_persistence_domain",
        "domains.coordinator.persistence",
        "CoordinatorPersistenceMixin",
    ),
    (
        "_coordinator_claims_domain",
        "domains.coordinator.claims",
        "CoordinatorClaimsMixin",
    ),
    (
        "_coordinator_attention_domain",
        "domains.coordinator.attention",
        "CoordinatorAttentionMixin",
    ),
    (
        "_coordinator_progress_domain",
        "domains.coordinator.progress",
        "CoordinatorProgressMixin",
    ),
    (
        "_coordinator_approvals_domain",
        "domains.coordinator.approvals",
        "CoordinatorApprovalsMixin",
    ),
    ("_resumes_storage_domain", "domains.resumes.storage", "ResumeStorageMixin"),
    ("_resumes_read_domain", "domains.resumes.read", "ResumeReadMixin"),
    (
        "_resumes_mutations_domain",
        "domains.resumes.mutations",
        "ResumeMutationMixin",
    ),
    (
        "_resumes_lifecycle_domain",
        "domains.resumes.lifecycle",
        "ResumeLifecycleMixin",
    ),
    (
        "_extractions_journal_domain",
        "domains.extractions.journal",
        "ExtractionJournalMixin",
    ),
    (
        "_extractions_requests_domain",
        "domains.extractions.requests",
        "ExtractionRequestMixin",
    ),
    (
        "_extractions_proposals_domain",
        "domains.extractions.proposals",
        "ExtractionProposalMixin",
    ),
    ("_sessions_history_domain", "domains.sessions.history", "SessionHistoryMixin"),
    (
        "_sessions_readiness_domain",
        "domains.sessions.readiness",
        "SessionReadinessMixin",
    ),
    (
        "_sessions_document_domain",
        "domains.sessions.document",
        "SessionDocumentMixin",
    ),
    (
        "_sessions_lifecycle_domain",
        "domains.sessions.lifecycle",
        "SessionLifecycleMixin",
    ),
    (
        "_accounts_email_execution_domain",
        "domains.accounts.email_execution",
        "EmailExecutionMixin",
    ),
    (
        "_accounts_email_scope_domain",
        "domains.accounts.email_scope",
        "EmailScopeMixin",
    ),
    (
        "_accounts_operations_domain",
        "domains.accounts.operations",
        "AccountOperationMixin",
    ),
    (
        "_accounts_password_execution_domain",
        "domains.accounts.password_execution",
        "PasswordExecutionMixin",
    ),
    (
        "_accounts_registry_domain",
        "domains.accounts.registry",
        "AccountRegistryMixin",
    ),
    (
        "_accounts_settings_domain",
        "domains.accounts.settings",
        "AccountSettingsMixin",
    ),
    (
        "_accounts_synthetic_domain",
        "domains.accounts.synthetic",
        "SyntheticAccountMixin",
    ),
    (
        "_accounts_trusted_fill_domain",
        "domains.accounts.trusted_fill",
        "TrustedFillMixin",
    ),
    ("_startup_domain", "domains.startup", "StartupMixin"),
)

_RUNTIME_BINDING_ORDER = (
    "_accounts_email_execution_domain",
    "_accounts_email_scope_domain",
    "_accounts_operations_domain",
    "_accounts_password_execution_domain",
    "_accounts_registry_domain",
    "_accounts_settings_domain",
    "_accounts_synthetic_domain",
    "_accounts_trusted_fill_domain",
    "_sessions_history_domain",
    "_sessions_readiness_domain",
    "_sessions_document_domain",
    "_sessions_lifecycle_domain",
    "_resumes_storage_domain",
    "_resumes_read_domain",
    "_resumes_mutations_domain",
    "_resumes_lifecycle_domain",
    "_extractions_journal_domain",
    "_extractions_requests_domain",
    "_extractions_proposals_domain",
    "_answer_read_domain",
    "_answer_mutation_domain",
    "_answer_merge_domain",
    "_answer_cleanup_domain",
    "_job_upsert_domain",
    "_job_legacy_domain",
    "_coordinator_persistence_domain",
    "_coordinator_claims_domain",
    "_coordinator_attention_domain",
    "_coordinator_progress_domain",
    "_coordinator_approvals_domain",
    "_startup_domain",
)


def load_domains(
    package_name: str,
    runtime_provider: Callable[[], dict[str, Any]],
) -> tuple[dict[str, ModuleType], tuple[type, ...]]:
    """Load root-local domains, bind live runtime leaves, and return Store mixins."""

    domains: dict[str, ModuleType] = {}
    mixins: list[type] = []
    for alias, module_name, mixin_name in _DOMAIN_IMPORTS:
        module = importlib.import_module(f"{package_name}.{module_name}")
        domains[alias] = module
        mixins.append(getattr(module, mixin_name))
    for alias in _RUNTIME_BINDING_ORDER:
        domains[alias]._bind_runtime(runtime_provider)
    return domains, tuple(mixins)


__all__ = ["load_domains"]
