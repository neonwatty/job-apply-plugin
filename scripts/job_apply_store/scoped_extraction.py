"""Validate native scoped requests through the frozen legacy Store validator."""

from __future__ import annotations

from typing import Any, Callable

from .errors import StoreError


_LEGACY_FIELDS = {
    "requestId", "resumeId", "resumeContentRevision", "revision", "status",
    "createdAt", "updatedAt", "closedAt", "proposalId", "failureReason",
    "supersedesRequestId",
}


def _legacy_projection(key: str, value: Any) -> Any:
    if not isinstance(value, dict) or value.get("scope") is None:
        return value
    if set(value) != _LEGACY_FIELDS | {"scope", "factRevision"}:
        raise StoreError("resume extraction request is invalid")
    if value["scope"] != "resume":
        raise StoreError("resume extraction request scope is invalid")
    completed = value.get("status") == "completed"
    fact_revision = value["factRevision"]
    valid_revision = (
        isinstance(fact_revision, int) and not isinstance(fact_revision, bool)
        and fact_revision >= 1
    ) if completed else fact_revision is None
    if not valid_revision:
        raise StoreError("resume extraction request fact revision is invalid")
    if completed and value["proposalId"] is not None:
        raise StoreError("resume extraction request proposal is invalid")
    projected = {field: value[field] for field in _LEGACY_FIELDS}
    if completed:
        # A scoped completion has a fact revision in place of a proposal ID.
        projected["proposalId"] = key
    return projected


def validate_request(
    key: str, value: Any, legacy_validator: Callable[[str, Any], Any]
) -> Any:
    legacy_validator(key, _legacy_projection(key, value))
    return value


def validate_document(
    document: dict[str, Any], legacy_validator: Callable[[dict[str, Any]], Any]
) -> dict[str, Any]:
    requests = document.get("requests")
    if not isinstance(requests, dict):
        legacy_validator(document)
        return document
    # The projection is temporary; neither the caller's document nor Store bytes change.
    projected = dict(document)
    projected["requests"] = {
        key: _legacy_projection(key, value) for key, value in requests.items()
    }
    legacy_validator(projected)
    return document
