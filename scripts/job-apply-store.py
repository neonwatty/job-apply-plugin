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


def _optional_email(value: Any, label: str) -> str | None:
    return _account_validation._optional_email(value, label)


def _validate_automation_settings_record(value: Any) -> dict[str, Any]:
    return _account_validation._validate_automation_settings_record(
        value, accounts_module=ACCOUNTS_MODULE
    )


def _validate_employer_account_record(key: str, value: Any) -> dict[str, Any]:
    return _account_validation._validate_employer_account_record(
        key,
        value,
        accounts_module=ACCOUNTS_MODULE,
        credentials_module=CREDENTIALS_MODULE,
    )


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _require_object(value: Any, label: str) -> dict[str, Any]:
    return _io.require_object(value, label)


def _fact_group_label(value: Any) -> str:
    return _profile_validation._fact_group_label(value)


def _fact_group_paths(value: Any) -> list[str]:
    return _profile_validation._fact_group_paths(value)


def _fact_group_order(value: Any) -> int:
    return _profile_validation._fact_group_order(value)


def _validate_fact_group_record(group_id: str, value: Any) -> dict[str, Any]:
    return _profile_validation._validate_fact_group_record(group_id, value)


def _set_private_mode(path: Path, mode: int) -> None:
    _io._set_private_mode(path, mode, _runtime=globals())


def _ensure_private_dir(path: Path) -> None:
    _io._ensure_private_dir(path, _runtime=globals())


@contextmanager
def exclusive_file_lock(path: Path):
    """Serialize read-modify-write operations across local clients."""

    with _io.exclusive_file_lock(path, _runtime=globals()):
        yield


