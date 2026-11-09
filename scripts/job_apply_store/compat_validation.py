"""Late-bound facade compatibility adapters for validation."""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from .compat_runtime import runtime as _runtime


def _json_pointer_value(document: Any, pointer: str) -> Any:
    return _runtime()['_normalization']._json_pointer_value(document, pointer)


def _decode_json_pointer(pointer: str) -> list[str]:
    return _runtime()['_normalization']._decode_json_pointer(pointer)


def _pointer_lookup(document: Any, pointer: str) -> tuple[bool, Any]:
    return _runtime()['_normalization']._pointer_lookup(document, pointer)


def _pointer_baseline(document: dict[str, Any], pointer: str) -> dict[str, Any]:
    return _runtime()['_normalization']._pointer_baseline(document, pointer)


def _json_values_equal(left: Any, right: Any) -> bool:
    """Compare JSON values without Python's boolean/number equivalence."""

    return _runtime()['_normalization']._json_values_equal(left, right)


def _replacement_scope(baseline: dict[str, Any]) -> dict[str, Any] | None:
    """Return the existing non-object ancestor a child acceptance would replace."""

    return _runtime()['_normalization']._replacement_scope(baseline)


def _set_pointer_value(
    document: dict[str, Any], pointer: str, value: Any, *, replace_ancestors: bool
) -> None:
    _runtime()['_normalization']._set_pointer_value(
        document, pointer, value, replace_ancestors=replace_ancestors
    )


def _candidate_leaf_paths(value: Any, prefix: str = "", depth: int = 0) -> list[str]:
    return _runtime()['_extraction_validation']._candidate_leaf_paths(value, prefix, depth)


def _validated_candidate(value: Any) -> tuple[dict[str, Any], list[str]]:
    return _runtime()['_extraction_validation']._validated_candidate(value)


def _validate_answer_record(key: str, value: Any) -> dict[str, Any]:
    return _runtime()['_profile_validation']._validate_answer_record(key, value)


def _validate_answer_redirects(
    redirects: Any, answers: dict[str, Any]
) -> dict[str, Any]:
    return _runtime()['_profile_validation']._validate_answer_redirects(redirects, answers)


def _validate_history_event_record(event: dict[str, Any]) -> None:
    """Validate the value-free history schema without assigning event semantics."""

    _runtime()['_session_validation']._validate_history_event_record(event)


def _validate_history_event_for_write(event: dict[str, Any]) -> None:
    """Apply this helper version's strict event-name write policy."""

    _runtime()['_session_validation']._validate_history_event_for_write(event)


def _validate_session_document(session: dict[str, Any]) -> None:
    _runtime()['_session_validation']._validate_session_document(
        session, answer_match_module=_runtime()['ANSWER_MATCH_MODULE']
    )


def _validate_claim_record(value: Any) -> dict[str, Any]:
    return _runtime()['_session_validation']._validate_claim_record(value)


def _parse_coordinator_time(value: str) -> datetime:
    return _runtime()['_session_validation']._parse_coordinator_time(value)


def _validate_job_record(key: str, value: Any) -> dict[str, Any]:
    return _runtime()['_job_resume_validation']._validate_job_record(
        key, value, path_type=_runtime()['Path']
    )


def _validate_resume_record(key: str, value: Any) -> dict[str, Any]:
    return _runtime()['_job_resume_validation']._validate_resume_record(
        key,
        value,
        path_type=_runtime()['Path'], os_module=_runtime()['os'],
        trusted_fill_module=_runtime()['TRUSTED_FILL_MODULE'],
    )


def _validate_extraction_proposal(key: str, value: Any) -> dict[str, Any]:
    return _runtime()['_extraction_validation']._validate_extraction_proposal(
        key, value, trusted_fill_module=_runtime()['TRUSTED_FILL_MODULE']
    )


def _validate_extractions_document(document: dict[str, Any]) -> dict[str, Any]:
    return _runtime()['_extraction_validation']._validate_extractions_document(
        document, trusted_fill_module=_runtime()['TRUSTED_FILL_MODULE']
    )


def _validate_extraction_request(key: str, value: Any) -> dict[str, Any]:
    return _runtime()['_extraction_validation']._validate_extraction_request(
        key, value, trusted_fill_module=_runtime()['TRUSTED_FILL_MODULE']
    )


def _validate_extraction_requests_document(
    document: dict[str, Any],
) -> dict[str, Any]:
    return _runtime()['_extraction_validation']._validate_extraction_requests_document(
        document, trusted_fill_module=_runtime()['TRUSTED_FILL_MODULE']
    )


def _extraction_request_lineage_depth(
    record: dict[str, Any], records_by_id: dict[str, dict[str, Any]],
) -> int:
    """Return a bounded causal rank for deterministic retry ordering."""
    return _runtime()['_extraction_validation']._extraction_request_lineage_depth(
        record, records_by_id
    )


def order_extraction_requests(
    records: list[dict[str, Any]], timestamp_field: str = "createdAt",
) -> list[dict[str, Any]]:
    """Order requests by time, retry causality, then opaque identity."""
    return _runtime()['_extraction_validation'].order_extraction_requests(records, timestamp_field)


__all__ = [
    '_json_pointer_value',
    '_decode_json_pointer',
    '_pointer_lookup',
    '_pointer_baseline',
    '_json_values_equal',
    '_replacement_scope',
    '_set_pointer_value',
    '_candidate_leaf_paths',
    '_validated_candidate',
    '_validate_answer_record',
    '_validate_answer_redirects',
    '_validate_history_event_record',
    '_validate_history_event_for_write',
    '_validate_session_document',
    '_validate_claim_record',
    '_parse_coordinator_time',
    '_validate_job_record',
    '_validate_resume_record',
    '_validate_extraction_proposal',
    '_validate_extractions_document',
    '_validate_extraction_request',
    '_validate_extraction_requests_document',
    '_extraction_request_lineage_depth',
    'order_extraction_requests',
]
