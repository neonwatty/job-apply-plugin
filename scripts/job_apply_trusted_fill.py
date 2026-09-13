#!/usr/bin/env python3
"""Inert, value-free Grounded Trusted Fill authority.

The authority stores and evaluates fingerprints and canonical revisions only.
It has no browser, credential, navigation, consent, or final-action operation.
"""

from __future__ import annotations

import copy
import re
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any


SCHEMA_VERSION = 1
POLICY_REVISION = 1
FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REFERENCE = re.compile(r"^[a-z][a-z0-9._-]{0,127}$")
CLAIM_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
REALM_REF = re.compile(r"^[0-9a-f]{64}$")
NONCE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")
CONTENT_REVISION = re.compile(r"^content_[A-Za-z0-9_-]{32,128}$")
ALLOWED_OPERATIONS = {
    "fill_text", "select_option", "toggle_non_consent", "upload_approved_resume",
}
APPROVAL_STATUSES = {"active", "revoked"}
MAX_DURATION = timedelta(hours=1)


class TrustedFillError(Exception):
    """A safe, value-free Trusted Fill contract failure."""


def _time(value: Any, label: str) -> datetime:
    if not isinstance(value, str):
        raise TrustedFillError(f"{label} is invalid")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise TrustedFillError(f"{label} is invalid") from error
    if parsed.tzinfo is None:
        raise TrustedFillError(f"{label} is invalid")
    return parsed.astimezone(timezone.utc)


