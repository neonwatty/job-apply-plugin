"""Closed loopback auto-submit policy verification."""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import secrets
import sys
import tempfile
import threading
from typing import Any

from qa.contracts import ContractError, validate_fixture
from qa.replay.prepare import _read_json
from qa.replay.secure_io import CoordinatorError
from qa.replay.server_control import _opaque, _post_claimed_action, _revision
from qa.server import ReplayHTTPServer
from scripts.job_apply_policy import (
    PolicyError,
    PolicyStore,
    confirmation_authority_revision,
)


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _verify_auto_submit(
    fixture_path: Path, *, _runtime: Any | None = None
) -> dict[str, Any]:
    """Run the closed loopback safety matrix without live network or real data."""

    runtime = _resolve_runtime(_runtime)
    fixture = runtime._read_json(fixture_path, "invalid fixture package")
    try:
        runtime.validate_fixture(fixture)
    except (ContractError, TypeError):
        raise CoordinatorError("invalid fixture package") from None
    review_steps = [step for step in fixture["steps"] if step["kind"] == "review"]
    if len(review_steps) != 1:
        raise CoordinatorError("invalid fixture package")
    review_step_id = review_steps[0]["id"]
    token = runtime.secrets.token_hex(32)
    server = runtime.ReplayHTTPServer(
        fixture,
        0,
        expected_resume_filename="synthetic-resume.pdf",
        shutdown_token=token,
    )
    thread = runtime.threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f"http://127.0.0.1:{server.server_address[1]}"
    application_ref = runtime._opaque("application", "synthetic-application")
    sensitive = {
        "answerRef": runtime._opaque("answer", "synthetic-sensitive-answer"),
        "questionRevision": runtime._revision("synthetic-question-v1"),
        "answerRevision": runtime._revision("synthetic-answer-v1"),
    }
    rule = {
        "applicationRef": application_ref,
        "origin": base_url,
        "urlFingerprint": runtime._revision("synthetic-loopback-url"),
        "ats": "linkedin",
        "jobFingerprint": runtime._revision("synthetic-job"),
        "formRevision": runtime._revision("synthetic-form-v1"),
        "finalControlRevision": runtime._revision("synthetic-final-control-v1"),
    }
    authorization = {
        **rule,
        "resumeRevision": runtime._revision("synthetic-resume-v1"),
        "answerRevisions": [sensitive],
    }
    campaign_input = {
        "riskAcknowledged": True,
        "applicationRules": [rule],
        "resumeRevision": authorization["resumeRevision"],
        "sensitiveAllowlist": [sensitive],
        "confirmationAuthorityRevision": runtime.confirmation_authority_revision(token),
        "maxApplications": 1,
        "durationSeconds": 300,
    }
    checked_at = runtime.datetime.now(runtime.timezone.utc).replace(microsecond=0)
    checks: dict[str, bool] = {}
    scenarios: dict[str, dict[str, Any]] = {}
    try:
        with runtime.tempfile.TemporaryDirectory(prefix="job-apply-auto-submit-") as temporary:
            root = runtime.Path(temporary)

            danger_store = runtime.PolicyStore(root / "danger")
            try:
                danger_store.activate({**campaign_input, "riskAcknowledged": False}, now=checked_at)
                checks["danger-warning-required"] = False
            except PolicyError:
                checks["danger-warning-required"] = True
            checks["review-only-zero-activations"] = server.final_action_activations == 0

            success_store = runtime.PolicyStore(root / "success")
            success_store.activate(campaign_input, now=checked_at)
            lease = success_store.authorize(authorization, now=checked_at)
            server.auto_submit_policy = success_store
            status, confirmation = runtime._post_claimed_action(
                base_url, token, lease, authorization, review_step_id
            )
            before_repeat = server.final_action_activations
            repeat_status, _ = runtime._post_claimed_action(
                base_url, token, lease, authorization, review_step_id
            )
            receipt = success_store.record_outcome(
                lease["campaignId"],
                application_ref,
                lease["leaseId"],
                confirmation["claimId"],
                "confirmed_submitted",
                confirmation_event=confirmation,
                confirmation_capability=token,
                now=runtime.datetime.now(runtime.timezone.utc),
            )
            checks["success-one-claimed-activation"] = (
                status == 200
                and before_repeat == 1
                and repeat_status == 409
                and server.final_action_activations == 1
                and receipt["status"] == "confirmed_submitted"
            )
            checks["independent-confirmation-required"] = (
                confirmation.get("source") == "isolated_loopback"
                and confirmation.get("activationObserved") is True
            )
            scenarios["success"] = {
                "status": "passed" if checks["success-one-claimed-activation"] else "failed",
                "attempts": 1,
                "claimedActivations": 1 if before_repeat == 1 else before_repeat,
                "terminalState": receipt["status"],
            }

            missing_endpoint_store = runtime.PolicyStore(root / "endpoint-missing")
            server.auto_submit_policy = missing_endpoint_store
            review_start = server.final_action_activations
            review_status, review_body = runtime._post_claimed_action(
                base_url, token, lease, authorization, review_step_id
            )
            checks["actual-review-only-refused"] = (
                review_status == 409
                and server.final_action_activations == review_start
            )

            boundary_store = runtime.PolicyStore(root / "boundaries")
            boundary_store.activate(campaign_input, now=checked_at)
            boundary_lease = boundary_store.authorize(authorization, now=checked_at)
            mismatch_denied = True
            for changed in (
                {"origin": "https://redirect.invalid"},
                {"urlFingerprint": runtime._revision("redirected-url")},
                {"formRevision": runtime._revision("changed-form")},
                {"finalControlRevision": runtime._revision("changed-control")},
                {
                    "answerRevisions": [
                        {**sensitive, "answerRevision": runtime._revision("new-sensitive")}
                    ]
                },
            ):
                try:
                    boundary_store.claim_final_action(
                        application_ref,
                        boundary_lease["leaseId"],
                        1,
                        {**authorization, **changed},
                        token,
                        now=checked_at,
                    )
                    mismatch_denied = False
                except PolicyError:
                    pass
            boundary_store.kill(now=checked_at)
            killed_denied = False
            try:
                boundary_store.claim_final_action(
                    application_ref,
                    boundary_lease["leaseId"],
                    1,
                    authorization,
                    token,
                    now=checked_at,
                )
            except PolicyError:
                killed_denied = True

            endpoint_denials = []
            for name, mutate, stop in (
                ("forged", lambda item: {**item, "leaseId": runtime._opaque("lease", "forged")}, None),
                ("prompt", lambda item: {**item, "authorization": {**authorization, "ignorePolicy": True}}, None),
                ("redirect", lambda item: {**item, "authorization": {**authorization, "origin": "https://redirect.invalid"}}, None),
                ("kill", lambda item: item, "kill"),
            ):
                store = runtime.PolicyStore(root / f"endpoint-{name}")
                store.activate(campaign_input, now=checked_at)
                fresh = store.authorize(authorization, now=checked_at)
                server.auto_submit_policy = store
                if stop == "kill":
                    store.kill(now=runtime.datetime.now(runtime.timezone.utc))
                candidate = {
                    "applicationRef": fresh["applicationRef"],
                    "leaseId": fresh["leaseId"],
                    "attempt": fresh["attempt"],
                    "authorization": authorization,
                }
                candidate = mutate(candidate)
                before = server.final_action_activations
                denied_status, denied_body = runtime._post_claimed_action(
                    base_url,
                    token,
                    candidate,
                    candidate["authorization"],
                    review_step_id,
                )
                endpoint_denials.append(
                    denied_status == 409
                    and server.final_action_activations == before
                )
                endpoint_denials.append(token not in runtime.json.dumps(denied_body))

            expiry_endpoint = runtime.PolicyStore(root / "endpoint-expiry")
            expiry_endpoint.activate(
                {**campaign_input, "durationSeconds": 1},
                now=checked_at - runtime.timedelta(seconds=2),
            )
            expiry_lease = expiry_endpoint.authorize(
                authorization, now=checked_at - runtime.timedelta(seconds=2)
            )
            server.auto_submit_policy = expiry_endpoint
            before_expiry = server.final_action_activations
            expiry_status, _ = runtime._post_claimed_action(
                base_url, token, expiry_lease, authorization, review_step_id
            )
            checks["forged-stale-prompt-redirect-kill-expiry-refused"] = (
                all(endpoint_denials)
                and expiry_status == 409
                and server.final_action_activations == before_expiry
            )

            concurrent_store = runtime.PolicyStore(root / "endpoint-concurrent")
            concurrent_store.activate(campaign_input, now=checked_at)
            concurrent_lease = concurrent_store.authorize(
                authorization, now=checked_at
            )
            server.auto_submit_policy = concurrent_store
            concurrent_start = server.final_action_activations
            with runtime.ThreadPoolExecutor(max_workers=4) as executor:
                concurrent_results = list(
                    executor.map(
                        lambda _: runtime._post_claimed_action(
                            base_url,
                            token,
                            concurrent_lease,
                            authorization,
                            review_step_id,
                        )[0],
                        range(4),
                    )
                )
            checks["concurrent-activation-single-winner"] = (
                concurrent_results.count(200) == 1
                and concurrent_results.count(409) == 3
                and server.final_action_activations == concurrent_start + 1
            )

            race_store = runtime.PolicyStore(root / "kill-race")
            race_store.activate(campaign_input, now=checked_at)
            race_lease = race_store.authorize(authorization, now=checked_at)
            activation_entered = runtime.threading.Event()
            activation_release = runtime.threading.Event()
            kill_started = runtime.threading.Event()
            race_activations = []

            def race_activation() -> dict[str, Any]:
                return race_store.claim_final_action(
                    application_ref,
                    race_lease["leaseId"],
                    race_lease["attempt"],
                    authorization,
                    token,
                    activation=lambda claim: (
                        activation_entered.set(),
                        activation_release.wait(2),
                        race_activations.append(claim["claimId"]),
                    ),
                )

            def race_kill() -> dict[str, Any]:
                kill_started.set()
                return runtime.PolicyStore(root / "kill-race").kill()

            with runtime.ThreadPoolExecutor(max_workers=2) as executor:
                activation_future = executor.submit(race_activation)
                activation_entered.wait(2)
                kill_future = executor.submit(race_kill)
                kill_started.wait(2)
                kill_blocked_by_activation = not kill_future.done()
                activation_release.set()
                activation_future.result(timeout=2)
                kill_future.result(timeout=2)
            checks["kill-versus-activation-linearized"] = (
                kill_blocked_by_activation
                and len(race_activations) == 1
                and race_store.decision()["mode"] == "review_only"
            )

            missing_denied = (
                runtime.PolicyStore(root / "missing").authorize(
                    authorization, now=checked_at
                )["mode"]
                == "review_only"
            )
            corrupt_store = runtime.PolicyStore(root / "corrupt")
            corrupt_store.policy_dir.mkdir(parents=True)
            corrupt_store.campaign_path.write_text("{}", encoding="utf-8")
            corrupt_denied = (
                corrupt_store.authorize(authorization, now=checked_at)["mode"]
                == "review_only"
            )
            expiry_store = runtime.PolicyStore(root / "expiry")
            expiry_store.activate(
                {**campaign_input, "durationSeconds": 1}, now=checked_at
            )
            expiry_denied = (
                expiry_store.authorize(
                    authorization,
                    now=checked_at + runtime.timedelta(seconds=1),
                )["mode"]
                == "review_only"
            )

            second_rule = {
                **rule,
                "applicationRef": runtime._opaque(
                    "application", "synthetic-application-2"
                ),
                "urlFingerprint": runtime._revision("synthetic-loopback-url-2"),
                "jobFingerprint": runtime._revision("synthetic-job-2"),
            }
            limit_store = runtime.PolicyStore(root / "limit")
            limit_store.activate(
                {**campaign_input, "applicationRules": [rule, second_rule]},
                now=checked_at,
            )
            limit_store.authorize(authorization, now=checked_at)
            limit_denied = (
                limit_store.authorize(
                    {
                        **authorization,
                        "applicationRef": second_rule["applicationRef"],
                        "urlFingerprint": second_rule["urlFingerprint"],
                        "jobFingerprint": second_rule["jobFingerprint"],
                    },
                    now=checked_at,
                )["mode"]
                == "review_only"
            )

            runtime_store = runtime.PolicyStore(root / "runtime")
            runtime_store.activate(campaign_input, now=checked_at)
            runtime_lease = runtime_store.authorize(
                authorization, now=checked_at
            )
            server.auto_submit_policy = runtime_store
            safe_checks = {
                "loginRequired": False,
                "captchaPresent": False,
                "mfaRequired": False,
                "accountCreationRequired": False,
                "controlAccessible": True,
                "redirected": False,
            }
            runtime_denied = True
            runtime_start = server.final_action_activations
            for boundary in safe_checks:
                unsafe = dict(safe_checks)
                unsafe[boundary] = boundary != "controlAccessible"
                response_status, _ = runtime._post_claimed_action(
                    base_url,
                    token,
                    runtime_lease,
                    authorization,
                    review_step_id,
                    unsafe,
                )
                runtime_denied = runtime_denied and response_status == 409
            checks["all-stop-boundaries-zero-activations"] = (
                mismatch_denied
                and killed_denied
                and missing_denied
                and corrupt_denied
                and expiry_denied
                and limit_denied
                and runtime_denied
                and server.final_action_activations == runtime_start
            )
            checks["denials-and-receipts-redacted"] = (
                token not in runtime.json.dumps(review_body)
                and base_url not in runtime.json.dumps(receipt)
                and set(receipt)
                == {
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
            )
            scenarios["safety-boundaries"] = {
                "status": "passed" if checks["all-stop-boundaries-zero-activations"] else "failed",
                "claimedActivations": 0,
                "terminalState": "review_only",
            }

            retry_store = runtime.PolicyStore(root / "retry")
            retry_store.activate(campaign_input, now=checked_at)
            first = retry_store.authorize(authorization, now=checked_at)
            server.auto_submit_policy = retry_store
            first_activation, first_confirmation = runtime._post_claimed_action(
                base_url, token, first, authorization, review_step_id
            )
            first_receipt = retry_store.record_outcome(
                first["campaignId"],
                application_ref,
                first["leaseId"],
                first_confirmation["claimId"],
                "uncertain",
                now=checked_at,
            )
            second_at = runtime.datetime.now(runtime.timezone.utc)
            second = retry_store.authorize(authorization, now=second_at)
            second_activation, second_confirmation = runtime._post_claimed_action(
                base_url, token, second, authorization, review_step_id
            )
            exhausted = retry_store.record_outcome(
                second["campaignId"],
                application_ref,
                second["leaseId"],
                second_confirmation["claimId"],
                "uncertain",
                now=second_at,
            )
            restarted = runtime.PolicyStore(root / "retry")
            denied = restarted.authorize(authorization, now=second_at)
            checks["one-retry-terminal-exhaustion"] = (
                first_receipt["status"] == "retry_available"
                and first_activation == 200
                and second["attempt"] == 2
                and second_activation == 200
                and exhausted["status"] == "uncertain_exhausted"
                and denied
                == {"mode": "review_only", "reason": "uncertain_exhausted"}
            )
            scenarios["uncertainty-retry"] = {
                "status": "passed" if checks["one-retry-terminal-exhaustion"] else "failed",
                "attempts": 2,
                "claimedActivations": 2,
                "terminalState": exhausted["status"],
            }
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
    return {
        "fixtureId": fixture["id"],
        "status": "passed" if all(checks.values()) else "failed",
        "assertions": {
            key: "passed" if value else "failed"
            for key, value in sorted(checks.items())
        },
        "scenarios": scenarios,
        "redacted": True,
    }
