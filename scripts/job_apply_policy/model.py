"""Closed policy models and value-free validation primitives."""
from __future__ import annotations

import hashlib
import hmac
import json
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlsplit

SCHEMA_VERSION = 1
STORE_ENV = "JOB_APPLY_STORE_DIR"
MAX_APPLICATIONS = 10
MAX_DURATION = timedelta(hours=4)
LEASE_DURATION = timedelta(minutes=5)
FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REFERENCE = re.compile(r"^(campaign|application|answer|lease|claim|receipt):[0-9a-f]{64}$")
ATS = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

RULE_FIELDS = {
    "applicationRef",
    "origin",
    "urlFingerprint",
    "ats",
    "jobFingerprint",
    "formRevision",
    "finalControlRevision",
}
SENSITIVE_FIELDS = {"answerRef", "questionRevision", "answerRevision"}
AUTHORIZATION_FIELDS = RULE_FIELDS | {
    "resumeRevision",
    "answerRevisions",
}
CAMPAIGN_FIELDS = {
    "schemaVersion",
    "campaignId",
    "mode",
    "status",
    "createdAt",
    "expiresAt",
    "maxApplications",
    "applicationRules",
    "resumeRevision",
    "sensitiveAllowlist",
    "confirmationAuthorityRevision",
    "riskAcknowledgedAt",
    "killSwitch",
    "killSwitchAt",
    "reservedApplications",
}
ATTEMPT_FIELDS = {
    "attempt",
    "leaseId",
    "issuedAt",
    "expiresAt",
    "claimId",
    "claimedAt",
    "outcome",
    "outcomeAt",
    "confirmationRevision",
    "receipt",
}
APPLICATION_FIELDS = {
    "schemaVersion",
    "campaignId",
    "applicationRef",
    "slot",
    "authorizationFingerprint",
    "authorization",
    "status",
    "attempts",
    "createdAt",
    "updatedAt",
}
RECEIPT_FIELDS = {
    "schemaVersion",
    "receiptId",
    "campaignId",
    "applicationRef",
    "slot",
    "attempt",
    "leaseId",
    "claimId",
    "outcome",
    "status",
    "at",
    "confirmationRevision",
}
CAMPAIGN_STATUSES = {"active", "revoked", "killed", "expired"}
APPLICATION_STATUSES = {
    "lease_issued",
    "action_claimed",
    "retry_available",
    "confirmed_submitted",
    "uncertain_exhausted",
    "blocked",
}
OUTCOMES = {"confirmed_submitted", "uncertain", "blocked"}
CONFIRMATION_FIELDS = {
    "eventId",
    "claimId",
    "source",
    "observedAt",
    "confirmationRevision",
    "activationObserved",
    "proof",
}


