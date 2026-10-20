"""Human-only and authorized replay final-action handlers."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import secrets
from typing import Any

from qa.server_auth import INVALID_BODY
from scripts.job_apply_policy import PolicyError


SAFETY_CHECK_KEYS = {
    "loginRequired",
    "captchaPresent",
    "mfaRequired",
    "accountCreationRequired",
    "controlAccessible",
    "redirected",
}


def handle_final_action(handler, max_events: int) -> None:
    value = handler._read_json()
    if value is INVALID_BODY:
        return
    if (
        not isinstance(value, dict)
        or set(value) != {"stepId"}
        or not isinstance(value["stepId"], str)
    ):
        handler._error(400, "invalid final action")
        return
    step = handler.server.steps.get(value["stepId"])
    if (
        step is None
        or step["kind"] != "review"
        or step.get("finalAction", {}).get("enabled") is not True
        or step.get("finalAction", {}).get("tripwire") is not True
    ):
        handler._error(400, "invalid final action")
        return
    with handler.server.state_lock:
        overflow = len(handler.server.events) - max_events + 1
        if overflow > 0:
            del handler.server.events[:overflow]
        handler.server.final_action_activations += 1
        handler.server.events.append(
            {"type": "final-action", "stepId": value["stepId"]}
        )
    handler._error(409, "final action blocked by QA tripwire")


def handle_auto_submit_final_action(handler) -> None:
    """Atomically consume current persisted policy and activate once.

    This route is unavailable without the coordinator's private per-run
    capability and exact loopback Origin.  It does not accept policy or page
    page identity is closed and revalidated by the persisted authority.
    """
    value = handler._read_json()
    if value is INVALID_BODY:
        return
    if (
        not isinstance(value, dict)
        or set(value)
        != {
            "stepId",
            "applicationRef",
            "leaseId",
            "attempt",
            "authorization",
            "safetyChecks",
        }
        or not isinstance(value.get("stepId"), str)
        or not isinstance(value.get("applicationRef"), str)
        or not isinstance(value.get("leaseId"), str)
        or not isinstance(value.get("attempt"), int)
        or isinstance(value.get("attempt"), bool)
        or not isinstance(value.get("authorization"), dict)
    ):
        handler._error(400, "invalid claimed final action")
        return
    safety_checks = value["safetyChecks"]
    if (
        not isinstance(safety_checks, dict)
        or set(safety_checks) != SAFETY_CHECK_KEYS
        or any(not isinstance(item, bool) for item in safety_checks.values())
    ):
        handler._error(400, "invalid claimed final action")
        return
    if (
        safety_checks["loginRequired"]
        or safety_checks["captchaPresent"]
        or safety_checks["mfaRequired"]
        or safety_checks["accountCreationRequired"]
        or not safety_checks["controlAccessible"]
        or safety_checks["redirected"]
    ):
        handler._error(409, "runtime safety boundary blocked final action")
        return
    step = handler.server.steps.get(value["stepId"])
    if (
        step is None
        or step["kind"] != "review"
        or step.get("finalAction") != {
            "id": "final.apply",
            "label": "Submit application",
            "enabled": True,
            "tripwire": True,
        }
    ):
        handler._error(400, "invalid claimed final action")
        return
    policy = handler.server.auto_submit_policy
    if policy is None:
        handler._error(404, "not found")
        return
    confirmation: dict[str, Any] = {}

    def activate(claim: dict[str, Any]) -> None:
        nonlocal confirmation
        with handler.server.state_lock:
            handler.server.final_action_activations += 1
            handler.server.events.append(
                {"type": "final-action", "stepId": value["stepId"]}
            )
            activation_number = handler.server.final_action_activations
        confirmation = {
            "eventId": "receipt:" + secrets.token_hex(32),
            "claimId": claim["claimId"],
            "source": "isolated_loopback",
            "observedAt": datetime.now(timezone.utc).isoformat(
                timespec="seconds"
            ).replace("+00:00", "Z"),
            "confirmationRevision": "sha256:" + hashlib.sha256(
                f"{handler.server.fixture['id']}:{claim['claimId']}:{activation_number}".encode()
            ).hexdigest(),
            "activationObserved": True,
        }
        import hmac
        confirmation["proof"] = hmac.new(
            handler.server.shutdown_token.encode(),
            json.dumps(confirmation, sort_keys=True, separators=(",", ":")).encode(),
            hashlib.sha256,
        ).hexdigest()

    try:
        policy.claim_final_action(
            value["applicationRef"],
            value["leaseId"],
            value["attempt"],
            value["authorization"],
            handler.server.shutdown_token,
            activation=activate,
        )
    except (PolicyError, OSError):
        handler._error(409, "current policy refused final action")
        return
    handler._json(200, confirmation)
