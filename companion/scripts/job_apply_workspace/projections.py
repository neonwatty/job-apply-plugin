"""Browser-safe projections over canonical Store records."""

from __future__ import annotations

from typing import Any

from . import runtime


def public_resume(record: dict[str, Any]) -> dict[str, Any]:
    """Project resume metadata without filesystem or document identity data."""

    hidden = {"path", "managedFile", "originalFilename", "digest", "contentRevision"}
    return {key: value for key, value in record.items() if key not in hidden}


def public_resumes(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [public_resume(record) for record in records]


def public_extraction_request(record: dict[str, Any]) -> dict[str, Any]:
    """Project the closed browser-safe extraction request schema."""

    allowed = (
        "requestId", "resumeId", "revision", "status", "createdAt",
        "updatedAt", "closedAt", "proposalId", "failureReason",
        "supersedesRequestId",
    )
    return {key: record.get(key) for key in allowed}


def resume_projection(
    record: dict[str, Any],
    jobs: list[dict[str, Any]],
    proposals: list[dict[str, Any]],
    requests: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    result = public_resume(record)
    result["assignedJobCount"] = sum(
        item.get("deletedAt") is None and item.get("resumeId") == record["id"]
        for item in jobs
    )
    result["implicitJobCount"] = sum(
        record.get("default")
        and item.get("deletedAt") is None
        and item.get("resumeId") is None
        for item in jobs
    )
    related = [item for item in proposals if item.get("resumeId") == record["id"]]
    result["proposalStatus"] = next(
        ("pending" for item in related if item.get("status") == "pending"),
        "completed" if related else None,
    )
    result["pendingConflictCount"] = sum(
        len(item.get("pendingPaths", []))
        for item in related
        if item.get("status") == "pending"
    )
    related_requests = [
        item for item in (requests or []) if item.get("resumeId") == record["id"]
    ]
    ordered_requests = runtime()["STORE_MODULE"].order_extraction_requests(
        related_requests, timestamp_field="updatedAt"
    )
    latest_request = ordered_requests[-1] if ordered_requests else None
    result["extractionRequest"] = (
        public_extraction_request(latest_request) if latest_request else None
    )
    return result


def unified_trash_projection(store: Any) -> dict[str, Any]:
    """Return one deterministic, redacted view of every recoverable record."""

    jobs = store.list_jobs(include_trashed=True)
    resumes = store.list_resumes(include_trashed=True)
    answers = store.list_answers(include_trashed=True, review_status=None)
    sessions = {item["applicationId"]: item for item in store.list_sessions()}
    claim = store.claim_status()["claim"]
    items: list[dict[str, Any]] = []
    for record in jobs:
        if record.get("deletedAt") is None:
            continue
        session = sessions.get(record["id"])
        items.append({
            "type": "job", "id": record["id"], "revision": record["revision"],
            "deletedAt": record["deletedAt"],
            "label": record.get("role") or record.get("company") or "Untitled job",
            "secondaryLabel": record.get("company") or "",
            "status": record.get("status", "saved"),
            "blockerCounts": {
                "claims": int(claim is not None and claim.get("jobId") == record["id"]),
                "nonterminalSessions": int(
                    session is not None
                    and session.get("status") not in {"completed", "abandoned"}
                ),
            },
        })
    for record in resumes:
        if record.get("deletedAt") is None:
            continue
        items.append({
            "type": "resume", "id": record["id"], "revision": record["revision"],
            "deletedAt": record["deletedAt"],
            "label": record.get("label") or "Untitled resume",
            "blockerCounts": {
                "jobReferences": sum(
                    job.get("resumeId") == record["id"] for job in jobs
                ),
            },
        })
    for record in answers:
        if record.get("deletedAt") is None:
            continue
        references = record.get("referenceCounts", {})
        items.append({
            "type": "answer", "id": record["key"],
            "revision": record["revision"], "deletedAt": record["deletedAt"],
            "label": record.get("question") or record["key"],
            "state": record.get("state"),
            "reviewStatus": record.get("reviewStatus"),
            "blockerCounts": {
                "sessions": references.get("sessions", 0),
                "history": references.get("history", 0),
            },
        })
    items.sort(key=lambda item: (item["type"], item["label"].casefold(), item["id"]))
    counts = {
        kind: sum(item["type"] == kind for item in items)
        for kind in ("job", "resume", "answer")
    }
    return {"items": items, "counts": counts, "total": len(items)}


def public_proposal_summary(record: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "id", "resumeId", "resumeRevision", "profileRevision",
        "resultProfileRevision", "status", "revision", "createdAt", "updatedAt",
        "supersededBy", "staleReasons",
    }
    summary = {key: value for key, value in record.items() if key in allowed}
    summary["autoFilledCount"] = len(record.get("autoFilledPaths", []))
    summary["pendingCount"] = len(record.get("pendingPaths", []))
    return summary


def public_proposal_detail(
    record: dict[str, Any], inspection: dict[str, Any]
) -> dict[str, Any]:
    store_module = runtime()["STORE_MODULE"]
    detail = public_proposal_summary(record)
    detail["candidate"] = record.get("candidate", {})
    detail["pendingPaths"] = record.get("pendingPaths", [])
    detail["liveProfileRevision"] = inspection["revision"]
    current: dict[str, Any] = {}
    replacements: dict[str, Any] = {}
    for pointer in record.get("pendingPaths", []):
        exists, value = store_module._pointer_lookup(inspection["profile"], pointer)
        current[pointer] = {"exists": exists, "value": value if exists else None}
        replacement = store_module._replacement_scope(
            store_module._pointer_baseline(inspection["profile"], pointer)
        )
        if replacement is not None:
            replacements[pointer] = replacement
    detail["currentValues"] = current
    detail["replacementScopes"] = replacements
    return detail
