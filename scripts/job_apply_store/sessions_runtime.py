"""Shared session projection primitives and canonical root-local collaborators."""

from __future__ import annotations

import copy
import _imp
import hashlib
import importlib.util
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .constants import ANSWER_STATES, LEGACY_PENDING_FIELD_KEYS, _ATS_UNSET
from .errors import StoreError
from .io import require_object as _require_object
from .normalization import (
    _canonical_json, _scope_fingerprint, _question_fingerprint,
    _safe_session_id, _validate_optional_strings,
)
from .validation import sessions


SCRIPT_PATH = Path(__file__).resolve().parent.parent / "job-apply-store.py"
_COMPANIONS = {}


def companion(name: str):
    """Load canonical local contracts while restoring ambient import state."""
    # Canonical callers from different roots share Python's import registry.
    # Serialize the temporary registry/path substitution across those roots.
    _imp.acquire_lock()
    try:
        return _load_companion(name)
    finally:
        _imp.release_lock()


def _load_companion(name: str):
    if name in _COMPANIONS:
        return _COMPANIONS[name]
    if name not in {"job_apply_answer_match", "job_apply_form_readiness"}:
        raise ValueError("unsupported session companion")
    private_name = f"{__package__}._session_{name}"
    spec = importlib.util.spec_from_file_location(private_name, SCRIPT_PATH.with_name(name + ".py"))
    if spec is None or spec.loader is None:
        raise RuntimeError("session contracts are unavailable")
    module = importlib.util.module_from_spec(spec)
    saved_path = list(sys.path)
    saved = {key: value for key, value in sys.modules.items()
             if key == "qa" or key.startswith("qa.")}
    for key in saved:
        del sys.modules[key]
    sys.path[:0] = [str(SCRIPT_PATH.parent), str(SCRIPT_PATH.parent.parent)]
    sys.modules[private_name] = module
    try:
        spec.loader.exec_module(module)
        _COMPANIONS[name] = module
        return module
    except BaseException:
        sys.modules.pop(private_name, None)
        raise
    finally:
        for key in tuple(sys.modules):
            if key == "qa" or key.startswith("qa."):
                del sys.modules[key]
        sys.modules.update(saved)
        sys.path[:] = saved_path


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _validate_session_document(session: dict[str, Any]) -> None:
    sessions._validate_session_document(
        session, answer_match_module=companion("job_apply_answer_match")
    )


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