def _fsync_directory(path: Path) -> None:
    _io._fsync_directory(path, _runtime=globals())


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Replace a JSON document atomically without risking the previous file."""

    _io.atomic_write_json(path, payload, _runtime=globals())


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    return _io.read_json_object(path, label)


def validate_version(document: dict[str, Any], label: str) -> None:
    _io.validate_version(document, label)


def normalize_question(question: str) -> str:
    return _normalization.normalize_question(question)


def answer_key(question: str, scope: dict[str, Any] | None = None) -> str:
    return _normalization.answer_key(question, scope)


def normalize_job_url(url: str) -> str:
    return _normalization.normalize_job_url(url)


def normalize_resume_path(path: str) -> str:
    return _normalization.normalize_resume_path(path, _runtime=globals())


def observe_resume_file(path: str) -> dict[str, Any]:
    return _normalization.observe_resume_file(path, _runtime=globals())


def _resume_modified_at(metadata: os.stat_result) -> str:
    return _normalization._resume_modified_at(metadata)


def _validate_resume_bytes(path: Path, extension: str) -> tuple[str, int, str]:
    """Validate a private staged copy without disclosing its path or content."""

    media_type = RESUME_MEDIA_TYPES.get(extension)
    if media_type is None:
        raise StoreError("resume format must be PDF, DOCX, or UTF-8 TXT")
    try:
        metadata = path.stat()
        size = metadata.st_size
        if size > RESUME_MAX_BYTES:
            raise StoreError("resume file exceeds the 10 MiB limit")
        if size == 0:
            raise StoreError("resume file is empty")
        if extension == ".pdf":
            with path.open("rb") as source:
                if source.read(5) != b"%PDF-":
                    raise StoreError("resume content does not match its extension")
        elif extension == ".docx":
            try:
                with zipfile.ZipFile(path) as archive:
                    names = set(archive.namelist())
                    if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                        raise StoreError("resume content does not match its extension")
                    bad_member = next(
                        (
                            name
                            for name in names
                            if name.startswith("/")
                            or ".." in Path(name.replace("\\", "/")).parts
                        ),
                        None,
                    )
                    if bad_member is not None:
                        raise StoreError("resume content does not match its extension")
            except (OSError, zipfile.BadZipFile):
                raise StoreError("resume content does not match its extension") from None
        else:
            data = path.read_bytes()
            if b"\0" in data:
                raise StoreError("resume content does not match its extension")
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                raise StoreError("resume content does not match its extension") from None
    except StoreError:
        raise
    except OSError:
        raise StoreError("resume file could not be validated") from None
    return media_type, size, _resume_modified_at(metadata)


def _safe_session_id(application_id: str) -> str:
    return _normalization._safe_session_id(application_id)


def _is_reparse_point(metadata: os.stat_result) -> bool:
    return _normalization._is_reparse_point(metadata)


def _managed_resume_digest_cache_identity(
    metadata: os.stat_result,
    *,
    platform_name: str | None = None,
) -> tuple[int, int, int, int, int] | None:
    """Return metadata that reliably changes after in-place content writes."""

    return _normalization._managed_resume_digest_cache_identity(
        metadata,
        platform_name=platform_name,
        _runtime=globals(),
    )


def _validate_optional_strings(
    document: dict[str, Any], fields: set[str], label: str
) -> None:
    _normalization._validate_optional_strings(document, fields, label)


def _json_pointer_segment(value: str) -> str:
    return _normalization._json_pointer_segment(value)


def _canonical_json(value: Any) -> str:
    return _normalization._canonical_json(value)


def _scope_fingerprint(value: dict[str, Any]) -> str:
    return _normalization._scope_fingerprint(value)


def _question_fingerprint(value: str) -> str:
    return _normalization._question_fingerprint(value)


def _legacy_pending_reference(application_id: str, field: dict[str, Any]) -> str:
    """Project a stable opaque identity without persisting or returning legacy text."""

    digest = hashlib.sha256(
        _canonical_json({"applicationId": application_id, "pendingField": field}).encode(
            "utf-8"
        )
    ).hexdigest()
    return f"pending_{digest[:32]}"


def _project_legacy_session(
    session: dict[str, Any], expected_ats: Any = _ATS_UNSET
) -> dict[str, Any]:
    """Return a value-free modern view of the exact closed 1.2 pending shape."""

    pending_fields = session.get("pendingFields", [])
    if not isinstance(pending_fields, list):
        _validate_session_document(session)
        return session
    if not any(
        isinstance(value, dict) and "reference" not in value
        for value in pending_fields
    ):
        _validate_session_document(session)
        return session

    application_id = _safe_session_id(session.get("applicationId", ""))
    if any(
        isinstance(value, dict) and "reference" in value
        for value in pending_fields
    ):
        raise StoreError("legacy and modern pending fields cannot be mixed")
    _validate_optional_strings(session, {"company", "role", "url"}, "session")
    canonical_ats_supplied = expected_ats is not _ATS_UNSET
    ats = expected_ats if canonical_ats_supplied else session.get("ats")
    legacy_scope_fingerprint = (
        _scope_fingerprint({"ats": ats})
        if isinstance(ats, str) and ats
        else None
    )
    projected = copy.deepcopy(session)
    if canonical_ats_supplied:
        projected["ats"] = copy.deepcopy(expected_ats)
    for legacy_job_field in ("company", "role", "url"):
        projected.pop(legacy_job_field, None)
    projected_fields: list[dict[str, Any]] = []
    references: set[str] = set()
    for value in pending_fields:
        field = _require_object(value, "pending field")
        if not set(field).issubset(LEGACY_PENDING_FIELD_KEYS):
            raise StoreError("pending field reference is invalid")
        _validate_optional_strings(
            field, {"question", "state", "answerKey"}, "pending field"
        )
        if "state" in field and field["state"] not in ANSWER_STATES:
            raise StoreError("pending field state is unsupported")
        if "sensitive" in field and not isinstance(field["sensitive"], bool):
            raise StoreError("pending field sensitive must be a boolean")
        candidate = copy.deepcopy(field)
        question = candidate.pop("question", None)
        if isinstance(question, str) and question.strip():
            candidate["questionFingerprint"] = _question_fingerprint(question)
        if legacy_scope_fingerprint is not None:
            candidate["scopeFingerprint"] = legacy_scope_fingerprint
        candidate["reference"] = _legacy_pending_reference(application_id, field)
        reference = candidate.get("reference")
        if reference in references:
            raise StoreError("pending field references must be unique")
        references.add(reference)
        projected_fields.append(candidate)
    projected["pendingFields"] = projected_fields
    _validate_session_document(projected)
    return projected


def _pending_reference_identity(field: dict[str, Any]) -> str:
    """Match durable field meaning while excluding refreshed match evidence."""

    return _canonical_json(
        {
            key: copy.deepcopy(value)
            for key, value in field.items()
            if key
            not in {
                "reference",
                "matchConfidence",
                "matchReasonCodes",
                "matchAnswerRevision",
            }
        }
    )


def _top_level_pointer_key(pointer: str) -> str:
    return _normalization._top_level_pointer_key(pointer)


def _meaningfully_present(value: Any) -> bool:
    """Return whether a profile value carries non-blank user information."""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(_meaningfully_present(item) for item in value)
    if isinstance(value, dict):
        return any(_meaningfully_present(item) for item in value.values())
    return True


def _json_pointer_value(document: Any, pointer: str) -> Any:
    return _normalization._json_pointer_value(document, pointer)


def _decode_json_pointer(pointer: str) -> list[str]:
    return _normalization._decode_json_pointer(pointer)


def _pointer_lookup(document: Any, pointer: str) -> tuple[bool, Any]:
    return _normalization._pointer_lookup(document, pointer)


def _pointer_baseline(document: dict[str, Any], pointer: str) -> dict[str, Any]:
    return _normalization._pointer_baseline(document, pointer)


def _json_values_equal(left: Any, right: Any) -> bool:
    """Compare JSON values without Python's boolean/number equivalence."""

    return _normalization._json_values_equal(left, right)


