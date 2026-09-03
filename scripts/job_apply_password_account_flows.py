#!/usr/bin/env python3
"""Portable contracts for password-bearing employer-account flows."""

from __future__ import annotations

import hashlib
import importlib.util
import re
from pathlib import Path
from typing import Any, Callable, Protocol


FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REALM_REF = re.compile(r"^[0-9a-f]{64}$")
CREDENTIAL_REF = re.compile(r"^credential_[0-9a-f]{64}$")
PREPARATION_FIELDS = {
    "jobId", "jobRevision", "realmRef", "realmDescriptor",
    "accountRevision", "settingsRevision", "portalUrl",
}
CONTROL_FIELDS = {
    "accountFormFingerprint", "emailControlFingerprint",
    "passwordControlFingerprint", "createAccountControlFingerprint",
}
PREPARATION_RECEIPT_FIELDS = {
    "providerId", *CONTROL_FIELDS, "accountCreationControlsFingerprint",
    "readOnly", "effectCount",
}
EXECUTION_RECEIPT_FIELDS = {
    "providerId", "credentialProviderId", "credentialRef",
    "credentialVersion", "reused", "outcome", "retryAllowed",
    "finalActionAuthorized", "createAccountActivations",
    "emailControlRemoved", "passwordControlRemoved",
}
OUTCOME_LIFECYCLES = {
    "active": "active",
    "email_verification_required": "verification_required",
    "captcha_required": "verification_required",
    "mfa_required": "verification_required",
    "password_reset_required": "reset_required",
    "failed_definitive": "failed_definitive",
    "ambiguous": "ambiguous",
}


