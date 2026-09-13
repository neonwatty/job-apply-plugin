"""Receipt persistence and outcome mutation operations."""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any

from .model import (
    OUTCOMES, SCHEMA_VERSION, PolicyError, _confirmation_event, _new_reference,
    _object, _reference, _validate_receipt, format_time, parse_time, utc_now,
)
from .storage import _private_dir

class OutcomesMixin:
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
            self._write_json(
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
            self._write_json(self.campaign_path, campaign)
            return {"mode": "review_only", "reason": status, "campaignId": campaign["campaignId"]}

    def kill(self, now: datetime | None = None) -> dict[str, Any]:
        return self._stop_campaign("killed", True, now)

    def revoke(self, now: datetime | None = None) -> dict[str, Any]:
        return self._stop_campaign("revoked", False, now)