def _replacement_scope(baseline: dict[str, Any]) -> dict[str, Any] | None:
    """Return the existing non-object ancestor a child acceptance would replace."""

    return _normalization._replacement_scope(baseline)


def _set_pointer_value(
    document: dict[str, Any], pointer: str, value: Any, *, replace_ancestors: bool
) -> None:
    _normalization._set_pointer_value(
        document, pointer, value, replace_ancestors=replace_ancestors
    )


def _candidate_leaf_paths(value: Any, prefix: str = "", depth: int = 0) -> list[str]:
    return _extraction_validation._candidate_leaf_paths(value, prefix, depth)


def _validated_candidate(value: Any) -> tuple[dict[str, Any], list[str]]:
    return _extraction_validation._validated_candidate(value)


def _validate_answer_record(key: str, value: Any) -> dict[str, Any]:
    return _profile_validation._validate_answer_record(key, value)


def _validate_answer_redirects(
    redirects: Any, answers: dict[str, Any]
) -> dict[str, Any]:
    return _profile_validation._validate_answer_redirects(redirects, answers)


def _validate_history_event_record(event: dict[str, Any]) -> None:
    """Validate the value-free history schema without assigning event semantics."""

    _session_validation._validate_history_event_record(event)


def _validate_history_event_for_write(event: dict[str, Any]) -> None:
    """Apply this helper version's strict event-name write policy."""

    _session_validation._validate_history_event_for_write(event)


def _validate_session_document(session: dict[str, Any]) -> None:
    _session_validation._validate_session_document(
        session, answer_match_module=ANSWER_MATCH_MODULE
    )


def _validate_claim_record(value: Any) -> dict[str, Any]:
    return _session_validation._validate_claim_record(value)


def _parse_coordinator_time(value: str) -> datetime:
    return _session_validation._parse_coordinator_time(value)


def _validate_job_record(key: str, value: Any) -> dict[str, Any]:
    return _job_resume_validation._validate_job_record(
        key, value, path_type=Path
    )


def _validate_resume_record(key: str, value: Any) -> dict[str, Any]:
    return _job_resume_validation._validate_resume_record(
        key,
        value,
        path_type=Path, os_module=os,
        trusted_fill_module=TRUSTED_FILL_MODULE,
    )


def _validate_extraction_proposal(key: str, value: Any) -> dict[str, Any]:
    return _extraction_validation._validate_extraction_proposal(
        key, value, trusted_fill_module=TRUSTED_FILL_MODULE
    )


def _validate_extractions_document(document: dict[str, Any]) -> dict[str, Any]:
    return _extraction_validation._validate_extractions_document(
        document, trusted_fill_module=TRUSTED_FILL_MODULE
    )


def _validate_extraction_request(key: str, value: Any) -> dict[str, Any]:
    return _extraction_validation._validate_extraction_request(
        key, value, trusted_fill_module=TRUSTED_FILL_MODULE
    )


