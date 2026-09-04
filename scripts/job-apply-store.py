#!/usr/bin/env python3
"""Local, versioned storage helper for the Job Apply plugin.

All successful commands emit JSON on stdout. Errors are deliberately terse and
never include stored values. The helper uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import hmac
import importlib
import importlib.util
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import unicodedata
import uuid
import zipfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


_IMPLEMENTATION_ROOT = Path(__file__).with_name("job_apply_store").resolve()
_PACKAGE_NAME = "_job_apply_store_parts_" + hashlib.sha256(
    str(_IMPLEMENTATION_ROOT).encode("utf-8")
).hexdigest()
_COMPANION_PACKAGE_NAME = "_job_apply_store_companions_" + hashlib.sha256(
    str(Path(__file__).resolve().parent).encode("utf-8")
).hexdigest()
_ROOT_PRIVATE_PACKAGE_NAMES = (
    _PACKAGE_NAME,
    _COMPANION_PACKAGE_NAME,
    "_job_apply_account_runtime_" + hashlib.sha256(
        str(Path(__file__).resolve().parent).encode("utf-8")
    ).hexdigest(),
    "_job_apply_answer_matching_parts_" + hashlib.sha256(
        str(Path(__file__).with_name("job_apply_answer_matching").resolve()).encode("utf-8")
    ).hexdigest(),
)


def _remove_root_private_packages() -> None:
    for package_name in _ROOT_PRIVATE_PACKAGE_NAMES:
        for module_name in tuple(sys.modules):
            if module_name == package_name or module_name.startswith(package_name + "."):
                del sys.modules[module_name]


def _load_implementation_package() -> Any:
    """Load a fresh, root-local implementation package for this facade."""

    _remove_root_private_packages()
    spec = importlib.util.spec_from_file_location(
        _PACKAGE_NAME,
        _IMPLEMENTATION_ROOT / "__init__.py",
        submodule_search_locations=[str(_IMPLEMENTATION_ROOT)],
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("Store implementation is unavailable")
    package = importlib.util.module_from_spec(spec)
    sys.modules[_PACKAGE_NAME] = package
    try:
        spec.loader.exec_module(package)
    except BaseException:
        _remove_root_private_packages()
        raise
    return package


_implementation = _load_implementation_package()
_constants = _implementation.constants
_errors = _implementation.errors
_io = _implementation.io
_normalization = _implementation.normalization
_base = _implementation.base
_profile_validation = _implementation.profile_answers
_session_validation = _implementation.sessions
_job_resume_validation = _implementation.jobs_resumes
_extraction_validation = _implementation.extraction
_account_validation = _implementation.accounts

try:
    _profile_domain = importlib.import_module(f"{_PACKAGE_NAME}.domains.profile")
    _profile_facts_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.profile_facts"
    )
    _answer_read_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.answers.read"
    )
    _answer_mutation_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.answers.mutations"
    )
    _answer_merge_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.answers.merge"
    )
    _answer_cleanup_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.answers.cleanup"
    )
    _job_crud_domain = importlib.import_module(f"{_PACKAGE_NAME}.domains.jobs.crud")
    _job_overview_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.jobs.overview"
    )
    _job_upsert_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.jobs.upsert"
    )
    _job_legacy_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.jobs.legacy"
    )
    _coordinator_persistence_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.coordinator.persistence"
    )
    _coordinator_claims_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.coordinator.claims"
    )
    _coordinator_attention_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.coordinator.attention"
    )
    _coordinator_progress_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.coordinator.progress"
    )
    _coordinator_approvals_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.coordinator.approvals"
    )
    _resumes_storage_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.resumes.storage"
    )
    _resumes_read_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.resumes.read"
    )
    _resumes_mutations_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.resumes.mutations"
    )
    _resumes_lifecycle_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.resumes.lifecycle"
    )
    _extractions_journal_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.extractions.journal"
    )
    _extractions_requests_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.extractions.requests"
    )
    _extractions_proposals_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.extractions.proposals"
    )
    _sessions_history_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.sessions.history"
    )
    _sessions_readiness_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.sessions.readiness"
    )
    _sessions_document_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.sessions.document"
    )
    _sessions_lifecycle_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.sessions.lifecycle"
    )
    _accounts_email_execution_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.email_execution"
    )
    _accounts_email_scope_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.email_scope"
    )
    _accounts_operations_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.operations"
    )
    _accounts_password_execution_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.password_execution"
    )
    _accounts_registry_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.registry"
    )
    _accounts_settings_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.settings"
    )
    _accounts_synthetic_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.synthetic"
    )
    _accounts_trusted_fill_domain = importlib.import_module(
        f"{_PACKAGE_NAME}.domains.accounts.trusted_fill"
    )
    _startup_domain = importlib.import_module(f"{_PACKAGE_NAME}.domains.startup")
    _startup_domain._bind_runtime(lambda: globals())
    _cli_parser = importlib.import_module(f"{_PACKAGE_NAME}.cli_parser")
    _cli_dispatch = importlib.import_module(f"{_PACKAGE_NAME}.cli_dispatch")
    for _runtime_domain in (
        _accounts_email_execution_domain,
        _accounts_email_scope_domain,
        _accounts_operations_domain,
        _accounts_password_execution_domain,
        _accounts_registry_domain,
        _accounts_settings_domain,
        _accounts_synthetic_domain,
        _accounts_trusted_fill_domain,
        _sessions_history_domain,
        _sessions_readiness_domain,
        _sessions_document_domain,
        _sessions_lifecycle_domain,
        _resumes_storage_domain,
        _resumes_read_domain,
        _resumes_mutations_domain,
        _resumes_lifecycle_domain,
        _extractions_journal_domain,
        _extractions_requests_domain,
        _extractions_proposals_domain,

        _answer_read_domain,
        _answer_mutation_domain,
        _answer_merge_domain,
        _answer_cleanup_domain,
        _job_upsert_domain,
        _job_legacy_domain,
        _coordinator_persistence_domain,
        _coordinator_claims_domain,
        _coordinator_attention_domain,
        _coordinator_progress_domain,
        _coordinator_approvals_domain,
    ):
        _runtime_domain._bind_runtime(lambda: globals())
except BaseException:
    _remove_root_private_packages()
    raise

SCHEMA_VERSION = _constants.SCHEMA_VERSION
STORE_ENV = _constants.STORE_ENV
ANSWER_STATES = _constants.ANSWER_STATES
ANSWER_REVIEW_STATUSES = _constants.ANSWER_REVIEW_STATUSES
SENSITIVITY_LEVELS = _constants.SENSITIVITY_LEVELS
HISTORY_EVENTS = _constants.HISTORY_EVENTS
HISTORY_EVENT_IDENTIFIER = _constants.HISTORY_EVENT_IDENTIFIER
SESSION_STATUSES = _constants.SESSION_STATUSES
ATTENTION_BLOCKER_TYPES = _constants.ATTENTION_BLOCKER_TYPES
READINESS_EVIDENCE_KINDS = _constants.READINESS_EVIDENCE_KINDS
BROWSER_HANDOFF_STATES = _constants.BROWSER_HANDOFF_STATES
READINESS_BLOCKER_CODES = _constants.READINESS_BLOCKER_CODES
AGENT_BLOCKER_CODES = _constants.AGENT_BLOCKER_CODES
AGENT_BLOCKER_TYPE_BY_CODE = _constants.AGENT_BLOCKER_TYPE_BY_CODE
ATTENTION_BLOCKER_CODES = _constants.ATTENTION_BLOCKER_CODES
BROWSER_HANDOFF_REASON_CODES = _constants.BROWSER_HANDOFF_REASON_CODES
APPROVAL_POLICY_MODES = _constants.APPROVAL_POLICY_MODES
APPROVAL_USE_AUTHORITIES = _constants.APPROVAL_USE_AUTHORITIES
READINESS_ASSERTION_NAMES = _constants.READINESS_ASSERTION_NAMES
JOB_STATUSES = _constants.JOB_STATUSES
JOB_CLOSED_OUTCOMES = _constants.JOB_CLOSED_OUTCOMES
JOB_ORIGINS = _constants.JOB_ORIGINS
JOB_PROVENANCE_ORIGINS = _constants.JOB_PROVENANCE_ORIGINS
JOB_INGEST_FIELDS = _constants.JOB_INGEST_FIELDS
JOB_TRANSITIONS = _constants.JOB_TRANSITIONS
FACT_SOURCES = _constants.FACT_SOURCES
FACT_GROUP_ID = _constants.FACT_GROUP_ID
FACT_GROUP_MAX_PATHS = _constants.FACT_GROUP_MAX_PATHS
PROFILE_NAMED_TOP_LEVEL = _constants.PROFILE_NAMED_TOP_LEVEL
REPLAY_TRANSITIONS = _constants.REPLAY_TRANSITIONS
REPLAY_ATS = _constants.REPLAY_ATS
SESSION_ID = _constants.SESSION_ID
PENDING_REFERENCE = _constants.PENDING_REFERENCE
LEGACY_PENDING_FIELD_KEYS = _constants.LEGACY_PENDING_FIELD_KEYS
_ATS_UNSET = _constants._ATS_UNSET
CLAIM_LEASE_SECONDS = _constants.CLAIM_LEASE_SECONDS
CLAIM_HEARTBEAT_SECONDS = _constants.CLAIM_HEARTBEAT_SECONDS
OVERVIEW_DIGEST_CACHE_SECONDS = _constants.OVERVIEW_DIGEST_CACHE_SECONDS
LEGACY_SEARCH_ROOT = _constants.LEGACY_SEARCH_ROOT
LEGACY_SEARCH_MAX_FILES = _constants.LEGACY_SEARCH_MAX_FILES
LEGACY_SEARCH_MAX_FILE_BYTES = _constants.LEGACY_SEARCH_MAX_FILE_BYTES
LEGACY_SEARCH_MAX_TOTAL_BYTES = _constants.LEGACY_SEARCH_MAX_TOTAL_BYTES
LEGACY_SEARCH_MAX_ENTRIES = _constants.LEGACY_SEARCH_MAX_ENTRIES
RESUME_MAX_BYTES = _constants.RESUME_MAX_BYTES
UPLOAD_RECOVERY_GRACE_SECONDS = _constants.UPLOAD_RECOVERY_GRACE_SECONDS
RESUME_MEDIA_TYPES = _constants.RESUME_MEDIA_TYPES
EXTRACTION_MAX_BYTES = _constants.EXTRACTION_MAX_BYTES
EXTRACTION_MAX_DEPTH = _constants.EXTRACTION_MAX_DEPTH
EXTRACTION_MAX_LEAVES = _constants.EXTRACTION_MAX_LEAVES
EXTRACTION_MAX_STRING = _constants.EXTRACTION_MAX_STRING
EXTRACTION_STATUSES = _constants.EXTRACTION_STATUSES
EXTRACTION_DECISIONS = _constants.EXTRACTION_DECISIONS
EXTRACTION_REQUEST_STATUSES = _constants.EXTRACTION_REQUEST_STATUSES
EXTRACTION_REQUEST_FAILURE_REASONS = _constants.EXTRACTION_REQUEST_FAILURE_REASONS
EMAIL_PATTERN = _constants.EMAIL_PATTERN
_MISSING = _constants._MISSING

StoreError = _errors.StoreError
TrustedFillCurrentError = _errors.TrustedFillCurrentError
StoreError.__module__ = __name__
TrustedFillCurrentError.__module__ = __name__

_job_origin = _normalization._job_origin
_nonempty_job_value = _normalization._nonempty_job_value
_normalized_job_source = _normalization._normalized_job_source
_job_observation_source = _normalization._job_observation_source
_job_field_provenance = _normalization._job_field_provenance
_agent_may_update_job_field = _normalization._agent_may_update_job_field
_migration_may_update_job_field = _normalization._migration_may_update_job_field
_reject_supplied_migration_provenance = (
    _normalization._reject_supplied_migration_provenance
)
_validate_migration_provenance_replacement = (
    _normalization._validate_migration_provenance_replacement
)
_stamp_job_provenance = _normalization._stamp_job_provenance


_COMPANION_REGISTRY_NAMES = {
    "job_apply_accounts",
    "job_apply_account_flows_macos",
    "job_apply_account_flows",
    "job_apply_trusted_fill",
    "job_apply_credentials",
    "job_apply_credentials_macos",
    "job_apply_credentials_portable_runtime",
    "job_apply_account_executor",
    "job_apply_password_account_flows",
    "job_apply_account_canary_executor",
    "job_apply_form_readiness",
    "job_apply_answer_match",
}


def _is_companion_registry_name(name: str) -> bool:
    return name in _COMPANION_REGISTRY_NAMES or name == "qa" or name.startswith(
        "qa."
    )


def _load_companion_module(name: str, unavailable: str) -> Any:
    """Execute an adjacent companion without consulting fixed-name imports."""

    path = Path(__file__).with_name(f"{name}.py")
    private_name = f"{_COMPANION_PACKAGE_NAME}.{name}"
    spec = importlib.util.spec_from_file_location(private_name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(unavailable)
    module = importlib.util.module_from_spec(spec)
    saved_modules = {
        module_name: value
        for module_name, value in sys.modules.items()
        if _is_companion_registry_name(module_name)
    }
    saved_path = list(sys.path)
    for module_name in tuple(sys.modules):
        if _is_companion_registry_name(module_name):
            del sys.modules[module_name]
    scripts_root = str(Path(__file__).resolve().parent)
    plugin_root = str(Path(__file__).resolve().parent.parent)
    sys.path[:] = [
        scripts_root,
        plugin_root,
        *(entry for entry in saved_path if entry not in {scripts_root, plugin_root}),
    ]
    # Dataclass-based frozen local contracts need their module namespace
    # registered while annotations are resolved during import.
    sys.modules[private_name] = module
    try:
        spec.loader.exec_module(module)
        module.__name__ = name
        return module
    except BaseException:
        _remove_root_private_packages()
        raise
    finally:
        for module_name in tuple(sys.modules):
            if _is_companion_registry_name(module_name):
                del sys.modules[module_name]
        sys.modules.update(saved_modules)
        sys.path[:] = saved_path


def _load_accounts_module() -> Any:
    return _load_companion_module(
        "job_apply_accounts", "account contracts are unavailable"
    )


ACCOUNTS_MODULE = _load_accounts_module()


def _load_account_flows_macos_module() -> Any:
    return _load_companion_module(
        "job_apply_account_flows_macos", "account flow contracts are unavailable"
    )


ACCOUNT_FLOWS_MACOS_MODULE = _load_account_flows_macos_module()


def _load_account_flows_module() -> Any:
    return _load_companion_module(
        "job_apply_account_flows", "account flow contracts are unavailable"
    )


ACCOUNT_FLOWS_MODULE = _load_account_flows_module()


def _load_trusted_fill_module() -> Any:
    return _load_companion_module(
        "job_apply_trusted_fill", "trusted fill contracts are unavailable"
    )


TRUSTED_FILL_MODULE = _load_trusted_fill_module()


def _load_local_module(name: str) -> Any:
    return _load_companion_module(name, "account executor contracts are unavailable")


CREDENTIALS_MODULE = _load_local_module("job_apply_credentials")
CREDENTIALS_MACOS_MODULE = _load_local_module("job_apply_credentials_macos")
ACCOUNT_EXECUTOR_MODULE = _load_local_module("job_apply_account_executor")
PASSWORD_ACCOUNT_FLOWS_MODULE = _load_local_module("job_apply_password_account_flows")
CANARY_EXECUTOR_MODULE = _load_local_module("job_apply_account_canary_executor")
FORM_READINESS_MODULE = _load_local_module("job_apply_form_readiness")
ANSWER_MATCH_MODULE = _load_local_module("job_apply_answer_match")


try:
    _compat_runtime = importlib.import_module(f"{_PACKAGE_NAME}.compat_runtime")
    _compat_runtime.bind_runtime(lambda: globals())
    for _compat_name in ("compat_storage", "compat_sessions", "compat_validation"):
        _compat_module = importlib.import_module(f"{_PACKAGE_NAME}.{_compat_name}")
        for _export_name in _compat_module.__all__:
            _export = getattr(_compat_module, _export_name)
            _export.__module__ = __name__
            globals()[_export_name] = _export
except BaseException:
    _remove_root_private_packages()
    raise


def _read_input(path: str) -> dict[str, Any]:
    try:
        if path == "-":
            value = json.load(sys.stdin)
        else:
            with Path(path).expanduser().open(encoding="utf-8") as source:
                value = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        raise StoreError("input is not a readable JSON object") from error
    return _require_object(value, "input")


class Store(
    _profile_domain.ProfileStoreMixin,
    _profile_facts_domain.ProfileFactsStoreMixin,
    _answer_read_domain.AnswerReadMixin,
    _answer_mutation_domain.AnswerMutationMixin,
    _answer_merge_domain.AnswerMergeMixin,
    _answer_cleanup_domain.AnswerCleanupMixin,
    _job_crud_domain.JobCrudMixin,
    _job_overview_domain.JobOverviewMixin,
    _job_upsert_domain.JobUpsertMixin,
    _job_legacy_domain.JobLegacyMixin,
    _coordinator_persistence_domain.CoordinatorPersistenceMixin,
    _coordinator_claims_domain.CoordinatorClaimsMixin,
    _coordinator_attention_domain.CoordinatorAttentionMixin,
    _coordinator_progress_domain.CoordinatorProgressMixin,
    _coordinator_approvals_domain.CoordinatorApprovalsMixin,
    _resumes_storage_domain.ResumeStorageMixin,
    _resumes_read_domain.ResumeReadMixin,
    _resumes_mutations_domain.ResumeMutationMixin,
    _resumes_lifecycle_domain.ResumeLifecycleMixin,
    _extractions_journal_domain.ExtractionJournalMixin,
    _extractions_requests_domain.ExtractionRequestMixin,
    _extractions_proposals_domain.ExtractionProposalMixin,
    _sessions_history_domain.SessionHistoryMixin,
    _sessions_readiness_domain.SessionReadinessMixin,
    _sessions_document_domain.SessionDocumentMixin,
    _sessions_lifecycle_domain.SessionLifecycleMixin,
    _accounts_email_execution_domain.EmailExecutionMixin,
    _accounts_email_scope_domain.EmailScopeMixin,
    _accounts_operations_domain.AccountOperationMixin,
    _accounts_password_execution_domain.PasswordExecutionMixin,
    _accounts_registry_domain.AccountRegistryMixin,
    _accounts_settings_domain.AccountSettingsMixin,
    _accounts_synthetic_domain.SyntheticAccountMixin,
    _accounts_trusted_fill_domain.TrustedFillMixin,
    _startup_domain.StartupMixin,
    _base.StoreBase,
):
    _runtime_provider = staticmethod(lambda: globals())


def _scope(value: str) -> dict[str, Any]:
    try:
        return _require_object(json.loads(value), "scope")
    except json.JSONDecodeError as error:
        raise StoreError("scope must be a JSON object") from error


def build_parser() -> argparse.ArgumentParser:
    return _cli_parser.build_parser(globals())


def resolve_store(args: argparse.Namespace) -> Store:
    configured = args.root or os.environ.get(STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    legacy = Path(args.legacy_profile).expanduser() if args.legacy_profile else None
    return Store(root, legacy)


def run(args: argparse.Namespace) -> Any:
    return _cli_dispatch.run(args, globals())


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = run(args)
    except StoreError as error:
        print(f"job-apply-store: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("job-apply-store: storage operation failed", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, sort_keys=True, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
