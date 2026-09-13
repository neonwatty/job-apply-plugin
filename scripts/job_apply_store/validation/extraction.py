"""Pure resume-extraction proposal and request validation."""

from __future__ import annotations

import json
import re
from typing import Any

from ..constants import (
    EXTRACTION_DECISIONS,
    EXTRACTION_MAX_BYTES,
    EXTRACTION_MAX_DEPTH,
    EXTRACTION_MAX_LEAVES,
    EXTRACTION_MAX_STRING,
    EXTRACTION_REQUEST_FAILURE_REASONS,
    EXTRACTION_REQUEST_STATUSES,
    EXTRACTION_STATUSES,
)
from ..errors import StoreError
from ..io import require_object, validate_version
from ..normalization import (
    _decode_json_pointer,
    _json_pointer_segment,
    _safe_session_id,
)


def _candidate_leaf_paths(
    value: Any, prefix: str = "", depth: int = 0,
) -> list[str]:
    if depth > EXTRACTION_MAX_DEPTH:
        raise StoreError("proposal candidate exceeds structural limits")
    if isinstance(value, str) and len(value.encode("utf-8")) > EXTRACTION_MAX_STRING:
        raise StoreError("proposal candidate exceeds structural limits")
    if value is None:
        raise StoreError("proposal candidate values must not be null")
    if isinstance(value, dict) and value:
        paths: list[str] = []
        for key, child in value.items():
            if not isinstance(key, str) or not key:
                raise StoreError("proposal candidate keys must be non-empty strings")
            paths.extend(
                _candidate_leaf_paths(
                    child, f"{prefix}/{_json_pointer_segment(key)}", depth + 1
                )
            )
        return paths
    return [prefix]


def _validated_candidate(value: Any) -> tuple[dict[str, Any], list[str]]:
    candidate = require_object(value, "proposal candidate")
    if not candidate:
        raise StoreError("proposal candidate must not be empty")
    try:
        encoded = json.dumps(
            candidate,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError):
        raise StoreError("proposal candidate must contain JSON values") from None
    if len(encoded) > EXTRACTION_MAX_BYTES:
        raise StoreError("proposal candidate exceeds structural limits")
    paths = _candidate_leaf_paths(candidate)
    if len(paths) > EXTRACTION_MAX_LEAVES:
        raise StoreError("proposal candidate exceeds structural limits")
    return candidate, sorted(paths)


