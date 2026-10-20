"""Pure history, session, and coordinator-claim validation."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

from ..constants import (
    ANSWER_STATES,
    APPROVAL_POLICY_MODES,
    APPROVAL_USE_AUTHORITIES,
    ATTENTION_BLOCKER_CODES,
    ATTENTION_BLOCKER_TYPES,
    BROWSER_HANDOFF_REASON_CODES,
    BROWSER_HANDOFF_STATES,
    HISTORY_EVENT_IDENTIFIER,
    HISTORY_EVENTS,
    PENDING_REFERENCE,
    READINESS_ASSERTION_NAMES,
    READINESS_BLOCKER_CODES,
    READINESS_EVIDENCE_KINDS,
    SENSITIVITY_LEVELS,
    SESSION_STATUSES,
)
from ..errors import StoreError
from ..io import require_object
from ..normalization import _safe_session_id, _validate_optional_strings


def _validate_history_event_record(event: dict[str, Any]) -> None:
    """Validate the value-free history schema without assigning event semantics."""

    allowed = {
        "schemaVersion", "eventId", "applicationId", "event", "company",
        "role", "ats", "status", "answerKeys", "at",
    }
    if set(event) - allowed:
        raise StoreError("history event contains unsupported fields")
    _safe_session_id(event.get("applicationId", ""))
    event_name = event.get("event")
    if not isinstance(event_name, str) or not HISTORY_EVENT_IDENTIFIER.fullmatch(event_name):
        raise StoreError("history event type is invalid")
    if not isinstance(event.get("eventId"), str) or not event["eventId"]:
        raise StoreError("history event id is invalid")
    if not isinstance(event.get("at"), str) or not event["at"]:
        raise StoreError("history event timestamp is invalid")
    answer_keys = event.get("answerKeys")
    if not isinstance(answer_keys, list) or not all(isinstance(item, str) for item in answer_keys):
        raise StoreError("history answerKeys list is invalid")
    _validate_optional_strings(event, {"company", "role", "ats", "status"}, "history event")


def _validate_history_event_for_write(event: dict[str, Any]) -> None:
    """Apply this helper version's strict event-name write policy."""

    _validate_history_event_record(event)
    if not isinstance(event.get("eventId"), str) or not event["eventId"]:
        raise StoreError("history event id is invalid")
    if event["event"] not in HISTORY_EVENTS:
        raise StoreError("history event type is unsupported")


