#!/usr/bin/env python3
"""Platform-neutral, value-free account-flow automation contracts.

Credential storage is intentionally absent. Implementations receive private
identity through a callback and may return only value-free attestations.
"""

from __future__ import annotations

import hashlib
import importlib.util
import re
from pathlib import Path
from typing import Any, Callable, Protocol
from urllib.parse import parse_qs, urlsplit


FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REALM_REF = re.compile(r"^[0-9a-f]{64}$")
EMAIL_ONLY_EFFECTS = frozenset({
    "focus_email_control",
    "fill_email_from_canonical_settings",
    "activate_exact_recruiting_terms_consent",
    "activate_exact_candidate_profile_next",
    "observe_candidate_profile_outcome",
})
EMAIL_ONLY_OUTCOMES = {
    "active": "active",
    "verification_required": "verification_required",
    "failed_definitive": "failed_definitive",
    "ambiguous": "ambiguous",
}
_SYNTHETIC_TEST_AUTHORITY = object()


def _accounts_module():
    spec = importlib.util.spec_from_file_location(
        "job_apply_accounts_account_flows",
        Path(__file__).with_name("job_apply_accounts.py"),
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


ACCOUNTS = _accounts_module()


def synthetic_test_authority() -> object:
    return _SYNTHETIC_TEST_AUTHORITY


class AccountFlowError(ValueError):
    pass


class AccountFlowAutomationProvider(Protocol):
    provider_id: str

    def execute_email_only(
        self, request: dict[str, Any], private_email: Callable[[], str]
    ) -> dict[str, Any]: ...


def fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def aggregate_controls(request: dict[str, Any]) -> str:
    ordered = ":".join(request[field] for field in (
        "accountFormFingerprint", "emailControlFingerprint",
        "termsControlFingerprint", "termsDocumentFingerprint",
        "nextControlFingerprint",
    ))
    return fingerprint(ordered)


def validate_email_only_request(value: Any, *, allow_loopback: bool = False) -> dict[str, Any]:
    fields = {
        "jobId", "jobRevision", "expectedClaimId", "realmRef", "realmDescriptor", "flowKind",
        "accountRevision", "settingsRevision", "portalUrl",
        "accountFormFingerprint", "emailControlFingerprint",
        "termsControlFingerprint", "termsDocumentFingerprint",
        "nextControlFingerprint", "passwordControlFingerprint",
        "createAccountControlFingerprint", "accountCreationControlsFingerprint",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise AccountFlowError("email-only flow request contains unsupported fields")
    if value["flowKind"] != "email_only_candidate_profile":
        raise AccountFlowError("email-only flow kind is invalid")
    if not isinstance(value["jobId"], str) or not value["jobId"] or not isinstance(value["expectedClaimId"], str) or not value["expectedClaimId"]:
        raise AccountFlowError("email-only job binding is invalid")
    if not isinstance(value["realmDescriptor"], str) or not value["realmDescriptor"].startswith("oracle-recruiting:v1:"):
        raise AccountFlowError("email-only realm descriptor is invalid")
    if not isinstance(value["realmRef"], str) or REALM_REF.fullmatch(value["realmRef"]) is None:
        raise AccountFlowError("email-only realm reference is invalid")
    if fingerprint(value["realmDescriptor"]).removeprefix("sha256:") != value["realmRef"]:
        raise AccountFlowError("email-only realm identity mismatch")
    for field in ("jobRevision", "accountRevision", "settingsRevision"):
        if not isinstance(value[field], int) or isinstance(value[field], bool) or value[field] < 1:
            raise AccountFlowError("email-only revision binding is invalid")
    for field in (
        "accountFormFingerprint", "emailControlFingerprint", "termsControlFingerprint",
        "termsDocumentFingerprint", "nextControlFingerprint", "accountCreationControlsFingerprint",
    ):
        if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
            raise AccountFlowError("email-only control binding is invalid")
    if value["passwordControlFingerprint"] is not None or value["createAccountControlFingerprint"] is not None:
        raise AccountFlowError("email-only flow forbids password and create-account controls")
    if aggregate_controls(value) != value["accountCreationControlsFingerprint"]:
        raise AccountFlowError("email-only aggregate control binding mismatch")
    try:
        portal = urlsplit(value["portalUrl"])
        port = portal.port
    except (TypeError, ValueError):
        raise AccountFlowError("email-only portal is invalid") from None
    live = portal.scheme == "https" and portal.hostname and port in (None, 443)
    synthetic = allow_loopback and portal.scheme == "http" and portal.hostname == "127.0.0.1" and port is not None
    synthetic_query = parse_qs(portal.query, strict_parsing=True) if synthetic else {}
    if synthetic and (
        set(synthetic_query) != {"operation"}
        or len(synthetic_query["operation"]) != 1
        or re.fullmatch(r"[0-9a-f]{64}", synthetic_query["operation"][0]) is None
    ):
        raise AccountFlowError("email-only synthetic operation binding is invalid")
    if not (live or synthetic) or portal.username is not None or portal.password is not None or (portal.query and live) or portal.fragment:
        raise AccountFlowError("email-only portal binding is invalid")
    if live:
        resolved = ACCOUNTS.normalize_realm(value["portalUrl"])
        if (
            resolved.get("status") != "resolved"
            or resolved.get("adapterId") != "oracle-recruiting"
            or resolved.get("flowKind") != "email_only_candidate_profile"
            or resolved.get("descriptor") != value["realmDescriptor"]
            or resolved.get("realmRef") != value["realmRef"]
        ):
            raise AccountFlowError("email-only portal realm binding mismatch")
    return dict(value)


def execute_email_only(
    request: dict[str, Any], provider: AccountFlowAutomationProvider,
    private_email: Callable[[], str], *, allow_loopback: bool = False,
    operation_fingerprint: str | None = None,
) -> dict[str, Any]:
    packet = validate_email_only_request(request, allow_loopback=allow_loopback)
    if operation_fingerprint is not None:
        if not isinstance(operation_fingerprint, str) or FINGERPRINT.fullmatch(operation_fingerprint) is None:
            raise AccountFlowError("email-only operation fingerprint is invalid")
        packet = {**packet, "operationFingerprint": operation_fingerprint}
    result = provider.execute_email_only(packet, private_email)
    required = {
        "providerId", "outcome", "retryAllowed", "finalActionAuthorized",
        "emailRemoved", "termsAccepted", "nextActivations", "credentialProviderInvocations",
    }
    if not isinstance(result, dict) or set(result) != required:
        raise AccountFlowError("email-only provider attestation is invalid")
    if result["outcome"] not in EMAIL_ONLY_OUTCOMES:
        raise AccountFlowError("email-only outcome is invalid")
    if (
        result["retryAllowed"] is not False
        or result["finalActionAuthorized"] is not False
        or result["emailRemoved"] is not True
        or result["termsAccepted"] is not True
        or result["nextActivations"] != 1
        or result["credentialProviderInvocations"] != 0
    ):
        raise AccountFlowError("email-only provider violated the reviewed effect contract")
    return {
        "lifecycleState": EMAIL_ONLY_OUTCOMES[result["outcome"]],
        **result,
    }
