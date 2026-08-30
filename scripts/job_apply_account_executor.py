#!/usr/bin/env python3
"""Synthetic-only non-final employer-account executor contract."""

from __future__ import annotations

import hashlib
import json
import re
import time
from typing import Any
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit, urlunsplit


FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REALM_REF = re.compile(r"^[0-9a-f]{64}$")
OUTCOMES = {
    "success": "active",
    "reuse": "active",
    "verification": "verification_required",
    "challenge": "verification_required",
    "consent": "verification_required",
    "reset": "reset_required",
    "definitive_failure": "failed_definitive",
    "ambiguity": "ambiguous",
}
TERMINAL_NO_RETRY = {
    "verification_required", "reset_required", "failed_definitive", "ambiguous",
}


class AccountExecutorError(ValueError):
    """A safe synthetic-account executor failure."""


def _fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def synthetic_proofs(target_url: str, _portal_state: str | None = None) -> dict[str, str]:
    """Return lifecycle-independent, value-free synthetic control proofs.

    The caller may retain a scenario label for backwards-compatible fixture
    construction, but it has no influence on any committed proof. Lifecycle is
    learned only from the portal observation produced after the native effect.
    """

    return {
        "syntheticTargetFingerprint": _fingerprint(target_url),
        "observedFormFingerprint": _fingerprint("account-form:v2"),
        "observedControlFingerprint": _fingerprint("account-controls:v2"),
        "secureControlFingerprint": _fingerprint("native-secure-control:v1"),
    }


def operation_fingerprint(target_url: str, realm_ref: str, secure_control_fingerprint: str) -> str:
    target = urlsplit(target_url)
    canonical = urlunsplit((target.scheme, target.netloc, target.path, "", ""))
    return _fingerprint(f"protected-account:v1:{canonical}:{realm_ref}:{secure_control_fingerprint}")


def _positive(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise AccountExecutorError(f"{label} must be a positive integer")
    return value


def validate_request(value: Any) -> dict[str, Any]:
    fields = {
        "jobId", "expectedJobRevision", "expectedClaimId", "realmRef",
        "realmDescriptor", "expectedSettingsRevision", "expectedAccountRevision",
        "syntheticTargetUrl", "syntheticTargetFingerprint", "observedFormFingerprint",
        "observedControlFingerprint", "secureControlFingerprint",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise AccountExecutorError("account execution request contains unsupported fields")
    for field in ("jobId", "expectedClaimId", "realmDescriptor"):
        if not isinstance(value[field], str) or not value[field]:
            raise AccountExecutorError("account execution binding is invalid")
    if not isinstance(value["realmRef"], str) or REALM_REF.fullmatch(value["realmRef"]) is None:
        raise AccountExecutorError("account realm binding is invalid")
    for field in ("expectedJobRevision", "expectedSettingsRevision", "expectedAccountRevision"):
        _positive(value[field], field)
    for field in (
        "syntheticTargetFingerprint", "observedFormFingerprint",
        "observedControlFingerprint", "secureControlFingerprint",
    ):
        if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
            raise AccountExecutorError("account execution fingerprint is invalid")
    try:
        target = urlsplit(value["syntheticTargetUrl"])
        port = target.port
    except (TypeError, ValueError):
        raise AccountExecutorError("synthetic target is invalid") from None
    if (
        target.scheme != "http" or target.hostname != "127.0.0.1" or port is None
        or target.username is not None or target.password is not None
        or target.fragment or target.path != "/synthetic-account"
    ):
        raise AccountExecutorError("only the loopback synthetic account portal is authorized")
    query = parse_qs(target.query, strict_parsing=True)
    operation = operation_fingerprint(value["syntheticTargetUrl"], value["realmRef"], value["secureControlFingerprint"])
    if query != {"operation": [operation.removeprefix("sha256:")]}:
        raise AccountExecutorError("synthetic operation binding is invalid")
    if value["syntheticTargetFingerprint"] != _fingerprint(value["syntheticTargetUrl"]):
        raise AccountExecutorError("synthetic account target proof mismatch")
    if value["secureControlFingerprint"] != _fingerprint("native-secure-control:v1"):
        raise AccountExecutorError("synthetic secure control proof mismatch")
    return value


def observe_synthetic_portal(target_url: str, operation: str) -> dict[str, Any]:
    """Consume browser-created, value-free portal evidence from loopback."""

    target = urlsplit(target_url)
    observation_url = f"http://127.0.0.1:{target.port}/observations/by-operation/{operation.removeprefix('sha256:')}"
    deadline = time.monotonic() + 3
    observed = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(observation_url, timeout=1) as response:
                observed = json.load(response)
            break
        except urllib.error.HTTPError as error:
            if error.code != 404:
                raise AccountExecutorError("synthetic portal observation is unavailable") from error
        except Exception as error:
            raise AccountExecutorError("synthetic portal observation is unavailable") from error
        time.sleep(0.025)
    if observed is None:
        raise AccountExecutorError("synthetic portal observation is unavailable")
    required = {"portalState", "lifecycleState", "formFingerprint", "controlFingerprint"}
    if not isinstance(observed, dict) or set(observed) != required:
        raise AccountExecutorError("synthetic portal observation is invalid")
    portal_state = observed.get("portalState")
    proofs = synthetic_proofs(target_url)
    if portal_state not in OUTCOMES or observed != {
        "portalState": portal_state,
        "lifecycleState": OUTCOMES.get(portal_state),
        "formFingerprint": proofs["observedFormFingerprint"],
        "controlFingerprint": proofs["observedControlFingerprint"],
    }:
        raise AccountExecutorError("synthetic portal observation binding mismatch")
    return observed


def execute_non_final(
    request: dict[str, Any], provider: Any, strategy: str, existing_ref: str | None,
    observer: Any = observe_synthetic_portal,
) -> dict[str, Any]:
    packet = validate_request(request)
    operation = operation_fingerprint(packet["syntheticTargetUrl"], packet["realmRef"], packet["secureControlFingerprint"])
    receipt = provider.provision_or_reuse_and_fill({
        "realmRef": packet["realmRef"],
        "strategy": strategy,
        "existingCredentialRef": existing_ref,
        "secureControlFingerprint": packet["secureControlFingerprint"],
        "syntheticTargetUrl": packet["syntheticTargetUrl"],
        "operationFingerprint": operation,
    })
    observed = observer(packet["syntheticTargetUrl"], operation)
    if observed["formFingerprint"] != packet["observedFormFingerprint"] or observed["controlFingerprint"] != packet["observedControlFingerprint"]:
        raise AccountExecutorError("synthetic portal fingerprint drift")
    state = observed["lifecycleState"]
    return {
        "lifecycleState": state,
        "providerId": receipt["providerId"],
        "credentialRef": receipt["credentialRef"],
        "credentialVersion": receipt["credentialVersion"],
        "reused": receipt["reused"],
        "retryAllowed": False,
        "finalActionAuthorized": False,
        "secureControlCleared": receipt["secureControlCleared"],
    }
