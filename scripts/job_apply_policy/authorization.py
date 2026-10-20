"""Authorization, lease, and one-winner action-claim operations."""
from __future__ import annotations

import hashlib
import hmac
from datetime import datetime
from typing import Any, Callable

from .model import (
    RULE_FIELDS, SCHEMA_VERSION, PolicyError, _authorization, _digest,
    _new_reference, _reference, confirmation_authority_revision, format_time,
    parse_time, utc_now,
)
from .storage import _private_dir

class AuthorizationMixin:
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
                        self._write_json(application_path, application)
                        return self._authorization_result(application)
                    return {"mode": "review_only", "reason": application["status"]}

                applications = self._campaign_applications(campaign["campaignId"])
                reserved = len(applications)
                if campaign["reservedApplications"] != reserved:
                    campaign["reservedApplications"] = reserved
                    self._write_json(self.campaign_path, campaign)
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
                self._write_json(application_path, application)
                campaign["reservedApplications"] = slot
                self._write_json(self.campaign_path, campaign)
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
            self._write_json(
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