def _validate_extraction_requests_document(
    document: dict[str, Any],
) -> dict[str, Any]:
    return _extraction_validation._validate_extraction_requests_document(
        document, trusted_fill_module=TRUSTED_FILL_MODULE
    )


def _extraction_request_lineage_depth(
    record: dict[str, Any], records_by_id: dict[str, dict[str, Any]],
) -> int:
    """Return a bounded causal rank for deterministic retry ordering."""
    return _extraction_validation._extraction_request_lineage_depth(
        record, records_by_id
    )


def order_extraction_requests(
    records: list[dict[str, Any]], timestamp_field: str = "createdAt",
) -> list[dict[str, Any]]:
    """Order requests by time, retry causality, then opaque identity."""
    return _extraction_validation.order_extraction_requests(records, timestamp_field)


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
    _base.StoreBase,
):
    _runtime_provider = staticmethod(lambda: globals())


    def initialize(self) -> dict[str, Any]:
        """Validate existing documents, then create only missing store files."""

        self._validate_existing_documents()

        _ensure_private_dir(self.root)
        _ensure_private_dir(self.sessions_path)
        _ensure_private_dir(self.resume_files_path)
        # A durable extraction operation may describe newly installed managed
        # bytes. Apply its document snapshot before reconciling quarantines so
        # file recovery uses the committed content identity, never stale resume
        # metadata from before the replacement.
        if self.resume_extraction_journal_path.exists():
            with exclusive_file_lock(self.store_lock_path):
                self._roll_forward_extraction_locked()
        if any(self.resume_files_path.iterdir()):
            with exclusive_file_lock(self.store_lock_path):
                self._recover_resume_files_locked()
        migrated = False

        if not self.profile_path.exists():
            profile: dict[str, Any] = {}
            metadata: dict[str, Any] = {
                "createdAt": utc_now(),
                "updatedAt": utc_now(),
                "revision": 1,
                "factProvenance": {},
            }
            if self.legacy_profile.exists():
                profile = read_json_object(self.legacy_profile, "legacy profile")
                metadata["migratedFrom"] = "~/.claude-job-profile.json"
                metadata["migratedAt"] = utc_now()
                migrated = True
            atomic_write_json(
                self.profile_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "profile": profile,
                    "metadata": metadata,
                },
            )

        if not self.answers_path.exists():
            now = utc_now()
            atomic_write_json(
                self.answers_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "answers": {},
                    "redirects": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.fact_groups_path.exists():
            now = utc_now()
            atomic_write_json(
                self.fact_groups_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "groups": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.jobs_path.exists():
            now = utc_now()
            atomic_write_json(
                self.jobs_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "jobs": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.resumes_path.exists():
            now = utc_now()
            atomic_write_json(
                self.resumes_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "resumes": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.history_path.exists():
            descriptor = os.open(
                self.history_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            os.close(descriptor)
        _set_private_mode(self.history_path, 0o600)

        coordinator_exists = (
            self.coordinator_path.exists() or self.coordinator_journal_path.exists()
        )
        if coordinator_exists:
            with exclusive_file_lock(self.store_lock_path):
                self._ensure_coordinator_files_locked()
                self._repair_pending_history_tail_locked()
                self._roll_forward_locked()
                self.read_history()

        return {"initialized": True, "migratedLegacyProfile": migrated, **self.paths()}

    def validate_workspace_startup(self) -> None:
        """Validate existing documents without creating, repairing, or migrating state."""

        self._validate_existing_documents()

    def _validate_existing_documents(self) -> None:
        """Validate existing store documents without creating or repairing files."""

        if self.profile_path.exists():
            self._load_profile_document()
        if self.fact_groups_path.exists():
            self._load_fact_groups_document()
        if self.answers_path.exists():
            self._load_answers_document()
        if self.jobs_path.exists():
            self._load_jobs_document()
        if self.resumes_path.exists():
            self._load_resumes_document()
        if self.automation_settings_path.exists():
            self._load_automation_settings_document()
        if self.employer_accounts_path.exists():
            self._load_employer_accounts_document()
        if self.account_operation_journal_path.exists():
            self._load_account_operation_journal()
        if self.trusted_fill_path.exists():
            self._load_trusted_fill_document()
        if self.resume_extractions_path.exists():
            self._load_extractions_document()
        if self.resume_extraction_requests_path.exists():
            self._load_extraction_requests_document()
        if self.resume_extraction_journal_path.exists():
            self._load_extraction_journal()
        if self.sessions_path.exists():
            self._validate_existing_session_documents()
        if self.coordinator_path.exists():
            self._load_coordinator_document()
        coordinator_journal = None
        if self.coordinator_journal_path.exists():
            coordinator_journal = self._load_coordinator_journal()
        pending_operation = (
            coordinator_journal["operation"]
            if coordinator_journal is not None
            else None
        )
        pending_history_write = (
            pending_operation is not None
            and pending_operation.get("historyEvent") is not None
        )
        if (
            self.history_path.exists()
            and not pending_history_write
        ):
            self.read_history()

    def _validate_existing_session_documents(self) -> None:
        """Validate canonical session files without following or changing identities."""

        try:
            directory_metadata = self.sessions_path.lstat()
        except OSError:
            raise StoreError("canonical sessions directory cannot be validated") from None
        if stat.S_ISLNK(directory_metadata.st_mode) or _is_reparse_point(directory_metadata) or not stat.S_ISDIR(
            directory_metadata.st_mode
        ):
            raise StoreError("canonical sessions directory is invalid")
        directory: int | None = None
        if os.name != "nt":
            directory_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0)
            if hasattr(os, "O_NOFOLLOW"):
                directory_flags |= os.O_NOFOLLOW
            try:
                directory = os.open(self.sessions_path, directory_flags)
            except OSError:
                raise StoreError("canonical sessions directory cannot be validated") from None
        try:
            opened_directory = (
                self.sessions_path.lstat()
                if directory is None
                else os.fstat(directory)
            )
            if (
                stat.S_ISLNK(opened_directory.st_mode)
                or _is_reparse_point(opened_directory)
                or not stat.S_ISDIR(opened_directory.st_mode)
                or opened_directory.st_dev != directory_metadata.st_dev
                or opened_directory.st_ino != directory_metadata.st_ino
            ):
                raise StoreError("canonical sessions directory identity changed")
            for name in sorted(os.listdir(self.sessions_path if directory is None else directory)):
                if not name.endswith(".json"):
                    continue
                application_id = _safe_session_id(name[:-5])
                try:
                    metadata = (
                        (self.sessions_path / name).lstat()
                        if directory is None
                        else os.stat(name, dir_fd=directory, follow_symlinks=False)
                    )
                except OSError:
                    raise StoreError("canonical session cannot be validated") from None
                if stat.S_ISLNK(metadata.st_mode) or _is_reparse_point(metadata) or not stat.S_ISREG(metadata.st_mode):
                    raise StoreError("canonical session must be a regular file")
                flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                try:
                    descriptor = (
                        os.open(self.sessions_path / name, flags)
                        if directory is None
                        else os.open(name, flags, dir_fd=directory)
                    )
                except OSError:
                    raise StoreError("canonical session cannot be validated") from None
                try:
                    opened = os.fstat(descriptor)
                    if (
                        opened.st_dev != metadata.st_dev
                        or opened.st_ino != metadata.st_ino
                        or not stat.S_ISREG(opened.st_mode)
                        or _is_reparse_point(opened)
                    ):
                        raise StoreError("canonical session identity changed")
                    try:
                        with os.fdopen(descriptor, encoding="utf-8") as source:
                            descriptor = -1
                            session = _require_object(json.load(source), "session")
                    except (OSError, UnicodeError, json.JSONDecodeError):
                        raise StoreError("cannot read valid session JSON") from None
                finally:
                    if descriptor >= 0:
                        os.close(descriptor)
                validate_version(session, "session")
                _project_legacy_session(session)
                if session["applicationId"] != application_id:
                    raise StoreError("session application id does not match path")
            closed_directory = self.sessions_path.lstat()
            if (
                stat.S_ISLNK(closed_directory.st_mode)
                or _is_reparse_point(closed_directory)
                or not stat.S_ISDIR(closed_directory.st_mode)
                or closed_directory.st_dev != directory_metadata.st_dev
                or closed_directory.st_ino != directory_metadata.st_ino
            ):
                raise StoreError("canonical sessions directory identity changed")
        finally:
            if directory is not None:
                os.close(directory)


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
