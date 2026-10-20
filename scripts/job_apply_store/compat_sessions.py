"""Late-bound facade compatibility adapters for sessions."""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from .compat_runtime import runtime as _runtime
from .constants import _ATS_UNSET


def _json_pointer_segment(value: str) -> str:
    return _runtime()['_normalization']._json_pointer_segment(value)


def _canonical_json(value: Any) -> str:
    return _runtime()['_normalization']._canonical_json(value)


def _scope_fingerprint(value: dict[str, Any]) -> str:
    return _runtime()['_normalization']._scope_fingerprint(value)


def _question_fingerprint(value: str) -> str:
    return _runtime()['_normalization']._question_fingerprint(value)


def _legacy_pending_reference(application_id: str, field: dict[str, Any]) -> str:
    """Project a stable opaque identity without persisting or returning legacy text."""

    digest = _runtime()['hashlib'].sha256(
        _runtime()['_canonical_json']({"applicationId": application_id, "pendingField": field}).encode(
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
        _runtime()['_validate_session_document'](session)
        return session
    if not any(
        isinstance(value, dict) and "reference" not in value
        for value in pending_fields
    ):
        _runtime()['_validate_session_document'](session)
        return session

    application_id = _runtime()['_safe_session_id'](session.get("applicationId", ""))
    if any(
        isinstance(value, dict) and "reference" in value
        for value in pending_fields
    ):
        raise _runtime()['StoreError']("legacy and modern pending fields cannot be mixed")
    _runtime()['_validate_optional_strings'](session, {"company", "role", "url"}, "session")
    canonical_ats_supplied = expected_ats is not _runtime()['_ATS_UNSET']
    ats = expected_ats if canonical_ats_supplied else session.get("ats")
    legacy_scope_fingerprint = (
        _runtime()['_scope_fingerprint']({"ats": ats})
        if isinstance(ats, str) and ats
        else None
    )
    projected = _runtime()['copy'].deepcopy(session)
    if canonical_ats_supplied:
        projected["ats"] = _runtime()['copy'].deepcopy(expected_ats)
    for legacy_job_field in ("company", "role", "url"):
        projected.pop(legacy_job_field, None)
    projected_fields: list[dict[str, _runtime()['Any']]] = []
    references: set[str] = set()
    for value in pending_fields:
        field = _runtime()['_require_object'](value, "pending field")
        if not set(field).issubset(_runtime()['LEGACY_PENDING_FIELD_KEYS']):
            raise _runtime()['StoreError']("pending field reference is invalid")
        _runtime()['_validate_optional_strings'](
            field, {"question", "state", "answerKey"}, "pending field"
        )
        if "state" in field and field["state"] not in _runtime()['ANSWER_STATES']:
            raise _runtime()['StoreError']("pending field state is unsupported")
        if "sensitive" in field and not isinstance(field["sensitive"], bool):
            raise _runtime()['StoreError']("pending field sensitive must be a boolean")
        candidate = _runtime()['copy'].deepcopy(field)
        question = candidate.pop("question", None)
        if isinstance(question, str) and question.strip():
            candidate["questionFingerprint"] = _runtime()['_question_fingerprint'](question)
        if legacy_scope_fingerprint is not None:
            candidate["scopeFingerprint"] = legacy_scope_fingerprint
        candidate["reference"] = _runtime()['_legacy_pending_reference'](application_id, field)
        reference = candidate.get("reference")
        if reference in references:
            raise _runtime()['StoreError']("pending field references must be unique")
        references.add(reference)
        projected_fields.append(candidate)
    projected["pendingFields"] = projected_fields
    _runtime()['_validate_session_document'](projected)
    return projected


def _pending_reference_identity(field: dict[str, Any]) -> str:
    """Match durable field meaning while excluding refreshed match evidence."""

    return _runtime()['_canonical_json'](
        {
            key: _runtime()['copy'].deepcopy(value)
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
    return _runtime()['_normalization']._top_level_pointer_key(pointer)


def _meaningfully_present(value: Any) -> bool:
    """Return whether a profile value carries non-blank user information."""
    if value is None:
        return False
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return any(_runtime()['_meaningfully_present'](item) for item in value)
    if isinstance(value, dict):
        return any(_runtime()['_meaningfully_present'](item) for item in value.values())
    return True


__all__ = [
    '_json_pointer_segment',
    '_canonical_json',
    '_scope_fingerprint',
    '_question_fingerprint',
    '_legacy_pending_reference',
    '_project_legacy_session',
    '_pending_reference_identity',
    '_top_level_pointer_key',
    '_meaningfully_present',
]