def _validate_extraction_proposal(
    key: str, value: Any, *, trusted_fill_module: Any,
) -> dict[str, Any]:
    record = require_object(value, "resume proposal")
    allowed = {
        "id",
        "resumeId",
        "resumeRevision",
        "resumeDigest",
        "resumeContentRevision",
        "profileRevision",
        "resultProfileRevision",
        "candidate",
        "baselines",
        "autoFilledPaths",
        "pendingPaths",
        "decisions",
        "status",
        "revision",
        "createdAt",
        "updatedAt",
        "supersededBy",
    }
    if set(record) - allowed or record.get("id") != key:
        raise StoreError("resume proposal record is invalid")
    _safe_session_id(key)
    _safe_session_id(record.get("resumeId", ""))
    for field in ("resumeRevision", "profileRevision", "resultProfileRevision", "revision"):
        number = record.get(field)
        if not isinstance(number, int) or isinstance(number, bool) or number < 1:
            raise StoreError("resume proposal revision is invalid")
    digest = record.get("resumeDigest")
    if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
        raise StoreError("resume proposal binding is invalid")
    content_revision = record.get("resumeContentRevision")
    if content_revision is not None:
        try:
            trusted_fill_module.validate_content_revision(content_revision)
        except trusted_fill_module.TrustedFillError as error:
            raise StoreError(str(error)) from None
    candidate, candidate_paths = _validated_candidate(record.get("candidate"))
    baselines = require_object(record.get("baselines"), "resume proposal baselines")
    auto_paths = record.get("autoFilledPaths")
    pending_paths = record.get("pendingPaths")
    if not isinstance(auto_paths, list) or not isinstance(pending_paths, list):
        raise StoreError("resume proposal paths are invalid")
    if (
        not all(isinstance(path, str) for path in auto_paths + pending_paths)
        or len(set(auto_paths + pending_paths)) != len(auto_paths + pending_paths)
        or not set(auto_paths + pending_paths) <= set(candidate_paths)
        or set(baselines) != set(candidate_paths)
    ):
        raise StoreError("resume proposal paths are invalid")
    for path, baseline in baselines.items():
        segments = _decode_json_pointer(path)
        item = require_object(baseline, "resume proposal baseline")
        allowed_baseline = {"exists", "ancestors", "value"}
        if set(item) - allowed_baseline or not isinstance(
            item.get("exists"), bool
        ) or not isinstance(item.get("ancestors"), list):
            raise StoreError("resume proposal baseline is invalid")
        if item["exists"] != ("value" in item):
            raise StoreError("resume proposal baseline is invalid")
        if len(item["ancestors"]) != len(segments) - 1:
            raise StoreError("resume proposal baseline is invalid")
        expected_ancestor = ""
        for index, ancestor in enumerate(item["ancestors"]):
            expected_ancestor += f"/{_json_pointer_segment(segments[index])}"
            ancestor_item = require_object(
                ancestor, "resume proposal ancestor baseline"
            )
            if (
                set(ancestor_item) - {"path", "exists", "container", "empty", "value"}
                or ancestor_item.get("path") != expected_ancestor
                or not isinstance(ancestor_item.get("exists"), bool)
            ):
                raise StoreError("resume proposal baseline is invalid")
            payload_fields = {
                field for field in ("container", "value") if field in ancestor_item
            }
            if not ancestor_item["exists"] and payload_fields:
                raise StoreError("resume proposal baseline is invalid")
            if ancestor_item["exists"] and payload_fields not in (
                {"container"},
                {"value"},
            ):
                raise StoreError("resume proposal baseline is invalid")
            if "container" in ancestor_item and ancestor_item["container"] is not True:
                raise StoreError("resume proposal baseline is invalid")
            if "container" in ancestor_item:
                if not isinstance(ancestor_item.get("empty"), bool):
                    raise StoreError("resume proposal baseline is invalid")
            elif "empty" in ancestor_item:
                raise StoreError("resume proposal baseline is invalid")
    decisions = require_object(record.get("decisions"), "resume proposal decisions")
    for path, decision in decisions.items():
        _decode_json_pointer(path)
        item = require_object(decision, "resume proposal decision")
        if (
            set(item) != {"decision", "decidedAt"}
            or item.get("decision") not in EXTRACTION_DECISIONS
        ):
            raise StoreError("resume proposal decision is invalid")
        if not isinstance(item.get("decidedAt"), str) or not item["decidedAt"]:
            raise StoreError("resume proposal decision is invalid")
    if (
        set(decisions) & set(pending_paths)
        or set(decisions) | set(pending_paths)
        != set(candidate_paths) - set(auto_paths)
    ):
        raise StoreError("resume proposal decision paths are invalid")
    status = record.get("status")
    if status not in EXTRACTION_STATUSES:
        raise StoreError("resume proposal status is invalid")
    if status == "pending" and not pending_paths:
        raise StoreError("pending resume proposal has no pending paths")
    if status == "completed" and pending_paths:
        raise StoreError("completed resume proposal has pending paths")
    superseded_by = record.get("supersededBy")
    if status == "superseded":
        _safe_session_id(superseded_by or "")
    elif superseded_by is not None:
        raise StoreError("resume proposal supersession is invalid")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(record.get(field), str) or not record[field]:
            raise StoreError("resume proposal timestamp is invalid")
    return record


def _validate_extractions_document(
    document: dict[str, Any], *, trusted_fill_module: Any,
) -> dict[str, Any]:
    validate_version(document, "resume proposals")
    if set(document) != {"schemaVersion", "proposals", "metadata"}:
        raise StoreError("resume proposal store contains unsupported fields")
    proposals = require_object(document.get("proposals"), "resume proposals")
    require_object(document.get("metadata"), "resume proposal metadata")
    for key, record in proposals.items():
        if not isinstance(key, str):
            raise StoreError("resume proposal index is invalid")
        _validate_extraction_proposal(
            key, record, trusted_fill_module=trusted_fill_module
        )
    pending_by_resume: set[str] = set()
    for record in proposals.values():
        if record["status"] == "pending":
            if record["resumeId"] in pending_by_resume:
                raise StoreError("resume proposal store has multiple pending proposals")
            pending_by_resume.add(record["resumeId"])
    return document


