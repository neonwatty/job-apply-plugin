"""Durable policy storage primitives and record validation."""
from __future__ import annotations

import fcntl
import json
import os
import tempfile
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any, Iterator

from .model import (
    APPLICATION_FIELDS, APPLICATION_STATUSES, ATTEMPT_FIELDS, LEASE_DURATION,
    OUTCOMES, SCHEMA_VERSION, PolicyError, _authorization, _closed, _digest,
    _fingerprint, _new_reference, _object, _reference, _validate_receipt,
    format_time, parse_time,
)

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


class StorageMixin:
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

    def _write_json(self, path: Path, payload: dict[str, Any]) -> None:
        _atomic_json(path, payload)