class PolicyError(Exception):
    """An expected policy failure safe to display without stored values."""


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def format_time(value: datetime) -> str:
    if value.tzinfo is None:
        raise PolicyError("time must include a timezone")
    return value.astimezone(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def parse_time(value: Any) -> datetime:
    if not isinstance(value, str) or not value:
        raise PolicyError("timestamp is invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise PolicyError("timestamp is invalid") from error
    if parsed.tzinfo is None:
        raise PolicyError("timestamp is invalid")
    return parsed.astimezone(timezone.utc)


def _object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise PolicyError(f"{label} must be a JSON object")
    return value


def _closed(value: dict[str, Any], fields: set[str], label: str) -> None:
    if set(value) != fields:
        raise PolicyError(f"{label} fields are invalid")


def _fingerprint(value: Any, label: str) -> str:
    if not isinstance(value, str) or not FINGERPRINT.fullmatch(value):
        raise PolicyError(f"{label} must be an opaque revision fingerprint")
    return value


def _reference(value: Any, kind: str, label: str) -> str:
    if (
        not isinstance(value, str)
        or not REFERENCE.fullmatch(value)
        or not value.startswith(f"{kind}:")
    ):
        raise PolicyError(f"{label} must be an opaque {kind} reference")
    return value


def _new_reference(kind: str) -> str:
    return f"{kind}:{secrets.token_hex(32)}"


def _origin(value: Any) -> str:
    if not isinstance(value, str):
        raise PolicyError("origin is invalid")
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or value.endswith("/")
    ):
        raise PolicyError("origin must be an exact HTTP(S) origin")
    return value


def _rule(value: Any) -> dict[str, Any]:
    rule = _object(value, "application rule")
    _closed(rule, RULE_FIELDS, "application rule")
    _reference(rule["applicationRef"], "application", "applicationRef")
    _origin(rule["origin"])
    _fingerprint(rule["urlFingerprint"], "urlFingerprint")
    if not isinstance(rule["ats"], str) or not ATS.fullmatch(rule["ats"]):
        raise PolicyError("ats is invalid")
    _fingerprint(rule["jobFingerprint"], "jobFingerprint")
    _fingerprint(rule["formRevision"], "formRevision")
    _fingerprint(rule["finalControlRevision"], "finalControlRevision")
    return dict(rule)


def _sensitive(value: Any) -> dict[str, Any]:
    item = _object(value, "sensitive answer revision")
    _closed(item, SENSITIVE_FIELDS, "sensitive answer revision")
    _reference(item["answerRef"], "answer", "answerRef")
    _fingerprint(item["questionRevision"], "questionRevision")
    _fingerprint(item["answerRevision"], "answerRevision")
    return dict(item)


def _authorization(value: Any) -> dict[str, Any]:
    item = _object(value, "authorization")
    _closed(item, AUTHORIZATION_FIELDS, "authorization")
    normalized = _rule({field: item[field] for field in RULE_FIELDS})
    normalized.update(
        {
            "resumeRevision": _fingerprint(
                item["resumeRevision"], "resumeRevision"
            ),
            "formRevision": _fingerprint(item["formRevision"], "formRevision"),
            "finalControlRevision": _fingerprint(
                item["finalControlRevision"], "finalControlRevision"
            ),
        }
    )
    answers = item["answerRevisions"]
    if not isinstance(answers, list):
        raise PolicyError("answerRevisions must be a list")
    normalized["answerRevisions"] = [_sensitive(answer) for answer in answers]
    refs = [answer["answerRef"] for answer in normalized["answerRevisions"]]
    if len(refs) != len(set(refs)):
        raise PolicyError("answerRevisions contains duplicates")
    return normalized


def _digest(value: Any) -> str:
    encoded = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=True
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(encoded).hexdigest()


def confirmation_authority_revision(capability: str) -> str:
    if not isinstance(capability, str) or re.fullmatch(r"[a-f0-9]{64}", capability) is None:
        raise PolicyError("trusted confirmation capability is invalid")
    return _digest(capability)


def _confirmation_event(
    value: Any,
    claim_id: str,
    authority_revision: str,
    capability: str | None,
) -> dict[str, Any]:
    event = _object(value, "confirmation event")
    _closed(event, CONFIRMATION_FIELDS, "confirmation event")
    _reference(event["eventId"], "receipt", "confirmation eventId")
    _reference(event["claimId"], "claim", "confirmation claimId")
    if event["claimId"] != claim_id:
        raise PolicyError("confirmation event does not match action claim")
    if event["source"] not in {"isolated_loopback", "approved_real_canary"}:
        raise PolicyError("confirmation source is not trusted")
    parse_time(event["observedAt"])
    _fingerprint(event["confirmationRevision"], "confirmationRevision")
    if event["activationObserved"] is not True:
        raise PolicyError("confirmation did not independently observe activation")
    if not isinstance(capability, str) or re.fullmatch(r"[a-f0-9]{64}", capability) is None:
        raise PolicyError("trusted confirmation capability is required")
    if confirmation_authority_revision(capability) != authority_revision:
        raise PolicyError("confirmation authority does not match campaign")
    proof = event["proof"]
    if not isinstance(proof, str) or re.fullmatch(r"[a-f0-9]{64}", proof) is None:
        raise PolicyError("confirmation proof is invalid")
    signed = {key: item for key, item in event.items() if key != "proof"}
    expected = hmac.new(
        capability.encode(),
        json.dumps(signed, sort_keys=True, separators=(",", ":")).encode(),
        hashlib.sha256,
    ).hexdigest()
    if not hmac.compare_digest(proof, expected):
        raise PolicyError("confirmation proof is invalid")
    return dict(event)


def _validate_receipt(receipt: dict[str, Any]) -> dict[str, Any]:
    _closed(receipt, RECEIPT_FIELDS, "receipt")
    if receipt["schemaVersion"] != SCHEMA_VERSION:
        raise PolicyError("receipt schema version is unsupported")
    _reference(receipt["receiptId"], "receipt", "receiptId")
    _reference(receipt["campaignId"], "campaign", "campaignId")
    _reference(receipt["applicationRef"], "application", "applicationRef")
    _reference(receipt["leaseId"], "lease", "leaseId")
    _reference(receipt["claimId"], "claim", "claimId")
    for field in ("slot", "attempt"):
        if not isinstance(receipt[field], int) or isinstance(receipt[field], bool) or receipt[field] < 1:
            raise PolicyError(f"receipt {field} is invalid")
    if receipt["outcome"] not in OUTCOMES:
        raise PolicyError("receipt outcome is invalid")
    expected_statuses = {
        "confirmed_submitted": {"confirmed_submitted"},
        "blocked": {"blocked"},
        "uncertain": {"retry_available", "uncertain_exhausted"},
    }
    if receipt["status"] not in expected_statuses[receipt["outcome"]]:
        raise PolicyError("receipt status is invalid")
    parse_time(receipt["at"])
    if receipt["outcome"] == "confirmed_submitted":
        _fingerprint(receipt["confirmationRevision"], "confirmationRevision")
    elif receipt["confirmationRevision"] is not None:
        raise PolicyError("receipt confirmation is invalid")
    return receipt