def _validate_session_document(
    session: dict[str, Any], *, answer_match_module: Any,
) -> None:
    allowed = {
        "schemaVersion", "applicationId", "status", "ats", "company", "role",
        "url", "step", "answerKeys", "pendingFields", "attemptRevision",
        "readiness", "blockers", "approvals", "browserHandoff", "createdAt",
        "updatedAt",
    }
    if set(session) - allowed:
        raise StoreError("session contains unsupported fields")
    _safe_session_id(session.get("applicationId", ""))
    if session.get("status") not in SESSION_STATUSES:
        raise StoreError("session status is unsupported")
    answer_keys = session.get("answerKeys", [])
    if not isinstance(answer_keys, list) or not all(isinstance(item, str) for item in answer_keys):
        raise StoreError("session answerKeys must be strings")
    pending_fields = session.get("pendingFields", [])
    if not isinstance(pending_fields, list):
        raise StoreError("session pendingFields must be a list")
    pending_allowed = {
        "question", "state", "answerKey", "sensitive", "reference",
        "fieldClass", "scopeFingerprint", "matchConfidence", "matchReasonCodes",
        "matchAnswerRevision", "questionFingerprint",
    }
    pending_references: set[str] = set()
    for value in pending_fields:
        field = require_object(value, "pending field")
        if set(field) - pending_allowed:
            raise StoreError("pending field contains unsupported fields")
        _validate_optional_strings(field, {"question", "state", "answerKey"}, "pending field")
        if "state" in field and field["state"] not in ANSWER_STATES:
            raise StoreError("pending field state is unsupported")
        if "sensitive" in field and not isinstance(field["sensitive"], bool):
            raise StoreError("pending field sensitive must be a boolean")
        if (
            "reference" not in field
            or not isinstance(field["reference"], str)
            or PENDING_REFERENCE.fullmatch(field["reference"]) is None
        ):
            raise StoreError("pending field reference is invalid")
        if field["reference"] in pending_references:
            raise StoreError("pending field references must be unique")
        pending_references.add(field["reference"])
        if "fieldClass" in field and (
            not isinstance(field["fieldClass"], str)
            or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", field["fieldClass"]) is None
        ):
            raise StoreError("pending field class is invalid")
        if "scopeFingerprint" in field and (
            not isinstance(field["scopeFingerprint"], str)
            or re.fullmatch(r"[0-9a-f]{64}", field["scopeFingerprint"]) is None
        ):
            raise StoreError("pending field scope fingerprint is invalid")
        if "questionFingerprint" in field and (
            not isinstance(field["questionFingerprint"], str)
            or re.fullmatch(r"[0-9a-f]{64}", field["questionFingerprint"]) is None
        ):
            raise StoreError("pending field question fingerprint is invalid")
        if (
            "matchConfidence" in field
            and field["matchConfidence"] not in answer_match_module.CONFIDENCE_BANDS
        ):
            raise StoreError("pending field confidence is invalid")
        if "matchAnswerRevision" in field and (
            not isinstance(field["matchAnswerRevision"], int)
            or isinstance(field["matchAnswerRevision"], bool)
            or field["matchAnswerRevision"] < 1
        ):
            raise StoreError("pending field match answer revision is invalid")
        if "matchReasonCodes" in field and (
            not isinstance(field["matchReasonCodes"], list)
            or not all(
                code in answer_match_module.REASON_CODES
                for code in field["matchReasonCodes"]
            )
        ):
            raise StoreError("pending field match reasons are invalid")
    attempt_revision = session.get("attemptRevision")
    if attempt_revision is not None and (
        not isinstance(attempt_revision, int)
        or isinstance(attempt_revision, bool)
        or attempt_revision < 1
    ):
        raise StoreError("session attempt revision is invalid")
    readiness = session.get("readiness")
    if readiness is not None:
        readiness = require_object(readiness, "session readiness")
        required = {
            "status", "evidenceKind", "attemptRevision", "observationRevision",
            "controlSetFingerprint", "requiredControlCount", "assertions",
            "blockerCodes", "fallbackCode",
        }
        if set(readiness) != required:
            raise StoreError("session readiness contains unsupported fields")
        if (
            readiness["status"] not in {"ready", "blocked"}
            or readiness["evidenceKind"] not in READINESS_EVIDENCE_KINDS
        ):
            raise StoreError("session readiness is invalid")
        if readiness["attemptRevision"] != attempt_revision:
            raise StoreError("session readiness is not bound to this attempt")
        if (
            not isinstance(readiness["observationRevision"], int)
            or isinstance(readiness["observationRevision"], bool)
            or readiness["observationRevision"] < 1
        ):
            raise StoreError("session readiness observation revision is invalid")
        if (
            not isinstance(readiness["controlSetFingerprint"], str)
            or re.fullmatch(r"sha256:[0-9a-f]{64}", readiness["controlSetFingerprint"]) is None
            or not isinstance(readiness["requiredControlCount"], int)
            or isinstance(readiness["requiredControlCount"], bool)
            or readiness["requiredControlCount"] < 1
        ):
            raise StoreError("session readiness form manifest is invalid")
        assertions = require_object(readiness["assertions"], "session readiness assertions")
        if set(assertions) != READINESS_ASSERTION_NAMES or not all(
            value in {"passed", "failed"} for value in assertions.values()
        ):
            raise StoreError("session readiness assertions are invalid")
        if (
            not isinstance(readiness["blockerCodes"], list)
            or len(readiness["blockerCodes"]) != len(set(readiness["blockerCodes"]))
            or not all(code in READINESS_BLOCKER_CODES for code in readiness["blockerCodes"])
        ):
            raise StoreError("session readiness blockers are invalid")
        if readiness["fallbackCode"] not in {None, "owner-upload-required"}:
            raise StoreError("session readiness fallback is invalid")
        all_passed = all(value == "passed" for value in assertions.values())
        if (
            (readiness["status"] == "ready") != all_passed
            or (readiness["status"] == "ready" and readiness["blockerCodes"])
            or (readiness["status"] == "blocked" and not readiness["blockerCodes"])
        ):
            raise StoreError("session readiness state is inconsistent")
        upload_fallback = readiness["fallbackCode"] == "owner-upload-required"
        if upload_fallback != (
            "external-upload-capability-unavailable" in readiness["blockerCodes"]
        ) or (
            upload_fallback
            and "required-upload-missing" not in readiness["blockerCodes"]
        ):
            raise StoreError("session readiness fallback is inconsistent")
    blockers = session.get("blockers", [])
    if not isinstance(blockers, list):
        raise StoreError("session blockers must be a list")
    for blocker in blockers:
        blocker = require_object(blocker, "session blocker")
        if set(blocker) - {"type", "code", "reference", "fieldClass", "sensitivity"}:
            raise StoreError("session blocker contains unsupported fields")
        if (
            blocker.get("type") not in ATTENTION_BLOCKER_TYPES
            or blocker.get("code") not in ATTENTION_BLOCKER_CODES
        ):
            raise StoreError("session blocker is invalid")
        if "reference" in blocker and PENDING_REFERENCE.fullmatch(blocker["reference"]) is None:
            raise StoreError("session blocker reference is invalid")
        if blocker.get("sensitivity", "none") not in SENSITIVITY_LEVELS:
            raise StoreError("session blocker sensitivity is invalid")
    approvals = session.get("approvals", [])
    if not isinstance(approvals, list):
        raise StoreError("session approvals must be a list")
    for approval in approvals:
        approval = require_object(approval, "session approval")
        required = {
            "reference", "answerKey", "currentUse", "remember", "policyMode",
            "useAuthority", "eligible", "confidenceBand", "reasonCodes",
            "answerRevision",
        }
        if (
            set(approval) != required
            or PENDING_REFERENCE.fullmatch(approval.get("reference", "")) is None
        ):
            raise StoreError("session approval is invalid")
        if not isinstance(approval["answerKey"], str) or not approval["answerKey"]:
            raise StoreError("session approval answer key is invalid")
        if (
            not isinstance(approval["currentUse"], bool)
            or not isinstance(approval["remember"], bool)
            or not isinstance(approval["eligible"], bool)
        ):
            raise StoreError("session approval decisions must be booleans")
        if (
            approval["policyMode"] not in APPROVAL_POLICY_MODES
            or approval["useAuthority"] not in APPROVAL_USE_AUTHORITIES
        ):
            raise StoreError("session approval policy is invalid")
        if approval["confidenceBand"] not in answer_match_module.CONFIDENCE_BANDS:
            raise StoreError("session approval confidence is invalid")
        if not isinstance(approval["reasonCodes"], list) or not all(
            code in answer_match_module.REASON_CODES
            for code in approval["reasonCodes"]
        ):
            raise StoreError("session approval reasons are invalid")
        if (
            not isinstance(approval["answerRevision"], int)
            or isinstance(approval["answerRevision"], bool)
            or approval["answerRevision"] < 1
        ):
            raise StoreError("session approval answer revision is invalid")
    browser_handoff = session.get("browserHandoff")
    if browser_handoff is not None:
        browser_handoff = require_object(browser_handoff, "browser handoff")
        if set(browser_handoff) != {"state", "reasonCode", "revision"}:
            raise StoreError("browser handoff contains unsupported fields")
        if (
            browser_handoff["state"] not in BROWSER_HANDOFF_STATES
            or browser_handoff["reasonCode"] not in BROWSER_HANDOFF_REASON_CODES
        ):
            raise StoreError("browser handoff is invalid")
        valid_reasons_by_state = {
            "not_required": {"none"},
            "complete": {"none"},
            "ready_for_owner": {"final-review-required"},
            "required": BROWSER_HANDOFF_REASON_CODES - {"none", "final-review-required"},
        }
        if browser_handoff["reasonCode"] not in valid_reasons_by_state[browser_handoff["state"]]:
            raise StoreError("browser handoff is invalid")
        if (
            not isinstance(browser_handoff["revision"], int)
            or isinstance(browser_handoff["revision"], bool)
            or browser_handoff["revision"] < 1
        ):
            raise StoreError("browser handoff revision is invalid")
    _validate_optional_strings(
        session,
        {
            "applicationId", "status", "ats", "company", "role", "url",
            "step", "createdAt", "updatedAt",
        },
        "session",
    )


def _validate_claim_record(value: Any) -> dict[str, Any]:
    claim = require_object(value, "coordinator claim")
    required = {
        "claimId", "jobId", "ownerLabel", "tokenHash", "acquiredAt",
        "heartbeatAt", "expiresAt",
    }
    if set(claim) != required or not all(
        isinstance(claim.get(field), str) and claim[field] for field in required
    ):
        raise StoreError("coordinator claim is invalid")
    _safe_session_id(claim["jobId"])
    for field in ("acquiredAt", "heartbeatAt", "expiresAt"):
        _parse_coordinator_time(claim[field])
    return claim


def _parse_coordinator_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (AttributeError, ValueError) as error:
        raise StoreError("coordinator timestamp is invalid") from error
    if parsed.tzinfo is None:
        raise StoreError("coordinator timestamp is invalid")
    return parsed.astimezone(timezone.utc)
