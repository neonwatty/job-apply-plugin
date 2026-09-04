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
    _answer_read_domain._bind_runtime(lambda: globals())
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


def _job_origin(origin: str) -> str:
    if origin not in JOB_ORIGINS:
        raise StoreError("job origin must be human or agent")
    return origin


def _nonempty_job_value(value: Any) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _normalized_job_source(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


def _job_observation_source(record: dict[str, Any]) -> str:
    return _normalized_job_source(record.get("source")) or "manual"


def _job_field_provenance(
    provenance: dict[str, Any], field: str
) -> dict[str, Any] | None:
    value = provenance.get(f"/{_json_pointer_segment(field)}")
    if not isinstance(value, dict) or value.get("origin") not in JOB_PROVENANCE_ORIGINS:
        return None
    return value


def _agent_may_update_job_field(
    record: dict[str, Any], provenance: dict[str, Any], field: str
) -> bool:
    authored = _job_field_provenance(provenance, field)
    if authored is not None:
        return authored["origin"] == "agent"
    return not _nonempty_job_value(record.get(field))


def _migration_may_update_job_field(
    record: dict[str, Any], provenance: dict[str, Any], field: str
) -> bool:
    if not _nonempty_job_value(record.get(field)):
        return True
    authored = _job_field_provenance(provenance, field)
    if authored is not None:
        return authored["origin"] == "migration"
    return False


def _reject_supplied_migration_provenance(provenance: dict[str, Any]) -> None:
    if any(
        isinstance(value, dict) and value.get("origin") == "migration"
        for value in provenance.values()
    ):
        raise StoreError("migration provenance is reserved for guided legacy imports")


def _validate_migration_provenance_replacement(
    current: dict[str, Any], replacement: dict[str, Any]
) -> None:
    protected_paths = {
        path
        for path in set(current) | set(replacement)
        if (
            isinstance(current.get(path), dict)
            and current[path].get("origin") == "migration"
        )
        or (
            isinstance(replacement.get(path), dict)
            and replacement[path].get("origin") == "migration"
        )
    }
    if any(current.get(path) != replacement.get(path) for path in protected_paths):
        raise StoreError("migration provenance is reserved for guided legacy imports")


def _stamp_job_provenance(
    provenance: dict[str, Any],
    fields: list[str] | set[str],
    origin: str,
    observation_source: str,
    updated_at: str,
) -> dict[str, Any]:
    stamped = dict(provenance)
    for field in fields:
        stamped[f"/{_json_pointer_segment(field)}"] = {
            "origin": origin,
            "observationSource": observation_source,
            "updatedAt": updated_at,
        }
    return stamped


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

    def _ensure_coordinator_files_locked(self) -> None:
        if not self.coordinator_path.exists():
            atomic_write_json(
                self.coordinator_path,
                {"schemaVersion": SCHEMA_VERSION, "claim": None},
            )
        if not self.coordinator_journal_path.exists():
            atomic_write_json(
                self.coordinator_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": None},
            )

    def _ensure_coordinator_files(self) -> None:
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_coordinator_files_locked()
            self._roll_forward_locked()

    def _load_coordinator_document(self) -> dict[str, Any]:
        document = read_json_object(self.coordinator_path, "coordinator")
        validate_version(document, "coordinator")
        if set(document) != {"schemaVersion", "claim"}:
            raise StoreError("coordinator contains unsupported fields")
        claim = document["claim"]
        if claim is not None:
            _validate_claim_record(claim)
        return document

    def _load_coordinator_journal(self) -> dict[str, Any]:
        document = read_json_object(self.coordinator_journal_path, "coordinator journal")
        validate_version(document, "coordinator journal")
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("coordinator journal contains unsupported fields")
        operation = document["operation"]
        if operation is not None:
            operation = _require_object(operation, "coordinator journal operation")
            kind = operation.get("kind")
            if kind == "answer_merge":
                expected = {
                    "kind", "operationId", "at", "winnerKey", "sourceKey",
                    "expectedWinnerRevision", "expectedSourceRevision", "sessions",
                    "resultClaim",
                }
                if set(operation) != expected:
                    raise StoreError("coordinator answer merge operation is invalid")
                for field in ("operationId", "at", "winnerKey", "sourceKey"):
                    if not isinstance(operation.get(field), str) or not operation[field]:
                        raise StoreError("coordinator answer merge operation is invalid")
                if operation["winnerKey"] == operation["sourceKey"]:
                    raise StoreError("coordinator answer merge identity is invalid")
                for field in ("expectedWinnerRevision", "expectedSourceRevision"):
                    revision = operation.get(field)
                    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
                        raise StoreError("coordinator answer merge revision is invalid")
                sessions = operation.get("sessions")
                if not isinstance(sessions, list):
                    raise StoreError("coordinator answer merge sessions are invalid")
                identities: set[str] = set()
                for session in sessions:
                    session_document = _require_object(
                        session, "coordinator answer merge session"
                    )
                    _validate_session_document(session_document)
                    identity = session_document["applicationId"]
                    if identity in identities:
                        raise StoreError("coordinator answer merge sessions are duplicated")
                    identities.add(identity)
                result_claim = operation.get("resultClaim")
                if result_claim is not None:
                    _validate_claim_record(result_claim)
                return document
            if kind == "answer_resolution":
                expected = {
                    "kind", "operationId", "jobId", "at", "answerKey",
                    "expectedJobRevision", "expectedSessionRevision",
                    "expectedAnswerRevision", "sourceStatus", "targetStatus",
                    "session", "resultClaim",
                }
                if set(operation) != expected:
                    raise StoreError("coordinator answer resolution operation is invalid")
                job_id = _safe_session_id(operation.get("jobId", ""))
                if not all(isinstance(operation.get(field), str) and operation[field] for field in ("operationId", "at", "answerKey")):
                    raise StoreError("coordinator answer resolution operation is invalid")
                for field in ("expectedJobRevision", "expectedSessionRevision", "expectedAnswerRevision"):
                    revision = operation.get(field)
                    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
                        raise StoreError("coordinator answer resolution revision is invalid")
                if operation.get("sourceStatus") != "needs_info" or operation.get("targetStatus") not in {"needs_info", "ready"}:
                    raise StoreError("coordinator answer resolution transition is invalid")
                session = _require_object(operation.get("session"), "coordinator session")
                _validate_session_document(session)
                if session.get("applicationId") != job_id:
                    raise StoreError("coordinator answer resolution session is invalid")
                if operation.get("resultClaim") is not None:
                    raise StoreError("coordinator answer resolution cannot create a claim")
                return document
            common = {"kind", "operationId", "jobId", "at", "historyEvent", "resultClaim"}
            transition = {"sourceStatus", "targetStatus", "expectedRevision"}
            expected = common | (transition if kind in {"acquire", "review_restart"} else set())
            if kind == "handoff":
                expected = common | transition | {"session"}
            if kind not in {"acquire", "review_restart", "recover", "handoff"} or set(operation) != expected:
                raise StoreError("coordinator journal operation is invalid")
            job_id = _safe_session_id(operation.get("jobId", ""))
            if not all(
                isinstance(operation.get(field), str) and operation[field]
                for field in ("operationId", "at")
            ):
                raise StoreError("coordinator journal operation is invalid")
            event = _require_object(operation.get("historyEvent"), "coordinator history event")
            _validate_history_event_for_write(event)
            if event.get("applicationId") != job_id:
                raise StoreError("coordinator history identity does not match")
            if kind in {"acquire", "review_restart", "handoff"}:
                revision = operation.get("expectedRevision")
                if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
                    raise StoreError("coordinator journal revision is invalid")
            if kind == "acquire":
                if operation.get("sourceStatus") != "ready" or operation.get("targetStatus") != "in_progress":
                    raise StoreError("coordinator acquisition transition is invalid")
            if kind == "review_restart":
                if operation.get("sourceStatus") != "awaiting_review" or operation.get("targetStatus") != "in_progress":
                    raise StoreError("coordinator review restart transition is invalid")
            if kind == "handoff":
                if operation.get("sourceStatus") != "in_progress" or operation.get("targetStatus") not in {"needs_info", "awaiting_review"}:
                    raise StoreError("coordinator handoff transition is invalid")
                session = _require_object(operation.get("session"), "coordinator session")
                _validate_session_document(session)
                if session.get("applicationId") != job_id:
                    raise StoreError("coordinator session identity does not match")
            result_claim = operation.get("resultClaim")
            if kind == "handoff":
                if result_claim is not None:
                    raise StoreError("coordinator handoff must release its claim")
            else:
                claim = _validate_claim_record(result_claim)
                if claim["jobId"] != job_id:
                    raise StoreError("coordinator claim identity does not match")
        return document

    def _load_jobs_document(self) -> dict[str, Any]:
        document = read_json_object(self.jobs_path, "jobs")
        validate_version(document, "jobs")
        jobs = _require_object(document.get("jobs"), "jobs.jobs")
        _require_object(document.get("metadata"), "jobs.metadata")
        for key, record in jobs.items():
            if not isinstance(key, str) or not key:
                raise StoreError("job index keys must be non-empty strings")
            _validate_job_record(key, record)
        return document

    def _load_resumes_document(self) -> dict[str, Any]:
        document = read_json_object(self.resumes_path, "resumes")
        validate_version(document, "resumes")
        resumes = _require_object(document.get("resumes"), "resumes.resumes")
        _require_object(document.get("metadata"), "resumes.metadata")
        active_defaults = 0
        for key, record in resumes.items():
            if not isinstance(key, str) or not key:
                raise StoreError("resume index keys must be non-empty strings")
            item = _validate_resume_record(key, record)
            if item["default"] and item.get("deletedAt") is None:
                active_defaults += 1
        if active_defaults > 1:
            raise StoreError("resume store has more than one active default")
        return document

    def _load_automation_settings_document(self) -> dict[str, Any]:
        document = read_json_object(self.automation_settings_path, "automation settings")
        validate_version(document, "automation settings")
        if set(document) != {"schemaVersion", "settings"}:
            raise StoreError("automation settings document contains unsupported fields")
        _validate_automation_settings_record(document.get("settings"))
        return document

    def _load_employer_accounts_document(self) -> dict[str, Any]:
        document = read_json_object(self.employer_accounts_path, "employer accounts")
        validate_version(document, "employer accounts")
        if set(document) != {"schemaVersion", "accounts", "metadata"}:
            raise StoreError("employer accounts document contains unsupported fields")
        accounts = _require_object(document.get("accounts"), "employer accounts")
        metadata = _require_object(document.get("metadata"), "employer account metadata")
        if set(metadata) != {"createdAt", "updatedAt"}:
            raise StoreError("employer account metadata is invalid")
        for field in ("createdAt", "updatedAt"):
            if not isinstance(metadata[field], str) or not metadata[field]:
                raise StoreError("employer account metadata timestamp is invalid")
        for key, record in accounts.items():
            _validate_employer_account_record(key, record)
        return document

    def _load_account_operation_journal(self) -> dict[str, Any]:
        document = read_json_object(self.account_operation_journal_path, "account operation journal")
        validate_version(document, "account operation journal")
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("account operation journal contains unsupported fields")
        operation = document["operation"]
        if operation is None:
            return document
        expected = {
            "operationId", "jobId", "jobRevision", "claimId", "realmRef",
            "accountRevision", "settingsRevision", "stage", "outcomeCode", "startedAt",
        }
        if not isinstance(operation, dict) or set(operation) != expected:
            raise StoreError("account operation journal is invalid")
        for field in ("operationId", "jobId", "claimId", "realmRef", "stage", "outcomeCode", "startedAt"):
            if not isinstance(operation[field], str) or not operation[field]:
                raise StoreError("account operation journal binding is invalid")
        for field in ("jobRevision", "accountRevision", "settingsRevision"):
            if not isinstance(operation[field], int) or isinstance(operation[field], bool) or operation[field] < 1:
                raise StoreError("account operation journal revision is invalid")
        if operation["stage"] not in {"prepared", "credential_provisioned", "signup_in_progress"}:
            raise StoreError("account operation journal stage is invalid")
        if operation["outcomeCode"] not in {*ACCOUNT_EXECUTOR_MODULE.OUTCOMES, "observed_pending"}:
            raise StoreError("account operation journal outcome is invalid")
        return document

    def _load_trusted_fill_document(self) -> dict[str, Any]:
        document = read_json_object(self.trusted_fill_path, "trusted fill approvals")
        validate_version(document, "trusted fill approvals")
        if set(document) != {"schemaVersion", "approvals", "metadata"}:
            raise StoreError("trusted fill approval document contains unsupported fields")
        approvals = _require_object(document.get("approvals"), "trusted fill approvals")
        metadata = _require_object(document.get("metadata"), "trusted fill metadata")
        if set(metadata) != {"createdAt", "updatedAt"}:
            raise StoreError("trusted fill metadata is invalid")
        for field in ("createdAt", "updatedAt"):
            if not isinstance(metadata[field], str) or not metadata[field]:
                raise StoreError("trusted fill metadata timestamp is invalid")
        for job_id, approval in approvals.items():
            _safe_session_id(job_id)
            try:
                TRUSTED_FILL_MODULE.validate_approval(approval)
            except TRUSTED_FILL_MODULE.TrustedFillError as error:
                raise StoreError(str(error)) from None
            if approval["jobId"] != job_id:
                raise StoreError("trusted fill approval job identity is invalid")
        return document

    def _load_extractions_document(self) -> dict[str, Any]:
        return _validate_extractions_document(
            read_json_object(self.resume_extractions_path, "resume proposals")
        )

    def _load_extraction_requests_document(self) -> dict[str, Any]:
        return _validate_extraction_requests_document(
            read_json_object(
                self.resume_extraction_requests_path, "resume extraction requests"
            )
        )

    def _load_extraction_journal(self) -> dict[str, Any]:
        document = read_json_object(
            self.resume_extraction_journal_path, "resume proposal journal"
        )
        validate_version(document, "resume proposal journal")
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("resume proposal journal contains unsupported fields")
        operation = document["operation"]
        if operation is not None:
            item = _require_object(operation, "resume proposal journal operation")
            legacy_keys = {
                "kind",
                "operationId",
                "profileDocument",
                "proposalsDocument",
            }
            expanded_keys = legacy_keys | {"requestsDocument", "resumesDocument"}
            if frozenset(item) not in {frozenset(legacy_keys), frozenset(expanded_keys)}:
                raise StoreError("resume proposal journal operation is invalid")
            if item.get("kind") not in {
                "create", "review", "request-create", "request-close",
                "request-retry", "request-complete", "resume-request-close",
            }:
                raise StoreError("resume proposal journal operation is invalid")
            if set(item) == legacy_keys and item["kind"] not in {"create", "review"}:
                raise StoreError("resume proposal journal operation is invalid")
            _safe_session_id(item.get("operationId", ""))
            if item.get("profileDocument") is not None:
                self._validate_profile_document_value(
                    _require_object(item["profileDocument"], "journal profile")
                )
            if item.get("proposalsDocument") is not None:
                _validate_extractions_document(
                    _require_object(item["proposalsDocument"], "journal proposals")
                )
            if "requestsDocument" in item and item["requestsDocument"] is not None:
                _validate_extraction_requests_document(
                    _require_object(item["requestsDocument"], "journal requests")
                )
            if "resumesDocument" in item and item["resumesDocument"] is not None:
                resumes = _require_object(item["resumesDocument"], "journal resumes")
                validate_version(resumes, "resumes")
                if set(resumes) != {"schemaVersion", "resumes", "metadata"}:
                    raise StoreError("resume proposal journal operation is invalid")
                for key, record in _require_object(resumes["resumes"], "resumes").items():
                    _validate_resume_record(key, record)
        return document

    def _ensure_extraction_files_locked(self) -> None:
        if not self.resume_extractions_path.exists():
            now = utc_now()
            atomic_write_json(
                self.resume_extractions_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "proposals": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )
        if not self.resume_extraction_journal_path.exists():
            atomic_write_json(
                self.resume_extraction_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": None},
            )

    def _ensure_extraction_requests_file_locked(self) -> None:
        self._ensure_extraction_files_locked()
        if not self.resume_extraction_requests_path.exists():
            now = utc_now()
            atomic_write_json(
                self.resume_extraction_requests_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "requests": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

    def _roll_forward_extraction_locked(self) -> None:
        journal = self._load_extraction_journal()
        operation = journal["operation"]
        if operation is None:
            return
        if operation.get("profileDocument") is not None:
            atomic_write_json(self.profile_path, operation["profileDocument"])
        if operation.get("proposalsDocument") is not None:
            atomic_write_json(self.resume_extractions_path, operation["proposalsDocument"])
        if operation.get("requestsDocument") is not None:
            atomic_write_json(
                self.resume_extraction_requests_path, operation["requestsDocument"]
            )
        if operation.get("resumesDocument") is not None:
            atomic_write_json(self.resumes_path, operation["resumesDocument"])
        atomic_write_json(
            self.resume_extraction_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": None},
        )

    def _commit_extraction_operation_locked(
        self,
        kind: str,
        profile_document: dict[str, Any] | None,
        proposals_document: dict[str, Any] | None,
        requests_document: dict[str, Any] | None = None,
        resumes_document: dict[str, Any] | None = None,
    ) -> None:
        operation = {
            "kind": kind,
            "operationId": f"extraction-{uuid.uuid4()}",
            "profileDocument": profile_document,
            "proposalsDocument": proposals_document,
            "requestsDocument": requests_document,
            "resumesDocument": resumes_document,
        }
        atomic_write_json(
            self.resume_extraction_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": operation},
        )
        self._roll_forward_extraction_locked()

    def _managed_resume_path(self, record: dict[str, Any]) -> Path:
        if record.get("storageKind") != "managed":
            raise StoreError("resume is not managed")
        candidate = self.resume_files_path / record["managedFile"]
        try:
            if candidate.parent.resolve(strict=False) != self.resume_files_path.resolve(strict=False):
                raise StoreError("managed resume file identity is invalid")
        except OSError:
            raise StoreError("managed resume file identity is invalid") from None
        return candidate

    def _resume_path(self, record: dict[str, Any]) -> Path:
        if record.get("storageKind") == "managed":
            return self._managed_resume_path(record)
        return Path(record["path"])

    def _resume_for_acquisition(self, record: dict[str, Any]) -> dict[str, Any]:
        resolved = dict(record)
        resolved["path"] = str(self._resume_path(record))
        return resolved

    @staticmethod
    def _private_file_digest(path: Path) -> str | None:
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor: int | None = None
        try:
            if path.is_symlink():
                return None
            descriptor = os.open(path, flags)
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > RESUME_MAX_BYTES:
                return None
            digest = hashlib.sha256()
            while True:
                chunk = os.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            return digest.hexdigest()
        except OSError:
            return None
        finally:
            if descriptor is not None:
                os.close(descriptor)

    def _managed_resume_observation(
        self,
        record: dict[str, Any],
        *,
        digest_cache: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        path = self._managed_resume_path(record)
        cache_key = record["id"]
        try:
            metadata = path.lstat()
        except OSError:
            return {"exists": False, "size": None, "modifiedAt": None, "digest": None}
        if path.is_symlink() or not stat.S_ISREG(metadata.st_mode) or metadata.st_size > RESUME_MAX_BYTES:
            return {"exists": False, "size": None, "modifiedAt": None, "digest": None}
        identity = (
            metadata.st_dev,
            metadata.st_ino,
            metadata.st_size,
            metadata.st_mtime_ns,
            metadata.st_ctime_ns,
        )
        cache_identity = _managed_resume_digest_cache_identity(metadata)
        now = self._now_datetime()
        cached = digest_cache.get(cache_key) if digest_cache is not None else None
        if (
            cache_identity is not None
            and cached is not None
            and cached.get("identity") == cache_identity
            and timedelta(0) <= now - cached["checkedAt"] < timedelta(seconds=OVERVIEW_DIGEST_CACHE_SECONDS)
        ):
            return {
                "exists": True,
                "size": metadata.st_size,
                "modifiedAt": _resume_modified_at(metadata),
                "digest": cached["digest"],
            }
        digest = self._private_file_digest(path)
        if digest is None:
            return {"exists": False, "size": None, "modifiedAt": None, "digest": None}
        try:
            after = path.lstat()
        except OSError:
            return {"exists": False, "size": None, "modifiedAt": None, "digest": None}
        after_identity = (
            after.st_dev,
            after.st_ino,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        )
        if after_identity != identity or not stat.S_ISREG(after.st_mode):
            return {"exists": False, "size": None, "modifiedAt": None, "digest": None}
        observation = {
            "exists": True,
            "size": after.st_size,
            "modifiedAt": _resume_modified_at(after),
            "digest": digest,
        }
        after_cache_identity = _managed_resume_digest_cache_identity(after)
        if digest_cache is not None and after_cache_identity is not None:
            digest_cache[cache_key] = {
                "identity": after_cache_identity,
                "digest": digest,
                "checkedAt": now,
            }
        return observation

    @staticmethod
    def _new_resume_content_revision() -> str:
        """Create an opaque content identity unrelated to bytes or metadata revision."""

        return "content_" + secrets.token_urlsafe(32)

    def _recover_resume_files_locked(self) -> None:
        """Recover interrupted swaps and collect private staging artifacts."""

        if not self.resumes_path.exists():
            records: list[dict[str, Any]] = []
        else:
            records = list(self._load_resumes_document()["resumes"].values())
        referenced = {
            record["managedFile"]: record
            for record in records
            if record.get("storageKind") == "managed"
        }
        for temporary in self.resume_files_path.glob(".*.tmp"):
            try:
                temporary.unlink()
            except OSError:
                pass
        recovery_cutoff = datetime.now(timezone.utc).timestamp() - UPLOAD_RECOVERY_GRACE_SECONDS
        for temporary in self.resume_files_path.glob(".browser-upload.*"):
            try:
                if temporary.stat().st_mtime <= recovery_cutoff:
                    temporary.unlink()
            except OSError:
                pass
        for managed_file, record in referenced.items():
            canonical = self.resume_files_path / managed_file
            expected_digest = record["digest"]
            quarantines = sorted(
                self.resume_files_path.glob(f".{managed_file}.*.quarantine")
            )
            if not quarantines:
                continue
            if self._private_file_digest(canonical) != expected_digest:
                recoverable = next(
                    (
                        candidate
                        for candidate in quarantines
                        if self._private_file_digest(candidate) == expected_digest
                    ),
                    None,
                )
                if recoverable is not None:
                    try:
                        canonical.unlink()
                    except FileNotFoundError:
                        pass
                    os.replace(recoverable, canonical)
                    _set_private_mode(canonical, 0o600)
            if self._private_file_digest(canonical) == expected_digest:
                for quarantine in quarantines:
                    try:
                        quarantine.unlink()
                    except OSError:
                        pass
        for quarantine in self.resume_files_path.glob(".*.quarantine"):
            try:
                quarantine.unlink()
            except OSError:
                pass
        for candidate in self.resume_files_path.iterdir():
            if candidate.name.startswith(".") or candidate.name in referenced:
                continue
            if candidate.suffix.lower() in RESUME_MEDIA_TYPES:
                try:
                    candidate.unlink()
                except OSError:
                    pass
        _fsync_directory(self.resume_files_path)

    def _stage_resume_import(self, source_value: Any, resume_id: str) -> dict[str, Any]:
        source = Path(normalize_resume_path(source_value))
        extension = source.suffix.lower()
        if extension not in RESUME_MEDIA_TYPES:
            raise StoreError("resume format must be PDF, DOCX, or UTF-8 TXT")
        _ensure_private_dir(self.resume_files_path)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        staged_path: Path | None = None
        descriptor: int | None = None
        try:
            try:
                if source.is_symlink():
                    raise StoreError("resume source must be a readable regular file")
            except OSError:
                raise StoreError("resume source must be a readable regular file") from None
            try:
                descriptor = os.open(source, flags)
            except OSError:
                raise StoreError("resume source must be a readable regular file") from None
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode):
                raise StoreError("resume source must be a readable regular file")
            if before.st_size > RESUME_MAX_BYTES:
                raise StoreError("resume file exceeds the 10 MiB limit")
            digest = hashlib.sha256()
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=self.resume_files_path,
                prefix=f".{resume_id}.",
                suffix=".tmp",
                delete=False,
            ) as staged:
                staged_path = Path(staged.name)
                total = 0
                while True:
                    chunk = os.read(descriptor, min(1024 * 1024, RESUME_MAX_BYTES + 1 - total))
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > RESUME_MAX_BYTES:
                        raise StoreError("resume file exceeds the 10 MiB limit")
                    staged.write(chunk)
                    digest.update(chunk)
                staged.flush()
                os.fsync(staged.fileno())
            after = os.fstat(descriptor)
            if (
                before.st_dev,
                before.st_ino,
                before.st_size,
                before.st_mtime_ns,
            ) != (
                after.st_dev,
                after.st_ino,
                after.st_size,
                after.st_mtime_ns,
            ):
                raise StoreError("resume source changed during import")
            _set_private_mode(staged_path, 0o600)
            media_type, size, modified_at = _validate_resume_bytes(staged_path, extension)
            result = {
                "path": staged_path,
                "managedFile": f"{resume_id}{extension}",
                "originalFilename": source.name,
                "mediaType": media_type,
                "digest": digest.hexdigest(),
                "observedSize": size,
                "observedModifiedAt": modified_at,
            }
            staged_path = None
            return result
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if staged_path is not None and staged_path.exists():
                try:
                    staged_path.unlink()
                except OSError:
                    pass

    @contextmanager
    def _temporary_resume_source(self, original_filename: Any, content: bytes):
        """Materialize bounded browser bytes privately for canonical path ingestion."""

        if (
            not isinstance(original_filename, str)
            or not original_filename
            or Path(original_filename).name != original_filename
            or "\0" in original_filename
        ):
            raise StoreError("resume filename is invalid")
        extension = Path(original_filename).suffix.lower()
        if extension not in RESUME_MEDIA_TYPES:
            raise StoreError("resume format must be PDF, DOCX, or UTF-8 TXT")
        if not isinstance(content, bytes):
            raise StoreError("resume content is invalid")
        if len(content) > RESUME_MAX_BYTES:
            raise StoreError("resume file exceeds the 10 MiB limit")
        _ensure_private_dir(self.resume_files_path)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="wb",
                dir=self.resume_files_path,
                prefix=".browser-upload.",
                suffix=extension,
                delete=False,
            ) as staged:
                temporary_path = Path(staged.name)
                staged.write(content)
                staged.flush()
                os.fsync(staged.fileno())
            _set_private_mode(temporary_path, 0o600)
            yield temporary_path
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except OSError:
                    # A successful canonical commit must stay successful. The
                    # private orphan is collected after the recovery grace.
                    pass

    @contextmanager
    def _staged_resume(self, source_value: Any, resume_id: str):
        staged = self._stage_resume_import(source_value, resume_id)
        try:
            yield staged
        finally:
            try:
                staged["path"].unlink()
            except FileNotFoundError:
                pass

    def _install_staged_resume(
        self,
        staged: dict[str, Any],
        destination: Path,
        write_metadata,
        previous: Path | None = None,
        rollback_metadata=None,
    ) -> None:
        quarantine: Path | None = None
        installed = False
        try:
            if previous is not None and previous.exists():
                quarantine = self.resume_files_path / f".{previous.name}.{uuid.uuid4().hex}.quarantine"
                os.replace(previous, quarantine)
            os.replace(staged["path"], destination)
            installed = True
            _set_private_mode(destination, 0o600)
            _fsync_directory(self.resume_files_path)
            write_metadata()
        except Exception:
            if installed:
                try:
                    destination.unlink()
                except FileNotFoundError:
                    pass
            if quarantine is not None and quarantine.exists():
                os.replace(quarantine, previous)
            _fsync_directory(self.resume_files_path)
            if rollback_metadata is not None:
                rollback_metadata()
            raise
        else:
            if quarantine is not None:
                try:
                    quarantine.unlink()
                except OSError:
                    pass
            _fsync_directory(self.resume_files_path)

    def profile_preparedness(self) -> dict[str, Any]:
        """Project value-free setup, coverage, and review state from Store data."""
        self.initialize()
        with exclusive_file_lock(self.store_lock_path):
            profile_document = self._load_profile_document()
            profile = profile_document["profile"]
            provenance = profile_document["metadata"].get("factProvenance", {})
            resumes = self._load_resumes_document()["resumes"]
            default_resume = next((
                item for item in resumes.values()
                if item.get("default") and item.get("deletedAt") is None
            ), None)

            essential_setup = []
            for item_id, key in (
                ("first_name", "firstName"),
                ("last_name", "lastName"),
                ("email", "email"),
            ):
                present = _meaningfully_present(profile.get(key))
                essential_setup.append({
                    "id": item_id,
                    "paths": [f"/{key}"],
                    "state": "present" if present else "blocked",
                    "reasonCode": None if present else f"{item_id}_missing",
                })

            resume_item: dict[str, Any] = {
                "id": "default_resume", "state": "blocked",
                "reasonCode": "default_resume_missing",
            }
            if default_resume is not None:
                resume_item["resumeId"] = default_resume["id"]
                if default_resume.get("storageKind") != "managed":
                    resume_item["reasonCode"] = "default_resume_unreadable"
                else:
                    observation = self._managed_resume_observation(default_resume)
                    if not observation["exists"]:
                        resume_item["reasonCode"] = "default_resume_unreadable"
                    elif observation.get("digest") != default_resume.get("digest"):
                        resume_item["reasonCode"] = "default_resume_changed"
                    else:
                        resume_item.update({"state": "present", "reasonCode": None})
            essential_setup.append(resume_item)

            coverage_groups = (
                ("phone", ("phone",)),
                ("location", ("location",)),
                ("work_history", ("workHistory",)),
                ("education", ("education",)),
                ("skills", ("skills",)),
                ("professional_links", ("linkedInUrl", "portfolioUrl", "githubUrl")),
            )
            common_coverage = []
            for item_id, keys in coverage_groups:
                present = any(_meaningfully_present(profile.get(key)) for key in keys)
                common_coverage.append({
                    "id": item_id,
                    "paths": [f"/{key}" for key in keys],
                    "state": "present" if present else "not_present",
                    "reasonCode": None if present else f"{item_id}_missing",
                })

            requests = (
                self._load_extraction_requests_document()["requests"].values()
                if self.resume_extraction_requests_path.exists() else []
            )
            review_health: list[dict[str, Any]] = []
            for request in requests:
                status = request["status"]
                if status not in {"requested", "failed", "stale"}:
                    continue
                item = {
                    "kind": "extraction_request",
                    "reasonCode": {
                        "requested": "extraction_requested",
                        "failed": "extraction_failed",
                        "stale": "extraction_stale",
                    }[status],
                    "resumeId": request["resumeId"],
                    "requestId": request["requestId"],
                }
                if status == "failed":
                    item["failureReason"] = request["failureReason"]
                review_health.append(item)

            proposals = (
                self._load_extractions_document()["proposals"].values()
                if self.resume_extractions_path.exists() else []
            )
            for proposal in proposals:
                if proposal["status"] != "pending" or not proposal["pendingPaths"]:
                    continue
                review_health.append({
                    "kind": "resume_proposal",
                    "reasonCode": "unresolved_conflicts",
                    "resumeId": proposal["resumeId"],
                    "proposalId": proposal["id"],
                    "count": len(proposal["pendingPaths"]),
                })
                protected_count = sum(
                    self._user_protects_path(provenance, path)
                    for path in proposal["pendingPaths"]
                )
                if protected_count:
                    review_health.append({
                        "kind": "resume_proposal",
                        "reasonCode": "human_protected_facts_retained",
                        "resumeId": proposal["resumeId"],
                        "proposalId": proposal["id"],
                        "count": protected_count,
                    })
            review_health.sort(key=lambda item: (
                item["kind"], item["reasonCode"],
                item.get("requestId", item.get("proposalId", "")),
            ))
            return {
                "essentialSetup": essential_setup,
                "commonCoverage": common_coverage,
                "reviewHealth": review_health,
            }

    def _reject_answer_collisions(
        self,
        answers: dict[str, Any],
        candidate: dict[str, Any],
        key: str,
        redirects: dict[str, Any] | None = None,
        redirect_targets: set[str] | None = None,
    ) -> None:
        candidate_names = self._answer_candidates(candidate)
        permitted_redirect_targets = redirect_targets or {key}
        for other_key, raw in answers.items():
            if other_key == key:
                continue
            other = _require_object(raw, "answer record")
            if _json_values_equal(other.get("scope", {}), candidate.get("scope", {})) and candidate_names & self._answer_candidates(other):
                raise StoreError("answer question or alias collides within scope")
        for normalized in candidate_names:
            retired_key = answer_key(normalized, candidate.get("scope", {}))
            redirect = (redirects or {}).get(retired_key)
            if redirect is not None and redirect.get("targetKey") not in permitted_redirect_targets:
                raise StoreError("answer question or alias is a retired redirect identity")

    def _preview_answer_cleanup_document(
        self, document: dict[str, Any]
    ) -> dict[str, Any]:
        candidates = []
        for record in document["answers"].values():
            if (
                not isinstance(record.get("key"), str)
                or not record["key"].strip()
                or not isinstance(record.get("question"), str)
                or not record["question"].strip()
            ):
                continue
            candidates.append(self._semantic_candidate(record))
        try:
            proposed = ANSWER_MATCH_MODULE.propose_cleanup(candidates=candidates)
        except Exception:
            raise StoreError("answer cleanup preview is invalid") from None
        revisions = {
            key: record.get("revision", 1)
            for key, record in document["answers"].items()
        }
        questions = {
            key: record["question"]
            for key, record in document["answers"].items()
            if isinstance(record.get("question"), str) and record["question"].strip()
        }
        proposals = [
            proposal | {
                "winnerRevision": revisions[proposal["winnerKey"]],
                "duplicateRevision": revisions[proposal["duplicateKey"]],
                "winnerQuestion": questions[proposal["winnerKey"]],
                "duplicateQuestion": questions[proposal["duplicateKey"]],
            }
            for proposal in proposed
        ]
        token = "answer-cleanup-v1." + hashlib.sha256(
            _canonical_json({"proposals": proposals, "revisions": revisions}).encode("utf-8")
        ).hexdigest()
        return {"proposals": proposals, "previewToken": token, "mutated": False}

    def preview_answer_cleanup(self) -> dict[str, Any]:
        """Return a revision-bound, value-free duplicate cleanup preview."""

        self.initialize()
        with exclusive_file_lock(self.store_lock_path):
            return self._preview_answer_cleanup_document(
                self._load_answers_document()
            )

    def approve_answer_cleanup(
        self, incoming: dict[str, Any], owner_confirmed: bool = False
    ) -> dict[str, Any]:
        packet = _require_object(incoming, "answer cleanup approval")
        required = {
            "previewToken", "winnerKey", "duplicateKey", "winnerRevision",
            "duplicateRevision",
        }
        if (
            set(packet) != required
            or owner_confirmed is not True
            or not isinstance(packet.get("previewToken"), str)
        ):
            raise StoreError("answer cleanup requires explicit owner approval")
        merged = self.merge_answers(
            packet["winnerKey"], packet["duplicateKey"],
            packet["winnerRevision"], packet["duplicateRevision"],
            cleanup_approval=packet,
        )
        return {"approved": True, "result": merged}

    def put_answer(
        self,
        incoming: dict[str, Any],
        remember_sensitive: bool = False,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        question = incoming.get("question")
        scope = incoming.get("scope", {})
        if not isinstance(scope, dict):
            raise StoreError("answer scope must be a JSON object")
        key = incoming.get("key")
        if key is None:
            if not isinstance(question, str):
                raise StoreError("answer requires a question or explicit key")
            key = answer_key(question, scope)
        if not isinstance(key, str) or not key.strip():
            raise StoreError("answer key must be a non-empty string")
        current_review_status = incoming.get("reviewStatus", "accepted")
        if (
            not isinstance(current_review_status, str)
            or current_review_status not in ANSWER_REVIEW_STATUSES
        ):
            raise StoreError("answer review status is unsupported")

        state = incoming.get("state")
        if state not in ANSWER_STATES:
            raise StoreError("answer state is unsupported")
        sensitivity = incoming.get(
            "sensitivity", "high" if state == "sensitive" else "none"
        )
        if sensitivity not in SENSITIVITY_LEVELS:
            raise StoreError("answer sensitivity is unsupported")
        value = incoming.get("value")
        if state == "confirmed" and value is None:
            raise StoreError("confirmed answers require a value")
        if state == "missing" and value is not None:
            raise StoreError("missing answers cannot contain a value")
        requires_consent = value is not None and (
            state == "sensitive" or sensitivity != "none"
        )
        if requires_consent and not remember_sensitive:
            raise StoreError(
                "sensitive answer value requires explicit remember consent"
            )

        aliases = incoming.get("aliases", [])
        if not isinstance(aliases, list) or not all(
            isinstance(alias, str) for alias in aliases
        ):
            raise StoreError("answer aliases must be strings")
        normalized_aliases: list[str] = []
        for alias in aliases:
            normalized = normalize_question(alias)
            if normalized and normalized not in normalized_aliases:
                normalized_aliases.append(normalized)

        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            if key in self._answer_redirects(document):
                raise StoreError("answer key was merged and cannot be resurrected")
            current = document["answers"].get(key)
            if current is not None and current.get("deletedAt") is not None:
                raise StoreError("answer is trashed")
            if current is not None:
                if (
                    not isinstance(expected_revision, int)
                    or isinstance(expected_revision, bool)
                    or expected_revision < 1
                ):
                    raise StoreError("existing answer put requires expected revision")
                if current.get("revision", 1) != expected_revision:
                    raise StoreError("answer revision conflict")
            elif current_review_status != "accepted":
                raise StoreError(
                    "new answers created through put must have accepted review status"
                )
            now = utc_now()
            record = dict(_require_object(current or {}, "answer record"))
            record.update(
                {
                    "key": key,
                    "question": question,
                    "aliases": normalized_aliases,
                    "value": value,
                    "state": state,
                    "source": incoming.get("source", "user"),
                    "scope": scope,
                    "fieldClass": incoming.get(
                        "fieldClass", record.get("fieldClass", "general")
                    ),
                    "sensitivity": sensitivity,
                    "reviewStatus": (
                        record.get("reviewStatus", "accepted")
                        if current is not None
                        else incoming.get("reviewStatus", "accepted")
                    ),
                    "createdAt": record.get("createdAt") or now,
                    "updatedAt": now,
                    "deletedAt": None,
                    "revision": (
                        record.get("revision", 1) + 1 if current is not None else 1
                    ),
                }
            )
            if current is None:
                record["observationCount"] = incoming.get("observationCount", 0)
                for field in ("observedAt", "lastObservedAt", "reviewedAt"):
                    if field in incoming:
                        record[field] = incoming[field]
            else:
                record["observationCount"] = current.get("observationCount", 0)
                for field in ("observedAt", "lastObservedAt", "reviewedAt"):
                    if field in current:
                        record[field] = current[field]
                    else:
                        record.pop(field, None)
            if state == "confirmed":
                record["confirmedAt"] = incoming.get("confirmedAt") or now
            else:
                record["confirmedAt"] = incoming.get("confirmedAt")
            if requires_consent:
                record["rememberedWithConsentAt"] = now
            else:
                record.pop("rememberedWithConsentAt", None)

            _validate_answer_record(key, record)
            self._reject_answer_collisions(
                document["answers"], record, key, self._answer_redirects(document)
            )
            counts = self._answer_reference_counts(document=document)
            document["answers"][key] = record
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.answers_path, document)
        return self._answer_mutation_projection(record, counts)

    def update_answer(
        self,
        key: str,
        patch: dict[str, Any],
        expected_revision: int,
        remember_sensitive: bool = False,
        _review_status_transition: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        allowed = {
            "question",
            "aliases",
            "value",
            "state",
            "source",
            "scope",
            "fieldClass",
            "sensitivity",
        }
        if (
            (not patch and _review_status_transition is None)
            or set(patch) - allowed
            or _review_status_transition not in {None, "accepted", "declined"}
        ):
            raise StoreError("answer patch contains unsupported fields")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            current = document["answers"].get(key)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("answer does not exist")
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            if (
                _review_status_transition is not None
                and current.get("reviewStatus", "accepted") != "pending"
            ):
                raise StoreError("only pending answers can be reviewed")
            updated = {**current, **patch}
            aliases = updated.get("aliases", [])
            if not isinstance(aliases, list) or not all(
                isinstance(alias, str) for alias in aliases
            ):
                raise StoreError("answer aliases must be strings")
            normalized_aliases: list[str] = []
            for alias in aliases:
                normalized = normalize_question(alias)
                if normalized and normalized not in normalized_aliases:
                    normalized_aliases.append(normalized)
            updated["aliases"] = normalized_aliases
            scope = updated.get("scope", {})
            if not isinstance(scope, dict):
                raise StoreError("answer scope must be a JSON object")
            state = updated.get("state")
            if state not in ANSWER_STATES:
                raise StoreError("answer state is unsupported")
            sensitivity = updated.get(
                "sensitivity", "high" if state == "sensitive" else "none"
            )
            if sensitivity not in SENSITIVITY_LEVELS:
                raise StoreError("answer sensitivity is unsupported")
            value = updated.get("value")
            if state == "confirmed" and value is None:
                raise StoreError("confirmed answers require a value")
            if state == "missing" and value is not None:
                raise StoreError("missing answers cannot contain a value")
            requires_consent = value is not None and (
                state == "sensitive" or sensitivity != "none"
            )
            changed_sensitive_value = (
                value != current.get("value")
                or not current.get("rememberedWithConsentAt")
            )
            if requires_consent and changed_sensitive_value and not remember_sensitive:
                raise StoreError(
                    "sensitive answer value requires explicit remember consent"
                )
            now = utc_now()
            updated["sensitivity"] = sensitivity
            updated["revision"] = revision + 1
            updated["createdAt"] = current.get("createdAt") or current.get("updatedAt") or now
            updated["updatedAt"] = now
            updated["deletedAt"] = None
            if _review_status_transition is not None:
                updated["reviewStatus"] = _review_status_transition
                updated["reviewedAt"] = now
            if state == "confirmed":
                if state != current.get("state") or value != current.get("value"):
                    updated["confirmedAt"] = now
                else:
                    updated["confirmedAt"] = current.get("confirmedAt") or now
            else:
                updated["confirmedAt"] = None
            if requires_consent:
                if changed_sensitive_value:
                    updated["rememberedWithConsentAt"] = now
            else:
                updated.pop("rememberedWithConsentAt", None)
            _validate_answer_record(key, updated)
            self._reject_answer_collisions(
                document["answers"], updated, key, self._answer_redirects(document)
            )
            counts = self._answer_reference_counts(document=document)
            document["answers"][key] = updated
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.answers_path, document)
        return self._answer_mutation_projection(updated, counts)

    def observe_answer(self, incoming: dict[str, Any]) -> dict[str, Any]:
        question = incoming.get("question")
        scope = incoming.get("scope", {})
        state = incoming.get("state", "inferred" if incoming.get("value") is not None else "missing")
        if not isinstance(question, str) or not isinstance(scope, dict):
            raise StoreError("observed answer requires question and object scope")
        if state not in {"missing", "inferred"}:
            raise StoreError("observed answer state must be missing or inferred")
        if incoming.get("value") is not None and incoming.get("sensitivity", "none") != "none":
            raise StoreError("sensitive observed values require review and fresh remember consent")
        self.initialize()
        now = utc_now()
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            normalized = normalize_question(question)
            current = next(
                (
                    record for record in document["answers"].values()
                    if _json_values_equal(record.get("scope", {}), scope)
                    and normalized in self._answer_candidates(record)
                ),
                None,
            )
            if current is not None:
                key = current["key"]
            else:
                computed_key = answer_key(question, scope)
                key = self._resolve_answer_key_in_document(document, computed_key)
                current = document["answers"].get(key)
                if current is not None and not _json_values_equal(current.get("scope", {}), scope):
                    raise StoreError(
                        "observed answer derived key is occupied by a different scope"
                    )
            if current is not None:
                if current.get("deletedAt") is not None:
                    raise StoreError("observed answer is trashed")
                updated = dict(current)
                updated["reviewStatus"] = current.get("reviewStatus", "accepted")
                updated["lastObservedAt"] = now
                updated["observedAt"] = updated.get("observedAt") or now
                updated["observationCount"] = updated.get("observationCount", 0) + 1
                updated["updatedAt"] = now
                updated["revision"] = updated.get("revision", 1) + 1
                _validate_answer_record(key, updated)
                document["answers"][key] = updated
            else:
                payload = {
                    **incoming,
                    "key": key,
                    "state": state,
                    "reviewStatus": "pending",
                    "observedAt": now,
                    "lastObservedAt": now,
                    "observationCount": 1,
                    "source": incoming.get("source", "agent"),
                }
                value = payload.get("value")
                if state == "missing" and value is not None:
                    raise StoreError("missing answers cannot contain a value")
                updated = {
                    "key": key,
                    "question": question,
                    "aliases": [],
                    "value": value,
                    "state": state,
                    "source": payload["source"],
                    "scope": scope,
                    "fieldClass": payload.get("fieldClass", "general"),
                    "sensitivity": payload.get("sensitivity", "none"),
                    "reviewStatus": "pending",
                    "observedAt": now,
                    "lastObservedAt": now,
                    "observationCount": 1,
                    "confirmedAt": None,
                    "createdAt": now,
                    "updatedAt": now,
                    "deletedAt": None,
                    "revision": 1,
                }
                _validate_answer_record(key, updated)
                self._reject_answer_collisions(
                    document["answers"], updated, key, self._answer_redirects(document)
                )
                document["answers"][key] = updated
            counts = self._answer_reference_counts(document=document)
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.answers_path, document)
        return self._answer_mutation_projection(updated, counts)

    def review_answer(
        self,
        key: str,
        review_status: str,
        expected_revision: int,
        patch: dict[str, Any] | None = None,
        remember_sensitive: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(review_status, str) or review_status not in {
            "accepted",
            "declined",
        }:
            raise StoreError("answer review decision must be accepted or declined")
        if patch is not None and "reviewStatus" in patch:
            raise StoreError("answer review patch cannot set review status")
        return self.update_answer(
            key,
            patch or {},
            expected_revision,
            remember_sensitive=remember_sensitive,
            _review_status_transition=review_status,
        )

    @staticmethod
    def _merged_observation_field(
        winner: dict[str, Any], source: dict[str, Any], field: str, earliest: bool
    ) -> str | None:
        values = [
            value for value in (winner.get(field), source.get(field))
            if isinstance(value, str) and value
        ]
        if not values:
            return None
        return min(values) if earliest else max(values)

    def _apply_answer_merge_locked(
        self, document: dict[str, Any], operation: dict[str, Any]
    ) -> dict[str, Any]:
        winner_key = operation["winnerKey"]
        source_key = operation["sourceKey"]
        expected_winner = operation["expectedWinnerRevision"]
        expected_source = operation["expectedSourceRevision"]
        redirects = document.setdefault("redirects", {})
        winner = document["answers"].get(winner_key)
        source = document["answers"].get(source_key)
        if source is None:
            redirect = redirects.get(source_key)
            if (
                redirect is None
                or redirect.get("targetKey") != winner_key
                or winner is None
                or winner.get("revision", 1) != expected_winner + 1
            ):
                raise StoreError("coordinator answer merge cannot be reconciled")
            return self._answer_view(winner)
        if winner is None:
            raise StoreError("answer merge winner does not exist")
        if (
            winner.get("revision", 1) != expected_winner
            or source.get("revision", 1) != expected_source
        ):
            raise StoreError("answer merge revision conflict")
        if winner.get("deletedAt") is not None or source.get("deletedAt") is not None:
            raise StoreError("answer merge records must be active")
        if winner.get("reviewStatus", "accepted") != "accepted":
            raise StoreError("answer merge winner must be accepted")
        if not _json_values_equal(winner.get("scope", {}), source.get("scope", {})):
            raise StoreError("answer merge requires exact matching scope")

        aliases: list[str] = []
        winner_question_value = winner.get("question")
        winner_question = normalize_question(
            winner_question_value
            if isinstance(winner_question_value, str) and winner_question_value.strip()
            else winner_key
        )
        for value in [
            *winner.get("aliases", []),
            source.get("question"),
            *source.get("aliases", []),
        ]:
            if not isinstance(value, str) or not value.strip():
                continue
            normalized = normalize_question(value)
            if normalized != winner_question and normalized not in aliases:
                aliases.append(normalized)
        merged = dict(winner)
        merged["aliases"] = aliases
        merged["observationCount"] = (
            winner.get("observationCount", 0) + source.get("observationCount", 0)
        )
        for field, earliest in (("observedAt", True), ("lastObservedAt", False)):
            value = self._merged_observation_field(winner, source, field, earliest)
            if value is None:
                merged.pop(field, None)
            else:
                merged[field] = value
        merged["revision"] = expected_winner + 1
        merged["updatedAt"] = operation["at"]
        _validate_answer_record(winner_key, merged)
        collision_candidates = {
            key: value for key, value in document["answers"].items()
            if key != source_key
        }
        self._reject_answer_collisions(
            collision_candidates,
            merged,
            winner_key,
            redirects,
            {winner_key, source_key},
        )
        document["answers"][winner_key] = merged
        del document["answers"][source_key]
        for redirect in redirects.values():
            if redirect["targetKey"] == source_key:
                redirect["targetKey"] = winner_key
        redirects[source_key] = {
            "targetKey": winner_key,
            "mergedAt": operation["at"],
        }
        document["metadata"]["updatedAt"] = operation["at"]
        _validate_answer_redirects(redirects, document["answers"])
        return self._answer_view(merged)

    @staticmethod
    def _rewrite_session_answer_key(
        session: dict[str, Any], source_key: str, winner_key: str, at: str
    ) -> dict[str, Any]:
        rewritten = copy.deepcopy(session)
        keys: list[str] = []
        for key in rewritten.get("answerKeys", []):
            key = winner_key if key == source_key else key
            if key not in keys:
                keys.append(key)
        rewritten["answerKeys"] = keys
        for field in rewritten.get("pendingFields", []):
            if field.get("answerKey") == source_key:
                field["answerKey"] = winner_key
                field.pop("matchConfidence", None)
                field.pop("matchReasonCodes", None)
                field.pop("matchAnswerRevision", None)
        rewritten["approvals"] = [
            approval
            for approval in rewritten.get("approvals", [])
            if approval.get("answerKey") != source_key
        ]
        rewritten["updatedAt"] = at
        _validate_session_document(rewritten)
        return rewritten

    def merge_answers(
        self,
        winner_key: str,
        source_key: str,
        expected_winner_revision: int,
        expected_source_revision: int,
        *,
        cleanup_approval: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        if not all(isinstance(key, str) and key for key in (winner_key, source_key)):
            raise StoreError("answer merge keys must be non-empty strings")
        if winner_key == source_key:
            raise StoreError("answer merge requires distinct records")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            if cleanup_approval is not None:
                current_preview = self._preview_answer_cleanup_document(document)
                if not hmac.compare_digest(
                    cleanup_approval["previewToken"],
                    current_preview["previewToken"],
                ):
                    raise StoreError("answer cleanup preview is stale")
                selected = {
                    key: cleanup_approval[key]
                    for key in (
                        "winnerKey", "duplicateKey", "winnerRevision",
                        "duplicateRevision",
                    )
                }
                if not any(
                    all(proposal.get(key) == value for key, value in selected.items())
                    for proposal in current_preview["proposals"]
                ):
                    raise StoreError(
                        "answer cleanup selection is not in the preview"
                    )
            redirects = self._answer_redirects(document)
            if winner_key in redirects or source_key in redirects:
                raise StoreError("answer merge records must be canonical active records")
            winner = document["answers"].get(winner_key)
            source = document["answers"].get(source_key)
            if winner is None or source is None:
                raise StoreError("answer merge record does not exist")
            # Validate every semantic and collision condition against an in-memory
            # operation before the crash-recovery journal can become durable.
            now = utc_now()
            preview = {
                "kind": "answer_merge",
                "operationId": uuid.uuid4().hex,
                "at": now,
                "winnerKey": winner_key,
                "sourceKey": source_key,
                "expectedWinnerRevision": expected_winner_revision,
                "expectedSourceRevision": expected_source_revision,
                "sessions": [],
                "resultClaim": self._load_coordinator_document()["claim"],
            }
            preview_document = copy.deepcopy(document)
            preview_merged = self._apply_answer_merge_locked(preview_document, preview)
            sessions = []
            all_sessions = self._list_sessions_uninitialized()
            for session in all_sessions:
                if source_key in session.get("answerKeys", []) or any(
                    field.get("answerKey") == source_key
                    for field in session.get("pendingFields", [])
                ):
                    sessions.append(
                        self._rewrite_session_answer_key(
                            session, source_key, winner_key, now
                        )
                    )
            preview["sessions"] = sessions
            rewritten_by_id = {
                session["applicationId"]: session for session in sessions
            }
            projected_sessions = [
                rewritten_by_id.get(session["applicationId"], session)
                for session in all_sessions
            ]
            counts = self._answer_reference_counts(
                document=preview_document,
                sessions=projected_sessions,
                history=self.read_history(),
            )
            self._commit_coordinator_operation_locked(preview)
            result = self._answer_projection(preview_merged, counts)
            result["mergedFrom"] = source_key
            return result

    def trash_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        return self._set_answer_deleted(key, expected_revision, restore=False)

    def restore_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        return self._set_answer_deleted(key, expected_revision, restore=True)

    def _set_answer_deleted(
        self, key: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            redirects = self._answer_redirects(document)
            current = document["answers"].get(key)
            if current is None:
                raise StoreError("answer does not exist")
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                updated = dict(current)
            else:
                if not restore and any(
                    redirect["targetKey"] == key for redirect in redirects.values()
                ):
                    raise StoreError("answer is the target of an immutable redirect")
                updated = dict(current)
                updated["deletedAt"] = None if restore else utc_now()
                updated["revision"] = revision + 1
                updated["updatedAt"] = utc_now()
                _validate_answer_record(key, updated)
                counts = self._answer_reference_counts(document=document)
                document["answers"][key] = updated
                document["metadata"]["updatedAt"] = updated["updatedAt"]
                atomic_write_json(self.answers_path, document)
            if restore == (not is_trashed):
                counts = self._answer_reference_counts(document=document)
        return self._answer_mutation_projection(updated, counts)

    def delete_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            redirects = self._answer_redirects(document)
            if key in redirects:
                raise StoreError("merged answer redirects are immutable")
            current = document["answers"].get(key)
            if current is None:
                return {"deleted": False, "key": key}
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("answer must be trashed before permanent deletion")
            if any(
                redirect["targetKey"] == key for redirect in redirects.values()
            ):
                raise StoreError("answer is the target of an immutable redirect")
            for session in self._list_sessions_uninitialized():
                if key in session.get("answerKeys", []) or any(
                    field.get("answerKey") == key
                    for field in session.get("pendingFields", [])
                ):
                    raise StoreError("answer is referenced by an active session")
            if any(key in event.get("answerKeys", []) for event in self.read_history()):
                raise StoreError("answer is referenced by application history")
            del document["answers"][key]
            document["metadata"]["updatedAt"] = utc_now()
            atomic_write_json(self.answers_path, document)
        return {"deleted": True, "key": key}

    def _require_active_resume(self, resume_id: str | None) -> None:
        if resume_id is None:
            return
        if not isinstance(resume_id, str):
            raise StoreError("job resume id must be a string")
        _safe_session_id(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("assigned resume does not exist")

    def create_job(
        self, incoming: dict[str, Any], origin: str = "human"
    ) -> dict[str, Any]:
        self.initialize()
        origin = _job_origin(origin)
        allowed = {
            "id",
            "url",
            "source",
            "sourceId",
            "role",
            "company",
            "location",
            "workplaceType",
            "employmentType",
            "compensation",
            "description",
            "ats",
            "priority",
            "status",
            "closedOutcome",
            "resumeId",
            "notes",
            "provenance",
            "lastCheckedAt",
        }
        if set(incoming) - allowed:
            raise StoreError("job input contains unsupported fields")
        url = incoming.get("url")
        normalized_url = normalize_job_url(url)
        job_id = incoming.get("id") or f"job-{uuid.uuid4()}"
        _safe_session_id(job_id)
        status = incoming.get("status", "saved")
        if status != "saved":
            raise StoreError("new jobs must start with saved status")
        now = utc_now()
        incoming_provenance = _require_object(
            incoming.get("provenance", {}), "job provenance"
        )
        _reject_supplied_migration_provenance(incoming_provenance)
        stamped_fields = {
            field
            for field in JOB_INGEST_FIELDS
            if field in incoming and _nonempty_job_value(incoming[field])
        }
        record = {
            **incoming,
            "id": job_id,
            "url": url.strip(),
            "normalizedUrl": normalized_url,
            "priority": incoming.get("priority", 0),
            "status": status,
            "closedOutcome": incoming.get("closedOutcome"),
            "provenance": _stamp_job_provenance(
                incoming_provenance,
                stamped_fields,
                origin,
                _job_observation_source(incoming),
                now,
            ),
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        _validate_job_record(job_id, record)
        with exclusive_file_lock(self.store_lock_path):
            self._require_active_resume(incoming.get("resumeId"))
            document = self._load_jobs_document()
            if job_id in document["jobs"]:
                raise StoreError("job id already exists")
            duplicate = next(
                (
                    item
                    for item in document["jobs"].values()
                    if item.get("deletedAt") is None
                    and item.get("normalizedUrl") == normalized_url
                ),
                None,
            )
            if duplicate is not None:
                raise StoreError("active job URL already exists")
            document["jobs"][job_id] = record
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.jobs_path, document)
        return record

    def get_job(self, job_id: str, include_trashed: bool = False) -> dict[str, Any] | None:
        self.initialize()
        _safe_session_id(job_id)
        record = self._load_jobs_document()["jobs"].get(job_id)
        if record is None or (record.get("deletedAt") is not None and not include_trashed):
            return None
        return _require_object(record, "job record")

    def list_jobs(
        self,
        status: str | None = None,
        include_trashed: bool = False,
        trashed_only: bool = False,
    ) -> list[dict[str, Any]]:
        self.initialize()
        if status is not None and status not in JOB_STATUSES:
            raise StoreError("job status is unsupported")
        if trashed_only:
            include_trashed = True
        records = []
        for record in self._load_jobs_document()["jobs"].values():
            if record.get("deletedAt") is not None and not include_trashed:
                continue
            if trashed_only and record.get("deletedAt") is None:
                continue
            if status is not None and record.get("status") != status:
                continue
            records.append(record)
        return sorted(
            records,
            key=lambda item: (
                -item.get("priority", 0),
                item.get("createdAt", ""),
                item["id"],
            ),
        )

    @staticmethod
    def _task_job_projection(record: dict[str, Any]) -> dict[str, Any]:
        """Project one canonical job without URLs, notes, or provenance."""

        return {
            key: record[key]
            for key in (
                "id", "role", "company", "location", "workplaceType",
                "employmentType", "status", "priority", "revision", "createdAt",
                "updatedAt",
            )
            if key in record
        }

    def task_snapshot(self) -> dict[str, Any]:
        """Return the shared, Store-owned task view used for job discussion."""

        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            profile = self._load_profile_document()["profile"]
            jobs = [
                item for item in self._load_jobs_document()["jobs"].values()
                if item.get("deletedAt") is None
            ]
            resumes = [
                item for item in self._load_resumes_document()["resumes"].values()
                if item.get("deletedAt") is None
            ]
            answers = [
                item for item in self._load_answers_document()["answers"].values()
                if item.get("deletedAt") is None
                and item.get("reviewStatus", "accepted") == "accepted"
            ]
            claim = self._load_coordinator_document()["claim"]
            now = self._now_datetime()
            overview = self._owner_beta_overview_locked(
                profile, jobs, resumes, answers, claim, now
            )
            projected_jobs = [
                self._task_job_projection(item)
                for item in sorted(
                    jobs,
                    key=lambda item: (
                        -item.get("priority", 0),
                        item.get("createdAt", ""),
                        item["id"],
                    ),
                )
            ]
            attention = self._needs_attention_locked(
                {item["id"]: item for item in jobs}, claim, now
            )
        signature_input = {
            "overview": overview,
            "jobs": projected_jobs,
            "attentionSignature": attention["snapshotSignature"],
        }
        return {
            "overview": overview,
            "jobs": projected_jobs,
            "attention": attention,
            "snapshotSignature": hashlib.sha256(
                _canonical_json(signature_input).encode("utf-8")
            ).hexdigest(),
        }

    def intake_task_job(
        self, incoming: dict[str, Any], origin: str = "agent"
    ) -> dict[str, Any]:
        """Atomically resolve or create exactly one active canonical job."""

        self.initialize()
        origin = _job_origin(origin)
        payload = {"jobs": [incoming]}
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            planned, decisions, changed = self._plan_job_upsert(
                document, payload, origin, utc_now()
            )
            if len(decisions) != 1:
                raise StoreError("task intake did not resolve exactly one job")
            decision = decisions[0]
            if decision["action"] in {"conflict", "invalid"}:
                raise StoreError(f"task intake {decision['action']}")
            job_id = decision.get("id")
            record = planned["jobs"].get(job_id)
            if (
                not isinstance(job_id, str)
                or record is None
                or record.get("deletedAt") is not None
            ):
                raise StoreError("task intake did not resolve one active job")
            if changed:
                atomic_write_json(self.jobs_path, planned)
        return {
            "action": decision["action"],
            "job": self._task_job_projection(record),
        }

    def select_task_job_ready(
        self, job_id: str, expected_revision: int, owner_confirmed: bool
    ) -> dict[str, Any]:
        """Apply an explicit, revision-bound owner choice to one canonical job."""

        self.initialize()
        _safe_session_id(job_id)
        if owner_confirmed is not True:
            raise StoreError("task selection requires owner confirmation")
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool):
            raise StoreError("task selection requires an exact revision")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("task selection job is unavailable")
            if current["revision"] != expected_revision:
                raise StoreError("task selection revision conflict")
            self._require_job_unclaimed_locked(job_id)
            if current["status"] not in {"saved", "needs_info", "ready"}:
                raise StoreError("task selection job is unavailable")
            if not self._preflight_job_record(current)["ready"]:
                raise StoreError("task selection preflight failed")
            if current["status"] == "ready":
                return {
                    "action": "noop",
                    "job": self._task_job_projection(current),
                }
            updated = dict(current)
            updated["status"] = "ready"
            updated["closedOutcome"] = None
            updated["revision"] += 1
            updated["updatedAt"] = utc_now()
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return {"action": "ready", "job": self._task_job_projection(updated)}

    def owner_beta_overview(self) -> dict[str, Any]:
        """Return a value-free, Store-derived projection for the companion landing page."""

        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            profile = self._load_profile_document()["profile"]
            jobs = [
                item for item in self._load_jobs_document()["jobs"].values()
                if item.get("deletedAt") is None
            ]
            resumes = [
                item for item in self._load_resumes_document()["resumes"].values()
                if item.get("deletedAt") is None
            ]
            answers = [
                item for item in self._load_answers_document()["answers"].values()
                if item.get("deletedAt") is None
                and item.get("reviewStatus", "accepted") == "accepted"
            ]
            claim = self._load_coordinator_document()["claim"]
            now = self._now_datetime()
            return self._owner_beta_overview_locked(
                profile, jobs, resumes, answers, claim, now
            )

    def _owner_beta_overview_locked(
        self,
        profile: dict[str, Any],
        jobs: list[dict[str, Any]],
        resumes: list[dict[str, Any]],
        answers: list[dict[str, Any]],
        claim: dict[str, Any] | None,
        now: datetime,
    ) -> dict[str, Any]:
        """Derive the canonical overview from documents already read under the lock."""

        attention_count = 0
        for job in jobs:
            status = job["status"]
            if status in {"needs_info", "awaiting_review"}:
                attention_count += 1
            elif status == "in_progress":
                owns_job = claim is not None and claim["jobId"] == job["id"]
                if not owns_job or now >= self._parse_time(claim["expiresAt"]):
                    attention_count += 1

        live_claim = (
            claim is not None
            and now < self._parse_time(claim["expiresAt"])
        )
        acquirable_ready_count = 0
        if not live_claim:
            resumes_by_id = {resume["id"]: resume for resume in resumes}
            active_resume_ids = set(resumes_by_id)
            self._overview_resume_digest_cache = {
                key: value
                for key, value in self._overview_resume_digest_cache.items()
                if key in active_resume_ids
            }
            resume_observations: dict[str, dict[str, Any]] = {}
            acquirable_ready_count = sum(
                self._preflight_job_record(
                    item,
                    profile=profile,
                    resumes=resumes_by_id,
                    resume_observations=resume_observations,
                    managed_digest_cache=self._overview_resume_digest_cache,
                )["ready"]
                for item in jobs
                if item["status"] == "ready"
            )
        counts = {
            "jobs": len(jobs),
            "readyJobs": sum(item["status"] == "ready" for item in jobs),
            "attentionJobs": attention_count,
            "resumes": len(resumes),
            "answers": len(answers),
        }
        setup = {
            "hasProfileFacts": self._has_application_facts(profile),
            "hasResume": bool(resumes),
        }
        if not setup["hasResume"]:
            next_action, target = "import_resume", "resumes"
        elif not setup["hasProfileFacts"]:
            next_action, target = "review_facts", "facts"
        elif counts["attentionJobs"]:
            next_action, target = "resolve_attention", "attention"
        elif acquirable_ready_count:
            next_action, target = "handoff_ready_job", "jobs"
        elif not counts["jobs"]:
            next_action, target = "capture_job", "jobs"
        else:
            next_action, target = "prepare_job", "jobs"
        return {
            "setup": setup,
            "counts": counts,
            "nextAction": next_action,
            "targetWorkspace": target,
        }

    def list_needs_attention(self) -> dict[str, Any]:
        """Return one coherent, privacy-minimized cross-job attention snapshot."""

        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            jobs = self._load_jobs_document()["jobs"]
            persisted_claim = self._load_coordinator_document()["claim"]
            return self._needs_attention_locked(
                jobs, persisted_claim, self._now_datetime()
            )

    def _needs_attention_locked(
        self,
        jobs: dict[str, dict[str, Any]],
        persisted_claim: dict[str, Any] | None,
        now: datetime,
    ) -> dict[str, Any]:
        """Derive attention rows from documents already read under the Store lock."""

        reason_rank = {
            "expired_agent_attempt": 0,
            "claimless_interrupted_attempt": 1,
            "awaiting_human_review": 2,
            "browser_action_required": 3,
            "needs_information": 4,
        }
        reason_details = {
            "expired_agent_attempt": (
                "Expired agent attempt",
                "Resume this attempt with the CLI claim-recover command for this job.",
            ),
            "claimless_interrupted_attempt": (
                "Interrupted agent attempt",
                "Reset this claimless attempt to needs_info with the revision-bound CLI job-transition command, then resolve it before starting a new attempt.",
            ),
            "awaiting_human_review": (
                "Awaiting your review",
                "Open Job details. After you personally submit on the third-party site, confirm Applied, or close the job with an outcome.",
            ),
            "needs_information": (
                "Needs information",
                "Open Job details and resolve the missing facts, resume, or answers, then run preflight and mark the job ready.",
            ),
            "browser_action_required": (
                "Browser action required",
                "Open Job details and continue in the visible browser. The saved information is already known; do not create or re-enter an answer in Companion.",
            ),
        }
        rows: list[dict[str, Any]] = []
        for job in jobs.values():
            if job.get("deletedAt") is not None:
                continue
            reason_code = None
            attention_at = job["updatedAt"]
            if job["status"] == "in_progress":
                selected_claim = (
                    persisted_claim
                    if persisted_claim is not None
                    and persisted_claim["jobId"] == job["id"]
                    else None
                )
                if selected_claim is None:
                    reason_code = "claimless_interrupted_attempt"
                elif now >= self._parse_time(selected_claim["expiresAt"]):
                    reason_code = "expired_agent_attempt"
                    attention_at = selected_claim["expiresAt"]
            elif job["status"] == "awaiting_review":
                reason_code = "awaiting_human_review"
            elif job["status"] == "needs_info":
                reason_code = "needs_information"
            if reason_code is None:
                continue

            missing_count = 0
            session_revision = None
            session_projection = None
            if reason_code in {"needs_information", "awaiting_human_review"}:
                session_path = self._session_path(job["id"])
                if session_path.exists():
                    session = self._read_session_projection(
                        session_path, job["id"], job.get("ats")
                    )
                    missing_count = len(session.get("pendingFields", []))
                    session_revision = self._session_revision(session)
                    session_projection = {
                        key: copy.deepcopy(session[key])
                        for key in (
                            "attemptRevision", "readiness", "blockers", "browserHandoff",
                        )
                        if key in session
                    }
                    if (
                        reason_code == "needs_information"
                        and missing_count == 0
                        and session.get("browserHandoff") == {
                            "state": "required",
                            "reasonCode": "unsupported-control",
                            "revision": session.get("browserHandoff", {}).get("revision"),
                        }
                        and {
                            (blocker.get("type"), blocker.get("code"))
                            for blocker in session.get("blockers", [])
                        } == {
                            ("browser_handoff", "unsupported-control"),
                            ("information", "owner-input-required"),
                        }
                    ):
                        reason_code = "browser_action_required"
            reason_label, guidance = reason_details[reason_code]
            rows.append({
                "jobId": job["id"],
                "status": job["status"],
                "revision": job["revision"],
                "priority": job.get("priority", 0),
                "reasonCode": reason_code,
                "reasonLabel": reason_label,
                "attentionAt": attention_at,
                "guidance": guidance,
                "missingInformationCount": missing_count,
                "sessionRevision": session_revision,
                "session": session_projection,
            })
        rows.sort(key=lambda item: (
            reason_rank[item["reasonCode"]],
            -item["priority"],
            item["attentionAt"],
            item["jobId"],
        ))
        serialized = json.dumps(
            rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        return {
            "items": rows,
            "snapshotSignature": hashlib.sha256(serialized).hexdigest(),
        }

    def _preflight_job_record(
        self,
        record: dict[str, Any],
        *,
        profile: dict[str, Any] | None = None,
        resumes: dict[str, dict[str, Any]] | None = None,
        resume_observations: dict[str, dict[str, Any]] | None = None,
        managed_digest_cache: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        errors: list[str] = []
        warnings: list[str] = []
        if profile is None:
            profile = self._load_profile_document()["profile"]
        if not self._has_application_facts(profile):
            errors.append("profile_empty")
        if resumes is None:
            resumes = self._load_resumes_document()["resumes"]
        resume_id = record.get("resumeId")
        if resume_id is None:
            default = next(
                (
                    item
                    for item in resumes.values()
                    if item.get("deletedAt") is None and item.get("default")
                ),
                None,
            )
            resume_id = default["id"] if default is not None else None
        resume = resumes.get(resume_id) if resume_id is not None else None
        if resume is None or resume.get("deletedAt") is not None:
            errors.append("resume_missing")
        else:
            observation = None
            if resume_observations is not None:
                observation = resume_observations.get(resume["id"])
            if observation is None:
                observation = (
                    self._managed_resume_observation(
                        resume, digest_cache=managed_digest_cache
                    )
                    if resume.get("storageKind") == "managed"
                    else observe_resume_file(str(self._resume_path(resume)))
                )
                if resume_observations is not None:
                    resume_observations[resume["id"]] = observation
            if not observation["exists"]:
                errors.append("resume_file_missing")
            elif (
                observation["size"] != resume.get("observedSize")
                or observation["modifiedAt"] != resume.get("observedModifiedAt")
                or (
                    resume.get("storageKind") == "managed"
                    and observation.get("digest") != resume.get("digest")
                )
            ):
                if resume.get("storageKind") == "managed":
                    errors.append("resume_file_changed")
                else:
                    warnings.append("resume_file_changed")
        if not record.get("role"):
            warnings.append("role_missing")
        if not record.get("company"):
            warnings.append("company_missing")
        return {
            "id": record["id"],
            "revision": record["revision"],
            "ready": not errors,
            "resumeId": resume_id,
            "errors": errors,
            "warnings": warnings,
        }

    def preflight_job(self, job_id: str) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        record = self._load_jobs_document()["jobs"].get(job_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("job does not exist")
        return self._preflight_job_record(record)

    def update_job(
        self,
        job_id: str,
        patch: dict[str, Any],
        expected_revision: int,
        origin: str = "human",
    ) -> dict[str, Any]:
        self.initialize()
        origin = _job_origin(origin)
        _safe_session_id(job_id)
        allowed = {
            "url",
            "source",
            "sourceId",
            "role",
            "company",
            "location",
            "workplaceType",
            "employmentType",
            "compensation",
            "description",
            "ats",
            "priority",
            "resumeId",
            "notes",
            "provenance",
            "lastCheckedAt",
        }
        if not patch or set(patch) - allowed:
            raise StoreError("job patch contains unsupported fields")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            current_provenance = _require_object(
                current.get("provenance", {}), "job provenance"
            )
            provenance = current_provenance
            provenance_changed = False
            if origin == "human" and "provenance" in patch:
                provenance = _require_object(patch["provenance"], "job provenance")
                _validate_migration_provenance_replacement(
                    current_provenance, provenance
                )
                provenance_changed = provenance != current_provenance
            accepted: dict[str, Any] = {}
            for field, value in patch.items():
                if field == "provenance":
                    continue
                if origin in {"agent", "migration"} and not _nonempty_job_value(value):
                    continue
                if origin == "agent" and not _agent_may_update_job_field(
                    current, current_provenance, field
                ):
                    continue
                if origin == "migration" and not _migration_may_update_job_field(
                    current, current_provenance, field
                ):
                    continue
                accepted[field] = value
            if "resumeId" in accepted:
                self._require_active_resume(accepted["resumeId"])
            updated = {**current, **accepted}
            if "url" in accepted:
                updated["normalizedUrl"] = normalize_job_url(accepted["url"])
                updated["url"] = accepted["url"].strip()
                duplicate = next(
                    (
                        item
                        for key, item in document["jobs"].items()
                        if key != job_id
                        and item.get("deletedAt") is None
                        and item.get("normalizedUrl") == updated["normalizedUrl"]
                    ),
                    None,
                )
                if duplicate is not None:
                    raise StoreError("active job URL already exists")
            changed = [
                field
                for field in accepted
                if current.get(field) != updated.get(field)
            ]
            if not changed and not provenance_changed:
                return current
            now = utc_now()
            updated["provenance"] = _stamp_job_provenance(
                provenance,
                changed,
                origin,
                _job_observation_source(updated),
                now,
            )
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = now
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    @staticmethod
    def _job_upsert_payload(payload: dict[str, Any]) -> list[Any]:
        if set(payload) != {"jobs"}:
            raise StoreError("job upsert input must contain only a jobs array")
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            raise StoreError("job upsert input.jobs must be an array")
        return jobs

    @staticmethod
    def _canonical_upsert_input(payload: dict[str, Any]) -> dict[str, Any]:
        normalized: list[Any] = []
        for value in Store._job_upsert_payload(payload):
            if not isinstance(value, dict):
                normalized.append(value)
                continue
            item: dict[str, Any] = {}
            for field, field_value in value.items():
                if isinstance(field_value, str):
                    field_value = field_value.strip()
                item[field] = field_value
            normalized.append(item)
        return {"jobs": normalized}

    @staticmethod
    def _upsert_token(
        document: dict[str, Any], payload: dict[str, Any], origin: str
    ) -> str:
        bound = {
            "version": 1,
            "origin": _job_origin(origin),
            "input": Store._canonical_upsert_input(payload),
            "jobsDocument": document,
        }
        return "job-upsert-v1." + hashlib.sha256(
            _canonical_json(bound).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _deterministic_job_id(item: dict[str, Any]) -> str:
        identity = f"url\0{item['normalizedUrl']}"
        return "job-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]

    @staticmethod
    def _normalize_upsert_item(value: Any) -> dict[str, Any]:
        item = _require_object(value, "job upsert item")
        if set(item) - JOB_INGEST_FIELDS:
            raise StoreError("job upsert item contains unsupported fields")
        if not _nonempty_job_value(item.get("url")):
            raise StoreError("job upsert item requires a URL")
        string_fields = JOB_INGEST_FIELDS - {"priority"}
        for field in string_fields:
            if field in item and item[field] is not None and not isinstance(
                item[field], str
            ):
                raise StoreError(f"job upsert item.{field} must be a string")
        priority = item.get("priority")
        if priority is not None and (
            not isinstance(priority, int)
            or isinstance(priority, bool)
            or not 0 <= priority <= 5
        ):
            raise StoreError("job upsert item.priority must be an integer from 0 to 5")
        normalized: dict[str, Any] = {}
        for field, field_value in item.items():
            if not _nonempty_job_value(field_value):
                continue
            normalized[field] = (
                field_value.strip() if isinstance(field_value, str) else field_value
            )
        normalized["normalizedUrl"] = normalize_job_url(normalized["url"])
        normalized["url"] = normalized["url"].strip()
        if "source" in normalized:
            normalized["source"] = normalized["source"].strip()
        if "sourceId" in normalized:
            normalized["sourceId"] = normalized["sourceId"].strip()
        return normalized

    @staticmethod
    def _source_identity(record: dict[str, Any]) -> tuple[str, str] | None:
        source = _normalized_job_source(record.get("source"))
        source_id = record.get("sourceId")
        if source and isinstance(source_id, str) and source_id.strip():
            return source, source_id.strip()
        return None

    def _plan_job_upsert(
        self,
        document: dict[str, Any],
        payload: dict[str, Any],
        origin: str,
        now: str,
        *,
        _allow_migration: bool = False,
        _target_ids: list[str | None] | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
        if not (_allow_migration and origin == "migration"):
            origin = _job_origin(origin)
        raw_jobs = self._job_upsert_payload(payload)
        normalized: list[dict[str, Any] | None] = []
        errors: list[str | None] = []
        for value in raw_jobs:
            try:
                normalized.append(self._normalize_upsert_item(value))
                errors.append(None)
            except StoreError as error:
                normalized.append(None)
                errors.append(str(error))

        conflict_indexes: set[int] = set()
        identities: dict[tuple[str, ...], list[int]] = {}
        for index, item in enumerate(normalized):
            if item is None:
                continue
            keys = [("url", item["normalizedUrl"])]
            source_identity = self._source_identity(item)
            if source_identity is not None:
                keys.append(("source", *source_identity))
            for key in keys:
                identities.setdefault(key, []).append(index)
        for indexes in identities.values():
            canonical = {
                _canonical_json(normalized[index]) for index in indexes
            }
            if len(canonical) > 1:
                conflict_indexes.update(indexes)

        simulated = json.loads(json.dumps(document))
        decisions: list[dict[str, Any]] = []
        changed_document = False
        for index, item in enumerate(normalized):
            if item is None:
                decisions.append(
                    {"index": index, "action": "invalid", "reason": errors[index]}
                )
                continue
            if index in conflict_indexes:
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "reason": "differing duplicate identities in input",
                    }
                )
                continue

            jobs = simulated["jobs"]
            target_id = _target_ids[index] if _target_ids is not None else None
            target_matches = (
                [jobs[target_id]] if target_id is not None and target_id in jobs else []
            )
            url_matches = [
                record
                for record in jobs.values()
                if record.get("normalizedUrl") == item["normalizedUrl"]
            ]
            source_identity = self._source_identity(item)
            source_matches = (
                [
                    record
                    for record in jobs.values()
                    if self._source_identity(record) == source_identity
                ]
                if source_identity is not None
                else []
            )
            matches = {
                record["id"]: record
                for record in url_matches + source_matches + target_matches
            }
            if (
                len(url_matches) > 1
                or len(source_matches) > 1
                or len(matches) > 1
                or any(record.get("deletedAt") is not None for record in matches.values())
            ):
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "reason": "job identities do not resolve to one active record",
                    }
                )
                continue

            current = next(iter(matches.values()), None)
            if current is not None:
                provenance = _require_object(
                    current.get("provenance", {}), "job provenance"
                )
                current_source = self._source_identity(current)
                source_changed = (
                    _nonempty_job_value(current.get("source"))
                    and _nonempty_job_value(item.get("source"))
                    and _normalized_job_source(current.get("source"))
                    != _normalized_job_source(item.get("source"))
                )
                source_id_changed = (
                    _nonempty_job_value(current.get("sourceId"))
                    and _nonempty_job_value(item.get("sourceId"))
                    and current.get("sourceId", "").strip()
                    != item.get("sourceId", "").strip()
                )
                migration_identity_refresh = origin == "migration" and (
                    current.get("normalizedUrl") == item["normalizedUrl"]
                    or target_id == current["id"]
                )
                migration_url_refresh = (
                    origin == "migration"
                    and target_id == current["id"]
                    and _migration_may_update_job_field(
                        current, provenance, "url"
                    )
                )
                if (
                    (
                        current.get("normalizedUrl") != item["normalizedUrl"]
                        and not migration_url_refresh
                    )
                    or (
                        (
                            current_source is not None
                            and source_identity is not None
                            and current_source != source_identity
                        )
                        or source_changed
                        or source_id_changed
                    )
                    and not migration_identity_refresh
                ):
                    decisions.append(
                        {
                            "index": index,
                            "action": "conflict",
                            "id": current["id"],
                            "reason": "incoming identity is incompatible with stored identity",
                        }
                    )
                    continue
                accepted: dict[str, Any] = {}
                for field in JOB_INGEST_FIELDS:
                    if field not in item or (field == "url" and not migration_url_refresh):
                        continue
                    value = item[field]
                    if origin == "agent" and not _agent_may_update_job_field(
                        current, provenance, field
                    ):
                        continue
                    if origin == "migration" and not _migration_may_update_job_field(
                        current, provenance, field
                    ):
                        continue
                    if current.get(field) != value:
                        accepted[field] = value
                if not accepted:
                    decisions.append(
                        {"index": index, "action": "noop", "id": current["id"]}
                    )
                    continue
                updated = {**current, **accepted}
                if "url" in accepted:
                    updated["normalizedUrl"] = item["normalizedUrl"]
                updated["provenance"] = _stamp_job_provenance(
                    provenance,
                    list(accepted),
                    origin,
                    _job_observation_source(updated),
                    now,
                )
                updated["revision"] = current["revision"] + 1
                updated["updatedAt"] = now
                _validate_job_record(current["id"], updated)
                jobs[current["id"]] = updated
                decisions.append(
                    {
                        "index": index,
                        "action": "update",
                        "id": current["id"],
                        "fields": sorted(accepted),
                    }
                )
                changed_document = True
                continue

            job_id = self._deterministic_job_id(item)
            if job_id in jobs:
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "id": job_id,
                        "reason": "deterministic job id is already in use",
                    }
                )
                continue
            incoming = {key: value for key, value in item.items() if key != "normalizedUrl"}
            fields = [field for field in JOB_INGEST_FIELDS if field in incoming]
            record = {
                **incoming,
                "id": job_id,
                "normalizedUrl": item["normalizedUrl"],
                "priority": incoming.get("priority", 0),
                "status": "saved",
                "closedOutcome": None,
                "provenance": _stamp_job_provenance(
                    {}, fields, origin, _job_observation_source(incoming), now
                ),
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
                "deletedAt": None,
            }
            try:
                _validate_job_record(job_id, record)
            except StoreError as error:
                decisions.append(
                    {"index": index, "action": "invalid", "reason": str(error)}
                )
                continue
            jobs[job_id] = record
            decisions.append({"index": index, "action": "create", "id": job_id})
            changed_document = True

        if changed_document:
            simulated["metadata"]["updatedAt"] = now
        return simulated, decisions, changed_document

    @staticmethod
    def _upsert_result(
        token: str, decisions: list[dict[str, Any]], committed: bool
    ) -> dict[str, Any]:
        counts = {action: 0 for action in ("create", "update", "noop", "conflict", "invalid")}
        for decision in decisions:
            counts[decision["action"]] += 1
        return {
            "token": token,
            "summary": counts,
            "decisions": decisions,
            "committed": committed,
        }

    def preview_job_upsert(
        self, payload: dict[str, Any], origin: str
    ) -> dict[str, Any]:
        document = self._load_jobs_document()
        token = self._upsert_token(document, payload, origin)
        _, decisions, _ = self._plan_job_upsert(document, payload, origin, utc_now())
        return self._upsert_result(token, decisions, committed=False)

    def commit_job_upsert(
        self, payload: dict[str, Any], origin: str, token: str
    ) -> dict[str, Any]:
        if not isinstance(token, str) or not token:
            raise StoreError("job upsert commit requires a preview token")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            expected = self._upsert_token(document, payload, origin)
            if not hmac.compare_digest(token, expected):
                raise StoreError("job upsert preview token rejected because the store or input drifted")
            planned, decisions, changed = self._plan_job_upsert(
                document, payload, origin, utc_now()
            )
            if changed:
                atomic_write_json(self.jobs_path, planned)
        return self._upsert_result(token, decisions, committed=changed)

    @staticmethod
    def _read_legacy_search_file(
        root_descriptor: int | None,
        root: Path,
        name: str,
        metadata: os.stat_result,
    ) -> bytes:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = (
                os.open(root / name, flags)
                if root_descriptor is None
                else os.open(name, flags, dir_fd=root_descriptor)
            )
        except OSError as error:
            raise StoreError("legacy search report cannot be opened safely") from error
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
            ):
                raise StoreError("legacy search report changed during discovery")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(descriptor, min(65536, LEGACY_SEARCH_MAX_FILE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > LEGACY_SEARCH_MAX_FILE_BYTES:
                    raise StoreError("legacy search report exceeds the per-file byte limit")
            closed = os.fstat(descriptor)
            if closed.st_size != opened.st_size:
                raise StoreError("legacy search report changed during discovery")
            return b"".join(chunks)
        finally:
            os.close(descriptor)

    @staticmethod
    def _parse_legacy_search_report(
        relative_path: str, source_sha256: str, text: str
    ) -> list[dict[str, Any]]:
        lines = text.splitlines()
        starts = [index for index, line in enumerate(lines) if line.startswith("###")]
        items: list[dict[str, Any]] = []
        heading_identities = [
            re.sub(r"^###\s+\d+\.\s*", "", lines[start]).strip()
            for start in starts
        ]
        heading_totals = {
            identity: heading_identities.count(identity)
            for identity in set(heading_identities)
        }
        content_occurrences: dict[str, int] = {}
        for ordinal, start in enumerate(starts, 1):
            end = starts[ordinal] if ordinal < len(starts) else len(lines)
            heading = lines[start]
            heading_identity = heading_identities[ordinal - 1]
            content_identity = heading_identity
            if heading_totals[heading_identity] > 1:
                content_identity = "\n".join(
                    [heading_identity, *lines[start + 1 : end]]
                ).strip()
            content_occurrence = content_occurrences.get(content_identity, 0) + 1
            content_occurrences[content_identity] = content_occurrence
            entry_id = "legacy-entry-" + hashlib.sha256(
                f"{relative_path}\0{content_identity}\0{content_occurrence}".encode("utf-8")
            ).hexdigest()[:24]
            item_id = "legacy-item-" + hashlib.sha256(
                entry_id.encode("utf-8")
            ).hexdigest()[:24]
            locator = {
                "sourceKind": "timestamped-search-report",
                "relativePath": relative_path,
                "entryId": entry_id,
                "sourceSha256": source_sha256,
            }

            heading_match = re.fullmatch(r"###\s+\d+\.\s+(.+?)\s+—\s+(.+)", heading)
            if heading_match is None:
                items.append({"itemId": item_id, "state": "invalid", "reason": "unsupported_heading", "source": locator})
                continue
            role = heading_match.group(1).strip()
            company = re.sub(r"\s+\(Score:\s*[^)]*\)\s*$", "", heading_match.group(2)).strip()
            if not role or not company:
                items.append({"itemId": item_id, "state": "invalid", "reason": "incomplete_heading", "source": locator})
                continue

            labels: dict[str, str] = {}
            duplicate = False
            for line in lines[start + 1 : end]:
                field = re.fullmatch(r"- \*\*([^*]+)\*\*:\s*(.*)", line)
                if field is None:
                    continue
                label = field.group(1).strip().lower()
                if label in labels:
                    duplicate = True
                    break
                labels[label] = field.group(2).strip()
            if duplicate:
                items.append({"itemId": item_id, "state": "invalid", "reason": "duplicate_field", "source": locator})
                continue

            url_candidates = []
            for label in ("url", "apply"):
                value = labels.get(label, "")
                if re.fullmatch(r"https?://\S+", value):
                    try:
                        normalized = normalize_job_url(value)
                    except StoreError:
                        continue
                    url_candidates.append((value, normalized))
            unique_urls = {normalized for _value, normalized in url_candidates}
            if not url_candidates:
                items.append({"itemId": item_id, "state": "invalid", "reason": "missing_url", "source": locator})
                continue
            if len(unique_urls) != 1:
                items.append({"itemId": item_id, "state": "invalid", "reason": "ambiguous_url", "source": locator})
                continue

            job: dict[str, Any] = {"url": url_candidates[0][0], "role": role, "company": company}
            mappings = {
                "source": "source",
                "location": "location",
                "salary": "compensation",
                "description": "description",
            }
            for label, canonical in mappings.items():
                if labels.get(label):
                    job[canonical] = labels[label]
            items.append({"itemId": item_id, "state": "valid", "source": locator, "job": job})
        return items

    def _discover_legacy_jobs(self) -> dict[str, Any]:
        root = Path.home() / LEGACY_SEARCH_ROOT
        try:
            root_metadata = root.lstat()
        except FileNotFoundError:
            return {"root": f"~/{LEGACY_SEARCH_ROOT}", "manifest": [], "items": []}
        except OSError as error:
            raise StoreError("legacy search root cannot be inspected") from error
        if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
            raise StoreError("legacy search root must be a regular directory")

        root_descriptor: int | None = None
        if os.name != "nt":
            root_flags = (
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            try:
                root_descriptor = os.open(root, root_flags)
            except OSError as error:
                raise StoreError("legacy search root cannot be opened safely") from error
        manifest: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        aggregate = 0
        try:
            opened_root = (
                root.lstat()
                if root_descriptor is None
                else os.fstat(root_descriptor)
            )
            if (
                not stat.S_ISDIR(opened_root.st_mode)
                or opened_root.st_dev != root_metadata.st_dev
                or opened_root.st_ino != root_metadata.st_ino
            ):
                raise StoreError("legacy search root changed during discovery")
            paths = sorted(
                name
                for name in os.listdir(root if root_descriptor is None else root_descriptor)
                if name.startswith("search-") and name.endswith(".md")
            )
            if len(paths) > LEGACY_SEARCH_MAX_FILES:
                raise StoreError("legacy search discovery exceeds the file limit")
            for name in paths:
                try:
                    metadata = (
                        (root / name).lstat()
                        if root_descriptor is None
                        else os.stat(
                            name, dir_fd=root_descriptor, follow_symlinks=False
                        )
                    )
                except OSError as error:
                    raise StoreError("legacy search report cannot be inspected") from error
                if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                    raise StoreError("legacy search reports must be regular files")
                if metadata.st_size > LEGACY_SEARCH_MAX_FILE_BYTES:
                    raise StoreError("legacy search report exceeds the per-file byte limit")
                aggregate += metadata.st_size
                if aggregate > LEGACY_SEARCH_MAX_TOTAL_BYTES:
                    raise StoreError("legacy search discovery exceeds the aggregate byte limit")
                raw = self._read_legacy_search_file(
                    root_descriptor, root, name, metadata
                )
                try:
                    decoded = raw.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise StoreError("legacy search report is not valid UTF-8") from error
                digest = hashlib.sha256(raw).hexdigest()
                manifest.append({"relativePath": name, "sourceSha256": digest, "size": len(raw)})
                items.extend(self._parse_legacy_search_report(name, digest, decoded))
                if len(items) > LEGACY_SEARCH_MAX_ENTRIES:
                    raise StoreError("legacy search discovery exceeds the entry limit")
        finally:
            if root_descriptor is not None:
                os.close(root_descriptor)
        if root_descriptor is None:
            try:
                closed_root = root.lstat()
            except OSError as error:
                raise StoreError("legacy search root changed during discovery") from error
            if (
                not stat.S_ISDIR(closed_root.st_mode)
                or closed_root.st_dev != root_metadata.st_dev
                or closed_root.st_ino != root_metadata.st_ino
            ):
                raise StoreError("legacy search root changed during discovery")
        return {"root": f"~/{LEGACY_SEARCH_ROOT}", "manifest": manifest, "items": items}

    def _migration_jobs_snapshot(self) -> tuple[dict[str, Any], Any]:
        if self.jobs_path.exists():
            document = self._load_jobs_document()
            return document, document
        document = {
            "schemaVersion": SCHEMA_VERSION,
            "jobs": {},
            "metadata": {"createdAt": "1970-01-01T00:00:00Z", "updatedAt": "1970-01-01T00:00:00Z"},
        }
        return document, {"state": "missing"}

    @staticmethod
    def _selected_legacy_items(
        discovery: dict[str, Any],
        selected: list[str],
        *,
        unknown_message: str = "legacy job selection contains an unknown item id",
        invalid_message: str = "legacy job selection contains an invalid item",
    ) -> list[dict[str, Any]]:
        if len(selected) != len(set(selected)):
            raise StoreError("legacy job selection contains duplicate item ids")
        indexed = {item["itemId"]: item for item in discovery["items"]}
        chosen: list[dict[str, Any]] = []
        for item_id in selected:
            item = indexed.get(item_id)
            if item is None:
                raise StoreError(unknown_message)
            if item["state"] != "valid":
                raise StoreError(invalid_message)
            chosen.append(item)
        return chosen

    @staticmethod
    def _legacy_jobs_token(
        discovery: dict[str, Any], selected: list[str], chosen: list[dict[str, Any]], snapshot: Any
    ) -> str:
        bound = {
            "version": 1,
            "origin": "migration",
            "selection": selected,
            "payloads": [item["job"] for item in chosen],
            "selectedLocators": [item["source"] for item in chosen],
            "manifest": discovery["manifest"],
            "jobsSnapshot": snapshot,
        }
        return "legacy-jobs-v1." + hashlib.sha256(_canonical_json(bound).encode("utf-8")).hexdigest()

    def _plan_legacy_jobs(
        self, document: dict[str, Any], chosen: list[dict[str, Any]], now: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
        payload = {"jobs": [item["job"] for item in chosen]}
        target_ids: list[str | None] = []
        for item in chosen:
            locator = item["source"]
            identity = (
                locator["sourceKind"],
                locator["relativePath"],
                locator["entryId"],
            )
            matches = [
                record["id"]
                for record in document["jobs"].values()
                if any(
                    (
                        source["sourceKind"],
                        source["relativePath"],
                        source["entryId"],
                    )
                    == identity
                    for source in record.get("legacySources", [])
                )
            ]
            if len(matches) > 1:
                raise StoreError("legacy source locator resolves to multiple jobs")
            target_ids.append(matches[0] if matches else None)
        planned, decisions, changed = self._plan_job_upsert(
            document,
            payload,
            "migration",
            now,
            _allow_migration=True,
            _target_ids=target_ids,
        )
        for item, decision in zip(chosen, decisions):
            decision["itemId"] = item["itemId"]
            if decision["action"] in {"conflict", "invalid"}:
                continue
            record = planned["jobs"][decision["id"]]
            sources = list(record.get("legacySources", []))
            locator = item["source"]
            identity = (locator["sourceKind"], locator["relativePath"], locator["entryId"])
            replaced = False
            merged = []
            for source in sources:
                source_identity = (source["sourceKind"], source["relativePath"], source["entryId"])
                if source_identity == identity:
                    merged.append(locator)
                    replaced = True
                else:
                    merged.append(source)
            if not replaced:
                merged.append(locator)
            merged.sort(key=lambda source: (source["relativePath"], source["entryId"]))
            if merged != sources:
                record["legacySources"] = merged
                if decision["action"] == "noop":
                    record["revision"] += 1
                    record["updatedAt"] = now
                    decision["action"] = "update"
                    decision["fields"] = ["legacySources"]
                elif decision["action"] == "update":
                    decision["fields"] = sorted(set(decision.get("fields", [])) | {"legacySources"})
                changed = True
                planned["metadata"]["updatedAt"] = now
                _validate_job_record(record["id"], record)
        if document["metadata"].get("createdAt") == "1970-01-01T00:00:00Z" and changed:
            planned["metadata"]["createdAt"] = now
        return planned, decisions, changed

    @staticmethod
    def _legacy_result(
        discovery: dict[str, Any], selected: list[str], decisions: list[dict[str, Any]] | None = None,
        token: str | None = None, committed: bool = False,
    ) -> dict[str, Any]:
        result = {"root": discovery["root"], "manifest": discovery["manifest"], "items": discovery["items"], "selected": selected, "committed": committed}
        if decisions is not None:
            counts = {action: 0 for action in ("create", "update", "noop", "conflict", "invalid")}
            for decision in decisions:
                counts[decision["action"]] += 1
            result.update({"token": token, "summary": counts, "decisions": decisions})
        return result

    def preview_legacy_jobs(self, selected: list[str]) -> dict[str, Any]:
        discovery = self._discover_legacy_jobs()
        if not selected:
            return self._legacy_result(discovery, [])
        chosen = self._selected_legacy_items(discovery, selected)
        document, snapshot = self._migration_jobs_snapshot()
        token = self._legacy_jobs_token(discovery, selected, chosen, snapshot)
        _planned, decisions, _changed = self._plan_legacy_jobs(document, chosen, utc_now())
        return self._legacy_result(discovery, selected, decisions, token)

    def commit_legacy_jobs(self, selected: list[str], token: str) -> dict[str, Any]:
        if not selected or not isinstance(token, str) or not token:
            raise StoreError("legacy job commit requires selection and a preview token")
        with exclusive_file_lock(self.store_lock_path):
            discovery = self._discover_legacy_jobs()
            chosen = self._selected_legacy_items(
                discovery,
                selected,
                unknown_message=(
                    "legacy job preview token rejected because the source, selection, input, or store drifted"
                ),
                invalid_message=(
                    "legacy job preview token rejected because the source, selection, input, or store drifted"
                ),
            )
            document, snapshot = self._migration_jobs_snapshot()
            expected = self._legacy_jobs_token(discovery, selected, chosen, snapshot)
            if not hmac.compare_digest(token, expected):
                raise StoreError("legacy job preview token rejected because the source, selection, input, or store drifted")
            planned, decisions, changed = self._plan_legacy_jobs(document, chosen, utc_now())
            if changed:
                atomic_write_json(self.jobs_path, planned)
        return self._legacy_result(discovery, selected, decisions, token, changed)

    def transition_job(
        self,
        job_id: str,
        status: str,
        expected_revision: int,
        closed_outcome: str | None = None,
        user_confirmed: bool = False,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        if status not in JOB_STATUSES:
            raise StoreError("job status is unsupported")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            self._require_job_unclaimed_locked(job_id)
            if status == current["status"]:
                return current
            if status not in JOB_TRANSITIONS[current["status"]]:
                raise StoreError("job status transition is unsupported")
            if status == "in_progress":
                raise StoreError("in_progress requires atomic job-acquire")
            if status == "applied" and not user_confirmed:
                raise StoreError("applied status requires explicit user confirmation")
            if status == "ready" and not self._preflight_job_record(current)["ready"]:
                raise StoreError("job is not ready")
            updated = dict(current)
            updated["status"] = status
            updated["closedOutcome"] = closed_outcome if status == "closed" else None
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    @staticmethod
    def _token_hash(token: str) -> str:
        if not isinstance(token, str) or not token:
            raise StoreError("claim token is required")
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _new_claim_token() -> str:
        # Keep the full 32-byte random payload while ensuring argparse can
        # always consume the bearer token as a separate option value.
        return f"claim_{secrets.token_urlsafe(32)}"

    def _public_claim(self, claim: dict[str, Any] | None) -> dict[str, Any] | None:
        if claim is None:
            return None
        public = {key: value for key, value in claim.items() if key != "tokenHash"}
        public["expired"] = self._now_datetime() >= self._parse_time(claim["expiresAt"])
        return public

    @staticmethod
    def _parse_time(value: str) -> datetime:
        return _parse_coordinator_time(value)

    def claim_status(self) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        claim = self._load_coordinator_document()["claim"]
        return {
            "claim": self._public_claim(claim),
            "leaseSeconds": CLAIM_LEASE_SECONDS,
            "heartbeatSeconds": CLAIM_HEARTBEAT_SECONDS,
        }

    def get_job_activity(self, job_id: str) -> dict[str, Any]:
        """Return a selected-job-only, value-free application activity view."""
        self.initialize()
        self._ensure_coordinator_files()
        job_id = _safe_session_id(job_id)
        with exclusive_file_lock(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")

            session = None
            answers_document = self._load_answers_document()
            session_path = self._session_path(job_id)
            if session_path.exists():
                stored_session = self._read_session_projection(
                    session_path, job_id, job.get("ats")
                )
                session = {
                    key: stored_session[key]
                    for key in (
                        "status", "step", "attemptRevision", "readiness", "blockers",
                        "approvals", "browserHandoff", "createdAt", "updatedAt",
                    )
                    if key in stored_session
                }
                approval_attempt_is_current = (
                    job["status"] in {"needs_info", "awaiting_review"}
                    or job["status"] == "in_progress"
                    and stored_session.get("attemptRevision") == job["revision"]
                )
                session["approvals"] = (
                    self._current_session_approvals(stored_session, answers_document)
                    if approval_attempt_is_current
                    else []
                )
                session["revision"] = self._session_revision(stored_session)
                session["pendingInformation"] = [
                    {
                        key: pending[key]
                        for key in (
                            "state", "sensitive", "fieldClass", "matchConfidence",
                            "matchReasonCodes",
                        )
                        if key in pending
                    } | self._pending_resolution_projection(pending, answers_document)
                    for pending in stored_session.get("pendingFields", [])
                ]

            persisted_claim = self._load_coordinator_document()["claim"]
            selected_claim = (
                persisted_claim
                if persisted_claim is not None and persisted_claim["jobId"] == job_id
                else None
            )
            if selected_claim is not None:
                expired = self._now_datetime() >= self._parse_time(
                    selected_claim["expiresAt"]
                )
                claim = {
                    "state": "expired" if expired else "active",
                    "acquiredAt": selected_claim["acquiredAt"],
                    "heartbeatAt": selected_claim["heartbeatAt"],
                    "expiresAt": selected_claim["expiresAt"],
                }
            elif job["status"] == "in_progress":
                claim = {"state": "interrupted"}
            else:
                claim = {"state": "none"}
            if claim["state"] == "expired":
                claim["recoveryGuidance"] = (
                    "Resume this attempt with the CLI claim-recover command for this job."
                )
            elif claim["state"] == "interrupted":
                claim["recoveryGuidance"] = (
                    "Reset this claimless attempt with the CLI job-transition command "
                    f"to needs_info using revision {job['revision']}; resolve any missing "
                    "information, then mark it ready for a new agent attempt."
                )

            history = []
            for event in self.read_history():
                if event["applicationId"] != job_id:
                    continue
                history.append({
                    key: event[key]
                    for key in ("event", "status", "ats", "at")
                    if key in event
                })

            return {
                "job": {"status": job["status"], "revision": job["revision"]},
                "session": session,
                "claim": claim,
                "history": history,
            }

    @staticmethod
    def _session_revision(session: dict[str, Any]) -> int:
        """Return a stable positive JSON/JavaScript-safe revision token."""
        digest = hashlib.sha256(_canonical_json(session).encode("utf-8")).hexdigest()
        return int(digest[:13], 16) + 1

    def _pending_resolution_projection(
        self, field: dict[str, Any], answers: dict[str, Any]
    ) -> dict[str, Any]:
        projection: dict[str, Any] = {"reference": field["reference"]}
        key = field.get("answerKey")
        if not isinstance(key, str) or not key:
            return projection | {"resolutionEligible": False}
        resolved = self._resolve_answer_key_in_document(answers, key)
        answer = answers["answers"].get(resolved)
        if answer is None or answer.get("deletedAt") is not None:
            return projection | {"resolutionEligible": False}
        projection["answerRevision"] = answer.get("revision", 1)
        projection["answerKey"] = resolved
        projection["answerSensitivity"] = answer.get("sensitivity", "none")
        projection["resolutionEligible"] = bool(
            field.get("sensitive") is not True
            and field.get("state") != "sensitive"
            and answer.get("reviewStatus", "accepted") == "accepted"
            and answer.get("state") == "confirmed"
            and answer.get("value") is not None
            and not self._answer_is_sensitive(answer)
        )
        return projection

    def _current_session_approvals(
        self, session: dict[str, Any], answers: dict[str, Any]
    ) -> list[dict[str, Any]]:
        pending = {
            field["reference"]: field
            for field in session.get("pendingFields", [])
        }
        current = []
        for approval in session.get("approvals", []):
            field = pending.get(approval.get("reference"))
            field_key = field.get("answerKey") if field is not None else None
            approval_key = approval.get("answerKey")
            if not isinstance(field_key, str) or not isinstance(approval_key, str):
                continue
            resolved_field = self._resolve_answer_key_in_document(answers, field_key)
            resolved_approval = self._resolve_answer_key_in_document(
                answers, approval_key
            )
            answer = answers["answers"].get(resolved_field)
            if (
                resolved_field != resolved_approval
                or answer is None
                or answer.get("deletedAt") is not None
                or answer.get("revision", 1) != approval.get("answerRevision")
            ):
                continue
            current.append(copy.deepcopy(approval))
        return current

    def pending_answer_detail(self, job_id: str, reference: str) -> dict[str, Any]:
        """Resolve an opaque durable pending reference to its canonical answer."""
        self.initialize()
        job_id = _safe_session_id(job_id)
        if not isinstance(reference, str) or PENDING_REFERENCE.fullmatch(reference) is None:
            raise StoreError("pending question reference is invalid")
        with exclusive_file_lock(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            path = self._session_path(job_id)
            if not path.exists():
                raise StoreError("answer resolution session does not exist")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            field = next(
                (
                    item for item in session.get("pendingFields", [])
                    if item.get("reference") == reference
                ),
                None,
            )
            if field is None:
                raise StoreError("pending question reference is stale")
            key = field.get("answerKey")
            if not isinstance(key, str) or not key:
                raise StoreError("pending question has no referenced answer")
            answers = self._load_answers_document()
            answer = self._get_answer_record(key, document=answers)
            if answer is None:
                raise StoreError("referenced answer does not exist")
            return self.answer_detail_projection(answer, answers)

    def _require_claim_locked(
        self, job_id: str, token: str, allow_expired: bool = False
    ) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if claim is None or claim["jobId"] != job_id:
            raise StoreError("job is not held by this claim")
        if not hmac.compare_digest(claim["tokenHash"], self._token_hash(token)):
            raise StoreError("claim token is invalid")
        job = self._load_jobs_document()["jobs"].get(job_id)
        if job is None or job.get("deletedAt") is not None or job.get("status") != "in_progress":
            raise StoreError("claimed job is not in progress")
        if not allow_expired and self._now_datetime() >= self._parse_time(claim["expiresAt"]):
            raise StoreError("claim has expired; use explicit recovery")
        return claim

    def _require_job_unclaimed_locked(self, job_id: str) -> None:
        if not self.coordinator_path.exists():
            return
        claim = self._load_coordinator_document()["claim"]
        if claim is not None and claim["jobId"] == job_id:
            raise StoreError("claimed job requires a coordinator operation")

    def _history_event_for_operation(
        self, operation_id: str, job: dict[str, Any], event: str, status: str, at: str
    ) -> dict[str, Any]:
        record = {
            "schemaVersion": SCHEMA_VERSION,
            "eventId": f"coordinator-{operation_id}",
            "applicationId": job["id"],
            "event": event,
            "status": status,
            "answerKeys": [],
            "at": at,
        }
        for field in ("company", "role", "ats"):
            if isinstance(job.get(field), str):
                record[field] = job[field]
        _validate_history_event_for_write(record)
        return record

    def _history_event_is_idempotent_locked(self, event: dict[str, Any]) -> bool:
        _validate_history_event_for_write(event)
        matching = [
            item
            for item in self.read_history()
            if item.get("eventId") == event["eventId"]
        ]
        if not matching:
            return False
        normalized = _canonical_json(event)
        if all(_canonical_json(item) == normalized for item in matching):
            return True
        raise StoreError("history event id collision")

    def _append_history_event_idempotent_locked(self, event: dict[str, Any]) -> None:
        if self._history_event_is_idempotent_locked(event):
            return
        encoded = (json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
        descriptor = os.open(
            self.history_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        original_size = os.fstat(descriptor).st_size
        try:
            offset = 0
            while offset < len(encoded):
                written = os.write(descriptor, encoded[offset:])
                if written <= 0:
                    raise StoreError("history append was incomplete")
                offset += written
            os.fsync(descriptor)
        except BaseException:
            os.ftruncate(descriptor, original_size)
            os.fsync(descriptor)
            raise
        finally:
            os.close(descriptor)
        _set_private_mode(self.history_path, 0o600)

    def _repair_pending_history_tail_locked(self) -> None:
        journal = self._load_coordinator_journal()
        if journal["operation"] is None or not self.history_path.exists():
            return
        descriptor = os.open(self.history_path, os.O_RDWR)
        try:
            content = os.read(descriptor, os.fstat(descriptor).st_size)
            if not content or content.endswith(b"\n"):
                return
            last_newline = content.rfind(b"\n")
            os.ftruncate(descriptor, last_newline + 1)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _roll_forward_locked(self) -> None:
        journal = self._load_coordinator_journal()
        operation = journal["operation"]
        if operation is None:
            return
        if operation["kind"] == "answer_merge":
            answers = self._load_answers_document()
            self._apply_answer_merge_locked(answers, operation)
            atomic_write_json(self.answers_path, answers)
            for session in operation["sessions"]:
                atomic_write_json(
                    self._session_path(session["applicationId"]), session
                )
            atomic_write_json(
                self.coordinator_path,
                {"schemaVersion": SCHEMA_VERSION, "claim": operation["resultClaim"]},
            )
            atomic_write_json(
                self.coordinator_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": None},
            )
            return
        if operation["kind"] == "answer_resolution":
            job_id = operation["jobId"]
            jobs = self._load_jobs_document()
            current = jobs["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("coordinator journal references a missing job")
            expected = operation["expectedJobRevision"]
            if current["revision"] == expected:
                if current["status"] != operation["sourceStatus"]:
                    raise StoreError("coordinator journal source status drifted")
                updated = dict(current)
                updated["status"] = operation["targetStatus"]
                updated["closedOutcome"] = None
                updated["revision"] = expected + 1
                updated["updatedAt"] = operation["at"]
                _validate_job_record(job_id, updated)
                jobs["jobs"][job_id] = updated
                jobs["metadata"]["updatedAt"] = operation["at"]
                atomic_write_json(self.jobs_path, jobs)
            elif not (current["revision"] == expected + 1 and current["status"] == operation["targetStatus"]):
                raise StoreError("coordinator journal cannot be reconciled")
            session = operation["session"]
            path = self._session_path(job_id)
            existing = self._read_session_projection(
                path, job_id, current.get("ats")
            )
            existing_revision = self._session_revision(existing)
            if existing_revision == operation["expectedSessionRevision"]:
                atomic_write_json(path, session)
            elif _canonical_json(existing) != _canonical_json(session):
                raise StoreError("coordinator session cannot be reconciled")
            atomic_write_json(self.coordinator_path, {"schemaVersion": SCHEMA_VERSION, "claim": None})
            atomic_write_json(self.coordinator_journal_path, {"schemaVersion": SCHEMA_VERSION, "operation": None})
            return
        event = operation.get("historyEvent")
        if event is not None:
            self._history_event_is_idempotent_locked(event)
        job_id = _safe_session_id(operation.get("jobId", ""))
        if "targetStatus" in operation:
            jobs = self._load_jobs_document()
            current = jobs["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("coordinator journal references a missing job")
            expected = operation["expectedRevision"]
            if current["revision"] == expected:
                if current["status"] != operation["sourceStatus"]:
                    raise StoreError("coordinator journal source status drifted")
                updated = dict(current)
                updated["status"] = operation["targetStatus"]
                updated["closedOutcome"] = None
                updated["revision"] = expected + 1
                updated["updatedAt"] = operation["at"]
                _validate_job_record(job_id, updated)
                jobs["jobs"][job_id] = updated
                jobs["metadata"]["updatedAt"] = operation["at"]
                atomic_write_json(self.jobs_path, jobs)
            elif not (
                current["revision"] == expected + 1
                and current["status"] == operation["targetStatus"]
            ):
                raise StoreError("coordinator journal cannot be reconciled")
        session = operation.get("session")
        if session is not None:
            _validate_session_document(session)
            atomic_write_json(self._session_path(job_id), session)
        if event is not None:
            self._append_history_event_idempotent_locked(event)
        atomic_write_json(
            self.coordinator_path,
            {"schemaVersion": SCHEMA_VERSION, "claim": operation.get("resultClaim")},
        )
        atomic_write_json(
            self.coordinator_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": None},
        )

    def _commit_coordinator_operation_locked(self, operation: dict[str, Any]) -> None:
        event = operation.get("historyEvent")
        if event is not None:
            self._history_event_is_idempotent_locked(event)
        atomic_write_json(
            self.coordinator_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": operation},
        )
        self._roll_forward_locked()

    def resolve_pending_answer(
        self, job_id: str, reference: str, expected_job_revision: int,
        expected_session_revision: int, expected_answer_revision: int,
        owner_confirmed: bool = False,
    ) -> dict[str, Any]:
        """Recheck one pending question without copying its answer value."""
        self.initialize()
        self._ensure_coordinator_files()
        job_id = _safe_session_id(job_id)
        if not owner_confirmed:
            raise StoreError("answer resolution requires explicit owner confirmation")
        if not isinstance(reference, str) or PENDING_REFERENCE.fullmatch(reference) is None:
            raise StoreError("pending question reference is invalid")
        for revision in (expected_job_revision, expected_session_revision, expected_answer_revision):
            if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
                raise StoreError("answer resolution revision is invalid")
        with exclusive_file_lock(self.store_lock_path):
            self._require_job_unclaimed_locked(job_id)
            jobs = self._load_jobs_document()
            job = jobs["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if job["revision"] != expected_job_revision:
                raise StoreError("job revision conflict")
            if job["status"] != "needs_info":
                raise StoreError("answer resolution requires a needs_info job")
            path = self._session_path(job_id)
            if not path.exists():
                raise StoreError("answer resolution session does not exist")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            if self._session_revision(session) != expected_session_revision:
                raise StoreError("session revision conflict")
            pending = session.get("pendingFields", [])
            matching = [
                (index, field) for index, field in enumerate(pending)
                if field.get("reference") == reference
            ]
            if len(matching) != 1:
                raise StoreError("pending question reference is stale")
            index, field = matching[0]
            key = field.get("answerKey")
            if not isinstance(key, str) or not key:
                raise StoreError("pending question has no referenced answer")
            if field.get("sensitive") is True or field.get("state") == "sensitive":
                raise StoreError("sensitive pending answers require reconfirmation")
            answers = self._load_answers_document()
            resolved_key = self._resolve_answer_key_in_document(answers, key)
            answer = answers["answers"].get(resolved_key)
            if answer is None or answer.get("deletedAt") is not None:
                raise StoreError("referenced answer does not exist")
            if answer.get("revision", 1) != expected_answer_revision:
                raise StoreError("answer revision conflict")
            if answer.get("reviewStatus", "accepted") != "accepted" or answer.get("state") != "confirmed" or answer.get("value") is None:
                raise StoreError("referenced answer is not accepted and confirmed")
            if self._answer_is_sensitive(answer):
                raise StoreError("sensitive pending answers require reconfirmation")
            now = self._now()
            updated_session = copy.deepcopy(session)
            del updated_session["pendingFields"][index]
            updated_session["blockers"] = [
                blocker
                for blocker in updated_session.get("blockers", [])
                if blocker.get("reference") != reference
            ]
            answer_keys = list(updated_session.get("answerKeys", []))
            if resolved_key not in answer_keys:
                answer_keys.append(resolved_key)
            updated_session["answerKeys"] = answer_keys
            updated_session["updatedAt"] = now
            _validate_session_document(updated_session)
            target = "needs_info"
            if (
                not updated_session["pendingFields"]
                and not updated_session.get("blockers", [])
                and (updated_session.get("browserHandoff") or {}).get("state")
                not in {"required", "ready_for_owner"}
            ):
                if not self._preflight_job_record(job)["ready"]:
                    raise StoreError("job preflight failed after answer resolution")
                target = "ready"
            self._commit_coordinator_operation_locked({
                "kind": "answer_resolution", "operationId": str(uuid.uuid4()),
                "jobId": job_id, "at": now, "answerKey": resolved_key,
                "expectedJobRevision": expected_job_revision,
                "expectedSessionRevision": expected_session_revision,
                "expectedAnswerRevision": expected_answer_revision,
                "sourceStatus": "needs_info", "targetStatus": target,
                "session": updated_session, "resultClaim": None,
            })
            result_job = self._load_jobs_document()["jobs"][job_id]
            return {
                "job": {"id": job_id, "status": result_job["status"], "revision": result_job["revision"]},
                "session": {
                    "revision": self._session_revision(updated_session),
                    "pendingInformation": [
                        {key: item[key] for key in ("question", "state", "sensitive") if key in item}
                        | self._pending_resolution_projection(item, answers)
                        for item in updated_session["pendingFields"]
                    ],
                },
                "resolved": True, "ready": target == "ready",
            }

    def acquire_ready_job(
        self, job_id: str, owner_label: str, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        _safe_session_id(job_id)
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            coordinator = self._load_coordinator_document()
            current_claim = coordinator["claim"]
            if current_claim is not None:
                if self._now_datetime() >= self._parse_time(current_claim["expiresAt"]):
                    raise StoreError("expired claim requires explicit same-job recovery")
                raise StoreError("another live job claim already exists")
            jobs = self._load_jobs_document()
            job = jobs["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if job["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            if job["status"] != "ready":
                raise StoreError("only a ready job can be acquired")
            preflight = self._preflight_job_record(job)
            if not preflight["ready"]:
                raise StoreError("job is not ready")
            now_dt = self._now_datetime()
            now = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            token = self._new_claim_token()
            claim = {
                "claimId": str(uuid.uuid4()),
                "jobId": job_id,
                "ownerLabel": owner_label.strip(),
                "tokenHash": self._token_hash(token),
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": (now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(uuid.uuid4())
            operation = {
                "kind": "acquire", "operationId": operation_id, "jobId": job_id,
                "sourceStatus": "ready", "targetStatus": "in_progress",
                "expectedRevision": job["revision"], "at": now,
                "historyEvent": self._history_event_for_operation(operation_id, job, "job-started", "in_progress", now),
                "resultClaim": claim,
            }
            self._commit_coordinator_operation_locked(operation)
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "resume": self._resume_for_acquisition(
                    self._load_resumes_document()["resumes"][preflight["resumeId"]]
                ),
                "claim": self._public_claim(claim),
                "token": token,
            }

    def restart_reviewed_job(
        self,
        job_id: str,
        owner_label: str,
        expected_revision: int,
        owner_confirmed_not_submitted: bool = False,
    ) -> dict[str, Any]:
        """Atomically reclaim one reviewed, owner-confirmed unsubmitted job."""

        self.initialize()
        self._ensure_coordinator_files()
        job_id = _safe_session_id(job_id)
        if owner_confirmed_not_submitted is not True:
            raise StoreError(
                "review restart requires explicit owner confirmation that the application was not submitted"
            )
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise StoreError("job revision is invalid")

        with exclusive_file_lock(self.store_lock_path):
            coordinator = self._load_coordinator_document()
            current_claim = coordinator["claim"]
            if current_claim is not None:
                if self._now_datetime() >= self._parse_time(current_claim["expiresAt"]):
                    raise StoreError("expired claim requires explicit same-job recovery")
                raise StoreError("another live job claim already exists")

            jobs = self._load_jobs_document()
            job = jobs["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if job["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            if job["status"] != "awaiting_review":
                raise StoreError("review restart requires an awaiting_review job")

            session_path = self._session_path(job_id)
            if not session_path.exists():
                raise StoreError("review restart requires prior review evidence")
            raw_session = read_json_object(session_path, "session")
            validate_version(raw_session, "session")
            session = _project_legacy_session(raw_session, job.get("ats"))
            review_envelope = {
                "attemptRevision", "readiness", "browserHandoff",
            }
            legacy_review_rebuild = not (review_envelope & set(raw_session))
            if legacy_review_rebuild:
                if (
                    session.get("status") != "review"
                    or session.get("step") != "final_review"
                    or session.get("pendingFields")
                    or session.get("blockers")
                ):
                    raise StoreError(
                        "review restart requires complete prior review evidence"
                    )
            else:
                # The modern 1.3.2 path remains strict. Any partial envelope,
                # explicit null, malformed value, or contradictory evidence is
                # rejected rather than being interpreted as legacy absence.
                readiness = session.get("readiness")
                if (
                    session.get("status") != "review"
                    or session.get("attemptRevision") != job["revision"] - 1
                    or session.get("pendingFields")
                    or session.get("blockers")
                    or readiness is None
                    or readiness.get("status") != "ready"
                    or readiness.get("evidenceKind")
                    != "agent_attested_current_attempt"
                    or readiness.get("attemptRevision")
                    != session.get("attemptRevision")
                    or readiness.get("blockerCodes")
                    or any(
                        value != "passed"
                        for value in readiness.get("assertions", {}).values()
                    )
                    or session.get("browserHandoff") != {
                        "state": "ready_for_owner",
                        "reasonCode": "final-review-required",
                        "revision": 1,
                    }
                ):
                    raise StoreError(
                        "review restart requires complete prior review evidence"
                    )
            job_history = [
                event
                for event in self.read_history()
                if event.get("applicationId") == job_id
            ]
            if (
                not job_history
                or job_history[-1].get("event") != "reviewed"
                or job_history[-1].get("status") != "awaiting_review"
            ):
                raise StoreError("review restart requires prior reviewed history")
            if legacy_review_rebuild and any(
                event.get("event") in {
                    "job-restarted", "legacy-review-rebuild",
                }
                for event in job_history[:-1]
            ):
                raise StoreError("legacy review restart was already used")

            preflight = self._preflight_job_record(job)
            resumes = self._load_resumes_document()["resumes"]
            resume = resumes.get(preflight.get("resumeId"))
            if (
                not preflight["ready"]
                or resume is None
                or resume.get("storageKind") != "managed"
            ):
                raise StoreError("job is not ready with a current managed resume")

            now_dt = self._now_datetime()
            now = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            token = self._new_claim_token()
            claim = {
                "claimId": str(uuid.uuid4()),
                "jobId": job_id,
                "ownerLabel": owner_label.strip(),
                "tokenHash": self._token_hash(token),
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": (
                    now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)
                ).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(uuid.uuid4())
            operation = {
                "kind": "review_restart",
                "operationId": operation_id,
                "jobId": job_id,
                "sourceStatus": "awaiting_review",
                "targetStatus": "in_progress",
                "expectedRevision": job["revision"],
                "at": now,
                "historyEvent": self._history_event_for_operation(
                    operation_id,
                    job,
                    (
                        "legacy-review-rebuild"
                        if legacy_review_rebuild
                        else "job-restarted"
                    ),
                    "in_progress",
                    now,
                ),
                "resultClaim": claim,
            }
            self._commit_coordinator_operation_locked(operation)
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "resume": self._resume_for_acquisition(resume),
                "claim": self._public_claim(claim),
                "token": token,
            }

    def heartbeat_claim(self, job_id: str, token: str) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            claim = dict(self._require_claim_locked(job_id, token))
            now_dt = self._now_datetime()
            claim["heartbeatAt"] = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            claim["expiresAt"] = (now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat(timespec="seconds").replace("+00:00", "Z")
            atomic_write_json(self.coordinator_path, {"schemaVersion": SCHEMA_VERSION, "claim": claim})
            return {"claim": self._public_claim(claim)}

    def recover_claim(self, job_id: str, owner_label: str) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        _safe_session_id(job_id)
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            old = self._load_coordinator_document()["claim"]
            if old is None or old["jobId"] != job_id:
                raise StoreError("explicit recovery must name the expired claimed job")
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("expired claim job is not in progress")
            if self._now_datetime() < self._parse_time(old["expiresAt"]):
                raise StoreError("live claim cannot be recovered")
            now_dt = self._now_datetime()
            now = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            token = self._new_claim_token()
            claim = {
                "claimId": str(uuid.uuid4()), "jobId": job_id,
                "ownerLabel": owner_label.strip(), "tokenHash": self._token_hash(token),
                "acquiredAt": now, "heartbeatAt": now,
                "expiresAt": (now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(uuid.uuid4())
            self._commit_coordinator_operation_locked({
                "kind": "recover", "operationId": operation_id, "jobId": job_id,
                "at": now,
                "historyEvent": self._history_event_for_operation(operation_id, job, "claim-recovered", "in_progress", now),
                "resultClaim": claim,
            })
            return {"job": job, "claim": self._public_claim(claim), "token": token}

    def trash_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_job_deleted(job_id, expected_revision, restore=False)

    def restore_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_job_deleted(job_id, expected_revision, restore=True)

    def _set_job_deleted(
        self, job_id: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            self._require_job_unclaimed_locked(job_id)
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                return current
            if restore:
                self._require_active_resume(current.get("resumeId"))
                duplicate = next(
                    (
                        item
                        for key, item in document["jobs"].items()
                        if key != job_id
                        and item.get("deletedAt") is None
                        and item.get("normalizedUrl") == current["normalizedUrl"]
                    ),
                    None,
                )
                if duplicate is not None:
                    raise StoreError("active job URL already exists")
            updated = dict(current)
            updated["deletedAt"] = None if restore else utc_now()
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    def delete_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None:
                return {"deleted": False, "id": job_id}
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            self._require_job_unclaimed_locked(job_id)
            if current.get("deletedAt") is None:
                raise StoreError("job must be trashed before permanent deletion")
            session_path = self._session_path(job_id)
            if session_path.exists():
                session = self._read_session_projection(
                    session_path, job_id, current.get("ats")
                )
                if session["status"] not in {"completed", "abandoned"}:
                    raise StoreError("job is referenced by a nonterminal application session")
            del document["jobs"][job_id]
            document["metadata"]["updatedAt"] = utc_now()
            atomic_write_json(self.jobs_path, document)
        return {"deleted": True, "id": job_id}

    def create_resume(self, incoming: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        allowed = {"id", "label", "path", "tags", "default"}
        if set(incoming) - allowed:
            raise StoreError("resume input contains unsupported fields")
        resume_id = incoming.get("id") or f"resume-{uuid.uuid4()}"
        _safe_session_id(resume_id)
        label = incoming.get("label")
        tags_input = incoming.get("tags", [])
        if not isinstance(tags_input, list):
            raise StoreError("resume tags must be a list")
        tags = [
            item.strip() if isinstance(item, str) else item for item in tags_input
        ]
        now = utc_now()
        with exclusive_file_lock(self.store_lock_path):
            with self._staged_resume(incoming.get("path", ""), resume_id) as staged:
                document = self._load_resumes_document()
                if resume_id in document["resumes"]:
                    raise StoreError("resume id already exists")
                if any(
                    item.get("storageKind") == "managed"
                    and item.get("digest") == staged["digest"]
                    for item in document["resumes"].values()
                ):
                    raise StoreError("resume file is already managed")
                active = [
                    item
                    for item in document["resumes"].values()
                    if item.get("deletedAt") is None
                ]
                make_default = incoming.get("default", not active)
                if not isinstance(make_default, bool):
                    raise StoreError("resume default must be a boolean")
                if make_default:
                    for key, item in list(document["resumes"].items()):
                        if item.get("deletedAt") is None and item.get("default"):
                            changed = dict(item)
                            changed["default"] = False
                            changed["revision"] += 1
                            changed["updatedAt"] = now
                            document["resumes"][key] = changed
                record = {
                    "id": resume_id,
                    "label": label.strip() if isinstance(label, str) else label,
                    "storageKind": "managed",
                    "managedFile": staged["managedFile"],
                    "originalFilename": staged["originalFilename"],
                    "mediaType": staged["mediaType"],
                    "digest": staged["digest"],
                    "contentRevision": self._new_resume_content_revision(),
                    "tags": tags,
                    "default": make_default,
                    "observedSize": staged["observedSize"],
                    "observedModifiedAt": staged["observedModifiedAt"],
                    "revision": 1,
                    "createdAt": now,
                    "updatedAt": now,
                    "deletedAt": None,
                }
                _validate_resume_record(resume_id, record)
                document["resumes"][resume_id] = record
                document["metadata"]["updatedAt"] = now
                destination = self.resume_files_path / staged["managedFile"]
                self._install_staged_resume(
                    staged,
                    destination,
                    lambda: atomic_write_json(self.resumes_path, document),
                )
        return record

    def import_resume(self, incoming: dict[str, Any]) -> dict[str, Any]:
        return self.create_resume(incoming)

    def create_resume_bytes(
        self, incoming: dict[str, Any], original_filename: str, content: bytes
    ) -> dict[str, Any]:
        with self._temporary_resume_source(original_filename, content) as source:
            return self.create_resume({**incoming, "path": str(source)})

    def update_resume_bytes(
        self,
        resume_id: str,
        original_filename: str,
        content: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        with self._temporary_resume_source(original_filename, content) as source:
            return self.update_resume(
                resume_id, {"path": str(source)}, expected_revision
            )

    def adopt_resume_bytes(
        self,
        resume_id: str,
        original_filename: str,
        content: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        with self._temporary_resume_source(original_filename, content) as source:
            return self.adopt_resume(resume_id, str(source), expected_revision)

    def read_resume_content(self, resume_id: str) -> tuple[dict[str, Any], bytes]:
        record = self.get_resume(resume_id)
        if record is None or record.get("storageKind") != "managed":
            raise StoreError("managed resume does not exist")
        path = self._managed_resume_path(record)
        flags = os.O_RDONLY | getattr(os, "O_BINARY", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        descriptor: int | None = None
        try:
            if path.is_symlink():
                raise OSError
            descriptor = os.open(path, flags)
            metadata = os.fstat(descriptor)
            if not stat.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= RESUME_MAX_BYTES:
                raise OSError
            chunks: list[bytes] = []
            digest = hashlib.sha256()
            total = 0
            while True:
                chunk = os.read(descriptor, min(1024 * 1024, RESUME_MAX_BYTES + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > RESUME_MAX_BYTES:
                    raise OSError
                digest.update(chunk)
                chunks.append(chunk)
            if total != metadata.st_size or digest.hexdigest() != record["digest"]:
                raise OSError
        except OSError:
            raise StoreError("managed resume content is unavailable") from None
        finally:
            if descriptor is not None:
                os.close(descriptor)
        content = b"".join(chunks)
        return record, content

    def resolve_resume(self, resume_id: str | None = None) -> dict[str, Any]:
        """Resolve one active managed resume for trusted local file upload."""

        self.initialize()
        records = self._load_resumes_document()["resumes"]
        if resume_id is None:
            record = next(
                (
                    item
                    for item in records.values()
                    if item.get("deletedAt") is None and item.get("default")
                ),
                None,
            )
        else:
            _safe_session_id(resume_id)
            record = records.get(resume_id)
            if record is not None and record.get("deletedAt") is not None:
                record = None
        if record is None:
            raise StoreError("active resume does not exist")
        if record.get("storageKind") != "managed":
            raise StoreError("resume must be adopted before use")
        observation = self._managed_resume_observation(record)
        if (
            not observation["exists"]
            or observation.get("digest") != record["digest"]
        ):
            raise StoreError("managed resume content is unavailable")
        return {
            "id": record["id"],
            "revision": record["revision"],
            "mediaType": record["mediaType"],
            "path": str(self._managed_resume_path(record)),
        }

    def get_resume(
        self, resume_id: str, include_trashed: bool = False
    ) -> dict[str, Any] | None:
        self.initialize()
        _safe_session_id(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or (record.get("deletedAt") is not None and not include_trashed):
            return None
        return _require_object(record, "resume record")

    def list_resumes(
        self, include_trashed: bool = False, trashed_only: bool = False
    ) -> list[dict[str, Any]]:
        self.initialize()
        if trashed_only:
            include_trashed = True
        records = [
            record
            for record in self._load_resumes_document()["resumes"].values()
            if (include_trashed or record.get("deletedAt") is None)
            and (not trashed_only or record.get("deletedAt") is not None)
        ]
        return sorted(
            records,
            key=lambda item: (
                not item.get("default", False),
                item.get("label", "").casefold(),
                item["id"],
            ),
        )

    def update_resume(
        self, resume_id: str, patch: dict[str, Any], expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        allowed = {"label", "path", "tags"}
        if not patch or set(patch) - allowed:
            raise StoreError("resume patch contains unsupported fields")
        with exclusive_file_lock(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            original_document = copy.deepcopy(document)
            current = document["resumes"].get(resume_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            updated = {**current, **{key: value for key, value in patch.items() if key != "path"}}
            if "label" in patch and isinstance(patch["label"], str):
                updated["label"] = patch["label"].strip()
            if "tags" in patch:
                if not isinstance(patch["tags"], list):
                    raise StoreError("resume tags must be a list")
                updated["tags"] = [
                    item.strip() if isinstance(item, str) else item
                    for item in patch["tags"]
                ]
            if "path" in patch:
                if current.get("storageKind") != "managed":
                    raise StoreError("legacy resume bytes require resume-adopt")
                with self._staged_resume(patch["path"], resume_id) as staged:
                    if any(
                        key != resume_id
                        and item.get("storageKind") == "managed"
                        and item.get("digest") == staged["digest"]
                        for key, item in document["resumes"].items()
                    ):
                        raise StoreError("resume file is already managed")
                    updated.update(
                        {
                            "managedFile": staged["managedFile"],
                            "originalFilename": staged["originalFilename"],
                            "mediaType": staged["mediaType"],
                            "digest": staged["digest"],
                            "contentRevision": self._new_resume_content_revision(),
                            "observedSize": staged["observedSize"],
                            "observedModifiedAt": staged["observedModifiedAt"],
                        }
                    )
                    updated["revision"] = current["revision"] + 1
                    updated["updatedAt"] = utc_now()
                    _validate_resume_record(resume_id, updated)
                    document["resumes"][resume_id] = updated
                    document["metadata"]["updatedAt"] = updated["updatedAt"]
                    requests_document = None
                    original_requests_document = None
                    if self.resume_extraction_requests_path.exists():
                        requests_document = self._load_extraction_requests_document()
                        original_requests_document = copy.deepcopy(requests_document)
                        open_request = next((
                            item for item in requests_document["requests"].values()
                            if item["resumeId"] == resume_id
                            and item["status"] == "requested"
                        ), None)
                        if open_request is not None:
                            self._close_resume_extraction_request_locked(
                                requests_document, open_request["requestId"],
                                open_request["revision"], "stale",
                            )
                    old_path = self._managed_resume_path(current)
                    destination = self.resume_files_path / staged["managedFile"]

                    def rollback_documents() -> None:
                        atomic_write_json(self.resumes_path, original_document)
                        if original_requests_document is not None:
                            atomic_write_json(
                                self.resume_extraction_requests_path,
                                original_requests_document,
                            )
                        if self.resume_extraction_journal_path.exists():
                            atomic_write_json(
                                self.resume_extraction_journal_path,
                                {"schemaVersion": SCHEMA_VERSION, "operation": None},
                            )

                    self._install_staged_resume(
                        staged,
                        destination,
                        lambda: self._commit_extraction_operation_locked(
                            "resume-request-close", None, None,
                            requests_document, document,
                        ) if requests_document is not None else atomic_write_json(
                            self.resumes_path, document
                        ),
                        previous=old_path,
                        rollback_metadata=rollback_documents,
                    )
            else:
                updated["revision"] = current["revision"] + 1
                updated["updatedAt"] = utc_now()
                _validate_resume_record(resume_id, updated)
                document["resumes"][resume_id] = updated
                document["metadata"]["updatedAt"] = updated["updatedAt"]
                atomic_write_json(self.resumes_path, document)
        return updated

    def adopt_resume(
        self, resume_id: str, source_path: str | None, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if current.get("storageKind") == "managed":
                raise StoreError("resume is already managed")
            staged = self._stage_resume_import(source_path or current["path"], resume_id)
            try:
                if any(
                    key != resume_id
                    and item.get("storageKind") == "managed"
                    and item.get("digest") == staged["digest"]
                    for key, item in document["resumes"].items()
                ):
                    raise StoreError("resume file is already managed")
                updated = {key: value for key, value in current.items() if key != "path"}
                updated.update(
                    {
                        "storageKind": "managed",
                        "managedFile": staged["managedFile"],
                        "originalFilename": staged["originalFilename"],
                        "mediaType": staged["mediaType"],
                        "digest": staged["digest"],
                        "contentRevision": self._new_resume_content_revision(),
                        "observedSize": staged["observedSize"],
                        "observedModifiedAt": staged["observedModifiedAt"],
                        "revision": current["revision"] + 1,
                        "updatedAt": utc_now(),
                    }
                )
                _validate_resume_record(resume_id, updated)
                document["resumes"][resume_id] = updated
                document["metadata"]["updatedAt"] = updated["updatedAt"]
                self._install_staged_resume(
                    staged,
                    self.resume_files_path / staged["managedFile"],
                    lambda: atomic_write_json(self.resumes_path, document),
                )
            finally:
                staged["path"].unlink(missing_ok=True)
        return updated

    def set_default_resume(
        self, resume_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_resumes_document()
            target = document["resumes"].get(resume_id)
            if target is None or target.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if target["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if target["default"]:
                return target
            now = utc_now()
            for key, item in list(document["resumes"].items()):
                if item.get("deletedAt") is not None:
                    continue
                if item.get("default") or key == resume_id:
                    changed = dict(item)
                    changed["default"] = key == resume_id
                    changed["revision"] += 1
                    changed["updatedAt"] = now
                    document["resumes"][key] = changed
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.resumes_path, document)
            return document["resumes"][resume_id]

    def check_resume(self, resume_id: str) -> dict[str, Any]:
        record = self.get_resume(resume_id, include_trashed=True)
        if record is None:
            raise StoreError("resume does not exist")
        current = (
            self._managed_resume_observation(record)
            if record.get("storageKind") == "managed"
            else observe_resume_file(str(self._resume_path(record)))
        )
        changed = (
            current["size"] != record.get("observedSize")
            or current["modifiedAt"] != record.get("observedModifiedAt")
            or (
                record.get("storageKind") == "managed"
                and current.get("digest") != record.get("digest")
            )
        )
        return {
            "id": resume_id,
            "exists": current["exists"],
            "changed": changed,
            "observedSize": record.get("observedSize"),
            "observedModifiedAt": record.get("observedModifiedAt"),
            "currentSize": current["size"],
            "currentModifiedAt": current["modifiedAt"],
            "storageKind": record.get("storageKind", "external"),
        }

    def trash_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_resume_deleted(resume_id, expected_revision, restore=False)

    def restore_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_resume_deleted(resume_id, expected_revision, restore=True)

    def _set_resume_deleted(
        self, resume_id: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                return current
            if restore:
                if any(
                    key != resume_id
                    and item.get("deletedAt") is None
                    and (
                        (
                            current.get("storageKind") == "managed"
                            and item.get("storageKind") == "managed"
                            and item.get("digest") == current.get("digest")
                        )
                        or (
                            current.get("storageKind") is None
                            and item.get("storageKind") is None
                            and item.get("path") == current.get("path")
                        )
                    )
                    for key, item in document["resumes"].items()
                ):
                    raise StoreError("active resume file already exists")
            else:
                jobs = list(self._load_jobs_document()["jobs"].values())
                if any(
                    item.get("deletedAt") is None
                    and item.get("resumeId") == resume_id
                    for item in jobs
                ):
                    raise StoreError("resume is assigned to an active job")
                if current.get("default") and any(
                    item.get("deletedAt") is None and item.get("resumeId") is None
                    for item in jobs
                ):
                    raise StoreError("default resume is used by an active job")
            updated = dict(current)
            updated["deletedAt"] = None if restore else utc_now()
            if not restore:
                updated["default"] = False
            elif not any(
                key != resume_id and item.get("deletedAt") is None
                for key, item in document["resumes"].items()
            ):
                updated["default"] = True
            else:
                updated["default"] = False
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_resume_record(resume_id, updated)
            document["resumes"][resume_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            requests_document = None
            if not restore and self.resume_extraction_requests_path.exists():
                requests_document = self._load_extraction_requests_document()
                open_request = next((
                    item for item in requests_document["requests"].values()
                    if item["resumeId"] == resume_id and item["status"] == "requested"
                ), None)
                if open_request is not None:
                    self._close_resume_extraction_request_locked(
                        requests_document, open_request["requestId"],
                        open_request["revision"], "cancelled",
                    )
            if requests_document is not None:
                self._commit_extraction_operation_locked(
                    "resume-request-close", None, None, requests_document, document
                )
            else:
                atomic_write_json(self.resumes_path, document)
        return updated

    def delete_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None:
                return {"deleted": False, "id": resume_id}
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("resume must be trashed before permanent deletion")
            if self.resume_extraction_requests_path.exists() and any(
                item["resumeId"] == resume_id and item["status"] == "requested"
                for item in self._load_extraction_requests_document()["requests"].values()
            ):
                raise StoreError("resume has an open extraction request")
            if any(
                item.get("resumeId") == resume_id
                for item in self._load_jobs_document()["jobs"].values()
            ):
                raise StoreError("resume is still referenced by a job")
            managed_path = (
                self._managed_resume_path(current)
                if current.get("storageKind") == "managed"
                else None
            )
            quarantine: Path | None = None
            if managed_path is not None and managed_path.exists():
                quarantine = self.resume_files_path / f".{managed_path.name}.{uuid.uuid4().hex}.quarantine"
                os.replace(managed_path, quarantine)
            del document["resumes"][resume_id]
            document["metadata"]["updatedAt"] = utc_now()
            try:
                atomic_write_json(self.resumes_path, document)
            except Exception:
                if quarantine is not None and quarantine.exists():
                    os.replace(quarantine, managed_path)
                    _fsync_directory(self.resume_files_path)
                raise
            if quarantine is not None:
                try:
                    quarantine.unlink()
                except OSError:
                    pass
                _fsync_directory(self.resume_files_path)
        return {"deleted": True, "id": resume_id}

    @staticmethod
    def _new_extraction_request(
        resume: dict[str, Any], supersedes: str | None = None
    ) -> dict[str, Any]:
        now = utc_now()
        return {
            "requestId": f"request-{uuid.uuid4()}",
            "resumeId": resume["id"],
            "resumeContentRevision": resume["contentRevision"],
            "revision": 1,
            "status": "requested",
            "createdAt": now,
            "updatedAt": now,
            "closedAt": None,
            "proposalId": None,
            "failureReason": None,
            "supersedesRequestId": supersedes,
        }

    def create_resume_extraction_request(
        self, resume_id: str, expected_resume_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            resumes_document = self._load_resumes_document()
            resume = resumes_document["resumes"].get(resume_id)
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume["revision"] != expected_resume_revision:
                raise StoreError("resume revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            requests_document = self._load_extraction_requests_document()
            if any(
                item["resumeId"] == resume_id and item["status"] == "requested"
                for item in requests_document["requests"].values()
            ):
                raise StoreError("open extraction request already exists")
            if resume.get("contentRevision") is None:
                resume = dict(resume)
                resume["contentRevision"] = self._new_resume_content_revision()
                resume["revision"] += 1
                resume["updatedAt"] = utc_now()
                _validate_resume_record(resume_id, resume)
                resumes_document["resumes"][resume_id] = resume
                resumes_document["metadata"]["updatedAt"] = resume["updatedAt"]
            request = self._new_extraction_request(resume)
            _validate_extraction_request(request["requestId"], request)
            requests_document["requests"][request["requestId"]] = request
            requests_document["metadata"]["updatedAt"] = request["updatedAt"]
            self._commit_extraction_operation_locked(
                "request-create", None, None, requests_document,
                resumes_document if resume["revision"] != expected_resume_revision else None,
            )
            return request

    def get_resume_extraction_request(self, request_id: str) -> dict[str, Any] | None:
        self.initialize()
        _safe_session_id(request_id)
        if not self.resume_extraction_requests_path.exists():
            return None
        return self._load_extraction_requests_document()["requests"].get(request_id)

    def list_resume_extraction_requests(
        self, resume_id: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        self.initialize()
        if resume_id is not None:
            _safe_session_id(resume_id)
        if status is not None and status not in EXTRACTION_REQUEST_STATUSES:
            raise StoreError("resume extraction request status is unsupported")
        if not self.resume_extraction_requests_path.exists():
            return []
        records = [
            item
            for item in self._load_extraction_requests_document()["requests"].values()
            if (resume_id is None or item["resumeId"] == resume_id)
            and (status is None or item["status"] == status)
        ]
        return order_extraction_requests(records)

    def _close_resume_extraction_request_locked(
        self, requests_document: dict[str, Any], request_id: str,
        expected_revision: int, status: str, failure_reason: str | None = None,
        proposal_id: str | None = None,
    ) -> dict[str, Any]:
        current = requests_document["requests"].get(request_id)
        if current is None:
            raise StoreError("resume extraction request does not exist")
        if current["revision"] != expected_revision:
            raise StoreError("request revision conflict")
        if current["status"] != "requested":
            raise StoreError("resume extraction request is not open")
        now = utc_now()
        updated = {
            **current, "status": status, "failureReason": failure_reason,
            "proposalId": proposal_id, "revision": current["revision"] + 1,
            "updatedAt": now, "closedAt": now,
        }
        _validate_extraction_request(request_id, updated)
        requests_document["requests"][request_id] = updated
        requests_document["metadata"]["updatedAt"] = now
        return updated

    def cancel_resume_extraction_request(
        self, request_id: str, expected_revision: int
    ) -> dict[str, Any]:
        return self._close_extraction_request(request_id, expected_revision, "cancelled")

    def fail_resume_extraction_request(
        self, request_id: str, reason: str, expected_revision: int
    ) -> dict[str, Any]:
        if reason not in EXTRACTION_REQUEST_FAILURE_REASONS:
            raise StoreError("resume extraction failure reason is unsupported")
        return self._close_extraction_request(
            request_id, expected_revision, "failed", reason
        )

    def _close_extraction_request(
        self, request_id: str, expected_revision: int, status: str,
        failure_reason: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(request_id)
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            document = self._load_extraction_requests_document()
            updated = self._close_resume_extraction_request_locked(
                document, request_id, expected_revision, status, failure_reason
            )
            self._commit_extraction_operation_locked(
                "request-close", None, None, document
            )
            return updated

    def retry_resume_extraction_request(
        self, request_id: str, expected_revision: int,
        expected_resume_revision: int,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(request_id)
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            document = self._load_extraction_requests_document()
            current = document["requests"].get(request_id)
            if current is None:
                raise StoreError("resume extraction request does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("request revision conflict")
            if current["status"] not in {"failed", "stale"}:
                raise StoreError("resume extraction request cannot be retried")
            resume = self._load_resumes_document()["resumes"].get(current["resumeId"])
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume["revision"] != expected_resume_revision:
                raise StoreError("resume revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            if any(
                item["resumeId"] == resume["id"] and item["status"] == "requested"
                for item in document["requests"].values()
            ):
                raise StoreError("open extraction request already exists")
            request = self._new_extraction_request(resume, request_id)
            _validate_extraction_request(request["requestId"], request)
            document["requests"][request["requestId"]] = request
            document["metadata"]["updatedAt"] = request["updatedAt"]
            self._commit_extraction_operation_locked(
                "request-retry", None, None, document
            )
            return request

    def _proposal_stale_reasons(self, proposal: dict[str, Any]) -> list[str]:
        resume = self._load_resumes_document()["resumes"].get(proposal["resumeId"])
        if resume is None:
            return ["resume_deleted"]
        reasons: list[str] = []
        if resume.get("deletedAt") is not None:
            reasons.append("resume_trashed")
        if resume.get("storageKind") != "managed":
            reasons.append("resume_not_managed")
            return reasons
        content_revision = proposal.get("resumeContentRevision")
        if content_revision is not None:
            if resume.get("contentRevision") != content_revision:
                reasons.append("resume_content_revision_changed")
        else:
            if resume["revision"] != proposal["resumeRevision"]:
                reasons.append("resume_revision_changed")
            if resume["digest"] != proposal["resumeDigest"]:
                reasons.append("resume_digest_changed")
        observation = self._managed_resume_observation(resume)
        if not observation["exists"]:
            reasons.append("resume_file_missing")
        elif observation.get("digest") != resume["digest"]:
            reasons.append("resume_file_changed")
        return reasons

    def _proposal_result(self, proposal: dict[str, Any]) -> dict[str, Any]:
        result = dict(proposal)
        reasons = self._proposal_stale_reasons(proposal)
        result["stale"] = bool(reasons)
        result["staleReasons"] = reasons
        return result

    @staticmethod
    def _proposal_summary(proposal: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": proposal["id"],
            "resumeId": proposal["resumeId"],
            "status": proposal["status"],
            "revision": proposal["revision"],
            "autoFilledCount": len(proposal["autoFilledPaths"]),
            "pendingCount": len(proposal["pendingPaths"]),
        }

    def _create_resume_proposal_locked(
        self,
        resume: dict[str, Any],
        candidate_input: dict[str, Any],
        profile_document: dict[str, Any],
        proposals_document: dict[str, Any],
        supersedes: str | None,
        *,
        bind_content_revision: bool,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        candidate, candidate_paths = _validated_candidate(candidate_input)
        profile_revision = profile_document["metadata"].get("revision", 1)
        pending = next((
            proposal for proposal in proposals_document["proposals"].values()
            if proposal["resumeId"] == resume["id"] and proposal["status"] == "pending"
        ), None)
        if pending is not None:
            if supersedes != pending["id"]:
                raise StoreError("pending proposal requires explicit supersession")
        elif supersedes is not None:
            raise StoreError("proposal to supersede does not exist")
        now = utc_now()
        proposal_id = f"proposal-{uuid.uuid4()}"
        profile = copy.deepcopy(profile_document["profile"])
        provenance = dict(profile_document["metadata"].get("factProvenance", {}))
        baselines = {
            path: _pointer_baseline(profile_document["profile"], path)
            for path in candidate_paths
        }
        auto_filled: list[str] = []
        pending_paths: list[str] = []
        for path in candidate_paths:
            baseline = baselines[path]
            ancestors_allow_fill = all(
                not ancestor["exists"]
                or (ancestor.get("container") is True and ancestor.get("empty") is False)
                or ("value" in ancestor and ancestor["value"] is None)
                for ancestor in baseline["ancestors"]
            )
            empty = not baseline["exists"] or baseline.get("value") is None
            if empty and ancestors_allow_fill and not self._user_protects_path(provenance, path):
                _exists, extracted = _pointer_lookup(candidate, path)
                _set_pointer_value(profile, path, extracted, replace_ancestors=False)
                auto_filled.append(path)
            else:
                pending_paths.append(path)
        result_profile_revision = profile_revision
        if auto_filled:
            metadata = dict(profile_document["metadata"])
            metadata["revision"] = profile_revision + 1
            metadata["updatedAt"] = now
            metadata["factProvenance"] = self._stamp_fact_provenance(
                provenance, auto_filled, "resume", now, profile_document["profile"]
            )
            profile_document = {
                "schemaVersion": SCHEMA_VERSION, "profile": profile, "metadata": metadata,
            }
            result_profile_revision = metadata["revision"]
        if pending is not None:
            replaced = dict(pending)
            replaced.update({
                "status": "superseded", "supersededBy": proposal_id,
                "revision": pending["revision"] + 1, "updatedAt": now,
            })
            _validate_extraction_proposal(pending["id"], replaced)
            proposals_document["proposals"][pending["id"]] = replaced
        proposal = {
            "id": proposal_id,
            "resumeId": resume["id"],
            "resumeRevision": resume["revision"],
            "resumeDigest": resume["digest"],
            "profileRevision": profile_revision,
            "resultProfileRevision": result_profile_revision,
            "candidate": candidate,
            "baselines": baselines,
            "autoFilledPaths": auto_filled,
            "pendingPaths": pending_paths,
            "decisions": {},
            "status": "pending" if pending_paths else "completed",
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "supersededBy": None,
        }
        if bind_content_revision:
            proposal["resumeContentRevision"] = resume["contentRevision"]
        _validate_extraction_proposal(proposal_id, proposal)
        proposals_document["proposals"][proposal_id] = proposal
        proposals_document["metadata"]["updatedAt"] = now
        _validate_extractions_document(proposals_document)
        return profile_document, proposals_document, proposal

    def create_resume_proposal(
        self,
        resume_id: str,
        candidate_input: dict[str, Any],
        expected_resume_revision: int,
        expected_profile_revision: int,
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        _validated_candidate(candidate_input)
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_extraction_files_locked()
            self._roll_forward_extraction_locked()
            resumes = self._load_resumes_document()["resumes"]
            resume = resumes.get(resume_id)
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume["revision"] != expected_resume_revision:
                raise StoreError("resume revision conflict")
            observation = self._managed_resume_observation(resume)
            if (
                not observation["exists"]
                or observation.get("digest") != resume["digest"]
            ):
                raise StoreError("resume file is not ready for extraction")
            profile_document = self._load_profile_document()
            profile_revision = profile_document["metadata"].get("revision", 1)
            if profile_revision != expected_profile_revision:
                raise StoreError("profile revision conflict")
            proposals_document = self._load_extractions_document()
            profile_document, proposals_document, proposal = (
                self._create_resume_proposal_locked(
                    resume, candidate_input, profile_document,
                    proposals_document, supersedes, bind_content_revision=False,
                )
            )
            self._commit_extraction_operation_locked(
                "create", profile_document, proposals_document
            )
            return self._proposal_result(proposal)

    def complete_resume_extraction_request(
        self,
        request_id: str,
        candidate_input: dict[str, Any],
        expected_request_revision: int,
        expected_profile_revision: int,
        expected_pending_proposal_id: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(request_id)
        if expected_pending_proposal_id is not None:
            _safe_session_id(expected_pending_proposal_id)
        _validated_candidate(candidate_input)
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            requests_document = self._load_extraction_requests_document()
            request = requests_document["requests"].get(request_id)
            if request is None:
                raise StoreError("resume extraction request does not exist")
            if request["revision"] != expected_request_revision:
                raise StoreError("request revision conflict")
            if request["status"] != "requested":
                raise StoreError("resume extraction request is not open")
            resume = self._load_resumes_document()["resumes"].get(request["resumeId"])
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume.get("contentRevision") != request["resumeContentRevision"]:
                raise StoreError("resume content revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            profile_document = self._load_profile_document()
            if profile_document["metadata"].get("revision", 1) != expected_profile_revision:
                raise StoreError("profile revision conflict")
            proposals_document = self._load_extractions_document()
            profile_document, proposals_document, proposal = (
                self._create_resume_proposal_locked(
                    resume, candidate_input, profile_document, proposals_document,
                    expected_pending_proposal_id, bind_content_revision=True,
                )
            )
            completed = self._close_resume_extraction_request_locked(
                requests_document, request_id, expected_request_revision,
                "completed", proposal_id=proposal["id"],
            )
            self._commit_extraction_operation_locked(
                "request-complete", profile_document, proposals_document,
                requests_document,
            )
            return {
                "request": completed,
                "proposalSummary": {
                    "id": proposal["id"],
                    "status": proposal["status"],
                    "revision": proposal["revision"],
                    "autoFilledCount": len(proposal["autoFilledPaths"]),
                    "pendingCount": len(proposal["pendingPaths"]),
                },
            }

    def get_resume_proposal(self, proposal_id: str) -> dict[str, Any] | None:
        self.initialize()
        _safe_session_id(proposal_id)
        if not self.resume_extractions_path.exists():
            return None
        proposal = self._load_extractions_document()["proposals"].get(proposal_id)
        return self._proposal_result(proposal) if proposal is not None else None

    def list_resume_proposals(
        self, resume_id: str | None = None, status: str | None = None,
        *, summary_only: bool = False,
    ) -> list[dict[str, Any]]:
        self.initialize()
        if resume_id is not None:
            _safe_session_id(resume_id)
        if status is not None and status not in EXTRACTION_STATUSES:
            raise StoreError("resume proposal status is unsupported")
        if not self.resume_extractions_path.exists():
            return []
        proposals = [
            proposal
            for proposal in self._load_extractions_document()["proposals"].values()
            if (resume_id is None or proposal["resumeId"] == resume_id)
            and (status is None or proposal["status"] == status)
        ]
        proposals.sort(key=lambda item: (item["createdAt"], item["id"]))
        projection = self._proposal_summary if summary_only else self._proposal_result
        return [projection(proposal) for proposal in proposals]

    def review_resume_proposal(
        self,
        proposal_id: str,
        decisions_input: dict[str, Any],
        expected_revision: int,
        expected_profile_revision: int,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(proposal_id)
        decisions_object = _require_object(
            decisions_input.get("decisions"), "proposal decisions"
        )
        confirmations = _require_object(
            decisions_input.get("replacementConfirmations", {}),
            "proposal replacement confirmations",
        )
        if set(decisions_input) - {"decisions", "replacementConfirmations"} or not decisions_object:
            raise StoreError("proposal review must contain decisions")
        if any(
            not isinstance(path, str) or decision not in EXTRACTION_DECISIONS
            for path, decision in decisions_object.items()
        ):
            raise StoreError("proposal review decision is unsupported")
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_extraction_files_locked()
            self._roll_forward_extraction_locked()
            proposals_document = self._load_extractions_document()
            current = proposals_document["proposals"].get(proposal_id)
            if current is None:
                raise StoreError("resume proposal does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume proposal revision conflict")
            if current["status"] != "pending":
                raise StoreError("resume proposal is not pending")
            if self._proposal_stale_reasons(current):
                raise StoreError("resume proposal is stale")
            if not set(decisions_object) <= set(current["pendingPaths"]):
                raise StoreError("proposal review path is not pending")
            profile_document = self._load_profile_document()
            profile_revision = profile_document["metadata"].get("revision", 1)
            if profile_revision != expected_profile_revision:
                raise StoreError("profile revision conflict")
            for path in decisions_object:
                if not _json_values_equal(
                    _pointer_baseline(profile_document["profile"], path),
                    current["baselines"][path],
                ):
                    raise StoreError("proposal review baseline changed")
            required_confirmations = {}
            for path, decision in decisions_object.items():
                if decision != "use_extracted":
                    continue
                replacement = _replacement_scope(current["baselines"][path])
                if replacement is not None:
                    required_confirmations[path] = replacement["path"]
            if confirmations != required_confirmations:
                raise StoreError("proposal review replacement confirmation is required")
            now = utc_now()
            profile = copy.deepcopy(profile_document["profile"])
            accepted: list[str] = []
            for path, decision in decisions_object.items():
                if decision == "use_extracted":
                    _exists, extracted = _pointer_lookup(current["candidate"], path)
                    _set_pointer_value(profile, path, extracted, replace_ancestors=True)
                    accepted.append(path)
            result_profile_revision = profile_revision
            if accepted:
                metadata = dict(profile_document["metadata"])
                metadata["revision"] = profile_revision + 1
                metadata["updatedAt"] = now
                metadata["factProvenance"] = self._stamp_fact_provenance(
                    dict(metadata.get("factProvenance", {})),
                    accepted,
                    "user",
                    now,
                    profile_document["profile"],
                )
                profile_document = {
                    "schemaVersion": SCHEMA_VERSION,
                    "profile": profile,
                    "metadata": metadata,
                }
                result_profile_revision = metadata["revision"]
            remaining = [
                path for path in current["pendingPaths"] if path not in decisions_object
            ]
            baselines = dict(current["baselines"])
            for path in remaining:
                baselines[path] = _pointer_baseline(profile, path)
            decisions = dict(current["decisions"])
            decisions.update(
                {
                    path: {"decision": decision, "decidedAt": now}
                    for path, decision in decisions_object.items()
                }
            )
            updated = dict(current)
            updated.update(
                {
                    "pendingPaths": remaining,
                    "baselines": baselines,
                    "decisions": decisions,
                    "status": "pending" if remaining else "completed",
                    "resultProfileRevision": result_profile_revision,
                    "revision": current["revision"] + 1,
                    "updatedAt": now,
                }
            )
            _validate_extraction_proposal(proposal_id, updated)
            proposals_document["proposals"][proposal_id] = updated
            proposals_document["metadata"]["updatedAt"] = now
            _validate_extractions_document(proposals_document)
            self._commit_extraction_operation_locked(
                "review", profile_document, proposals_document
            )
            return self._proposal_result(updated)

    def read_history(self) -> list[dict[str, Any]]:
        if not self.history_path.exists():
            return []
        events: list[dict[str, Any]] = []
        try:
            with self.history_path.open(encoding="utf-8") as source:
                for number, line in enumerate(source, 1):
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    _require_object(event, f"history line {number}")
                    validate_version(event, f"history line {number}")
                    _validate_history_event_record(event)
                    events.append(event)
        except (OSError, UnicodeError, json.JSONDecodeError) as error:
            raise StoreError(f"cannot read valid history JSONL at {self.history_path}") from error
        return events

    def append_history(self, incoming: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        allowed = {
            "applicationId",
            "event",
            "company",
            "role",
            "ats",
            "status",
            "answerKeys",
            "at",
        }
        unexpected = set(incoming) - allowed
        if unexpected:
            raise StoreError("history event contains unsupported fields")
        application_id = _safe_session_id(incoming.get("applicationId", ""))
        event_name = incoming.get("event")
        answer_keys = incoming.get("answerKeys", [])

        event = {
            "schemaVersion": SCHEMA_VERSION,
            "eventId": str(uuid.uuid4()),
            "at": incoming.get("at") or utc_now(),
            **incoming,
            "applicationId": application_id,
            "event": event_name,
            "answerKeys": answer_keys,
        }
        _validate_history_event_for_write(event)
        with exclusive_file_lock(self.store_lock_path):
            answers = self._load_answers_document()
            for key in event["answerKeys"]:
                resolved = self._resolve_answer_key_in_document(answers, key)
                if resolved not in answers["answers"]:
                    raise StoreError(
                        "history answerKey does not reference an existing answer"
                    )
            self._append_history_event_idempotent_locked(event)
        return event

    def record_replay_transition(
        self, application_id: str, transition: str, ats: str
    ) -> dict[str, Any]:
        """Record one value-free replay lifecycle transition idempotently.

        The replay coordinator serializes calls for a run. This method keeps the
        canonical history/session formats authoritative and repairs a missing
        session if a prior process stopped after the append.
        """

        application_id = _safe_session_id(application_id)
        if transition not in REPLAY_TRANSITIONS:
            raise StoreError("replay transition is unsupported")
        if ats not in REPLAY_ATS:
            raise StoreError("replay ATS is unsupported")

        self.initialize()
        history = self.read_history()
        application_events = [
            event
            for event in history
            if event["applicationId"] == application_id
            and event["event"] in HISTORY_EVENTS
        ]
        if any(
            event.get("ats") not in {None, ats} for event in application_events
        ):
            raise StoreError("replay lifecycle ATS does not match")
        names = [event["event"] for event in application_events]
        if any(name in {"completed", "abandoned", "failed"} for name in names):
            raise StoreError("replay lifecycle is terminal")

        started_indexes = [
            index for index, name in enumerate(names) if name == "started"
        ]
        reviewed_indexes = [
            index for index, name in enumerate(names) if name == "reviewed"
        ]
        if reviewed_indexes and (
            not started_indexes or reviewed_indexes[0] < started_indexes[0]
        ):
            raise StoreError("replay lifecycle is out of order")
        if transition == "reviewed" and not started_indexes:
            raise StoreError("replay lifecycle has not started")

        path = self._session_path(application_id)
        session = self.load_session(application_id) if path.exists() else None
        if session is not None:
            if session.get("ats") not in {None, ats}:
                raise StoreError("replay session ATS does not match")
            if session["status"] in {"completed", "abandoned"}:
                raise StoreError("replay session is terminal")

        changed = transition not in names
        if changed:
            self.append_history(
                {
                    "applicationId": application_id,
                    "event": transition,
                    "ats": ats,
                    "status": "active" if transition == "started" else "review",
                    "answerKeys": [],
                }
            )

        session_status = "review" if transition == "reviewed" else "active"
        session_step = "review" if transition == "reviewed" else "application"
        if session is not None:
            if transition == "started" and session["status"] == "review":
                return {
                    "applicationId": application_id,
                    "transition": transition,
                    "changed": changed,
                }
        self.save_session(
            application_id,
            {
                "status": session_status,
                "ats": ats,
                "step": session_step,
                "answerKeys": [],
                "pendingFields": [],
            },
        )
        return {
            "applicationId": application_id,
            "transition": transition,
            "changed": changed,
        }

    def _session_path(self, application_id: str) -> Path:
        return self.sessions_path / f"{_safe_session_id(application_id)}.json"

    def _read_session_projection(
        self,
        path: Path,
        application_id: str | None = None,
        expected_ats: Any = _ATS_UNSET,
    ) -> dict[str, Any]:
        session = read_json_object(path, "session")
        validate_version(session, "session")
        pending_fields = session.get("pendingFields", [])
        if not isinstance(pending_fields, list):
            _validate_session_document(session)
        legacy_pending = any(
            isinstance(value, dict) and "reference" not in value
            for value in pending_fields
        )
        projected = _project_legacy_session(session, expected_ats)
        if legacy_pending and self.answers_path.exists():
            answers = self._load_answers_document()
            ats = (
                expected_ats
                if expected_ats is not _ATS_UNSET
                else session.get("ats")
            )
            scope = {"ats": ats} if isinstance(ats, str) and ats else {}
            for raw, field in zip(
                session.get("pendingFields", []), projected["pendingFields"]
            ):
                question = raw.get("question")
                bound_key = raw.get("answerKey")
                answer = (
                    self._get_answer_record(bound_key, document=answers)
                    if isinstance(bound_key, str) and bound_key
                    else None
                )
                if answer is None:
                    continue
                if (
                    isinstance(question, str)
                    and question.strip()
                    and isinstance(answer.get("question"), str)
                    and answer["question"].strip()
                ):
                    try:
                        match = ANSWER_MATCH_MODULE.rank_candidates(
                            question=question,
                            scope=scope,
                            field_class="general",
                            sensitivity=(
                                answer.get("sensitivity", "none")
                                if answer.get("sensitivity", "none") != "none"
                                else "high"
                                if raw.get("sensitive") is True
                                or raw.get("state") == "sensitive"
                                else "none"
                            ),
                            candidates=[self._semantic_candidate(answer)],
                            limit=1,
                        )[0]
                    except Exception:
                        raise StoreError(
                            "pending field semantic match is invalid"
                        ) from None
                    field["matchConfidence"] = match["confidenceBand"]
                    field["matchReasonCodes"] = match["reasonCodes"]
                else:
                    field["matchConfidence"] = "none"
                    field["matchReasonCodes"] = ["no_semantic_match"]
                field["matchAnswerRevision"] = answer.get("revision", 1)
            _validate_session_document(projected)
        expected_id = application_id if application_id is not None else path.stem
        if projected["applicationId"] != expected_id:
            raise StoreError("session application id does not match path")
        return projected

    @staticmethod
    def _readiness_blocker_type(code: str) -> str:
        if "upload" in code:
            return "upload"
        if "validation" in code:
            return "validation"
        if "final" in code:
            return "final_action"
        if "inaccessible" in code or code == "owner-upload-required":
            return "browser_handoff"
        return "readiness"

    def _recompute_readiness(
        self, raw: Any, expected_attempt_revision: int,
        expected_ats: str | None = None,
    ) -> dict[str, Any]:
        packet = _require_object(raw, "readiness input")
        required = {
            "attemptRevision", "evidenceKind", "fixture", "observation",
            "expectedObservationRevision", "formManifest",
        }
        if set(packet) != required:
            raise StoreError("readiness input contains unsupported fields")
        if packet.get("attemptRevision") != expected_attempt_revision:
            raise StoreError("readiness input is not bound to the current attempt")
        if packet.get("evidenceKind") not in READINESS_EVIDENCE_KINDS:
            raise StoreError("readiness evidence kind is unsupported")
        try:
            fixture = _require_object(packet["fixture"], "readiness fixture")
            fixture_id = fixture.get("id")
            if (
                not isinstance(fixture_id, str)
                or re.fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", fixture_id) is None
            ):
                raise StoreError("readiness fixture id is invalid")
            fixture_path = (
                Path(__file__).resolve().parent.parent
                / "qa" / "fixtures" / fixture_id / "fixture.json"
            )
            trusted_fixture = read_json_object(fixture_path, "readiness fixture")
            if not hmac.compare_digest(
                _canonical_json(fixture), _canonical_json(trusted_fixture)
            ):
                raise StoreError("readiness fixture is not the bundled definition")
            if (
                isinstance(expected_ats, str)
                and expected_ats
                and fixture.get("platformFamily") != expected_ats
            ):
                raise StoreError("readiness fixture does not match the job ATS")
            steps = fixture.get("steps")
            if (
                not isinstance(steps, list)
                or not any(
                    isinstance(control, dict) and control.get("required") is True
                    for step in steps
                    if isinstance(step, dict)
                    for control in step.get("controls", [])
                    if isinstance(step.get("controls", []), list)
                )
            ):
                raise StoreError(
                    "readiness evidence requires an observed required control"
                )
            FORM_READINESS_MODULE.validate_form_manifest(
                fixture,
                packet["formManifest"],
                expected_observation_revision=packet["expectedObservationRevision"],
            )
            report = FORM_READINESS_MODULE.evaluate_readiness(
                fixture, packet["observation"],
                expected_observation_revision=packet["expectedObservationRevision"],
            )
        except Exception:
            raise StoreError("readiness evidence is invalid") from None
        return {
            "status": report["status"],
            "evidenceKind": packet["evidenceKind"],
            "attemptRevision": expected_attempt_revision,
            "observationRevision": report["observationRevision"],
            "controlSetFingerprint": packet["formManifest"][
                "controlSetFingerprint"
            ],
            "requiredControlCount": len(
                packet["formManifest"]["requiredControlIds"]
            ),
            "assertions": report["assertions"],
            "blockerCodes": report["blockerCodes"],
            "fallbackCode": report["fallbackCode"],
        }

    def _build_session(
        self,
        application_id: str,
        incoming: dict[str, Any],
        now: str | None = None,
        *,
        expected_attempt_revision: int | None = None,
        expected_ats: Any = _ATS_UNSET,
        internal_approvals: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        allowed = {
            "applicationId", "status", "ats", "company", "role", "url", "step",
            "answerKeys", "pendingFields", "createdAt", "updatedAt",
            "attemptRevision", "readinessInput", "blockers", "browserHandoff",
        }
        if set(incoming) - allowed:
            raise StoreError("session contains unsupported fields")
        application_id = _safe_session_id(application_id)
        if incoming.get("applicationId", application_id) != application_id:
            raise StoreError("session application id does not match path")
        attempt_revision = incoming.get("attemptRevision", expected_attempt_revision)
        if expected_attempt_revision is not None and attempt_revision != expected_attempt_revision:
            raise StoreError("session is not bound to the current attempt")
        status = incoming.get("status", "active")
        if status not in SESSION_STATUSES:
            raise StoreError("session status is unsupported")
        answer_keys = incoming.get("answerKeys", [])
        if not isinstance(answer_keys, list) or not all(isinstance(item, str) for item in answer_keys):
            raise StoreError("session answerKeys must be strings")
        path = self._session_path(application_id)
        created_at = incoming.get("createdAt")
        existing = None
        if path.exists():
            existing = self._read_session_projection(
                path, application_id, expected_ats
            )
            created_at = created_at or existing.get("createdAt")
        pending_input = incoming.get("pendingFields", [])
        if not isinstance(pending_input, list):
            raise StoreError("session pendingFields must be a list")
        answers_document = self._load_answers_document()
        reusable: dict[str, list[str]] = {}
        if existing is not None:
            for field in existing.get("pendingFields", []):
                reusable.setdefault(_pending_reference_identity(field), []).append(
                    field["reference"]
                )
        pending_fields = []
        for value in pending_input:
            field = _require_object(value, "pending field")
            if set(field) - {
                "question", "state", "answerKey", "sensitive", "fieldClass",
                "scope", "matchConfidence", "matchReasonCodes",
            }:
                raise StoreError("pending field contains unsupported fields")
            copied = copy.deepcopy(field)
            # Question text is ephemeral adapter input. Durable sessions use
            # only the opaque reference and closed metadata needed for review.
            question = copied.pop("question", None)
            if isinstance(question, str) and question.strip():
                copied["questionFingerprint"] = _question_fingerprint(question)
            raw_scope = copied.pop("scope", None)
            if raw_scope is None:
                ats = (
                    expected_ats
                    if expected_ats is not _ATS_UNSET
                    else incoming.get("ats")
                    if "ats" in incoming
                    else (existing or {}).get("ats")
                )
                raw_scope = {"ats": ats} if isinstance(ats, str) and ats else {}
            try:
                scope_object = _require_object(raw_scope, "pending field scope")
                if scope_object:
                    copied["scopeFingerprint"] = _scope_fingerprint(scope_object)
            except (TypeError, ValueError, OverflowError):
                raise StoreError("pending field scope is invalid") from None
            copied.pop("matchConfidence", None)
            copied.pop("matchReasonCodes", None)
            bound_key = copied.get("answerKey")
            answer = (
                self._get_answer_record(bound_key, document=answers_document)
                if isinstance(bound_key, str) and bound_key
                else None
            )
            if (
                answer is not None
                and isinstance(answer.get("question"), str)
                and answer["question"].strip()
                and isinstance(question, str)
                and question.strip()
            ):
                try:
                    match = ANSWER_MATCH_MODULE.rank_candidates(
                        question=question, scope=scope_object,
                        field_class=copied.get("fieldClass", "general"),
                        sensitivity=(
                            answer.get("sensitivity", "none")
                            if answer.get("sensitivity", "none") != "none"
                            else "high"
                            if copied.get("sensitive") is True
                            or copied.get("state") == "sensitive"
                            else "none"
                        ),
                        candidates=[self._semantic_candidate(answer)], limit=1,
                    )[0]
                except Exception:
                    raise StoreError("pending field semantic match is invalid") from None
                copied["matchConfidence"] = match["confidenceBand"]
                copied["matchReasonCodes"] = match["reasonCodes"]
                copied["matchAnswerRevision"] = answer.get("revision", 1)
            elif answer is not None:
                copied["matchConfidence"] = "none"
                copied["matchReasonCodes"] = ["no_semantic_match"]
                copied["matchAnswerRevision"] = answer.get("revision", 1)
            references = reusable.get(_pending_reference_identity(copied), [])
            copied["reference"] = references.pop(0) if references else f"pending_{uuid.uuid4().hex}"
            pending_fields.append(copied)
        timestamp = now or utc_now()
        readiness = None
        if "readinessInput" in incoming:
            if attempt_revision is None:
                raise StoreError("readiness requires a current attempt revision")
            readiness = self._recompute_readiness(
                incoming["readinessInput"], attempt_revision, expected_ats
            )
        elif existing is not None and existing.get("attemptRevision") == attempt_revision:
            readiness = copy.deepcopy(existing.get("readiness"))

        blockers: list[dict[str, Any]] = []
        for field in pending_fields:
            blocker = {
                "type": "information",
                "code": "sensitive-answer-required"
                if field.get("sensitive") is True or field.get("state") == "sensitive"
                else "answer-required",
                "reference": field["reference"],
                "sensitivity": "high"
                if field.get("sensitive") is True or field.get("state") == "sensitive"
                else "none",
            }
            if "fieldClass" in field:
                blocker["fieldClass"] = field["fieldClass"]
            blockers.append(blocker)
        if readiness is not None:
            for code in readiness["blockerCodes"]:
                blockers.append({"type": self._readiness_blocker_type(code), "code": code})
            if readiness["fallbackCode"] is not None:
                blockers.append({
                    "type": "browser_handoff",
                    "code": readiness["fallbackCode"],
                })
        supplied_blockers = incoming.get("blockers", [])
        if not isinstance(supplied_blockers, list):
            raise StoreError("session blockers must be a list")
        for raw_blocker in supplied_blockers:
            blocker = _require_object(raw_blocker, "session blocker")
            if set(blocker) != {"type", "code"}:
                raise StoreError("agent blockers must contain only closed type and code")
            expected_type = AGENT_BLOCKER_TYPE_BY_CODE.get(blocker.get("code"))
            if expected_type is None or blocker.get("type") != expected_type:
                raise StoreError("session blocker is invalid")
            blockers.append(copy.deepcopy(blocker))
        blockers = list({
            _canonical_json(item): item for item in blockers
        }.values())
        browser_blockers = [
            blocker
            for blocker in blockers
            if blocker.get("type") == "browser_handoff"
            and blocker.get("code") in BROWSER_HANDOFF_REASON_CODES
        ]

        browser_handoff = incoming.get("browserHandoff")
        if browser_handoff is None:
            if readiness is not None and readiness["fallbackCode"] is not None:
                browser_handoff = {
                    "state": "required", "reasonCode": readiness["fallbackCode"],
                    "revision": 1,
                }
            elif browser_blockers:
                browser_handoff = {
                    "state": "required", "reasonCode": browser_blockers[0]["code"],
                    "revision": 1,
                }
            elif status == "review":
                browser_handoff = {
                    "state": "ready_for_owner", "reasonCode": "final-review-required",
                    "revision": 1,
                }
            else:
                browser_handoff = {
                    "state": "not_required", "reasonCode": "none", "revision": 1,
                }
        else:
            browser_handoff = copy.deepcopy(
                _require_object(browser_handoff, "browser handoff")
            )
            if set(browser_handoff) != {"state", "reasonCode", "revision"}:
                raise StoreError("browser handoff contains unsupported fields")
        if browser_blockers and browser_handoff.get("state") != "required":
            raise StoreError("browser handoff contradicts browser blockers")

        durable_input = {
            key: copy.deepcopy(value)
            for key, value in incoming.items()
            if key not in {
                "readinessInput", "blockers", "browserHandoff", "company", "role",
                "url", "answerKeys", "pendingFields", "applicationId", "createdAt",
                "updatedAt", "attemptRevision",
            }
        }
        if expected_ats is not _ATS_UNSET:
            durable_input["ats"] = copy.deepcopy(expected_ats)
        elif "ats" not in incoming and "ats" in (existing or {}):
            durable_input["ats"] = copy.deepcopy(existing["ats"])
        current_references = {field["reference"] for field in pending_fields}
        carried_approvals = (
            existing.get("approvals", [])
            if existing is not None
            and existing.get("attemptRevision") == attempt_revision
            else []
        )
        carried_approvals = self._current_session_approvals(
            {
                "pendingFields": pending_fields,
                "approvals": [
                    approval for approval in carried_approvals
                    if approval.get("reference") in current_references
                ],
            },
            answers_document,
        )
        session = {
            "schemaVersion": SCHEMA_VERSION, **durable_input,
            "applicationId": application_id, "status": status,
            "answerKeys": answer_keys,
            "pendingFields": pending_fields,
            "attemptRevision": attempt_revision,
            "readiness": readiness,
            "blockers": blockers,
            "approvals": copy.deepcopy(
                internal_approvals
                if internal_approvals is not None
                else carried_approvals
            ),
            "browserHandoff": browser_handoff,
            "createdAt": created_at or timestamp, "updatedAt": timestamp,
        }
        _validate_session_document(session)
        return session

    def save_claim_progress(
        self, job_id: str, token: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            self._require_claim_locked(job_id, token)
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("claimed job is not in progress")
            session = self._build_session(
                job_id, incoming, self._now(),
                expected_attempt_revision=job["revision"],
                expected_ats=job.get("ats"),
            )
            if session["status"] != "active":
                raise StoreError("claim progress session must remain active")
            atomic_write_json(self._session_path(job_id), session)
            return session

    def handoff_claimed_job(
        self,
        job_id: str,
        token: str,
        status: str,
        incoming: dict[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        if status not in {"needs_info", "awaiting_review"}:
            raise StoreError("claimed handoff status is unsupported")
        with exclusive_file_lock(self.store_lock_path):
            self._require_claim_locked(job_id, token)
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("claimed job is not in progress")
            if job["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            now = self._now()
            session = self._build_session(
                job_id, incoming, now,
                expected_attempt_revision=job["revision"],
                expected_ats=job.get("ats"),
            )
            required_session_status = "active" if status == "needs_info" else "review"
            if session["status"] != required_session_status:
                raise StoreError("handoff session status does not match job status")
            if status == "awaiting_review":
                if "readinessInput" not in incoming:
                    raise StoreError(
                        "awaiting_review requires fresh current live readiness input"
                    )
                readiness = session.get("readiness")
                if (
                    readiness is None
                    or readiness.get("attemptRevision") != job["revision"]
                    or readiness.get("evidenceKind")
                    != "agent_attested_current_attempt"
                    or readiness.get("status") != "ready"
                    or readiness.get("blockerCodes")
                    or any(
                        value != "passed"
                        for value in readiness.get("assertions", {}).values()
                    )
                    or session.get("pendingFields")
                    or session.get("blockers")
                    or session.get("browserHandoff") != {
                        "state": "ready_for_owner",
                        "reasonCode": "final-review-required",
                        "revision": 1,
                    }
                ):
                    raise StoreError(
                        "awaiting_review requires complete current agent-attested readiness"
                    )
            event_name = "job-blocked" if status == "needs_info" else "reviewed"
            operation_id = str(uuid.uuid4())
            self._commit_coordinator_operation_locked({
                "kind": "handoff", "operationId": operation_id, "jobId": job_id,
                "sourceStatus": "in_progress", "targetStatus": status,
                "expectedRevision": job["revision"], "at": now, "session": session,
                "historyEvent": self._history_event_for_operation(operation_id, job, event_name, status, now),
                "resultClaim": None,
            })
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "session": session,
                "claim": None,
            }

    def preview_grouped_approval(
        self,
        job_id: str,
        expected_job_revision: int,
        expected_session_revision: int,
        decisions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Preview field-specific current-use, remember, and policy decisions."""

        self.initialize()
        job_id = _safe_session_id(job_id)
        if not isinstance(decisions, list) or not decisions:
            raise StoreError("grouped approval requires at least one field decision")
        with exclusive_file_lock(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("grouped approval job does not exist")
            if job["revision"] != expected_job_revision:
                raise StoreError("job revision conflict")
            path = self._session_path(job_id)
            if not path.exists():
                raise StoreError("grouped approval session does not exist")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            if self._session_revision(session) != expected_session_revision:
                raise StoreError("session revision conflict")
            pending = {
                field["reference"]: field
                for field in session.get("pendingFields", [])
            }
            answers = self._load_answers_document()
            projected: list[dict[str, Any]] = []
            seen_references: set[str] = set()
            for raw in decisions:
                decision = _require_object(raw, "grouped approval decision")
                required = {
                    "reference", "answerKey", "currentUse", "remember",
                    "policyMode", "useAuthority", "allowedSensitiveFieldClasses",
                }
                if set(decision) != required:
                    raise StoreError("grouped approval decision contains unsupported fields")
                if (
                    not isinstance(decision.get("answerKey"), str)
                    or not decision["answerKey"]
                ):
                    raise StoreError("grouped approval answer key is invalid")
                reference = decision.get("reference")
                if (
                    not isinstance(reference, str)
                    or PENDING_REFERENCE.fullmatch(reference) is None
                    or reference in seen_references
                    or reference not in pending
                ):
                    raise StoreError("grouped approval reference is invalid")
                seen_references.add(reference)
                if not isinstance(decision["currentUse"], bool) or not isinstance(decision["remember"], bool):
                    raise StoreError("grouped approval decisions must be booleans")
                if not decision["currentUse"] and decision["useAuthority"] != "none":
                    raise StoreError("denied current use cannot carry reuse authority")
                answer = self._get_answer_record(decision["answerKey"], document=answers)
                if answer is None:
                    raise StoreError("grouped approval answer is unavailable")
                field = pending[reference]
                bound_key = field.get("answerKey")
                if (
                    not isinstance(bound_key, str)
                    or self._resolve_answer_key_in_document(answers, bound_key)
                    != answer["key"]
                ):
                    raise StoreError(
                        "grouped approval answer does not match pending field"
                    )
                field_class = field.get("fieldClass", "general")
                answer_sensitivity = answer.get("sensitivity", "none")
                sensitivity = (
                    answer_sensitivity
                    if answer_sensitivity != "none"
                    else "high"
                    if field.get("sensitive") is True
                    or field.get("state") == "sensitive"
                    else "none"
                )
                if field.get("matchAnswerRevision") != answer.get("revision", 1):
                    raise StoreError("pending field semantic match is stale")
                candidate = self._semantic_candidate(answer)
                confidence = field.get("matchConfidence", "none")
                match_reasons = field.get("matchReasonCodes") or [
                    "no_semantic_match"
                ]
                match = {
                    "answerKey": answer["key"],
                    "confidenceBand": confidence,
                    "reasonCodes": match_reasons,
                }
                try:
                    policy = ANSWER_MATCH_MODULE.evaluate_reuse(
                        match=match, candidate=candidate,
                        scope=answer.get("scope", {}), field_class=field_class,
                        sensitivity=sensitivity, mode=decision["policyMode"],
                        use_authority=decision["useAuthority"],
                        allowed_sensitive_field_classes=decision[
                            "allowedSensitiveFieldClasses"
                        ],
                    )
                except Exception:
                    raise StoreError("grouped approval policy is invalid") from None
                candidate_scope_fingerprint = _scope_fingerprint(
                    answer.get("scope", {})
                )
                field_scope_fingerprint = field.get(
                    "scopeFingerprint", _scope_fingerprint({})
                )
                if not hmac.compare_digest(
                    candidate_scope_fingerprint, field_scope_fingerprint
                ):
                    policy["reasonCodes"] = [
                        code
                        for code in policy["reasonCodes"]
                        if code not in {"reuse_eligible", "scope_match"}
                    ]
                    if "scope_mismatch" not in policy["reasonCodes"]:
                        policy["reasonCodes"].append("scope_mismatch")
                eligible = (
                    decision["currentUse"]
                    and "reuse_eligible" in policy["reasonCodes"]
                )
                projected.append({
                    "reference": reference,
                    "answerKey": answer["key"],
                    "currentUse": decision["currentUse"],
                    "remember": decision["remember"],
                    "policyMode": decision["policyMode"],
                    "useAuthority": decision["useAuthority"],
                    "eligible": eligible,
                    "confidenceBand": policy["confidenceBand"],
                    "reasonCodes": policy["reasonCodes"],
                    "answerRevision": answer.get("revision", 1),
                })
            projected.sort(key=lambda item: item["reference"])
            token_input = {
                "jobRevision": expected_job_revision,
                "sessionRevision": expected_session_revision,
                "approvals": projected,
            }
            token = "grouped-approval-v1." + hashlib.sha256(
                _canonical_json(token_input).encode("utf-8")
            ).hexdigest()
            return {
                **token_input, "previewToken": token, "mutated": False,
            }

    def approve_grouped_approval(
        self,
        job_id: str,
        expected_job_revision: int,
        expected_session_revision: int,
        decisions: list[dict[str, Any]],
        preview_token: str,
        owner_confirmed: bool = False,
    ) -> dict[str, Any]:
        if owner_confirmed is not True:
            raise StoreError("grouped approval requires explicit owner confirmation")
        preview = self.preview_grouped_approval(
            job_id, expected_job_revision, expected_session_revision, decisions
        )
        if not isinstance(preview_token, str) or not hmac.compare_digest(
            preview_token, preview["previewToken"]
        ):
            raise StoreError("grouped approval preview is stale")
        with exclusive_file_lock(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            path = self._session_path(job_id)
            if job is None or job.get("revision") != expected_job_revision or not path.exists():
                raise StoreError("grouped approval state changed")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            if self._session_revision(session) != expected_session_revision:
                raise StoreError("session revision conflict")
            pending = {
                field["reference"]: field
                for field in session.get("pendingFields", [])
            }
            answers = self._load_answers_document()
            approvals_by_reference = {
                approval["reference"]: approval for approval in preview["approvals"]
            }
            for decision in decisions:
                reference = decision["reference"]
                field = pending.get(reference)
                answer = self._get_answer_record(
                    decision["answerKey"], document=answers
                )
                if field is None or answer is None:
                    raise StoreError("grouped approval state changed")
                bound_key = field.get("answerKey")
                if (
                    not isinstance(bound_key, str)
                    or self._resolve_answer_key_in_document(answers, bound_key)
                    != answer["key"]
                    or answer.get("revision", 1)
                    != approvals_by_reference[reference]["answerRevision"]
                ):
                    raise StoreError("grouped approval state changed")
            updated = copy.deepcopy(session)
            approvals = {
                approval["reference"]: copy.deepcopy(approval)
                for approval in self._current_session_approvals(session, answers)
            }
            approvals.update({
                approval["reference"]: copy.deepcopy(approval)
                for approval in preview["approvals"]
            })
            updated["approvals"] = [
                approvals[reference] for reference in sorted(approvals)
            ]
            updated["updatedAt"] = self._now()
            _validate_session_document(updated)
            atomic_write_json(path, updated)
        return {
            "approved": True,
            "sessionRevision": self._session_revision(updated),
            "approvals": copy.deepcopy(updated["approvals"]),
        }

    def save_session(
        self, application_id: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        with exclusive_file_lock(self.store_lock_path):
            self._require_generic_session_mutation_allowed_locked(application_id)
            session = self._build_session(application_id, incoming)
            path = self._session_path(application_id)
            atomic_write_json(path, session)
            return session

    def load_session(self, application_id: str) -> dict[str, Any]:
        self.initialize()
        path = self._session_path(application_id)
        if not path.exists():
            raise StoreError("session does not exist")
        job = (
            self._load_jobs_document()["jobs"].get(application_id)
            if self.jobs_path.exists()
            else None
        )
        return self._read_session_projection(path, application_id, job.get("ats")) \
            if job is not None else self._read_session_projection(path, application_id)

    def list_sessions(self) -> list[dict[str, Any]]:
        self.initialize()
        return self._list_sessions_uninitialized()

    def _list_sessions_uninitialized(self) -> list[dict[str, Any]]:
        sessions: list[dict[str, Any]] = []
        jobs = (
            self._load_jobs_document()["jobs"] if self.jobs_path.exists() else {}
        )
        for path in sorted(self.sessions_path.glob("*.json")):
            job = jobs.get(path.stem)
            session = self._read_session_projection(path, path.stem, job.get("ats")) \
                if job is not None else self._read_session_projection(path, path.stem)
            sessions.append(session)
        return sessions

    def delete_session(self, application_id: str) -> dict[str, Any]:
        self.initialize()
        with exclusive_file_lock(self.store_lock_path):
            self._require_generic_session_mutation_allowed_locked(
                application_id, allow_terminal_delete=True
            )
            path = self._session_path(application_id)
            if not path.exists():
                return {"deleted": False, "applicationId": application_id}
            path.unlink()
            _fsync_directory(self.sessions_path)
            return {"deleted": True, "applicationId": application_id}

    def _require_generic_session_mutation_allowed_locked(
        self, application_id: str, allow_terminal_delete: bool = False
    ) -> None:
        job = self._load_jobs_document()["jobs"].get(application_id)
        if (
            job is not None
            and job.get("deletedAt") is None
            and not (
                allow_terminal_delete and job.get("status") in {"applied", "closed"}
            )
        ):
            raise StoreError("canonical job sessions require a coordinator operation")


    def _ensure_account_control_documents(self) -> None:
        with exclusive_file_lock(self.store_lock_path):
            if not self.automation_settings_path.exists():
                now = self._now()
                atomic_write_json(
                    self.automation_settings_path,
                    {
                        "schemaVersion": SCHEMA_VERSION,
                        "settings": {
                            "enabled": False,
                            "automaticAccountCreation": False,
                            "signupEmail": None,
                            "passwordStrategy": "unique_per_realm",
                            "revision": 1,
                            "createdAt": now,
                            "updatedAt": now,
                        },
                    },
                )
            if not self.employer_accounts_path.exists():
                now = self._now()
                atomic_write_json(
                    self.employer_accounts_path,
                    {
                        "schemaVersion": SCHEMA_VERSION,
                        "accounts": {},
                        "metadata": {"createdAt": now, "updatedAt": now},
                    },
                )
            if not self.account_operation_journal_path.exists():
                atomic_write_json(
                    self.account_operation_journal_path,
                    {"schemaVersion": SCHEMA_VERSION, "operation": None},
                )

    def get_automation_settings(self, *, public: bool = False, companion: bool = False) -> dict[str, Any]:
        self.initialize()
        self._ensure_account_control_documents()
        record = copy.deepcopy(self._load_automation_settings_document()["settings"])
        if companion:
            return ACCOUNTS_MODULE.companion_settings(record)
        return ACCOUNTS_MODULE.public_settings(record) if public else record

    def update_automation_settings(
        self, patch: dict[str, Any], expected_revision: int, *, public: bool = False
    ) -> dict[str, Any]:
        incoming = _require_object(patch, "automation settings patch")
        allowed = {"enabled", "automaticAccountCreation", "signupEmail", "passwordStrategy"}
        if not incoming or set(incoming) - allowed:
            raise StoreError("automation settings patch contains unsupported fields")
        self.initialize()
        self._ensure_account_control_documents()
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_automation_settings_document()
            current = document["settings"]
            if current["revision"] != expected_revision:
                raise StoreError("automation settings revision conflict")
            updated = dict(current)
            updated.update(incoming)
            if "signupEmail" in incoming:
                updated["signupEmail"] = _optional_email(incoming["signupEmail"], "signup email")
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = self._now()
            _validate_automation_settings_record(updated)
            atomic_write_json(
                self.automation_settings_path,
                {"schemaVersion": SCHEMA_VERSION, "settings": updated},
            )
        result = copy.deepcopy(updated)
        return ACCOUNTS_MODULE.public_settings(result) if public else result

    def copy_profile_email_to_automation_settings(
        self, expected_profile_revision: int, expected_settings_revision: int,
        *, public: bool = True,
    ) -> dict[str, Any]:
        """Copy the canonical profile email internally without returning it."""

        self.initialize()
        self._ensure_account_control_documents()
        with exclusive_file_lock(self.store_lock_path):
            profile_document = self._load_profile_document()
            settings_document = self._load_automation_settings_document()
            if profile_document["metadata"].get("revision", 1) != expected_profile_revision:
                raise StoreError("profile revision conflict")
            current = settings_document["settings"]
            if current["revision"] != expected_settings_revision:
                raise StoreError("automation settings revision conflict")
            email = _optional_email(profile_document["profile"].get("email"), "profile email")
            if email is None:
                raise StoreError("canonical profile email is unavailable")
            updated = {
                **current, "signupEmail": email,
                "revision": current["revision"] + 1, "updatedAt": self._now(),
            }
            _validate_automation_settings_record(updated)
            atomic_write_json(
                self.automation_settings_path,
                {"schemaVersion": SCHEMA_VERSION, "settings": updated},
            )
        # The copied identity never crosses the method boundary.
        return ACCOUNTS_MODULE.public_settings(updated) if public else {"copied": True, "revision": updated["revision"]}

    def automation_capability(self, platform: str | None = None) -> dict[str, Any]:
        credential = ACCOUNTS_MODULE.discover_capability(
            platform or sys.platform, CREDENTIALS_MACOS_MODULE.ADAPTER_REGISTRY
        )
        account_flow = ACCOUNTS_MODULE.discover_account_flow_capability(
            platform or sys.platform, ACCOUNT_FLOWS_MACOS_MODULE.ADAPTER_REGISTRY
        )
        return {**credential, "accountFlowAutomation": account_flow}

    def resolve_account_realm(self, portal_url: str) -> dict[str, Any]:
        return ACCOUNTS_MODULE.normalize_realm(portal_url)

    def employer_account_flow_decision(self, job_id: str) -> dict[str, Any]:
        """Return a value-free account decision for one canonical job."""

        self.initialize()
        self._ensure_account_control_documents()
        with exclusive_file_lock(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("employer account flow job is unavailable")
            classified = ACCOUNTS_MODULE.classify_account_flow(job["url"])
            if classified.get("status") != "classified":
                return {
                    "jobId": job["id"],
                    "decision": "human_attention_required",
                    "adapterId": None,
                    "flowKind": None,
                    "accountRevision": None,
                    "reasonCode": "account_flow_unresolved",
                }
            base = {
                "jobId": job["id"],
                "adapterId": classified["adapterId"],
                "flowKind": classified["flowKind"],
            }
            if classified["accountRequired"] is False:
                return {
                    **base,
                    "decision": "account_not_required",
                    "accountRevision": None,
                }
            account = self._load_employer_accounts_document()["accounts"].get(
                classified["realmRef"]
            )
            if account is None:
                return {**base, "decision": "create_required", "accountRevision": None}
            lifecycle = account["lifecycleState"]
            settings = self._load_automation_settings_document()["settings"]
            if (
                classified["flowKind"] == ACCOUNTS_MODULE.FLOW_PASSWORD
                and lifecycle == "discovered"
                and settings["passwordStrategy"] != "unique_per_realm"
            ):
                return {
                    **base,
                    "decision": "human_attention_required",
                    "accountRevision": account["revision"],
                    "reasonCode": "password_strategy_requires_human",
                }
            if lifecycle == "active":
                decision = "reuse_active"
            elif lifecycle == "discovered":
                decision = "create_required"
            else:
                return {
                    **base,
                    "decision": "human_attention_required",
                    "accountRevision": account["revision"],
                    "reasonCode": "account_lifecycle_requires_human",
                }
            return {
                **base,
                "decision": decision,
                "accountRevision": account["revision"],
            }

    def list_employer_accounts(self, *, public: bool = False, companion: bool = False) -> list[dict[str, Any]]:
        self.initialize()
        self._ensure_account_control_documents()
        accounts = list(self._load_employer_accounts_document()["accounts"].values())
        accounts.sort(key=lambda item: item["realmRef"])
        records = copy.deepcopy(accounts)
        if companion:
            return [ACCOUNTS_MODULE.public_account(item) for item in records]
        return [ACCOUNTS_MODULE.public_account(item) for item in records] if public else records

    def get_employer_account(self, realm_ref: str, *, public: bool = False) -> dict[str, Any] | None:
        self.initialize()
        self._ensure_account_control_documents()
        record = self._load_employer_accounts_document()["accounts"].get(realm_ref)
        if record is None:
            return None
        result = copy.deepcopy(record)
        return ACCOUNTS_MODULE.public_account(result) if public else result

    def create_employer_account(
        self, portal_url: str, signup_email_override: str | None = None, *, public: bool = False
    ) -> dict[str, Any]:
        realm = self.resolve_account_realm(portal_url)
        if realm["status"] != "resolved":
            raise StoreError("employer account realm is unresolved")
        override = _optional_email(signup_email_override, "signup email override")
        self.initialize()
        self._ensure_account_control_documents()
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_employer_accounts_document()
            if realm["realmRef"] in document["accounts"]:
                raise StoreError("employer account already exists")
            now = self._now()
            record = {
                "realmRef": realm["realmRef"],
                "adapterId": realm["adapterId"],
                "descriptorVersion": realm["descriptorVersion"],
                "descriptor": realm["descriptor"],
                "flowKind": realm.get("flowKind", ACCOUNTS_MODULE.FLOW_PASSWORD),
                "credentialRequired": realm.get("credentialRequired", True),
                "signupEmailOverride": override,
                "providerId": None,
                "credentialRef": None,
                "credentialVersion": None,
                "lifecycleState": "discovered",
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
            }
            _validate_employer_account_record(realm["realmRef"], record)
            document["accounts"][realm["realmRef"]] = record
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.employer_accounts_path, document)
        result = copy.deepcopy(record)
        return ACCOUNTS_MODULE.public_account(result) if public else result

    def update_employer_account(
        self, realm_ref: str, patch: dict[str, Any], expected_revision: int, *, public: bool = False
    ) -> dict[str, Any]:
        incoming = _require_object(patch, "employer account patch")
        if set(incoming) != {"signupEmailOverride"}:
            raise StoreError("employer account patch may only change signup email override")
        override = _optional_email(incoming["signupEmailOverride"], "signup email override")
        self.initialize()
        self._ensure_account_control_documents()
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_employer_accounts_document()
            current = document["accounts"].get(realm_ref)
            if current is None:
                raise StoreError("employer account does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("employer account revision conflict")
            updated = dict(current)
            updated.update({
                "signupEmailOverride": override,
                "revision": current["revision"] + 1,
                "updatedAt": self._now(),
            })
            _validate_employer_account_record(realm_ref, updated)
            document["accounts"][realm_ref] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.employer_accounts_path, document)
        result = copy.deepcopy(updated)
        return ACCOUNTS_MODULE.public_account(result) if public else result

    def account_operation_status(self) -> dict[str, Any]:
        self.initialize()
        self._ensure_account_control_documents()
        operation = self._load_account_operation_journal()["operation"]
        if operation is None:
            return {"status": "idle", "operation": None}
        return {
            "status": "recovery_required",
            "operation": {
                "operationId": operation["operationId"],
                "jobId": operation["jobId"],
                "realmRef": operation["realmRef"],
                "stage": operation["stage"],
                "outcomeCode": operation["outcomeCode"],
            },
        }

    def recover_account_operation(self) -> dict[str, Any]:
        """Fail a stranded protected operation closed; never infer success."""

        self.initialize()
        self._ensure_account_control_documents()
        with exclusive_file_lock(self.store_lock_path):
            journal = self._load_account_operation_journal()
            operation = journal["operation"]
            if operation is None:
                return {"status": "idle", "recovered": False}
            accounts = self._load_employer_accounts_document()
            account = accounts["accounts"].get(operation["realmRef"])
            if account is None:
                raise StoreError("account operation realm is unavailable")
            if account["lifecycleState"] != "ambiguous":
                account = dict(account)
                account["lifecycleState"] = "ambiguous"
                account["revision"] += 1
                account["updatedAt"] = self._now()
                _validate_employer_account_record(account["realmRef"], account)
                accounts["accounts"][account["realmRef"]] = account
                accounts["metadata"]["updatedAt"] = account["updatedAt"]
                atomic_write_json(self.employer_accounts_path, accounts)
            jobs = self._load_jobs_document()["jobs"]
            job = jobs.get(operation["jobId"])
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("account operation job is unavailable")
            recovered_job = None
            if job["status"] == "in_progress":
                claim = self._load_coordinator_document()["claim"]
                if (
                    claim is None or claim["jobId"] != job["id"]
                    or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                ):
                    raise StoreError("account operation recovery requires a live same-job claim")
                recovered_job = self._account_attention_handoff_locked(job, "ambiguous_recovery")
            elif job["status"] != "needs_info":
                raise StoreError("account operation job cannot be reconciled")
            self._clear_account_operation_locked(operation)
            result = {
                "status": "ambiguous", "recovered": True,
                "account": ACCOUNTS_MODULE.public_account(account),
                "retryAllowed": False,
            }
            if recovered_job is not None:
                result["job"] = {
                    "id": recovered_job["id"], "status": recovered_job["status"],
                    "revision": recovered_job["revision"],
                }
            return result

    def _clear_account_operation_locked(self, operation: dict[str, Any]) -> None:
        current = self._load_account_operation_journal()["operation"]
        if current is None or current["operationId"] != operation["operationId"]:
            raise StoreError("account operation journal changed before completion")
        atomic_write_json(
            self.account_operation_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": None},
        )

    def _write_account_stage_locked(
        self, account: dict[str, Any], lifecycle: str, operation: dict[str, Any], stage: str,
        *, provider_id: str | None = None, credential_ref: str | None = None,
        credential_version: int | None = None,
    ) -> dict[str, Any]:
        accounts = self._load_employer_accounts_document()
        current = accounts["accounts"].get(account["realmRef"])
        if current is None or current["revision"] != account["revision"]:
            raise StoreError("employer account revision conflict")
        updated = dict(current)
        updated.update({
            "lifecycleState": lifecycle,
            "revision": current["revision"] + 1,
            "updatedAt": self._now(),
        })
        if provider_id is not None:
            updated.update({
                "providerId": provider_id,
                "credentialRef": credential_ref,
                "credentialVersion": credential_version,
            })
        _validate_employer_account_record(updated["realmRef"], updated)
        accounts["accounts"][updated["realmRef"]] = updated
        accounts["metadata"]["updatedAt"] = updated["updatedAt"]
        atomic_write_json(self.employer_accounts_path, accounts)
        operation = {**operation, "stage": stage, "accountRevision": updated["revision"]}
        journal = {"schemaVersion": SCHEMA_VERSION, "operation": operation}
        atomic_write_json(self.account_operation_journal_path, journal)
        return updated

    def _account_attention_handoff_locked(self, job: dict[str, Any], reason: str) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if claim is None or claim["jobId"] != job["id"] or self._now_datetime() >= self._parse_time(claim["expiresAt"]):
            raise StoreError("account denial requires the live claimed job")
        now = self._now()
        blocker_code = {
            "password_strategy": "owner-input-required",
            "reset_required": "owner-input-required",
            "verification_required": "mfa-required",
            "email_verification_required": "email-verification-required",
            "captcha_required": "captcha-required",
            "mfa_required": "mfa-required",
            "password_reset_required": "owner-input-required",
        }.get(reason, "browser-state-uncertain")
        session = self._build_session(job["id"], {
            "status": "active", "step": f"account_automation_denied:{reason}",
            "answerKeys": [], "pendingFields": [],
            "attemptRevision": job["revision"],
            "blockers": [{
                "type": AGENT_BLOCKER_TYPE_BY_CODE[blocker_code],
                "code": blocker_code,
            }],
            "browserHandoff": {
                "state": "required", "reasonCode": blocker_code, "revision": 1,
            },
        }, now, expected_attempt_revision=job["revision"], expected_ats=job.get("ats"))
        operation_id = str(uuid.uuid4())
        self._commit_coordinator_operation_locked({
            "kind": "handoff", "operationId": operation_id, "jobId": job["id"],
            "sourceStatus": "in_progress", "targetStatus": "needs_info",
            "expectedRevision": job["revision"], "at": now, "session": session,
            "historyEvent": self._history_event_for_operation(
                operation_id, job, "job-blocked", "needs_info", now
            ),
            "resultClaim": None,
        })
        return self._load_jobs_document()["jobs"][job["id"]]

    def execute_synthetic_account(
        self, incoming: dict[str, Any], *, provider: Any | None = None,
        observer: Any | None = None, public: bool = False,
        test_authority: object | None = None,
    ) -> dict[str, Any]:
        try:
            packet = ACCOUNT_EXECUTOR_MODULE.validate_request(incoming)
        except ACCOUNT_EXECUTOR_MODULE.AccountExecutorError as error:
            raise StoreError(str(error)) from None
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        if provider is None:
            raise StoreError("native protected provider injection is required")
        provider_id = getattr(provider, "provider_id", None)
        synthetic_authorized = (
            provider_id == "synthetic-protected"
            and test_authority is CREDENTIALS_MODULE.synthetic_test_authority()
            and not public
        )
        if provider_id == "synthetic-protected" and not synthetic_authorized:
            raise StoreError("synthetic provider is test-only")
        if not synthetic_authorized and (
            not sys.platform.startswith("darwin") or provider_id != "macos-keychain"
        ):
            raise StoreError("native account execution is unsupported on this platform")
        protected_provider = provider
        with exclusive_file_lock(self.store_lock_path):
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(packet["jobId"])
            if (
                claim is None or claim["jobId"] != packet["jobId"]
                or claim["claimId"] != packet["expectedClaimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress"
                or job["revision"] != packet["expectedJobRevision"]
            ):
                raise StoreError("account execution requires the exact live claimed job")
            realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
            if (
                realm["status"] != "resolved" or realm["realmRef"] != packet["realmRef"]
                or realm["descriptor"] != packet["realmDescriptor"]
            ):
                raise StoreError("account execution realm binding mismatch")
            expected_target = self._trusted_fill_fingerprint(packet["syntheticTargetUrl"])
            if expected_target != packet["syntheticTargetFingerprint"]:
                raise StoreError("synthetic target fingerprint mismatch")
            settings = self._load_automation_settings_document()["settings"]
            accounts = self._load_employer_accounts_document()
            account = accounts["accounts"].get(packet["realmRef"])
            if account is None:
                raise StoreError("employer account does not exist")
            if settings["revision"] != packet["expectedSettingsRevision"] or account["revision"] != packet["expectedAccountRevision"]:
                raise StoreError("account execution revision conflict")
            if not settings["enabled"] or not settings["automaticAccountCreation"]:
                raise StoreError("account automation is disabled")
            if account["signupEmailOverride"] is None and settings["signupEmail"] is None:
                raise StoreError("effective signup email is required")
            if account["lifecycleState"] in ACCOUNT_EXECUTOR_MODULE.TERMINAL_NO_RETRY:
                raise StoreError("account lifecycle permanently requires human attention")
            strategy = settings["passwordStrategy"]
            if strategy in {"custom", "ask_each_time"}:
                handed_off = self._account_attention_handoff_locked(job, "password_strategy")
                return {
                    "authorized": False, "reasonCode": "password_strategy_requires_human",
                    "retryAllowed": False, "attentionHandoff": True,
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            operation = {
                "operationId": str(uuid.uuid4()), "jobId": job["id"],
                "jobRevision": job["revision"], "claimId": claim["claimId"],
                "realmRef": account["realmRef"], "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending", "startedAt": self._now(),
            }
            atomic_write_json(
                self.account_operation_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": operation},
            )
            try:
                result = ACCOUNT_EXECUTOR_MODULE.execute_non_final(
                    packet, protected_provider, strategy, account["credentialRef"],
                    observer or ACCOUNT_EXECUTOR_MODULE.observe_synthetic_portal,
                )
            except Exception:
                ambiguous = self._write_account_stage_locked(
                    account, "ambiguous", operation, "signup_in_progress"
                )
                handed_off = self._account_attention_handoff_locked(job, "ambiguous")
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous",
                    "retryAllowed": False, "attentionHandoff": True,
                    "account": ACCOUNTS_MODULE.public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(
                account, "credential_provisioned", operation, "credential_provisioned",
                provider_id=result["providerId"], credential_ref=result["credentialRef"],
                credential_version=result["credentialVersion"],
            )
            account = self._write_account_stage_locked(
                account, "signup_in_progress", operation, "signup_in_progress"
            )
            account = self._write_account_stage_locked(
                account, result["lifecycleState"], operation, "signup_in_progress"
            )
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": result["lifecycleState"] == "active",
                "reasonCode": result["lifecycleState"], "retryAllowed": False,
                "attentionHandoff": attention, "reused": result["reused"],
                "secureControlCleared": result["secureControlCleared"],
                "finalActionAuthorized": False,
                "account": ACCOUNTS_MODULE.public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(job, result["lifecycleState"])
                response["job"] = {
                    "id": handed_off["id"], "status": handed_off["status"],
                    "revision": handed_off["revision"],
                }
            self._clear_account_operation_locked(operation)
            return response

    def execute_synthetic_email_only_account(
        self, incoming: dict[str, Any], *, provider: Any,
        test_authority: object | None = None,
    ) -> dict[str, Any]:
        """Execute one loopback Oracle email-only flow without credentials."""

        try:
            packet = ACCOUNT_FLOWS_MODULE.validate_email_only_request(incoming, allow_loopback=True)
        except ACCOUNT_FLOWS_MODULE.AccountFlowError as error:
            raise StoreError(str(error)) from None
        if (
            test_authority is not ACCOUNT_FLOWS_MODULE.synthetic_test_authority()
            or getattr(provider, "provider_id", None) != "macos-accessibility"
        ):
            raise StoreError("synthetic account-flow provider is test-only")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(packet["jobId"])
            if (
                claim is None or claim["jobId"] != packet["jobId"]
                or claim["claimId"] != packet["expectedClaimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress" or job["revision"] != packet["jobRevision"]
            ):
                raise StoreError("email-only execution requires the exact live claimed job")
            realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
            if (
                realm.get("status") != "resolved"
                or realm.get("adapterId") != "oracle-recruiting"
                or realm.get("flowKind") != ACCOUNTS_MODULE.FLOW_EMAIL_ONLY
                or realm.get("realmRef") != packet["realmRef"]
                or realm.get("descriptor") != packet["realmDescriptor"]
            ):
                raise StoreError("email-only execution realm binding mismatch")
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(packet["realmRef"])
            if (
                account is None or account["revision"] != packet["accountRevision"]
                or settings["revision"] != packet["settingsRevision"]
            ):
                raise StoreError("email-only execution revision conflict")
            if not settings["enabled"] or not settings["automaticAccountCreation"]:
                raise StoreError("account automation is disabled")
            if account.get("flowKind") != ACCOUNTS_MODULE.FLOW_EMAIL_ONLY or account.get("credentialRequired") is not False:
                raise StoreError("email-only account metadata is invalid")
            if account["providerId"] is not None or account["credentialRef"] is not None or account["credentialVersion"] is not None:
                raise StoreError("email-only execution forbids credential metadata")
            if account["lifecycleState"] != "discovered":
                raise StoreError("email-only account cannot be attempted again")
            effective_email = account["signupEmailOverride"] or settings["signupEmail"]
            if effective_email is None:
                raise StoreError("effective signup email is required")
            operation = {
                "operationId": str(uuid.uuid4()), "jobId": job["id"],
                "jobRevision": job["revision"], "claimId": claim["claimId"],
                "realmRef": account["realmRef"], "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending", "startedAt": self._now(),
            }
            # Durable burn precedes every portal effect.
            atomic_write_json(self.account_operation_journal_path, {"schemaVersion": SCHEMA_VERSION, "operation": operation})
            account = self._write_account_stage_locked(account, "signup_in_progress", operation, "signup_in_progress")
            try:
                result = ACCOUNT_FLOWS_MODULE.execute_email_only(
                    {**packet, "accountRevision": packet["accountRevision"]}, provider,
                    lambda: effective_email, allow_loopback=True,
                )
            except Exception:
                ambiguous = self._write_account_stage_locked(account, "ambiguous", operation, "signup_in_progress")
                handed_off = self._account_attention_handoff_locked(job, "ambiguous")
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous", "retryAllowed": False,
                    "attentionHandoff": True, "finalActionAuthorized": False,
                    "credentialProviderInvocations": 0,
                    "account": ACCOUNTS_MODULE.public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(
                account, result["lifecycleState"], operation, "signup_in_progress"
            )
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": not attention, "reasonCode": result["lifecycleState"],
                "retryAllowed": False, "attentionHandoff": attention,
                "finalActionAuthorized": False, "emailRemoved": result["emailRemoved"],
                "termsAccepted": result["termsAccepted"], "nextActivations": result["nextActivations"],
                "credentialProviderInvocations": 0,
                "account": ACCOUNTS_MODULE.public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(job, result["lifecycleState"])
                response["job"] = {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]}
            self._clear_account_operation_locked(operation)
            return response

    def _validate_live_email_only_stable_locked(
        self, request: dict[str, Any]
    ) -> dict[str, Any]:
        binding = request["binding"]
        job = self._load_jobs_document()["jobs"].get(binding["jobId"])
        if (
            job is None or job.get("deletedAt") is not None
            or not (
                (job["status"] == "in_progress" and job["revision"] == binding["jobRevision"])
                or (job["status"] == "ready" and job["revision"] + 1 == binding["jobRevision"])
            )
        ):
            raise StoreError("live email-only stable job binding drifted")
        if job["url"] != request["portalUrl"]:
            raise StoreError("live email-only portal URL drifted")
        realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
        settings = self._load_automation_settings_document()["settings"]
        account = self._load_employer_accounts_document()["accounts"].get(binding["realmRef"])
        if (
            realm.get("status") != "resolved"
            or realm.get("adapterId") != "oracle-recruiting"
            or realm.get("realmRef") != binding["realmRef"]
            or account is None or account["descriptor"] != realm.get("descriptor")
            or account["revision"] != binding["accountRevision"]
            or settings["revision"] != binding["settingsRevision"]
        ):
            raise StoreError("live email-only canonical binding drifted")
        if not settings["enabled"] or not settings["automaticAccountCreation"]:
            raise StoreError("account automation is disabled")
        if (
            account.get("flowKind") != ACCOUNTS_MODULE.FLOW_EMAIL_ONLY
            or account.get("credentialRequired") is not False
            or account["providerId"] is not None
            or account["credentialRef"] is not None
            or account["credentialVersion"] is not None
        ):
            raise StoreError("live email-only account metadata is invalid")
        if account["lifecycleState"] != "discovered":
            raise StoreError("live email-only account cannot be attempted again")
        if account["signupEmailOverride"] is None and settings["signupEmail"] is None:
            raise StoreError("effective signup email is required")
        return {"job": job, "realm": realm, "settings": settings, "account": account}

    def revalidate_live_email_only_stable_scope(
        self, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        """Recheck a claim-independent final scope without revealing values."""
        try:
            request = CANARY_EXECUTOR_MODULE.validate_stable_live_request(incoming)
        except CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            current = self._validate_live_email_only_stable_locked(request)
            operation = self._load_account_operation_journal()["operation"]
            if operation is not None:
                resumable = {
                    "jobId": current["job"]["id"],
                    "jobRevision": request["binding"]["jobRevision"],
                    "realmRef": current["account"]["realmRef"],
                    "accountRevision": current["account"]["revision"],
                    "settingsRevision": current["settings"]["revision"],
                    "stage": "prepared", "outcomeCode": "observed_pending",
                }
                if any(operation.get(field) != value for field, value in resumable.items()):
                    raise StoreError("account operation requires explicit recovery")
            return {
                "valid": True, "jobId": current["job"]["id"],
                "jobRevision": request["binding"]["jobRevision"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "finalActionAuthorized": False,
            }

    def revalidate_live_email_only_preparation_scope(
        self, scope: dict[str, Any], portal_url: str, portal_name: str,
        realm_descriptor: str,
    ) -> dict[str, Any]:
        """Recheck stable canonical scope before any read-only page access."""
        try:
            exact = CANARY_EXECUTOR_MODULE.CANARY.validate_preparation_scope(scope)
        except CANARY_EXECUTOR_MODULE.CANARY.CanaryAuthorityError as error:
            raise StoreError(str(error)) from None
        try:
            portal = urlsplit(portal_url)
            port = portal.port
        except (TypeError, ValueError):
            raise StoreError("live email-only preparation portal binding drifted") from None
        if (
            not isinstance(portal_url, str) or not isinstance(portal_name, str)
            or portal.scheme != "https" or not portal.hostname
            or portal.username is not None or portal.password is not None
            or portal.query or portal.fragment or not portal.path.startswith("/")
            or (port is not None and port != 443)
            or self._trusted_fill_fingerprint(portal_url) != exact["portalFingerprint"]
            or self._trusted_fill_fingerprint(portal_name) != exact["portalNameFingerprint"]
        ):
            raise StoreError("live email-only preparation portal binding drifted")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(exact["jobId"])
            if (
                job is None or job.get("deletedAt") is not None
                or job["url"] != portal_url
                or not (
                    (job["status"] == "in_progress" and job["revision"] == exact["jobRevision"])
                    or (job["status"] == "ready" and job["revision"] + 1 == exact["jobRevision"])
                )
            ):
                raise StoreError("live email-only preparation job binding drifted")
            realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(exact["realmRef"])
            if (
                realm.get("status") != "resolved" or realm.get("adapterId") != "oracle-recruiting"
                or realm.get("realmRef") != exact["realmRef"] or account is None
                or realm.get("descriptor") != realm_descriptor
                or account.get("descriptor") != realm.get("descriptor")
                or account.get("revision") != exact["accountRevision"]
                or settings.get("revision") != exact["settingsRevision"]
                or account.get("lifecycleState") != "discovered"
                or account.get("flowKind") != ACCOUNTS_MODULE.FLOW_EMAIL_ONLY
                or account.get("credentialRequired") is not False
                or not settings.get("enabled") or not settings.get("automaticAccountCreation")
                or (account.get("signupEmailOverride") is None and settings.get("signupEmail") is None)
            ):
                raise StoreError("live email-only preparation canonical binding drifted")
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            return {
                "valid": True, "jobId": job["id"],
                "jobRevision": exact["jobRevision"], "finalActionAuthorized": False,
            }

    def acquire_or_recover_live_email_only_claim(
        self, incoming: dict[str, Any], *, owner_label: str,
    ) -> dict[str, Any]:
        """Create fresh short-lived execution authority after stable approval."""
        stable = self.revalidate_live_email_only_stable_scope(incoming)
        status = self.claim_status()["claim"]
        if status is None:
            job = self.get_job(stable["jobId"])
            if job["status"] != "ready":
                raise StoreError("live email-only claim cannot be acquired")
            acquired = self.acquire_ready_job(job["id"], owner_label, job["revision"])
            claim = acquired["claim"]
        elif status["jobId"] != stable["jobId"]:
            raise StoreError("another job claim blocks live email-only execution")
        elif status["expired"]:
            claim = self.recover_claim(stable["jobId"], owner_label)["claim"]
        elif status["ownerLabel"] != owner_label.strip():
            raise StoreError("live email-only claim belongs to another owner")
        else:
            claim = status
        # Close the acquisition/recovery race by rechecking every stable field.
        self.revalidate_live_email_only_stable_scope(incoming)
        return {"claimId": claim["claimId"], "expiresAt": claim["expiresAt"]}

    def prepare_live_email_only_account_execution(
        self, incoming: dict[str, Any], binding: dict[str, Any],
    ) -> dict[str, Any]:
        """Durably stage one exact attempt before consuming owner authority."""

        try:
            stable = CANARY_EXECUTOR_MODULE.validate_stable_live_request(incoming)
            exact_binding = CANARY_EXECUTOR_MODULE.CANARY.validate_binding(binding)
        except (
            CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError,
            CANARY_EXECUTOR_MODULE.CANARY.CanaryAuthorityError,
        ) as error:
            raise StoreError(str(error)) from None
        if CANARY_EXECUTOR_MODULE.CANARY._without_claim(exact_binding) != stable["binding"]:
            raise StoreError("live email-only execution binding drifted")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(exact_binding["jobId"])
            account = self._load_employer_accounts_document()["accounts"].get(
                exact_binding["realmRef"]
            )
            settings = self._load_automation_settings_document()["settings"]
            if (
                claim is None or claim["jobId"] != exact_binding["jobId"]
                or claim["claimId"] != exact_binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress"
                or job["revision"] != exact_binding["jobRevision"]
                or job["url"] != stable["portalUrl"]
                or account is None or account["revision"] != exact_binding["accountRevision"]
                or settings["revision"] != exact_binding["settingsRevision"]
                or account["lifecycleState"] != "discovered"
            ):
                raise StoreError("live email-only execution preparation drifted")
            operation = self._load_account_operation_journal()["operation"]
            expected = {
                "jobId": job["id"], "jobRevision": job["revision"],
                "claimId": claim["claimId"], "realmRef": account["realmRef"],
                "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending",
            }
            if operation is not None:
                if any(operation.get(field) != value for field, value in expected.items()):
                    raise StoreError("account operation requires explicit recovery")
                return {"prepared": True, "reused": True}
            operation_id = str(uuid.uuid4())
            atomic_write_json(
                self.account_operation_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": {
                    "operationId": operation_id, **expected, "startedAt": self._now(),
                }},
            )
            return {"prepared": True, "reused": False}

    def execute_live_email_only_account(
        self, incoming: dict[str, Any], *, authority: Any, provider: Any,
        now: datetime,
    ) -> dict[str, Any]:
        """Consume one exact T007 capability and run one query-free Oracle attempt.

        This method is intentionally not exposed through the JSON CLI or HTTP.
        Capability material and the canonical signup identity remain inside the
        process. The durable journal is written before T007 is consumed, and
        both burns precede every browser effect.
        """

        try:
            request = CANARY_EXECUTOR_MODULE.validate_live_request(incoming)
        except CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        if request["binding"].get("flowKind") != ACCOUNTS_MODULE.FLOW_EMAIL_ONLY:
            raise StoreError("live email-only canary binding is invalid")
        if not sys.platform.startswith("darwin") or getattr(provider, "provider_id", None) != "macos-accessibility":
            raise StoreError("native account execution is unsupported on this platform")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        binding = request["binding"]
        with exclusive_file_lock(self.store_lock_path):
            prepared_operation = self._load_account_operation_journal()["operation"]
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(binding["jobId"])
            if (
                claim is None or claim["jobId"] != binding["jobId"]
                or claim["claimId"] != binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress" or job["revision"] != binding["jobRevision"]
            ):
                raise StoreError("live email-only execution requires the exact live claimed job")
            if job["url"] != request["portalUrl"]:
                raise StoreError("live email-only portal URL drifted")
            realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(binding["realmRef"])
            if (
                realm.get("status") != "resolved"
                or realm.get("adapterId") != "oracle-recruiting"
                or realm.get("realmRef") != binding["realmRef"]
                or account is None or account["descriptor"] != realm.get("descriptor")
                or account["revision"] != binding["accountRevision"]
                or settings["revision"] != binding["settingsRevision"]
            ):
                raise StoreError("live email-only canonical binding drifted")
            if not settings["enabled"] or not settings["automaticAccountCreation"]:
                raise StoreError("account automation is disabled")
            if (
                account.get("flowKind") != ACCOUNTS_MODULE.FLOW_EMAIL_ONLY
                or account.get("credentialRequired") is not False
                or account["providerId"] is not None
                or account["credentialRef"] is not None
                or account["credentialVersion"] is not None
            ):
                raise StoreError("live email-only account metadata is invalid")
            if account["lifecycleState"] != "discovered":
                raise StoreError("live email-only account cannot be attempted again")
            effective_email = account["signupEmailOverride"] or settings["signupEmail"]
            if effective_email is None:
                raise StoreError("effective signup email is required")
            expected_operation = {
                "jobId": job["id"], "jobRevision": job["revision"],
                "claimId": claim["claimId"], "realmRef": account["realmRef"],
                "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending",
            }
            if prepared_operation is None:
                operation_id = str(uuid.uuid4())
                operation = {
                    "operationId": operation_id, **expected_operation,
                    "startedAt": self._now(),
                }
                atomic_write_json(
                    self.account_operation_journal_path,
                    {"schemaVersion": SCHEMA_VERSION, "operation": operation},
                )
            else:
                if any(
                    prepared_operation.get(field) != value
                    for field, value in expected_operation.items()
                ):
                    raise StoreError("account operation requires explicit recovery")
                operation = prepared_operation
                operation_id = operation["operationId"]
            operation_fingerprint = "sha256:" + hashlib.sha256(operation_id.encode("ascii")).hexdigest()
            # The hash-only T007 ledger is consumed after the write-ahead burn
            # and before signup_in_progress or any native browser effect.
            authority.attempt(request["capabilityRef"], binding, now=now)
            account = self._write_account_stage_locked(
                account, "signup_in_progress", operation, "signup_in_progress"
            )
            flow_packet = {
                "jobId": job["id"], "jobRevision": job["revision"],
                "expectedClaimId": claim["claimId"], "realmRef": realm["realmRef"],
                "realmDescriptor": realm["descriptor"], "flowKind": ACCOUNTS_MODULE.FLOW_EMAIL_ONLY,
                "accountRevision": binding["accountRevision"],
                "settingsRevision": settings["revision"], "portalUrl": request["portalUrl"],
                "accountFormFingerprint": request["accountFormFingerprint"],
                "emailControlFingerprint": request["emailControlFingerprint"],
                "termsControlFingerprint": request["termsControlFingerprint"],
                "termsDocumentFingerprint": request["termsDocumentFingerprint"],
                "nextControlFingerprint": request["nextControlFingerprint"],
                "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
                "accountCreationControlsFingerprint": binding["accountCreationControlsFingerprint"],
            }
            try:
                result = ACCOUNT_FLOWS_MODULE.execute_email_only(
                    flow_packet, provider, lambda: effective_email,
                    operation_fingerprint=operation_fingerprint,
                )
            except Exception:
                ambiguous = self._write_account_stage_locked(account, "ambiguous", operation, "signup_in_progress")
                handed_off = self._account_attention_handoff_locked(job, "ambiguous")
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous", "retryAllowed": False,
                    "attentionHandoff": True, "finalActionAuthorized": False,
                    "credentialProviderInvocations": 0,
                    "account": ACCOUNTS_MODULE.public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(account, result["lifecycleState"], operation, "signup_in_progress")
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": not attention, "reasonCode": result["lifecycleState"],
                "retryAllowed": False, "attentionHandoff": attention,
                "finalActionAuthorized": False, "emailRemoved": result["emailRemoved"],
                "termsAccepted": result["termsAccepted"], "nextActivations": result["nextActivations"],
                "credentialProviderInvocations": 0,
                "account": ACCOUNTS_MODULE.public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(job, result["lifecycleState"])
                response["job"] = {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]}
            self._clear_account_operation_locked(operation)
            return response

    def _validate_live_password_stable_locked(
        self, request: dict[str, Any]
    ) -> dict[str, Any]:
        binding = request["binding"]
        job = self._load_jobs_document()["jobs"].get(binding["jobId"])
        if (
            job is None or job.get("deletedAt") is not None
            or not (
                (job["status"] == "in_progress" and job["revision"] == binding["jobRevision"])
                or (job["status"] == "ready" and job["revision"] + 1 == binding["jobRevision"])
            )
            or job["url"] != request["portalUrl"]
        ):
            raise StoreError("live password stable job binding drifted")
        realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
        settings = self._load_automation_settings_document()["settings"]
        account = self._load_employer_accounts_document()["accounts"].get(
            binding["realmRef"]
        )
        if (
            realm.get("status") != "resolved"
            or realm.get("adapterId") != "workday"
            or realm.get("flowKind") != ACCOUNTS_MODULE.FLOW_PASSWORD
            or realm.get("realmRef") != binding["realmRef"]
            or account is None or account.get("descriptor") != realm.get("descriptor")
            or account.get("revision") != binding["accountRevision"]
            or settings.get("revision") != binding["settingsRevision"]
        ):
            raise StoreError("live password canonical binding drifted")
        if not settings["enabled"] or not settings["automaticAccountCreation"]:
            raise StoreError("account automation is disabled")
        if settings["passwordStrategy"] != "unique_per_realm":
            raise StoreError("live password strategy requires human attention")
        if (
            account.get("flowKind") != ACCOUNTS_MODULE.FLOW_PASSWORD
            or account.get("credentialRequired") is not True
            or account.get("lifecycleState") != "discovered"
            or account.get("providerId") is not None
            or account.get("credentialRef") is not None
            or account.get("credentialVersion") is not None
        ):
            raise StoreError("live password account cannot be attempted")
        if account["signupEmailOverride"] is None and settings["signupEmail"] is None:
            raise StoreError("effective signup email is required")
        return {"job": job, "realm": realm, "settings": settings, "account": account}

    def revalidate_live_password_stable_scope(
        self, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            request = CANARY_EXECUTOR_MODULE.validate_stable_live_password_request(incoming)
        except CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            current = self._validate_live_password_stable_locked(request)
            operation = self._load_account_operation_journal()["operation"]
            if operation is not None:
                resumable = {
                    "jobId": current["job"]["id"],
                    "jobRevision": request["binding"]["jobRevision"],
                    "realmRef": current["account"]["realmRef"],
                    "accountRevision": current["account"]["revision"],
                    "settingsRevision": current["settings"]["revision"],
                    "stage": "prepared", "outcomeCode": "observed_pending",
                }
                if any(operation.get(field) != value for field, value in resumable.items()):
                    raise StoreError("account operation requires explicit recovery")
            return {
                "valid": True, "jobId": current["job"]["id"],
                "jobRevision": request["binding"]["jobRevision"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "finalActionAuthorized": False,
            }

    def acquire_or_recover_live_password_claim(
        self, incoming: dict[str, Any], *, owner_label: str,
    ) -> dict[str, Any]:
        stable = self.revalidate_live_password_stable_scope(incoming)
        status = self.claim_status()["claim"]
        if status is None:
            job = self.get_job(stable["jobId"])
            if job["status"] != "ready":
                raise StoreError("live password claim cannot be acquired")
            claim = self.acquire_ready_job(
                job["id"], owner_label, job["revision"]
            )["claim"]
        elif status["jobId"] != stable["jobId"]:
            raise StoreError("another job claim blocks live password execution")
        elif status["expired"]:
            claim = self.recover_claim(stable["jobId"], owner_label)["claim"]
        elif status["ownerLabel"] != owner_label.strip():
            raise StoreError("live password claim belongs to another owner")
        else:
            claim = status
        self.revalidate_live_password_stable_scope(incoming)
        return {"claimId": claim["claimId"], "expiresAt": claim["expiresAt"]}

    def prepare_live_password_account_execution(
        self, incoming: dict[str, Any], binding: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            stable = CANARY_EXECUTOR_MODULE.validate_stable_live_password_request(incoming)
            exact_binding = CANARY_EXECUTOR_MODULE.CANARY.validate_binding(binding)
        except (
            CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError,
            CANARY_EXECUTOR_MODULE.CANARY.CanaryAuthorityError,
        ) as error:
            raise StoreError(str(error)) from None
        if CANARY_EXECUTOR_MODULE.CANARY._without_claim(exact_binding) != stable["binding"]:
            raise StoreError("live password execution binding drifted")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            current = self._validate_live_password_stable_locked(stable)
            claim = self._load_coordinator_document()["claim"]
            if (
                claim is None or claim["jobId"] != exact_binding["jobId"]
                or claim["claimId"] != exact_binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or current["job"]["status"] != "in_progress"
            ):
                raise StoreError("live password execution preparation drifted")
            expected = {
                "jobId": current["job"]["id"],
                "jobRevision": current["job"]["revision"],
                "claimId": claim["claimId"],
                "realmRef": current["account"]["realmRef"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "stage": "prepared", "outcomeCode": "observed_pending",
            }
            operation = self._load_account_operation_journal()["operation"]
            if operation is not None:
                if any(operation.get(field) != value for field, value in expected.items()):
                    raise StoreError("account operation requires explicit recovery")
                return {"prepared": True, "reused": True}
            atomic_write_json(
                self.account_operation_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": {
                    "operationId": str(uuid.uuid4()), **expected,
                    "startedAt": self._now(),
                }},
            )
            return {"prepared": True, "reused": False}

    def execute_live_password_account(
        self, incoming: dict[str, Any], *, authority: Any, provider: Any,
        now: datetime,
    ) -> dict[str, Any]:
        try:
            request = CANARY_EXECUTOR_MODULE.validate_live_password_request(incoming)
        except CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        if (
            not sys.platform.startswith("darwin")
            or getattr(provider, "provider_id", None) != "macos-workday-account"
        ):
            raise StoreError("native account execution is unsupported on this platform")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        binding = request["binding"]
        with exclusive_file_lock(self.store_lock_path):
            current = self._validate_live_password_stable_locked({
                **request, "binding": CANARY_EXECUTOR_MODULE.CANARY._without_claim(binding)
            })
            claim = self._load_coordinator_document()["claim"]
            if (
                claim is None or claim["jobId"] != binding["jobId"]
                or claim["claimId"] != binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or current["job"]["status"] != "in_progress"
            ):
                raise StoreError("live password execution requires the exact live claimed job")
            operation = self._load_account_operation_journal()["operation"]
            expected_operation = {
                "jobId": current["job"]["id"],
                "jobRevision": current["job"]["revision"],
                "claimId": claim["claimId"],
                "realmRef": current["account"]["realmRef"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "stage": "prepared", "outcomeCode": "observed_pending",
            }
            if operation is None or any(
                operation.get(field) != value
                for field, value in expected_operation.items()
            ):
                raise StoreError("live password execution requires a prepared operation")
            authority.attempt(request["capabilityRef"], binding, now=now)
            account = self._write_account_stage_locked(
                current["account"], "signup_in_progress", operation,
                "signup_in_progress",
            )
            packet = {
                "jobId": current["job"]["id"],
                "jobRevision": current["job"]["revision"],
                "expectedClaimId": claim["claimId"],
                "realmRef": current["realm"]["realmRef"],
                "realmDescriptor": current["realm"]["descriptor"],
                "accountRevision": binding["accountRevision"],
                "settingsRevision": current["settings"]["revision"],
                "portalUrl": request["portalUrl"],
                "strategy": current["settings"]["passwordStrategy"],
                "accountFormFingerprint": request["accountFormFingerprint"],
                "emailControlFingerprint": request["emailControlFingerprint"],
                "passwordControlFingerprint": request["passwordControlFingerprint"],
                "createAccountControlFingerprint": request["createAccountControlFingerprint"],
                "accountCreationControlsFingerprint": binding["accountCreationControlsFingerprint"],
            }
            effective_email = (
                current["account"]["signupEmailOverride"]
                or current["settings"]["signupEmail"]
            )
            try:
                result = PASSWORD_ACCOUNT_FLOWS_MODULE.execute_password_account(
                    packet, provider, lambda: effective_email,
                )
                expected_ref = CREDENTIALS_MODULE.credential_reference(
                    "unique_per_realm", current["realm"]["realmRef"]
                )
                if result["credentialRef"] != expected_ref:
                    raise StoreError("native credential realm binding mismatch")
            except Exception:
                ambiguous = self._write_account_stage_locked(
                    account, "ambiguous", operation, "signup_in_progress"
                )
                handed_off = self._account_attention_handoff_locked(
                    current["job"], "ambiguous"
                )
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous",
                    "retryAllowed": False, "attentionHandoff": True,
                    "finalActionAuthorized": False,
                    "account": ACCOUNTS_MODULE.public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"],
                            "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(
                account, result["lifecycleState"], operation, "signup_in_progress",
                provider_id=result["credentialProviderId"],
                credential_ref=result["credentialRef"],
                credential_version=result["credentialVersion"],
            )
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": not attention,
                "reasonCode": result["attentionReason"],
                "retryAllowed": False, "attentionHandoff": attention,
                "finalActionAuthorized": False, "reused": result["reused"],
                "createAccountActivations": result["createAccountActivations"],
                "emailControlRemoved": result["emailControlRemoved"],
                "passwordControlRemoved": result["passwordControlRemoved"],
                "account": ACCOUNTS_MODULE.public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(
                    current["job"], result["attentionReason"]
                )
                response["job"] = {
                    "id": handed_off["id"], "status": handed_off["status"],
                    "revision": handed_off["revision"],
                }
            self._clear_account_operation_locked(operation)
            return response

    def _ensure_trusted_fill_document(self) -> None:
        with exclusive_file_lock(self.store_lock_path):
            if self.trusted_fill_path.exists():
                return
            now = self._now()
            atomic_write_json(self.trusted_fill_path, {
                "schemaVersion": SCHEMA_VERSION,
                "approvals": {},
                "metadata": {"createdAt": now, "updatedAt": now},
            })

    @staticmethod
    def _trusted_fill_fingerprint(value: str) -> str:
        return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()

    def _trusted_fill_current_locked(
        self, job_id: str, answer_refs: list[str]
    ) -> dict[str, Any]:
        jobs = self._load_jobs_document()["jobs"]
        job = jobs.get(job_id)
        if job is None or job.get("deletedAt") is not None or job["status"] != "in_progress":
            raise StoreError("trusted fill requires an in-progress claimed job")
        realm = ACCOUNTS_MODULE.normalize_realm(job["url"])
        if realm["status"] != "resolved":
            raise StoreError("trusted fill portal realm is unresolved")
        try:
            preflight = self._preflight_job_record(job)
        except Exception:
            raise TrustedFillCurrentError("resume_observation_failed") from None
        if not preflight["ready"]:
            if "resume_file_missing" in preflight["errors"] or "resume_missing" in preflight["errors"]:
                reason = "resume_content_missing"
            elif "resume_file_changed" in preflight["errors"]:
                reason = "resume_content_changed"
            else:
                reason = "resume_preflight_not_ready"
            raise TrustedFillCurrentError(reason)
        if preflight["resumeId"] is None:
            raise TrustedFillCurrentError("resume_content_missing")
        resume = self._load_resumes_document()["resumes"].get(preflight["resumeId"])
        if resume is None or resume.get("deletedAt") is not None:
            raise TrustedFillCurrentError("resume_content_missing")
        if resume.get("storageKind") != "managed":
            raise TrustedFillCurrentError("resume_content_unverifiable")
        try:
            content_revision = TRUSTED_FILL_MODULE.validate_content_revision(
                resume.get("contentRevision")
            )
        except TRUSTED_FILL_MODULE.TrustedFillError:
            raise TrustedFillCurrentError("resume_content_unverifiable") from None
        profile_revision = self._load_profile_document()["metadata"].get("revision", 1)
        answers = self._load_answers_document()["answers"]
        answer_bindings = []
        for answer_ref in sorted(answer_refs):
            answer = answers.get(answer_ref)
            if (
                answer is None or answer.get("deletedAt") is not None
                or answer.get("reviewStatus", "accepted") != "accepted"
            ):
                raise TrustedFillCurrentError("answer_binding_invalid")
            answer_bindings.append({
                "answerRef": answer_ref,
                "questionRevision": answer["revision"],
                "answerRevision": answer["revision"],
            })
        settings = self._load_automation_settings_document()["settings"]
        account = self._load_employer_accounts_document()["accounts"].get(realm["realmRef"])
        return {
            "jobId": job_id,
            "jobRevision": job["revision"],
            "realmRef": realm["realmRef"],
            "urlFingerprint": self._trusted_fill_fingerprint(job["normalizedUrl"]),
            "resumeId": resume["id"],
            "resumeRevision": resume["revision"],
            "resumeContentRevision": content_revision,
            "profileRevision": profile_revision,
            "vitalFactRevision": profile_revision,
            "answerBindings": answer_bindings,
            "automationSettingsRevision": settings["revision"],
            "employerAccountRevision": account["revision"] if account is not None else None,
            "policyRevision": TRUSTED_FILL_MODULE.POLICY_REVISION,
        }

    def approve_trusted_fill(self, incoming: dict[str, Any], *, public: bool = False) -> dict[str, Any]:
        packet = _require_object(incoming, "trusted fill approval request")
        required = {
            "jobId", "expectedJobRevision", "realmRef", "answerRefs",
            "observedQuestionFingerprint", "observedControlFingerprint",
            "formFingerprint", "allowedOperations", "durationMinutes",
        }
        if set(packet) != required:
            raise StoreError("trusted fill approval request contains unsupported fields")
        job_id = _safe_session_id(packet.get("jobId", ""))
        if not isinstance(packet.get("answerRefs"), list) or not all(isinstance(item, str) for item in packet["answerRefs"]):
            raise StoreError("trusted fill answer references must be a list of strings")
        if len(packet["answerRefs"]) != len(set(packet["answerRefs"])):
            raise StoreError("trusted fill answer references contain duplicates")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        self._ensure_trusted_fill_document()
        with exclusive_file_lock(self.store_lock_path):
            claim = self._load_coordinator_document()["claim"]
            if (
                claim is None or claim["jobId"] != job_id
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
            ):
                raise StoreError("trusted fill approval requires the live claimed job")
            try:
                current = self._trusted_fill_current_locked(job_id, packet["answerRefs"])
            except TrustedFillCurrentError as error:
                job = self._load_jobs_document()["jobs"][job_id]
                handed_off = self._trusted_fill_attention_handoff_locked(
                    job, error.reason_code
                )
                return {
                    "authorized": False,
                    "reasonCode": error.reason_code,
                    "retryAllowed": False,
                    "attentionHandoff": True,
                    "job": {
                        "id": handed_off["id"],
                        "status": handed_off["status"],
                        "revision": handed_off["revision"],
                    },
                }
            current["claimId"] = claim["claimId"]
            if current["jobRevision"] != packet.get("expectedJobRevision"):
                raise StoreError("job revision conflict")
            if current["realmRef"] != packet.get("realmRef"):
                raise StoreError("trusted fill realm binding mismatch")
            document = self._load_trusted_fill_document()
            previous = document["approvals"].get(job_id)
            if previous is not None and previous["status"] == "active" and self._now_datetime() < TRUSTED_FILL_MODULE._time(previous["expiresAt"], "approval expiresAt"):
                raise StoreError("active trusted fill approval already exists")
            bindings = {
                **current,
                "observedQuestionFingerprint": packet["observedQuestionFingerprint"],
                "observedControlFingerprint": packet["observedControlFingerprint"],
                "formFingerprint": packet["formFingerprint"],
                "allowedOperations": packet["allowedOperations"],
            }
            approval_revision = 1 if previous is None else previous["approvalRevision"] + 1
            try:
                approval = TRUSTED_FILL_MODULE.create_approval(
                    bindings, packet["durationMinutes"], approval_revision, self._now_datetime()
                )
            except TRUSTED_FILL_MODULE.TrustedFillError as error:
                raise StoreError(str(error)) from None
            document["approvals"][job_id] = approval
            document["metadata"]["updatedAt"] = self._now()
            atomic_write_json(self.trusted_fill_path, document)
        return TRUSTED_FILL_MODULE.public_status(approval, self._now_datetime()) if public else approval

    def trusted_fill_status(self, job_id: str, *, public: bool = False) -> dict[str, Any] | None:
        self.initialize()
        self._ensure_trusted_fill_document()
        _safe_session_id(job_id)
        record = self._load_trusted_fill_document()["approvals"].get(job_id)
        if public:
            return TRUSTED_FILL_MODULE.public_status(record, self._now_datetime())
        return copy.deepcopy(record) if record is not None else None

    def revoke_trusted_fill(
        self, job_id: str, expected_approval_revision: int, *, public: bool = False
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_trusted_fill_document()
        _safe_session_id(job_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_trusted_fill_document()
            record = document["approvals"].get(job_id)
            if record is None:
                raise StoreError("trusted fill approval does not exist")
            try:
                updated = TRUSTED_FILL_MODULE.revoke_approval(
                    record, expected_approval_revision, self._now_datetime()
                )
            except TRUSTED_FILL_MODULE.TrustedFillError as error:
                raise StoreError(str(error)) from None
            document["approvals"][job_id] = updated
            document["metadata"]["updatedAt"] = self._now()
            atomic_write_json(self.trusted_fill_path, document)
        return TRUSTED_FILL_MODULE.public_status(updated, self._now_datetime()) if public else updated

    def _trusted_fill_attention_handoff_locked(
        self, job: dict[str, Any], reason_code: str
    ) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if (
            claim is None or claim["jobId"] != job["id"]
            or self._now_datetime() >= self._parse_time(claim["expiresAt"])
        ):
            raise StoreError("trusted fill denial requires the live claimed job")
        now = self._now()
        blocker_code = {
            "authentication_required": "login-required",
            "credential_fields_present": "login-required",
            "consent_required": "consent-required",
            "approval_missing": "owner-input-required",
            "approval_revoked": "owner-input-required",
            "approval_expired": "owner-input-required",
            "approval_revision_mismatch": "owner-input-required",
            "answer_binding_invalid": "owner-input-required",
            "resume_content_missing": "owner-input-required",
            "resume_content_unverifiable": "owner-input-required",
            "resume_observation_failed": "owner-input-required",
            "resume_preflight_not_ready": "owner-input-required",
            "unseen_questions": "owner-input-required",
        }.get(reason_code, "browser-state-uncertain")
        session = self._build_session(job["id"], {
            "status": "active",
            "step": f"trusted_fill_denied:{reason_code}",
            "answerKeys": [],
            "pendingFields": [],
            "attemptRevision": job["revision"],
            "blockers": [{
                "type": AGENT_BLOCKER_TYPE_BY_CODE[blocker_code],
                "code": blocker_code,
            }],
            "browserHandoff": {
                "state": "required", "reasonCode": blocker_code, "revision": 1,
            },
        }, now, expected_attempt_revision=job["revision"], expected_ats=job.get("ats"))
        operation_id = str(uuid.uuid4())
        self._commit_coordinator_operation_locked({
            "kind": "handoff", "operationId": operation_id, "jobId": job["id"],
            "sourceStatus": "in_progress", "targetStatus": "needs_info",
            "expectedRevision": job["revision"], "at": now, "session": session,
            "historyEvent": self._history_event_for_operation(
                operation_id, job, "job-blocked", "needs_info", now
            ),
            "resultClaim": None,
        })
        return self._load_jobs_document()["jobs"][job["id"]]

    def evaluate_trusted_fill(self, incoming: dict[str, Any], *, public: bool = False) -> dict[str, Any]:
        observed = _require_object(incoming, "trusted fill evaluation")
        required = {
            "jobId", "expectedApprovalRevision", "observedQuestionFingerprint",
            "observedControlFingerprint", "formFingerprint", "fieldOperations",
            "authenticationRequired", "consentRequired", "credentialFieldsPresent",
            "finalControlsPresent", "unseenQuestions", "unseenControls",
        }
        if set(observed) != required:
            raise StoreError("trusted fill evaluation contains unsupported fields")
        for field in (
            "authenticationRequired", "consentRequired", "credentialFieldsPresent",
            "finalControlsPresent", "unseenQuestions", "unseenControls",
        ):
            if not isinstance(observed[field], bool):
                raise StoreError("trusted fill evaluation flags must be booleans")
        job_id = _safe_session_id(observed.get("jobId", ""))
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        self._ensure_trusted_fill_document()
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_trusted_fill_document()
            approval = document["approvals"].get(job_id)
            job = self._load_jobs_document()["jobs"].get(job_id)
            claim = self._load_coordinator_document()["claim"]
            if job is None or job.get("deletedAt") is not None or job["status"] != "in_progress":
                raise StoreError("trusted fill evaluation requires an in-progress job")
            if (
                claim is None or claim["jobId"] != job_id
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
            ):
                return {
                    "authorized": False,
                    "reasonCode": "claim_missing_or_expired",
                    "retryAllowed": False,
                    "attentionHandoff": False,
                }
            if approval is None:
                decision = {"authorized": False, "reasonCode": "approval_missing", "retryAllowed": False}
            elif approval["approvalRevision"] != observed.get("expectedApprovalRevision"):
                decision = {"authorized": False, "reasonCode": "approval_revision_mismatch", "retryAllowed": False}
            elif approval["claimId"] != claim["claimId"]:
                return {
                    "authorized": False,
                    "reasonCode": "claim_binding_mismatch",
                    "retryAllowed": False,
                    "attentionHandoff": False,
                }
            else:
                try:
                    current = self._trusted_fill_current_locked(
                        job_id, [item["answerRef"] for item in approval["answerBindings"]]
                    )
                except TrustedFillCurrentError as error:
                    decision = {
                        "authorized": False,
                        "reasonCode": error.reason_code,
                        "retryAllowed": False,
                    }
                else:
                    current["claimId"] = claim["claimId"]
                    try:
                        decision = TRUSTED_FILL_MODULE.evaluate_approval(
                            approval, current, observed, self._now_datetime()
                        )
                    except TRUSTED_FILL_MODULE.TrustedFillError as error:
                        raise StoreError(str(error)) from None
            if not decision["authorized"]:
                handed_off = self._trusted_fill_attention_handoff_locked(job, decision["reasonCode"])
                decision = {
                    **decision,
                    "attentionHandoff": True,
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            else:
                decision["attentionHandoff"] = False
        return decision


def _scope(value: str) -> dict[str, Any]:
    try:
        return _require_object(json.loads(value), "scope")
    except json.JSONDecodeError as error:
        raise StoreError("scope must be a JSON object") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        help=f"store directory (default: ${STORE_ENV} or ~/.job-apply)",
    )
    parser.add_argument("--legacy-profile", help="legacy profile path override")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("init")
    commands.add_parser("paths")
    commands.add_parser("profile-get")
    commands.add_parser("profile-inspect")
    profile_replace = commands.add_parser("profile-replace")
    profile_replace.add_argument("--input", required=True)
    profile_replace.add_argument("--expected-revision", required=True, type=int)
    profile_replace.add_argument("--source", required=True, choices=sorted(FACT_SOURCES))
    profile_patch = commands.add_parser("profile-patch")
    profile_patch.add_argument("--input", required=True)
    profile_patch.add_argument("--expected-revision", required=True, type=int)
    profile_patch.add_argument("--source", required=True, choices=sorted(FACT_SOURCES))
    commands.add_parser("fact-group-list")
    fact_group_get = commands.add_parser("fact-group-get")
    fact_group_get.add_argument("--id", required=True)
    fact_group_create = commands.add_parser("fact-group-create")
    fact_group_create.add_argument("--input", required=True)
    fact_group_update = commands.add_parser("fact-group-update")
    fact_group_update.add_argument("--id", required=True)
    fact_group_update.add_argument("--input", required=True)
    fact_group_update.add_argument("--expected-revision", required=True, type=int)
    fact_group_delete = commands.add_parser("fact-group-delete")
    fact_group_delete.add_argument("--id", required=True)
    fact_group_delete.add_argument("--expected-revision", required=True, type=int)
    commands.add_parser("preferences-get")
    preferences_set = commands.add_parser("preferences-set")
    preferences_set.add_argument("--input", required=True)
    preferences_set.add_argument("--expected-revision", required=True, type=int)
    preferences_set.add_argument("--source", required=True, choices=sorted(FACT_SOURCES))
    preferences_set.add_argument("--replace", action="store_true")

    key = commands.add_parser("answer-key")
    key.add_argument("--question", required=True)
    key.add_argument("--scope", default="{}")
    put = commands.add_parser("answer-put")
    put.add_argument("--input", required=True)
    put.add_argument("--expected-revision", type=int)
    put.add_argument("--remember-sensitive", action="store_true")
    get = commands.add_parser("answer-get")
    get.add_argument("--key", required=True)
    get.add_argument("--include-trashed", action="store_true")
    find = commands.add_parser("answer-find")
    find.add_argument("--question", required=True)
    find.add_argument("--scope", default="{}")
    answer_list = commands.add_parser("answer-list")
    answer_list.add_argument("--state")
    answer_review_filter = answer_list.add_mutually_exclusive_group()
    answer_review_filter.add_argument("--review-status", choices=sorted(ANSWER_REVIEW_STATUSES), default="accepted")
    answer_review_filter.add_argument("--all-review-statuses", action="store_true")
    answer_list.add_argument("--query", default="")
    answer_list.add_argument("--offset", type=int, default=0)
    answer_list.add_argument("--limit", type=int, default=50)
    answer_list.add_argument("--include-trashed", action="store_true")
    answer_list.add_argument("--trashed-only", action="store_true")
    answer_reveal = commands.add_parser("answer-reveal")
    answer_reveal.add_argument("--key", required=True)
    answer_observe = commands.add_parser("answer-observe")
    answer_observe.add_argument("--input", required=True)
    answer_review = commands.add_parser("answer-review")
    answer_review.add_argument("--key", required=True)
    answer_review.add_argument("--decision", required=True, choices=["accepted", "declined"])
    answer_review.add_argument("--expected-revision", required=True, type=int)
    answer_review.add_argument("--input")
    answer_review.add_argument("--remember-sensitive", action="store_true")
    answer_update = commands.add_parser("answer-update")
    answer_update.add_argument("--key", required=True)
    answer_update.add_argument("--input", required=True)
    answer_update.add_argument("--expected-revision", required=True, type=int)
    answer_update.add_argument("--remember-sensitive", action="store_true")
    answer_trash = commands.add_parser("answer-trash")
    answer_trash.add_argument("--key", required=True)
    answer_trash.add_argument("--expected-revision", required=True, type=int)
    answer_restore = commands.add_parser("answer-restore")
    answer_restore.add_argument("--key", required=True)
    answer_restore.add_argument("--expected-revision", required=True, type=int)
    answer_delete = commands.add_parser("answer-delete")
    answer_delete.add_argument("--key", required=True)
    answer_delete.add_argument("--expected-revision", required=True, type=int)
    answer_merge = commands.add_parser("answer-merge")
    answer_merge.add_argument("--winner-key", required=True)
    answer_merge.add_argument("--source-key", required=True)
    answer_merge.add_argument("--expected-winner-revision", required=True, type=int)
    answer_merge.add_argument("--expected-source-revision", required=True, type=int)
    semantic_lookup = commands.add_parser("answer-semantic-lookup")
    semantic_lookup.add_argument("--input", required=True)
    commands.add_parser("answer-cleanup-preview")
    cleanup_approve = commands.add_parser("answer-cleanup-approve")
    cleanup_approve.add_argument("--input", required=True)
    cleanup_approve.add_argument("--owner-confirmed", action="store_true")

    job_create = commands.add_parser("job-create")
    job_create.add_argument("--input", required=True)
    job_create.add_argument("--origin", choices=sorted(JOB_ORIGINS), default="human")
    job_upsert_preview = commands.add_parser("job-upsert-preview")
    job_upsert_preview.add_argument("--input", required=True)
    job_upsert_preview.add_argument("--origin", choices=sorted(JOB_ORIGINS), required=True)
    job_upsert_commit = commands.add_parser("job-upsert-commit")
    job_upsert_commit.add_argument("--input", required=True)
    job_upsert_commit.add_argument("--origin", choices=sorted(JOB_ORIGINS), required=True)
    job_upsert_commit.add_argument("--token", required=True)
    legacy_jobs_preview = commands.add_parser("legacy-jobs-preview")
    legacy_jobs_preview.add_argument("--select", action="append", default=[])
    legacy_jobs_commit = commands.add_parser("legacy-jobs-commit")
    legacy_jobs_commit.add_argument("--select", action="append", required=True)
    legacy_jobs_commit.add_argument("--confirm", required=True)
    job_get = commands.add_parser("job-get")
    job_get.add_argument("--id", required=True)
    job_get.add_argument("--include-trashed", action="store_true")
    job_list = commands.add_parser("job-list")
    job_list.add_argument("--status")
    job_list.add_argument("--include-trashed", action="store_true")
    job_list.add_argument("--trashed-only", action="store_true")
    job_preflight = commands.add_parser("job-preflight")
    job_preflight.add_argument("--id", required=True)
    job_update = commands.add_parser("job-update")
    job_update.add_argument("--id", required=True)
    job_update.add_argument("--input", required=True)
    job_update.add_argument("--expected-revision", required=True, type=int)
    job_update.add_argument("--origin", choices=sorted(JOB_ORIGINS), default="human")
    job_transition = commands.add_parser("job-transition")
    job_transition.add_argument("--id", required=True)
    job_transition.add_argument("--status", required=True)
    job_transition.add_argument("--closed-outcome")
    job_transition.add_argument("--expected-revision", required=True, type=int)
    job_transition.add_argument("--user-confirmed", action="store_true")
    job_acquire = commands.add_parser("job-acquire")
    job_acquire.add_argument("--id", required=True)
    job_acquire.add_argument("--owner", required=True)
    job_acquire.add_argument("--expected-revision", required=True, type=int)
    job_review_restart = commands.add_parser("job-review-restart")
    job_review_restart.add_argument("--id", required=True)
    job_review_restart.add_argument("--owner", required=True)
    job_review_restart.add_argument("--expected-revision", required=True, type=int)
    job_review_restart.add_argument(
        "--owner-confirmed-not-submitted", action="store_true"
    )
    commands.add_parser("claim-status")
    claim_heartbeat = commands.add_parser("claim-heartbeat")
    claim_heartbeat.add_argument("--id", required=True)
    claim_heartbeat.add_argument("--token", required=True)
    claim_recover = commands.add_parser("claim-recover")
    claim_recover.add_argument("--id", required=True)
    claim_recover.add_argument("--owner", required=True)
    claim_progress = commands.add_parser("claim-progress")
    claim_progress.add_argument("--id", required=True)
    claim_progress.add_argument("--token", required=True)
    claim_progress.add_argument("--input", required=True)
    claim_handoff = commands.add_parser("claim-handoff")
    claim_handoff.add_argument("--id", required=True)
    claim_handoff.add_argument("--token", required=True)
    claim_handoff.add_argument("--status", required=True)
    claim_handoff.add_argument("--input", required=True)
    claim_handoff.add_argument("--expected-revision", required=True, type=int)
    approval_preview = commands.add_parser("attention-approval-preview")
    approval_preview.add_argument("--id", required=True)
    approval_preview.add_argument("--expected-job-revision", required=True, type=int)
    approval_preview.add_argument("--expected-session-revision", required=True, type=int)
    approval_preview.add_argument("--input", required=True)
    approval_commit = commands.add_parser("attention-approval-approve")
    approval_commit.add_argument("--id", required=True)
    approval_commit.add_argument("--expected-job-revision", required=True, type=int)
    approval_commit.add_argument("--expected-session-revision", required=True, type=int)
    approval_commit.add_argument("--preview-token", required=True)
    approval_commit.add_argument("--input", required=True)
    approval_commit.add_argument("--owner-confirmed", action="store_true")
    job_trash = commands.add_parser("job-trash")
    job_trash.add_argument("--id", required=True)
    job_trash.add_argument("--expected-revision", required=True, type=int)
    job_restore = commands.add_parser("job-restore")
    job_restore.add_argument("--id", required=True)
    job_restore.add_argument("--expected-revision", required=True, type=int)
    job_delete = commands.add_parser("job-delete")
    job_delete.add_argument("--id", required=True)
    job_delete.add_argument("--expected-revision", required=True, type=int)

    resume_create = commands.add_parser("resume-create")
    resume_create.add_argument("--input", required=True)
    resume_import = commands.add_parser("resume-import")
    resume_import.add_argument("--input", required=True)
    resume_get = commands.add_parser("resume-get")
    resume_get.add_argument("--id", required=True)
    resume_get.add_argument("--include-trashed", action="store_true")
    resume_resolve = commands.add_parser("resume-resolve")
    resume_resolve.add_argument("--id")
    resume_list = commands.add_parser("resume-list")
    resume_list.add_argument("--include-trashed", action="store_true")
    resume_list.add_argument("--trashed-only", action="store_true")
    resume_update = commands.add_parser("resume-update")
    resume_update.add_argument("--id", required=True)
    resume_update.add_argument("--input", required=True)
    resume_update.add_argument("--expected-revision", required=True, type=int)
    resume_adopt = commands.add_parser("resume-adopt")
    resume_adopt.add_argument("--id", required=True)
    resume_adopt.add_argument("--expected-revision", required=True, type=int)
    resume_adopt.add_argument("--path")
    resume_default = commands.add_parser("resume-set-default")
    resume_default.add_argument("--id", required=True)
    resume_default.add_argument("--expected-revision", required=True, type=int)
    resume_check = commands.add_parser("resume-check")
    resume_check.add_argument("--id", required=True)
    resume_trash = commands.add_parser("resume-trash")
    resume_trash.add_argument("--id", required=True)
    resume_trash.add_argument("--expected-revision", required=True, type=int)
    resume_restore = commands.add_parser("resume-restore")
    resume_restore.add_argument("--id", required=True)
    resume_restore.add_argument("--expected-revision", required=True, type=int)
    resume_delete = commands.add_parser("resume-delete")
    resume_delete.add_argument("--id", required=True)
    resume_delete.add_argument("--expected-revision", required=True, type=int)
    request_create = commands.add_parser("resume-extraction-request-create")
    request_create.add_argument("--resume-id", required=True)
    request_create.add_argument("--expected-resume-revision", required=True, type=int)
    request_get = commands.add_parser("resume-extraction-request-get")
    request_get.add_argument("--id", required=True)
    request_list = commands.add_parser("resume-extraction-request-list")
    request_list.add_argument("--resume-id")
    request_list.add_argument("--status", choices=sorted(EXTRACTION_REQUEST_STATUSES))
    request_cancel = commands.add_parser("resume-extraction-request-cancel")
    request_cancel.add_argument("--id", required=True)
    request_cancel.add_argument("--expected-revision", required=True, type=int)
    request_fail = commands.add_parser("resume-extraction-request-fail")
    request_fail.add_argument("--id", required=True)
    request_fail.add_argument(
        "--reason", required=True, choices=sorted(EXTRACTION_REQUEST_FAILURE_REASONS)
    )
    request_fail.add_argument("--expected-revision", required=True, type=int)
    request_retry = commands.add_parser("resume-extraction-request-retry")
    request_retry.add_argument("--id", required=True)
    request_retry.add_argument("--expected-revision", required=True, type=int)
    request_retry.add_argument("--expected-resume-revision", required=True, type=int)
    request_complete = commands.add_parser("resume-extraction-request-complete")
    request_complete.add_argument("--id", required=True)
    request_complete.add_argument("--input", required=True)
    request_complete.add_argument("--expected-request-revision", required=True, type=int)
    request_complete.add_argument("--expected-profile-revision", required=True, type=int)
    request_complete.add_argument("--expected-pending-proposal-id")
    commands.add_parser("profile-preparedness-get")
    proposal_create = commands.add_parser("resume-proposal-create")
    proposal_create.add_argument("--resume-id", required=True)
    proposal_create.add_argument("--expected-resume-revision", required=True, type=int)
    proposal_create.add_argument("--expected-profile-revision", required=True, type=int)
    proposal_create.add_argument("--supersedes")
    proposal_create.add_argument("--input", required=True)
    proposal_get = commands.add_parser("resume-proposal-get")
    proposal_get.add_argument("--id", required=True)
    proposal_list = commands.add_parser("resume-proposal-list")
    proposal_list.add_argument("--resume-id")
    proposal_list.add_argument("--status")
    proposal_list.add_argument("--summary-only", action="store_true")
    proposal_review = commands.add_parser("resume-proposal-review")
    proposal_review.add_argument("--id", required=True)
    proposal_review.add_argument("--expected-revision", required=True, type=int)
    proposal_review.add_argument("--expected-profile-revision", required=True, type=int)
    proposal_review.add_argument("--input", required=True)

    history_append = commands.add_parser("history-append")
    history_append.add_argument("--input", required=True)
    commands.add_parser("history-list")

    replay_transition = commands.add_parser("replay-transition")
    replay_transition.add_argument("--id", required=True)
    replay_transition.add_argument("--transition", required=True)
    replay_transition.add_argument("--ats", required=True)

    session_save = commands.add_parser("session-save")
    session_save.add_argument("--id", required=True)
    session_save.add_argument("--input", required=True)
    session_load = commands.add_parser("session-load")
    session_load.add_argument("--id", required=True)
    commands.add_parser("session-list")
    session_delete = commands.add_parser("session-delete")
    session_delete.add_argument("--id", required=True)
    commands.add_parser("automation-settings-get")
    automation_update = commands.add_parser("automation-settings-update")
    automation_update.add_argument("--input", required=True)
    automation_update.add_argument("--expected-revision", required=True, type=int)
    automation_copy_email = commands.add_parser("automation-settings-copy-profile-email")
    automation_copy_email.add_argument("--expected-profile-revision", required=True, type=int)
    automation_copy_email.add_argument("--expected-settings-revision", required=True, type=int)
    automation_capability = commands.add_parser("automation-capability")
    automation_capability.add_argument("--platform", choices=["darwin", "linux", "win32"])
    realm_resolve = commands.add_parser("account-realm-resolve")
    realm_resolve.add_argument("--url", required=True)
    commands.add_parser("employer-account-list")
    account_get = commands.add_parser("employer-account-get")
    account_get.add_argument("--realm-ref", required=True)
    account_create = commands.add_parser("employer-account-create")
    account_create.add_argument("--url", required=True)
    account_create.add_argument("--input")
    account_update = commands.add_parser("employer-account-update")
    account_update.add_argument("--realm-ref", required=True)
    account_update.add_argument("--input", required=True)
    account_update.add_argument("--expected-revision", required=True, type=int)
    account_execute = commands.add_parser("employer-account-execute-synthetic")
    account_execute.add_argument("--input", required=True)
    commands.add_parser("employer-account-operation-status")
    commands.add_parser("employer-account-operation-recover")
    trusted_approve = commands.add_parser("trusted-fill-approve")
    trusted_approve.add_argument("--input", required=True)
    trusted_status = commands.add_parser("trusted-fill-status")
    trusted_status.add_argument("--id", required=True)
    trusted_evaluate = commands.add_parser("trusted-fill-evaluate")
    trusted_evaluate.add_argument("--input", required=True)
    trusted_revoke = commands.add_parser("trusted-fill-revoke")
    trusted_revoke.add_argument("--id", required=True)
    trusted_revoke.add_argument("--expected-approval-revision", required=True, type=int)
    return parser


def resolve_store(args: argparse.Namespace) -> Store:
    configured = args.root or os.environ.get(STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    legacy = Path(args.legacy_profile).expanduser() if args.legacy_profile else None
    return Store(root, legacy)


def run(args: argparse.Namespace) -> Any:
    store = resolve_store(args)
    command = args.command
    if command == "init":
        return store.initialize()
    if command == "paths":
        return store.paths()
    if command == "profile-get":
        return store.get_profile()
    if command == "profile-inspect":
        return store.inspect_profile()
    if command == "profile-replace":
        return store.replace_profile(
            _read_input(args.input), args.expected_revision, args.source
        )
    if command == "profile-patch":
        return store.patch_profile(
            _read_input(args.input), args.expected_revision, args.source
        )
    if command == "fact-group-list":
        return store.list_fact_groups()
    if command == "fact-group-get":
        return store.get_fact_group(args.id)
    if command == "fact-group-create":
        return store.create_fact_group(_read_input(args.input))
    if command == "fact-group-update":
        return store.update_fact_group(
            args.id, _read_input(args.input), args.expected_revision
        )
    if command == "fact-group-delete":
        return store.delete_fact_group(args.id, args.expected_revision)
    if command == "preferences-get":
        return store.get_preferences()
    if command == "preferences-set":
        return store.set_preferences(
            _read_input(args.input), args.expected_revision, args.source, args.replace
        )
    if command == "answer-key":
        return {"key": answer_key(args.question, _scope(args.scope))}
    if command == "answer-put":
        return store.put_answer(
            _read_input(args.input),
            remember_sensitive=args.remember_sensitive,
            expected_revision=args.expected_revision,
        )
    if command == "answer-get":
        return store.get_answer(args.key, include_trashed=args.include_trashed)
    if command == "answer-find":
        return store.find_answer(args.question, _scope(args.scope))
    if command == "answer-list":
        return store.query_answers(
            query=args.query,
            state=args.state,
            review_status=None if args.all_review_statuses else args.review_status,
            include_trashed=args.include_trashed,
            trashed_only=args.trashed_only,
            offset=args.offset,
            limit=args.limit,
        )
    if command == "answer-reveal":
        return store.reveal_answer(args.key)
    if command == "answer-observe":
        return store.observe_answer(_read_input(args.input))
    if command == "answer-review":
        return store.review_answer(
            args.key,
            args.decision,
            args.expected_revision,
            _read_input(args.input) if args.input else None,
            remember_sensitive=args.remember_sensitive,
        )
    if command == "answer-update":
        return store.update_answer(
            args.key,
            _read_input(args.input),
            args.expected_revision,
            remember_sensitive=args.remember_sensitive,
        )
    if command == "answer-trash":
        return store.trash_answer(args.key, args.expected_revision)
    if command == "answer-restore":
        return store.restore_answer(args.key, args.expected_revision)
    if command == "answer-delete":
        return store.delete_answer(args.key, args.expected_revision)
    if command == "answer-merge":
        return store.merge_answers(
            args.winner_key,
            args.source_key,
            args.expected_winner_revision,
            args.expected_source_revision,
        )
    if command == "answer-semantic-lookup":
        return store.semantic_answer_lookup(_read_input(args.input))
    if command == "answer-cleanup-preview":
        return store.preview_answer_cleanup()
    if command == "answer-cleanup-approve":
        return store.approve_answer_cleanup(
            _read_input(args.input), owner_confirmed=args.owner_confirmed
        )
    if command == "job-create":
        return store.create_job(_read_input(args.input), origin=args.origin)
    if command == "job-upsert-preview":
        return store.preview_job_upsert(_read_input(args.input), args.origin)
    if command == "job-upsert-commit":
        return store.commit_job_upsert(
            _read_input(args.input), args.origin, args.token
        )
    if command == "legacy-jobs-preview":
        return store.preview_legacy_jobs(args.select)
    if command == "legacy-jobs-commit":
        return store.commit_legacy_jobs(args.select, args.confirm)
    if command == "job-get":
        return store.get_job(args.id, include_trashed=args.include_trashed)
    if command == "job-list":
        return store.list_jobs(
            args.status,
            include_trashed=args.include_trashed,
            trashed_only=args.trashed_only,
        )
    if command == "job-preflight":
        return store.preflight_job(args.id)
    if command == "job-update":
        return store.update_job(
            args.id,
            _read_input(args.input),
            args.expected_revision,
            origin=args.origin,
        )
    if command == "job-transition":
        return store.transition_job(
            args.id,
            args.status,
            args.expected_revision,
            closed_outcome=args.closed_outcome,
            user_confirmed=args.user_confirmed,
        )
    if command == "job-acquire":
        return store.acquire_ready_job(args.id, args.owner, args.expected_revision)
    if command == "job-review-restart":
        return store.restart_reviewed_job(
            args.id,
            args.owner,
            args.expected_revision,
            owner_confirmed_not_submitted=args.owner_confirmed_not_submitted,
        )
    if command == "claim-status":
        return store.claim_status()
    if command == "claim-heartbeat":
        return store.heartbeat_claim(args.id, args.token)
    if command == "claim-recover":
        return store.recover_claim(args.id, args.owner)
    if command == "claim-progress":
        return store.save_claim_progress(args.id, args.token, _read_input(args.input))
    if command == "claim-handoff":
        return store.handoff_claimed_job(
            args.id,
            args.token,
            args.status,
            _read_input(args.input),
            args.expected_revision,
        )
    if command == "attention-approval-preview":
        payload = _read_input(args.input)
        if set(payload) != {"decisions"}:
            raise StoreError("grouped approval input must contain decisions")
        return store.preview_grouped_approval(
            args.id, args.expected_job_revision, args.expected_session_revision,
            payload["decisions"],
        )
    if command == "attention-approval-approve":
        payload = _read_input(args.input)
        if set(payload) != {"decisions"}:
            raise StoreError("grouped approval input must contain decisions")
        return store.approve_grouped_approval(
            args.id, args.expected_job_revision, args.expected_session_revision,
            payload["decisions"], args.preview_token,
            owner_confirmed=args.owner_confirmed,
        )
    if command == "job-trash":
        return store.trash_job(args.id, args.expected_revision)
    if command == "job-restore":
        return store.restore_job(args.id, args.expected_revision)
    if command == "job-delete":
        return store.delete_job(args.id, args.expected_revision)
    if command == "resume-create":
        return store.create_resume(_read_input(args.input))
    if command == "resume-import":
        return store.import_resume(_read_input(args.input))
    if command == "resume-get":
        return store.get_resume(args.id, include_trashed=args.include_trashed)
    if command == "resume-resolve":
        return store.resolve_resume(args.id)
    if command == "resume-list":
        return store.list_resumes(
            include_trashed=args.include_trashed,
            trashed_only=args.trashed_only,
        )
    if command == "resume-update":
        return store.update_resume(
            args.id, _read_input(args.input), args.expected_revision
        )
    if command == "resume-adopt":
        return store.adopt_resume(args.id, args.path, args.expected_revision)
    if command == "resume-set-default":
        return store.set_default_resume(args.id, args.expected_revision)
    if command == "resume-check":
        return store.check_resume(args.id)
    if command == "resume-trash":
        return store.trash_resume(args.id, args.expected_revision)
    if command == "resume-restore":
        return store.restore_resume(args.id, args.expected_revision)
    if command == "resume-delete":
        return store.delete_resume(args.id, args.expected_revision)
    if command == "resume-extraction-request-create":
        return store.create_resume_extraction_request(
            args.resume_id, args.expected_resume_revision
        )
    if command == "resume-extraction-request-get":
        return store.get_resume_extraction_request(args.id)
    if command == "resume-extraction-request-list":
        return store.list_resume_extraction_requests(args.resume_id, args.status)
    if command == "resume-extraction-request-cancel":
        return store.cancel_resume_extraction_request(args.id, args.expected_revision)
    if command == "resume-extraction-request-fail":
        return store.fail_resume_extraction_request(
            args.id, args.reason, args.expected_revision
        )
    if command == "resume-extraction-request-retry":
        return store.retry_resume_extraction_request(
            args.id, args.expected_revision, args.expected_resume_revision
        )
    if command == "resume-extraction-request-complete":
        return store.complete_resume_extraction_request(
            args.id, _read_input(args.input), args.expected_request_revision,
            args.expected_profile_revision, args.expected_pending_proposal_id,
        )
    if command == "profile-preparedness-get":
        return store.profile_preparedness()
    if command == "resume-proposal-create":
        return store.create_resume_proposal(
            args.resume_id,
            _read_input(args.input),
            args.expected_resume_revision,
            args.expected_profile_revision,
            args.supersedes,
        )
    if command == "resume-proposal-get":
        return store.get_resume_proposal(args.id)
    if command == "resume-proposal-list":
        return store.list_resume_proposals(
            args.resume_id, args.status, summary_only=args.summary_only
        )
    if command == "resume-proposal-review":
        return store.review_resume_proposal(
            args.id,
            _read_input(args.input),
            args.expected_revision,
            args.expected_profile_revision,
        )
    if command == "history-append":
        return store.append_history(_read_input(args.input))
    if command == "history-list":
        store.initialize()
        return store.read_history()
    if command == "replay-transition":
        return store.record_replay_transition(
            args.id, args.transition, args.ats
        )
    if command == "session-save":
        return store.save_session(args.id, _read_input(args.input))
    if command == "session-load":
        return store.load_session(args.id)
    if command == "session-list":
        return store.list_sessions()
    if command == "session-delete":
        return store.delete_session(args.id)
    if command == "automation-settings-get":
        return store.get_automation_settings(public=True)
    if command == "automation-settings-update":
        return store.update_automation_settings(
            _read_input(args.input), args.expected_revision, public=True
        )
    if command == "automation-settings-copy-profile-email":
        return store.copy_profile_email_to_automation_settings(
            args.expected_profile_revision, args.expected_settings_revision,
        )
    if command == "automation-capability":
        return store.automation_capability(args.platform)
    if command == "account-realm-resolve":
        return store.resolve_account_realm(args.url)
    if command == "employer-account-list":
        return store.list_employer_accounts(public=True)
    if command == "employer-account-get":
        return store.get_employer_account(args.realm_ref, public=True)
    if command == "employer-account-create":
        metadata = _read_input(args.input) if args.input else {}
        if set(metadata) - {"signupEmailOverride"}:
            raise StoreError("employer account input contains unsupported fields")
        return store.create_employer_account(
            args.url, metadata.get("signupEmailOverride"), public=True
        )
    if command == "employer-account-update":
        return store.update_employer_account(
            args.realm_ref, _read_input(args.input), args.expected_revision, public=True
        )
    if command == "employer-account-execute-synthetic":
        return store.execute_synthetic_account(_read_input(args.input))
    if command == "employer-account-operation-status":
        return store.account_operation_status()
    if command == "employer-account-operation-recover":
        return store.recover_account_operation()
    if command == "trusted-fill-approve":
        return store.approve_trusted_fill(_read_input(args.input))
    if command == "trusted-fill-status":
        return store.trusted_fill_status(args.id)
    if command == "trusted-fill-evaluate":
        return store.evaluate_trusted_fill(_read_input(args.input))
    if command == "trusted-fill-revoke":
        return store.revoke_trusted_fill(args.id, args.expected_approval_revision)
    raise StoreError("unsupported command")


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
