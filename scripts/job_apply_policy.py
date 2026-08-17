#!/usr/bin/env python3
"""Inert local policy authority for bounded Job Apply Auto-submit campaigns.

This helper only creates and evaluates local policy records. It deliberately has
no browser integration and cannot activate a final control.
"""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import hmac
import json
import os
import re
import secrets
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator
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


def _private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    if os.name != "nt":
        os.chmod(path, 0o700)


def _fsync_dir(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    _private_dir(path.parent)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, indent=2, sort_keys=True)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        if os.name != "nt":
            os.chmod(temporary_path, 0o600)
        os.replace(temporary_path, path)
        temporary_path = None
        if os.name != "nt":
            os.chmod(path, 0o600)
        _fsync_dir(path.parent)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def _read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as source:
            return _object(json.load(source), label)
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError(f"{label} is unavailable or invalid") from error


class PolicyStore:
    def __init__(self, root: Path):
        self.root = root.expanduser()
        self.policy_dir = self.root / "auto-submit"
        self.campaign_path = self.policy_dir / "campaign.json"
        self.archive_dir = self.policy_dir / "campaigns"
        self.applications_dir = self.policy_dir / "applications"
        self.receipts_path = self.policy_dir / "receipts.jsonl"
        self.lock_path = self.policy_dir / ".lock"

    @contextmanager
    def _lock(self) -> Iterator[None]:
        _private_dir(self.policy_dir)
        descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX)
            yield
        finally:
            fcntl.flock(descriptor, fcntl.LOCK_UN)
            os.close(descriptor)

    def _validate_campaign(self, campaign: dict[str, Any]) -> dict[str, Any]:
        _closed(campaign, CAMPAIGN_FIELDS, "campaign")
        if campaign["schemaVersion"] != SCHEMA_VERSION:
            raise PolicyError("campaign schema version is unsupported")
        _reference(campaign["campaignId"], "campaign", "campaignId")
        if campaign["mode"] != "auto_submit":
            raise PolicyError("campaign mode is invalid")
        if campaign["status"] not in CAMPAIGN_STATUSES:
            raise PolicyError("campaign status is invalid")
        created = parse_time(campaign["createdAt"])
        expires = parse_time(campaign["expiresAt"])
        if expires <= created or expires - created > MAX_DURATION:
            raise PolicyError("campaign duration is invalid")
        maximum = campaign["maxApplications"]
        if not isinstance(maximum, int) or isinstance(maximum, bool) or not 1 <= maximum <= MAX_APPLICATIONS:
            raise PolicyError("campaign application limit is invalid")
        rules = campaign["applicationRules"]
        if not isinstance(rules, list) or not rules:
            raise PolicyError("campaign requires application rules")
        normalized_rules = [_rule(rule) for rule in rules]
        refs = [rule["applicationRef"] for rule in normalized_rules]
        if len(refs) != len(set(refs)):
            raise PolicyError("campaign application rules contain duplicates")
        _fingerprint(campaign["resumeRevision"], "resumeRevision")
        _fingerprint(
            campaign["confirmationAuthorityRevision"],
            "confirmationAuthorityRevision",
        )
        allowlist = campaign["sensitiveAllowlist"]
        if not isinstance(allowlist, list):
            raise PolicyError("sensitiveAllowlist must be a list")
        normalized_allowlist = [_sensitive(item) for item in allowlist]
        answer_refs = [item["answerRef"] for item in normalized_allowlist]
        if len(answer_refs) != len(set(answer_refs)):
            raise PolicyError("sensitiveAllowlist contains duplicates")
        parse_time(campaign["riskAcknowledgedAt"])
        if not isinstance(campaign["killSwitch"], bool):
            raise PolicyError("campaign kill switch is invalid")
        if campaign["killSwitchAt"] is not None:
            parse_time(campaign["killSwitchAt"])
        if campaign["killSwitch"] != (campaign["status"] == "killed"):
            raise PolicyError("campaign kill switch state is inconsistent")
        if campaign["killSwitch"] != (campaign["killSwitchAt"] is not None):
            raise PolicyError("campaign kill switch timestamp is inconsistent")
        reserved = campaign["reservedApplications"]
        if not isinstance(reserved, int) or isinstance(reserved, bool) or not 0 <= reserved <= maximum:
            raise PolicyError("campaign reservation count is invalid")
        return campaign

    def load_campaign(self) -> dict[str, Any]:
        if not self.campaign_path.exists():
            raise PolicyError("campaign does not exist")
        return self._validate_campaign(_read_json(self.campaign_path, "campaign"))

    def _campaign_mode(self, campaign: dict[str, Any], now: datetime) -> tuple[str, str]:
        if campaign["killSwitch"]:
            return "review_only", "kill_switch"
        if campaign["status"] != "active":
            return "review_only", campaign["status"]
        if now >= parse_time(campaign["expiresAt"]):
            return "review_only", "expired"
        return "auto_submit", "active_campaign"

    def decision(self, now: datetime | None = None) -> dict[str, Any]:
        checked_at = now or utc_now()
        try:
            campaign = self.load_campaign()
            mode, reason = self._campaign_mode(campaign, checked_at)
            return {
                "mode": mode,
                "reason": reason,
                "campaignId": campaign["campaignId"] if mode == "auto_submit" else None,
            }
        except (PolicyError, OSError):
            return {"mode": "review_only", "reason": "policy_unavailable", "campaignId": None}

    def activate(self, incoming: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
        current_time = now or utc_now()
        allowed = {
            "riskAcknowledged",
            "applicationRules",
            "resumeRevision",
            "sensitiveAllowlist",
            "confirmationAuthorityRevision",
            "maxApplications",
            "durationSeconds",
        }
        if set(incoming) - allowed:
            raise PolicyError("campaign input contains unsupported fields")
        if incoming.get("riskAcknowledged") is not True:
            raise PolicyError("explicit risk acknowledgement is required")
        rules = incoming.get("applicationRules")
        if not isinstance(rules, list) or not rules:
            raise PolicyError("campaign requires application rules")
        normalized_rules = [_rule(rule) for rule in rules]
        maximum = incoming.get("maxApplications", MAX_APPLICATIONS)
        duration_seconds = incoming.get("durationSeconds", int(MAX_DURATION.total_seconds()))
        if not isinstance(duration_seconds, int) or isinstance(duration_seconds, bool) or not 1 <= duration_seconds <= int(MAX_DURATION.total_seconds()):
            raise PolicyError("campaign duration is invalid")
        campaign = {
            "schemaVersion": SCHEMA_VERSION,
            "campaignId": _new_reference("campaign"),
            "mode": "auto_submit",
            "status": "active",
            "createdAt": format_time(current_time),
            "expiresAt": format_time(current_time + timedelta(seconds=duration_seconds)),
            "maxApplications": maximum,
            "applicationRules": normalized_rules,
            "resumeRevision": _fingerprint(incoming.get("resumeRevision"), "resumeRevision"),
            "sensitiveAllowlist": [
                _sensitive(item) for item in incoming.get("sensitiveAllowlist", [])
            ],
            "confirmationAuthorityRevision": _fingerprint(
                incoming.get("confirmationAuthorityRevision"),
                "confirmationAuthorityRevision",
            ),
            "riskAcknowledgedAt": format_time(current_time),
            "killSwitch": False,
            "killSwitchAt": None,
            "reservedApplications": 0,
        }
        self._validate_campaign(campaign)
        with self._lock():
            if self.campaign_path.exists():
                previous = self.load_campaign()
                previous_mode, _ = self._campaign_mode(previous, current_time)
                if previous_mode == "auto_submit" or previous["killSwitch"]:
                    raise PolicyError("an active or killed campaign cannot be replaced")
                _private_dir(self.archive_dir)
                archive_path = self.archive_dir / f"{previous['campaignId'].split(':', 1)[1]}.json"
                if archive_path.exists():
                    archived = self._validate_campaign(
                        _read_json(archive_path, "campaign archive")
                    )
                    if archived != previous:
                        raise PolicyError("campaign archive already exists")
                else:
                    _atomic_json(archive_path, previous)
            _atomic_json(self.campaign_path, campaign)
        return campaign

    def _load_campaign_by_id(self, campaign_id: str) -> dict[str, Any]:
        _reference(campaign_id, "campaign", "campaignId")
        current = self.load_campaign()
        if current["campaignId"] == campaign_id:
            return current
        archive_path = self.archive_dir / f"{campaign_id.split(':', 1)[1]}.json"
        if not archive_path.exists():
            raise PolicyError("campaign does not exist")
        archived = self._validate_campaign(
            _read_json(archive_path, "campaign archive")
        )
        if archived["campaignId"] != campaign_id:
            raise PolicyError("campaign archive does not match")
        return archived

    def _campaign_applications_dir(self, campaign_id: str) -> Path:
        _reference(campaign_id, "campaign", "campaignId")
        return self.applications_dir / campaign_id.split(":", 1)[1]

    def _application_path(self, application_ref: str, campaign_id: str) -> Path:
        _reference(application_ref, "application", "applicationRef")
        return self._campaign_applications_dir(campaign_id) / f"{application_ref.split(':', 1)[1]}.json"

    def _validate_application(self, value: dict[str, Any]) -> dict[str, Any]:
        _closed(value, APPLICATION_FIELDS, "application record")
        if value["schemaVersion"] != SCHEMA_VERSION:
            raise PolicyError("application schema version is unsupported")
        _reference(value["campaignId"], "campaign", "campaignId")
        _reference(value["applicationRef"], "application", "applicationRef")
        if not isinstance(value["slot"], int) or isinstance(value["slot"], bool) or value["slot"] < 1:
            raise PolicyError("application slot is invalid")
        authorization = _authorization(value["authorization"])
        if authorization["applicationRef"] != value["applicationRef"]:
            raise PolicyError("application authorization does not match")
        if value["authorizationFingerprint"] != _digest(authorization):
            raise PolicyError("application authorization fingerprint is invalid")
        if value["status"] not in APPLICATION_STATUSES:
            raise PolicyError("application status is invalid")
        attempts = value["attempts"]
        if not isinstance(attempts, list) or not 1 <= len(attempts) <= 2:
            raise PolicyError("application attempts are invalid")
        for number, attempt_value in enumerate(attempts, 1):
            attempt = _object(attempt_value, "attempt")
            _closed(attempt, ATTEMPT_FIELDS, "attempt")
            if attempt["attempt"] != number:
                raise PolicyError("attempt ordinal is invalid")
            _reference(attempt["leaseId"], "lease", "leaseId")
            issued = parse_time(attempt["issuedAt"])
            expires = parse_time(attempt["expiresAt"])
            if expires <= issued or expires - issued > LEASE_DURATION:
                raise PolicyError("attempt lease duration is invalid")
            if attempt["outcome"] is not None and attempt["outcome"] not in OUTCOMES:
                raise PolicyError("attempt outcome is invalid")
            if attempt["claimId"] is not None:
                _reference(attempt["claimId"], "claim", "claimId")
            if attempt["claimedAt"] is not None:
                claimed_at = parse_time(attempt["claimedAt"])
                if claimed_at < issued or claimed_at >= expires:
                    raise PolicyError("attempt claim time is invalid")
            if (attempt["claimId"] is None) != (attempt["claimedAt"] is None):
                raise PolicyError("attempt claim state is inconsistent")
            if attempt["outcomeAt"] is not None:
                parse_time(attempt["outcomeAt"])
            if attempt["confirmationRevision"] is not None:
                _fingerprint(attempt["confirmationRevision"], "confirmationRevision")
            if attempt["receipt"] is not None:
                receipt = _object(attempt["receipt"], "receipt")
                _validate_receipt(receipt)
                if (
                    receipt["campaignId"] != value["campaignId"]
                    or receipt["applicationRef"] != value["applicationRef"]
                    or receipt["slot"] != value["slot"]
                    or receipt["attempt"] != number
                    or receipt["leaseId"] != attempt["leaseId"]
                    or receipt["claimId"] != attempt["claimId"]
                    or receipt["outcome"] != attempt["outcome"]
                    or receipt["confirmationRevision"] != attempt["confirmationRevision"]
                ):
                    raise PolicyError("attempt receipt does not match")
            if (attempt["outcome"] is None) != (attempt["receipt"] is None):
                raise PolicyError("attempt receipt state is inconsistent")
            if attempt["outcome"] is not None and attempt["claimId"] is None:
                raise PolicyError("unclaimed attempt cannot have an outcome")
            if (attempt["outcome"] is None) != (attempt["outcomeAt"] is None):
                raise PolicyError("attempt outcome time is inconsistent")
            if attempt["outcome"] == "confirmed_submitted" and attempt["confirmationRevision"] is None:
                raise PolicyError("confirmed attempt has no confirmation")
            if attempt["outcome"] != "confirmed_submitted" and attempt["confirmationRevision"] is not None:
                raise PolicyError("attempt confirmation is invalid")
        outcomes = [attempt["outcome"] for attempt in attempts]
        if len(attempts) == 2 and outcomes[0] != "uncertain":
            raise PolicyError("retry does not follow uncertainty")
        state_is_valid = {
            "lease_issued": outcomes[-1] is None,
            "action_claimed": outcomes[-1] is None and attempts[-1]["claimId"] is not None,
            "retry_available": len(attempts) == 1 and outcomes == ["uncertain"],
            "confirmed_submitted": outcomes[-1] == "confirmed_submitted",
            "uncertain_exhausted": len(attempts) == 2 and outcomes == ["uncertain", "uncertain"],
            "blocked": outcomes[-1] == "blocked",
        }[value["status"]]
        if value["status"] == "lease_issued" and attempts[-1]["claimId"] is not None:
            state_is_valid = False
        if not state_is_valid:
            raise PolicyError("application attempt state is inconsistent")
        parse_time(value["createdAt"])
        parse_time(value["updatedAt"])
        return value

    def _load_application(self, application_ref: str, campaign_id: str) -> dict[str, Any]:
        path = self._application_path(application_ref, campaign_id)
        if not path.exists():
            raise PolicyError("application reservation does not exist")
        application = self._validate_application(_read_json(path, "application record"))
        if application["campaignId"] != campaign_id:
            raise PolicyError("application campaign does not match")
        if application["applicationRef"] != application_ref:
            raise PolicyError("application record does not match")
        return application

    def _campaign_applications(self, campaign_id: str) -> list[dict[str, Any]]:
        directory = self._campaign_applications_dir(campaign_id)
        if not directory.exists():
            return []
        applications = []
        for path in sorted(directory.glob("*.json")):
            application = self._validate_application(_read_json(path, "application record"))
            if application["campaignId"] != campaign_id:
                raise PolicyError("application campaign does not match")
            if path.stem != application["applicationRef"].split(":", 1)[1]:
                raise PolicyError("application record path does not match")
            applications.append(application)
        refs = [item["applicationRef"] for item in applications]
        slots = [item["slot"] for item in applications]
        if len(refs) != len(set(refs)) or len(slots) != len(set(slots)):
            raise PolicyError("application reservations are not unique")
        if sorted(slots) != list(range(1, len(slots) + 1)):
            raise PolicyError("application reservation slots are invalid")
        return applications

    def _new_attempt(self, number: int, now: datetime, campaign_expiry: datetime) -> dict[str, Any]:
        expires = min(now + LEASE_DURATION, campaign_expiry)
        if expires <= now:
            raise PolicyError("campaign is expired")
        return {
            "attempt": number,
            "leaseId": _new_reference("lease"),
            "issuedAt": format_time(now),
            "expiresAt": format_time(expires),
            "claimId": None,
            "claimedAt": None,
            "outcome": None,
            "outcomeAt": None,
            "confirmationRevision": None,
            "receipt": None,
        }

    def _authorization_matches_campaign(
        self,
        campaign: dict[str, Any],
        authorization: dict[str, Any],
    ) -> str | None:
        matching_rules = [
            rule
            for rule in campaign["applicationRules"]
            if rule["applicationRef"] == authorization["applicationRef"]
        ]
        rule_value = {field: authorization[field] for field in RULE_FIELDS}
        if len(matching_rules) != 1 or matching_rules[0] != rule_value:
            return "scope_mismatch"
        if authorization["resumeRevision"] != campaign["resumeRevision"]:
            return "resume_mismatch"
        allowed_answers = {
            item["answerRef"]: item for item in campaign["sensitiveAllowlist"]
        }
        if any(
            allowed_answers.get(item["answerRef"]) != item
            for item in authorization["answerRevisions"]
        ):
            return "sensitive_scope_mismatch"
        return None

    def _authorization_result(self, application: dict[str, Any]) -> dict[str, Any]:
        attempt = application["attempts"][-1]
        return {
            "mode": "auto_submit",
            "reason": "exact_policy_lease",
            "campaignId": application["campaignId"],
            "applicationRef": application["applicationRef"],
            "slot": application["slot"],
            "attempt": attempt["attempt"],
            "leaseId": attempt["leaseId"],
            "leaseExpiresAt": attempt["expiresAt"],
        }

    def authorize(self, incoming: dict[str, Any], now: datetime | None = None) -> dict[str, Any]:
        current_time = now or utc_now()
        try:
            authorization = _authorization(incoming)
        except PolicyError:
            return {"mode": "review_only", "reason": "authorization_invalid"}
        with self._lock():
            try:
                campaign = self.load_campaign()
                mode, reason = self._campaign_mode(campaign, current_time)
                if mode != "auto_submit":
                    return {"mode": "review_only", "reason": reason}
                mismatch = self._authorization_matches_campaign(campaign, authorization)
                if mismatch is not None:
                    return {"mode": "review_only", "reason": mismatch}

                application_path = self._application_path(
                    authorization["applicationRef"], campaign["campaignId"]
                )
                authorization_fingerprint = _digest(authorization)
                if application_path.exists():
                    application = self._load_application(
                        authorization["applicationRef"], campaign["campaignId"]
                    )
                    if (
                        application["campaignId"] != campaign["campaignId"]
                        or application["authorizationFingerprint"] != authorization_fingerprint
                    ):
                        return {"mode": "review_only", "reason": "authorization_changed"}
                    if application["status"] == "lease_issued":
                        active = application["attempts"][-1]
                        if current_time >= parse_time(active["expiresAt"]):
                            return {"mode": "review_only", "reason": "lease_expired"}
                        return self._authorization_result(application)
                    if application["status"] == "retry_available":
                        attempt = self._new_attempt(
                            2, current_time, parse_time(campaign["expiresAt"])
                        )
                        application["attempts"].append(attempt)
                        application["status"] = "lease_issued"
                        application["updatedAt"] = format_time(current_time)
                        self._validate_application(application)
                        _atomic_json(application_path, application)
                        return self._authorization_result(application)
                    return {"mode": "review_only", "reason": application["status"]}

                applications = self._campaign_applications(campaign["campaignId"])
                reserved = len(applications)
                if campaign["reservedApplications"] != reserved:
                    campaign["reservedApplications"] = reserved
                    _atomic_json(self.campaign_path, campaign)
                if reserved >= campaign["maxApplications"]:
                    return {"mode": "review_only", "reason": "application_limit"}
                slot = reserved + 1
                attempt = self._new_attempt(
                    1, current_time, parse_time(campaign["expiresAt"])
                )
                application = {
                    "schemaVersion": SCHEMA_VERSION,
                    "campaignId": campaign["campaignId"],
                    "applicationRef": authorization["applicationRef"],
                    "slot": slot,
                    "authorizationFingerprint": authorization_fingerprint,
                    "authorization": authorization,
                    "status": "lease_issued",
                    "attempts": [attempt],
                    "createdAt": format_time(current_time),
                    "updatedAt": format_time(current_time),
                }
                self._validate_application(application)
                _private_dir(self._campaign_applications_dir(campaign["campaignId"]))
                _atomic_json(application_path, application)
                campaign["reservedApplications"] = slot
                _atomic_json(self.campaign_path, campaign)
                return self._authorization_result(application)
            except (PolicyError, OSError):
                return {"mode": "review_only", "reason": "policy_unavailable"}

    def claim_final_action(
        self,
        application_ref: str,
        lease_id: str,
        attempt_ordinal: int,
        observed_authorization: dict[str, Any],
        action_capability: str | None = None,
        now: datetime | None = None,
        activation: Callable[[dict[str, Any]], None] | None = None,
    ) -> dict[str, Any]:
        """Atomically consume an issued lease immediately before activation.

        The caller must supply the freshly observed closed identity.  Stored page
        state, redirects, model output, and a previous authorization result are
        deliberately insufficient.  A claim is never idempotently reissued: one
        process wins and every repeat or concurrent claimant fails closed.
        """
        current_time = now or utc_now()
        _reference(application_ref, "application", "applicationRef")
        _reference(lease_id, "lease", "leaseId")
        if (
            not isinstance(attempt_ordinal, int)
            or isinstance(attempt_ordinal, bool)
            or attempt_ordinal not in {1, 2}
        ):
            raise PolicyError("attempt ordinal is invalid")
        authorization = _authorization(observed_authorization)
        if authorization["applicationRef"] != application_ref:
            raise PolicyError("observed authorization does not match")
        with self._lock():
            campaign = self.load_campaign()
            mode, reason = self._campaign_mode(campaign, current_time)
            if mode != "auto_submit":
                raise PolicyError(f"final action is not authorized: {reason}")
            mismatch = self._authorization_matches_campaign(campaign, authorization)
            if mismatch is not None:
                raise PolicyError(f"final action is not authorized: {mismatch}")
            if (
                confirmation_authority_revision(action_capability)
                != campaign["confirmationAuthorityRevision"]
            ):
                raise PolicyError("final action capability does not match campaign")
            application = self._load_application(application_ref, campaign["campaignId"])
            if application["authorizationFingerprint"] != _digest(authorization):
                raise PolicyError("final action is not authorized: authorization_changed")
            attempt = application["attempts"][-1]
            if application["status"] != "lease_issued":
                raise PolicyError("final action lease is already claimed or consumed")
            if attempt["attempt"] != attempt_ordinal or attempt["leaseId"] != lease_id:
                raise PolicyError("final action lease is stale")
            if attempt["outcome"] is not None or attempt["claimId"] is not None:
                raise PolicyError("final action lease is already claimed or consumed")
            if current_time >= parse_time(attempt["expiresAt"]):
                raise PolicyError("final action lease is expired")
            claim_id = _new_reference("claim")
            claim_proof = hmac.new(
                action_capability.encode(), claim_id.encode(), hashlib.sha256
            ).hexdigest()
            attempt["claimId"] = claim_id
            attempt["claimedAt"] = format_time(current_time)
            application["status"] = "action_claimed"
            application["updatedAt"] = format_time(current_time)
            self._validate_application(application)
            _atomic_json(
                self._application_path(application_ref, campaign["campaignId"]),
                application,
            )
            claim = {
                "mode": "auto_submit",
                "reason": "atomic_action_claim",
                "campaignId": campaign["campaignId"],
                "applicationRef": application_ref,
                "slot": application["slot"],
                "attempt": attempt_ordinal,
                "claimId": claim_id,
                "claimProof": claim_proof,
            }
            # The activation callback runs while the same exclusive policy lock
            # still excludes kill/revoke and every competing consumer.  State is
            # durably consumed first, so a callback failure can only fail closed.
            if activation is not None:
                activation(dict(claim))
            return claim

    def _append_receipt(self, receipt: dict[str, Any]) -> None:
        _validate_receipt(receipt)
        _private_dir(self.policy_dir)
        encoded = (json.dumps(receipt, sort_keys=True) + "\n").encode("utf-8")
        descriptor = os.open(
            self.receipts_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        try:
            written = os.write(descriptor, encoded)
            if written != len(encoded):
                raise PolicyError("receipt append was incomplete")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _receipt_is_logged(self, receipt_id: str) -> bool:
        if not self.receipts_path.exists():
            return False
        try:
            with self.receipts_path.open(encoding="utf-8") as source:
                for line in source:
                    if not line.strip():
                        continue
                    receipt = _object(json.loads(line), "receipt")
                    _validate_receipt(receipt)
                    if receipt["receiptId"] == receipt_id:
                        return True
        except (OSError, json.JSONDecodeError) as error:
            raise PolicyError("receipt log is unavailable or invalid") from error
        return False

    def _ensure_receipt_logged(self, receipt: dict[str, Any]) -> None:
        if not self._receipt_is_logged(receipt["receiptId"]):
            self._append_receipt(receipt)

    def record_outcome(
        self,
        campaign_id: str,
        application_ref: str,
        lease_id: str,
        claim_id: str,
        outcome: str,
        confirmation_event: dict[str, Any] | None = None,
        confirmation_capability: str | None = None,
        now: datetime | None = None,
    ) -> dict[str, Any]:
        current_time = now or utc_now()
        _reference(campaign_id, "campaign", "campaignId")
        _reference(application_ref, "application", "applicationRef")
        _reference(lease_id, "lease", "leaseId")
        _reference(claim_id, "claim", "claimId")
        if outcome not in OUTCOMES:
            raise PolicyError("outcome is unsupported")
        if outcome == "confirmed_submitted":
            if not isinstance(confirmation_event, dict):
                raise PolicyError("trusted confirmation event is required")
            confirmation_revision = None
        elif confirmation_event is not None or confirmation_capability is not None:
            raise PolicyError("confirmation evidence is only valid for confirmed submission")
        else:
            confirmation_revision = None
        with self._lock():
            campaign = self._load_campaign_by_id(campaign_id)
            application = self._load_application(application_ref, campaign["campaignId"])
            if outcome == "confirmed_submitted":
                confirmation = _confirmation_event(
                    confirmation_event,
                    claim_id,
                    campaign["confirmationAuthorityRevision"],
                    confirmation_capability,
                )
                confirmation_revision = confirmation["confirmationRevision"]
            if application["campaignId"] != campaign["campaignId"]:
                raise PolicyError("application campaign does not match")
            attempt = application["attempts"][-1]
            if attempt["leaseId"] != lease_id:
                raise PolicyError("lease is stale or already consumed")
            if attempt["claimId"] != claim_id:
                raise PolicyError("action claim is stale or invalid")
            if outcome == "confirmed_submitted" and (
                parse_time(confirmation["observedAt"]) < parse_time(attempt["claimedAt"])
                or parse_time(confirmation["observedAt"]) > current_time
            ):
                raise PolicyError("confirmation event time is invalid")
            if attempt["outcome"] is not None:
                if attempt["outcome"] != outcome or attempt["confirmationRevision"] != confirmation_revision:
                    raise PolicyError("lease is stale or already consumed")
                receipt = _object(attempt["receipt"], "receipt")
                self._ensure_receipt_logged(receipt)
                return receipt
            if application["status"] != "action_claimed":
                raise PolicyError("application has no active action claim")
            attempt["outcome"] = outcome
            attempt["outcomeAt"] = format_time(current_time)
            attempt["confirmationRevision"] = confirmation_revision
            if outcome == "confirmed_submitted":
                status = "confirmed_submitted"
            elif outcome == "blocked":
                status = "blocked"
            elif attempt["attempt"] == 1:
                status = "retry_available"
            else:
                status = "uncertain_exhausted"
            application["status"] = status
            application["updatedAt"] = format_time(current_time)
            receipt = {
                "schemaVersion": SCHEMA_VERSION,
                "receiptId": _new_reference("receipt"),
                "campaignId": campaign["campaignId"],
                "applicationRef": application_ref,
                "slot": application["slot"],
                "attempt": attempt["attempt"],
                "leaseId": lease_id,
                "claimId": claim_id,
                "outcome": outcome,
                "status": status,
                "at": format_time(current_time),
                "confirmationRevision": confirmation_revision,
            }
            attempt["receipt"] = receipt
            self._validate_application(application)
            _atomic_json(
                self._application_path(application_ref, campaign["campaignId"]),
                application,
            )
            self._ensure_receipt_logged(receipt)
            return receipt

    def _stop_campaign(self, status: str, kill: bool, now: datetime | None) -> dict[str, Any]:
        current_time = now or utc_now()
        with self._lock():
            campaign = self.load_campaign()
            if campaign["killSwitch"] and not kill:
                raise PolicyError("kill switch cannot be cleared by revocation")
            campaign["status"] = status
            campaign["killSwitch"] = kill
            campaign["killSwitchAt"] = format_time(current_time) if kill else None
            self._validate_campaign(campaign)
            _atomic_json(self.campaign_path, campaign)
            return {"mode": "review_only", "reason": status, "campaignId": campaign["campaignId"]}

    def kill(self, now: datetime | None = None) -> dict[str, Any]:
        return self._stop_campaign("killed", True, now)

    def revoke(self, now: datetime | None = None) -> dict[str, Any]:
        return self._stop_campaign("revoked", False, now)


def _read_input(path: str) -> dict[str, Any]:
    try:
        if path == "-":
            return _object(json.load(sys.stdin), "input")
        with Path(path).expanduser().open(encoding="utf-8") as source:
            return _object(json.load(source), "input")
    except (OSError, json.JSONDecodeError) as error:
        raise PolicyError("input is not a readable JSON object") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", help=f"store root (default: ${STORE_ENV} or ~/.job-apply)")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("status")
    activate = commands.add_parser("activate")
    activate.add_argument("--input", required=True)
    authorize = commands.add_parser("authorize")
    authorize.add_argument("--input", required=True)
    claim = commands.add_parser("claim-final-action")
    claim.add_argument("--input", required=True, help="fresh observed identity")
    claim.add_argument("--application-ref", required=True)
    claim.add_argument("--lease-id", required=True)
    claim.add_argument("--attempt", required=True, type=int)
    claim.add_argument("--action-capability", required=True)
    outcome = commands.add_parser("record-outcome")
    outcome.add_argument("--campaign-id", required=True)
    outcome.add_argument("--application-ref", required=True)
    outcome.add_argument("--lease-id", required=True)
    outcome.add_argument("--claim-id", required=True)
    outcome.add_argument("--outcome", required=True, choices=sorted(OUTCOMES))
    outcome.add_argument("--confirmation-event")
    outcome.add_argument("--confirmation-capability")
    commands.add_parser("kill")
    commands.add_parser("revoke")
    return parser


def run(args: argparse.Namespace) -> Any:
    configured = args.root or os.environ.get(STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    store = PolicyStore(root)
    if args.command == "status":
        return store.decision()
    if args.command == "activate":
        return store.activate(_read_input(args.input))
    if args.command == "authorize":
        return store.authorize(_read_input(args.input))
    if args.command == "claim-final-action":
        return store.claim_final_action(
            args.application_ref,
            args.lease_id,
            args.attempt,
            _read_input(args.input),
            args.action_capability,
        )
    if args.command == "record-outcome":
        return store.record_outcome(
            args.campaign_id,
            args.application_ref,
            args.lease_id,
            args.claim_id,
            args.outcome,
            _read_input(args.confirmation_event) if args.confirmation_event else None,
            args.confirmation_capability,
        )
    if args.command == "kill":
        return store.kill()
    if args.command == "revoke":
        return store.revoke()
    raise PolicyError("unsupported command")


def main() -> int:
    args = build_parser().parse_args()
    try:
        result = run(args)
    except PolicyError as error:
        print(f"job-apply-policy: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("job-apply-policy: policy operation failed", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