def _accounts_module():
    spec = importlib.util.spec_from_file_location(
        "job_apply_accounts_password_flows",
        Path(__file__).with_name("job_apply_accounts.py"),
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


ACCOUNTS = _accounts_module()


class PasswordAccountFlowError(ValueError):
    """A value-free password-account contract failure."""


class PasswordAccountAutomationProvider(Protocol):
    provider_id: str

    def prepare(self, request: dict[str, Any]) -> dict[str, Any]: ...

    def execute(
        self, request: dict[str, Any], private_email: Callable[[], str]
    ) -> dict[str, Any]: ...


def _positive(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _aggregate_controls(value: dict[str, Any]) -> str:
    ordered = ":".join(value[field] for field in (
        "accountFormFingerprint", "emailControlFingerprint",
        "passwordControlFingerprint", "createAccountControlFingerprint",
    ))
    return "sha256:" + hashlib.sha256(ordered.encode("ascii")).hexdigest()


def validate_password_preparation_request(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != PREPARATION_FIELDS:
        raise PasswordAccountFlowError("password preparation request is invalid")
    if not isinstance(value["jobId"], str) or not value["jobId"]:
        raise PasswordAccountFlowError("password preparation job binding is invalid")
    if not all(_positive(value[field]) for field in (
        "jobRevision", "accountRevision", "settingsRevision"
    )):
        raise PasswordAccountFlowError("password preparation revision binding is invalid")
    if (
        not isinstance(value["realmRef"], str)
        or REALM_REF.fullmatch(value["realmRef"]) is None
        or not isinstance(value["realmDescriptor"], str)
    ):
        raise PasswordAccountFlowError("password preparation realm binding is invalid")
    realm = ACCOUNTS.normalize_realm(value["portalUrl"])
    if (
        realm.get("status") != "resolved"
        or realm.get("adapterId") != "workday"
        or realm.get("flowKind") != ACCOUNTS.FLOW_PASSWORD
        or realm.get("realmRef") != value["realmRef"]
        or realm.get("descriptor") != value["realmDescriptor"]
    ):
        raise PasswordAccountFlowError("password preparation requires an exact Workday realm")
    # The live seam is deliberately narrower than general realm resolution:
    # approval binds one query-free portal string.
    if "?" in value["portalUrl"] or "#" in value["portalUrl"]:
        raise PasswordAccountFlowError("password preparation portal binding is invalid")
    return dict(value)


def validate_password_execution_request(value: Any) -> dict[str, Any]:
    fields = PREPARATION_FIELDS | {
        "expectedClaimId", "strategy", *CONTROL_FIELDS,
        "accountCreationControlsFingerprint",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise PasswordAccountFlowError("password execution request is invalid")
    validate_password_preparation_request({
        field: value[field] for field in PREPARATION_FIELDS
    })
    if not isinstance(value["expectedClaimId"], str) or not value["expectedClaimId"]:
        raise PasswordAccountFlowError("password execution claim binding is invalid")
    if value["strategy"] != "unique_per_realm":
        raise PasswordAccountFlowError("live password execution requires unique-per-realm strategy")
    if any(
        not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None
        for field in CONTROL_FIELDS | {"accountCreationControlsFingerprint"}
    ):
        raise PasswordAccountFlowError("password execution control binding is invalid")
    if _aggregate_controls(value) != value["accountCreationControlsFingerprint"]:
        raise PasswordAccountFlowError("password execution aggregate binding is invalid")
    return dict(value)


def validate_password_preparation_receipt(
    value: Any, provider_id: str
) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != PREPARATION_RECEIPT_FIELDS:
        raise PasswordAccountFlowError("password preparation attestation is invalid")
    if value["providerId"] != provider_id:
        raise PasswordAccountFlowError("password preparation provider mismatch")
    if any(
        not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None
        for field in CONTROL_FIELDS | {"accountCreationControlsFingerprint"}
    ):
        raise PasswordAccountFlowError("password preparation control binding is invalid")
    if _aggregate_controls(value) != value["accountCreationControlsFingerprint"]:
        raise PasswordAccountFlowError("password preparation aggregate binding is invalid")
    if value["readOnly"] is not True or value["effectCount"] != 0:
        raise PasswordAccountFlowError("password preparation performed an effect")
    return dict(value)


def validate_password_receipt(value: Any, provider_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != EXECUTION_RECEIPT_FIELDS:
        raise PasswordAccountFlowError("password execution attestation is invalid")
    if value["providerId"] != provider_id or value["credentialProviderId"] != "macos-keychain":
        raise PasswordAccountFlowError("password execution provider mismatch")
    if (
        not isinstance(value["credentialRef"], str)
        or CREDENTIAL_REF.fullmatch(value["credentialRef"]) is None
        or not _positive(value["credentialVersion"])
        or not isinstance(value["reused"], bool)
    ):
        raise PasswordAccountFlowError("password execution credential metadata is invalid")
    if value["outcome"] not in OUTCOME_LIFECYCLES:
        raise PasswordAccountFlowError("password execution outcome is invalid")
    if (
        value["retryAllowed"] is not False
        or value["finalActionAuthorized"] is not False
        or value["createAccountActivations"] != 1
        or value["emailControlRemoved"] is not True
        or value["passwordControlRemoved"] is not True
    ):
        raise PasswordAccountFlowError("password execution violated the reviewed effect contract")
    return dict(value)


def prepare_password_account(
    request: dict[str, Any], provider: PasswordAccountAutomationProvider
) -> dict[str, Any]:
    packet = validate_password_preparation_request(request)
    provider_id = getattr(provider, "provider_id", None)
    if not isinstance(provider_id, str) or not provider_id:
        raise PasswordAccountFlowError("password preparation provider is unavailable")
    return validate_password_preparation_receipt(provider.prepare(packet), provider_id)


def execute_password_account(
    request: dict[str, Any], provider: PasswordAccountAutomationProvider,
    private_email: Callable[[], str],
) -> dict[str, Any]:
    packet = validate_password_execution_request(request)
    provider_id = getattr(provider, "provider_id", None)
    if not isinstance(provider_id, str) or not provider_id:
        raise PasswordAccountFlowError("password execution provider is unavailable")
    receipt = validate_password_receipt(
        provider.execute(packet, private_email), provider_id
    )
    return {
        **receipt,
        "lifecycleState": OUTCOME_LIFECYCLES[receipt["outcome"]],
        "attentionReason": receipt["outcome"],
    }