def _positive(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise TrustedFillError(f"{label} must be a positive integer")
    return value


def _fingerprint(value: Any, label: str) -> str:
    if not isinstance(value, str) or FINGERPRINT.fullmatch(value) is None:
        raise TrustedFillError(f"{label} must be a sha256 fingerprint")
    return value


def validate_content_revision(value: Any) -> str:
    if not isinstance(value, str) or CONTENT_REVISION.fullmatch(value) is None:
        raise TrustedFillError("resume content revision is unverifiable")
    return value


def validate_operations(value: Any) -> list[str]:
    if (
        not isinstance(value, list) or not value
        or not all(isinstance(item, str) for item in value)
        or len(set(value)) != len(value)
        or not set(value) <= ALLOWED_OPERATIONS
    ):
        raise TrustedFillError("allowed operations are invalid or include a final action")
    return sorted(value)


def validate_approval(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TrustedFillError("approval must be an object")
    fields = {
        "schemaVersion", "approvalId", "status", "issuedAt", "expiresAt",
        "revokedAt", "jobId", "jobRevision", "claimId", "realmRef", "urlFingerprint",
        "resumeId", "resumeRevision", "resumeContentRevision", "profileRevision",
        "vitalFactRevision", "answerBindings", "observedQuestionFingerprint",
        "observedControlFingerprint", "formFingerprint", "automationSettingsRevision",
        "employerAccountRevision", "policyRevision", "allowedOperations", "nonce",
        "approvalRevision",
    }
    if set(value) != fields or value.get("schemaVersion") != SCHEMA_VERSION:
        raise TrustedFillError("approval contains unsupported fields")
    for field in ("approvalId", "jobId", "resumeId"):
        if not isinstance(value[field], str) or REFERENCE.fullmatch(value[field]) is None:
            raise TrustedFillError("approval reference is invalid")
    if not isinstance(value["claimId"], str) or CLAIM_ID.fullmatch(value["claimId"]) is None:
        raise TrustedFillError("approval claim binding is invalid")
    if value["status"] not in APPROVAL_STATUSES:
        raise TrustedFillError("approval status is invalid")
    issued = _time(value["issuedAt"], "approval issuedAt")
    expires = _time(value["expiresAt"], "approval expiresAt")
    if expires <= issued or expires - issued > MAX_DURATION:
        raise TrustedFillError("approval duration is invalid")
    if value["status"] == "revoked":
        _time(value["revokedAt"], "approval revokedAt")
    elif value["revokedAt"] is not None:
        raise TrustedFillError("active approval cannot have revokedAt")
    if not isinstance(value["realmRef"], str) or REALM_REF.fullmatch(value["realmRef"]) is None:
        raise TrustedFillError("approval realm reference is invalid")
    for field in ("urlFingerprint", "observedQuestionFingerprint", "observedControlFingerprint", "formFingerprint"):
        _fingerprint(value[field], field)
    for field in (
        "jobRevision", "resumeRevision", "profileRevision",
        "vitalFactRevision", "automationSettingsRevision", "policyRevision", "approvalRevision",
    ):
        _positive(value[field], field)
    validate_content_revision(value["resumeContentRevision"])
    if value["policyRevision"] != POLICY_REVISION:
        raise TrustedFillError("approval policy revision is unsupported")
    account_revision = value["employerAccountRevision"]
    if account_revision is not None:
        _positive(account_revision, "employerAccountRevision")
    bindings = value["answerBindings"]
    if not isinstance(bindings, list):
        raise TrustedFillError("answer bindings must be a list")
    refs = []
    for binding in bindings:
        if not isinstance(binding, dict) or set(binding) != {"answerRef", "questionRevision", "answerRevision"}:
            raise TrustedFillError("answer binding is invalid")
        if not isinstance(binding["answerRef"], str) or REFERENCE.fullmatch(binding["answerRef"]) is None:
            raise TrustedFillError("answer binding reference is invalid")
        _positive(binding["questionRevision"], "questionRevision")
        _positive(binding["answerRevision"], "answerRevision")
        refs.append(binding["answerRef"])
    if len(refs) != len(set(refs)) or refs != sorted(refs):
        raise TrustedFillError("answer bindings must be unique and sorted")
    validate_operations(value["allowedOperations"])
    if not isinstance(value["nonce"], str) or NONCE.fullmatch(value["nonce"]) is None:
        raise TrustedFillError("approval nonce is invalid")
    return value


def create_approval(bindings: dict[str, Any], duration_minutes: int, approval_revision: int, now: datetime) -> dict[str, Any]:
    if not isinstance(duration_minutes, int) or isinstance(duration_minutes, bool) or not 1 <= duration_minutes <= 60:
        raise TrustedFillError("approval duration must be between 1 and 60 minutes")
    issued = now.astimezone(timezone.utc)
    record = {
        "schemaVersion": SCHEMA_VERSION,
        "approvalId": f"trusted-fill-{secrets.token_hex(16)}",
        "status": "active",
        "issuedAt": issued.isoformat(timespec="seconds").replace("+00:00", "Z"),
        "expiresAt": (issued + timedelta(minutes=duration_minutes)).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "revokedAt": None,
        **copy.deepcopy(bindings),
        "policyRevision": POLICY_REVISION,
        "nonce": secrets.token_urlsafe(32),
        "approvalRevision": approval_revision,
    }
    validate_approval(record)
    return record


def revoke_approval(record: dict[str, Any], expected_revision: int, now: datetime) -> dict[str, Any]:
    validate_approval(record)
    if record["approvalRevision"] != expected_revision:
        raise TrustedFillError("approval revision conflict")
    if record["status"] != "active":
        raise TrustedFillError("approval is not active")
    updated = copy.deepcopy(record)
    updated["status"] = "revoked"
    updated["revokedAt"] = now.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    updated["approvalRevision"] += 1
    validate_approval(updated)
    return updated


def evaluate_approval(record: dict[str, Any] | None, current: dict[str, Any], observed: dict[str, Any], now: datetime) -> dict[str, Any]:
    if record is None:
        return {"authorized": False, "reasonCode": "approval_missing", "retryAllowed": False}
    validate_approval(record)
    if record["status"] != "active":
        return {"authorized": False, "reasonCode": "approval_revoked", "retryAllowed": False}
    if now.astimezone(timezone.utc) >= _time(record["expiresAt"], "approval expiresAt"):
        return {"authorized": False, "reasonCode": "approval_expired", "retryAllowed": False}
    flags = {
        "authenticationRequired": "authentication_required",
        "consentRequired": "consent_required",
        "credentialFieldsPresent": "credential_fields_present",
        "finalControlsPresent": "final_controls_present",
        "unseenQuestions": "unseen_questions",
        "unseenControls": "unseen_controls",
    }
    for field, reason in flags.items():
        if observed.get(field) is True:
            return {"authorized": False, "reasonCode": reason, "retryAllowed": False}
    exact = {
        "jobId", "jobRevision", "claimId", "realmRef", "urlFingerprint", "resumeId",
        "resumeRevision", "resumeContentRevision", "profileRevision", "vitalFactRevision",
        "answerBindings", "automationSettingsRevision", "employerAccountRevision", "policyRevision",
    }
    if any(record[field] != current.get(field) for field in exact):
        return {"authorized": False, "reasonCode": "canonical_drift", "retryAllowed": False}
    for field in ("observedQuestionFingerprint", "observedControlFingerprint", "formFingerprint"):
        if observed.get(field) != record[field]:
            return {"authorized": False, "reasonCode": "observed_drift", "retryAllowed": False}
    operations = validate_operations(observed.get("fieldOperations"))
    if not set(operations) <= set(record["allowedOperations"]):
        return {"authorized": False, "reasonCode": "operation_not_approved", "retryAllowed": False}
    return {
        "authorized": True,
        "reasonCode": "authorized_non_final_fields",
        "retryAllowed": False,
        "approvalRevision": record["approvalRevision"],
        "allowedOperations": operations,
    }


def public_status(record: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
    if record is None:
        return {"status": "missing", "approvalRevision": None}
    validate_approval(record)
    status = record["status"]
    if status == "active" and now.astimezone(timezone.utc) >= _time(record["expiresAt"], "approval expiresAt"):
        status = "expired"
    return {
        "status": status,
        "jobId": record["jobId"],
        "realmRef": record["realmRef"],
        "expiresAt": record["expiresAt"],
        "approvalRevision": record["approvalRevision"],
        "allowedOperations": list(record["allowedOperations"]),
    }