def _validate_extraction_request(
    key: str, value: Any, *, trusted_fill_module: Any,
) -> dict[str, Any]:
    record = require_object(value, "resume extraction request")
    required = {
        "requestId", "resumeId", "resumeContentRevision", "revision",
        "status", "createdAt", "updatedAt", "closedAt", "proposalId",
        "failureReason", "supersedesRequestId",
    }
    if set(record) != required or record.get("requestId") != key:
        raise StoreError("resume extraction request is invalid")
    _safe_session_id(key)
    _safe_session_id(record.get("resumeId", ""))
    try:
        trusted_fill_module.validate_content_revision(
            record.get("resumeContentRevision")
        )
    except trusted_fill_module.TrustedFillError as error:
        raise StoreError(str(error)) from None
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("resume extraction request revision is invalid")
    status = record.get("status")
    if status not in EXTRACTION_REQUEST_STATUSES:
        raise StoreError("resume extraction request status is invalid")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(record.get(field), str) or not record[field]:
            raise StoreError("resume extraction request timestamp is invalid")
    terminal = status != "requested"
    closed_at = record.get("closedAt")
    if terminal != (isinstance(closed_at, str) and bool(closed_at)):
        raise StoreError("resume extraction request closure is invalid")
    proposal_id = record.get("proposalId")
    if status == "completed":
        _safe_session_id(proposal_id or "")
    elif proposal_id is not None:
        raise StoreError("resume extraction request proposal is invalid")
    failure = record.get("failureReason")
    if status == "failed":
        if failure not in EXTRACTION_REQUEST_FAILURE_REASONS:
            raise StoreError("resume extraction failure reason is invalid")
    elif failure is not None:
        raise StoreError("resume extraction failure reason is invalid")
    supersedes = record.get("supersedesRequestId")
    if supersedes is not None:
        _safe_session_id(supersedes)
        if supersedes == key:
            raise StoreError("resume extraction supersession is invalid")
    return record


def _validate_extraction_requests_document(
    document: dict[str, Any], *, trusted_fill_module: Any,
) -> dict[str, Any]:
    validate_version(document, "resume extraction requests")
    if set(document) != {"schemaVersion", "requests", "metadata"}:
        raise StoreError("resume extraction request store contains unsupported fields")
    requests = require_object(document.get("requests"), "resume extraction requests")
    metadata = require_object(document.get("metadata"), "request metadata")
    if set(metadata) != {"createdAt", "updatedAt"}:
        raise StoreError("resume extraction request metadata is invalid")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(metadata.get(field), str) or not metadata[field]:
            raise StoreError("resume extraction request metadata is invalid")
    open_by_resume: set[str] = set()
    for key, record in requests.items():
        if not isinstance(key, str):
            raise StoreError("resume extraction request index is invalid")
        item = _validate_extraction_request(
            key, record, trusted_fill_module=trusted_fill_module
        )
        if item["status"] == "requested":
            if item["resumeId"] in open_by_resume:
                raise StoreError(
                    "resume extraction request store has multiple open requests"
                )
            open_by_resume.add(item["resumeId"])
    return document


def _extraction_request_lineage_depth(
    record: dict[str, Any], records_by_id: dict[str, dict[str, Any]],
) -> int:
    """Return a bounded causal rank for deterministic retry ordering."""
    depth = 0
    seen = {record["requestId"]}
    current = record
    while current.get("supersedesRequestId") is not None:
        predecessor_id = current["supersedesRequestId"]
        if predecessor_id in seen:
            break
        predecessor = records_by_id.get(predecessor_id)
        if predecessor is None or predecessor.get("resumeId") != record["resumeId"]:
            break
        seen.add(predecessor_id)
        depth += 1
        current = predecessor
    return depth


def order_extraction_requests(
    records: list[dict[str, Any]], timestamp_field: str = "createdAt",
) -> list[dict[str, Any]]:
    """Order requests by time, retry causality, then opaque identity."""
    records_by_id = {item["requestId"]: item for item in records}
    return sorted(
        records,
        key=lambda item: (
            item[timestamp_field],
            _extraction_request_lineage_depth(item, records_by_id),
            item["requestId"],
        ),
    )
