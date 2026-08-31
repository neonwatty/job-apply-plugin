#!/usr/bin/env python3
"""Disabled-by-default, account-creation-only live canary executor seam.

This module contains no browser implementation and no general action API. A
reviewed native adapter may receive only an exact named HTTPS portal plus
value-free account-creation control fingerprints after one T007 capability has
already been durably consumed. There is no representation of a final
application action in either the request or adapter protocol.
"""

from __future__ import annotations

import re
import hashlib
import importlib.util
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REVIEWED_NATIVE_ACCOUNT_CREATION_EFFECTS = frozenset({
    "focus_email_control",
    "fill_email_from_settings",
    "focus_password_control",
    "fill_password_from_keychain",
    "activate_create_account_control",
    "observe_account_creation_outcome",
})
REVIEWED_NATIVE_EMAIL_ONLY_EFFECTS = frozenset({
    "focus_email_control",
    "fill_email_from_canonical_settings",
    "activate_exact_recruiting_terms_consent",
    "activate_exact_candidate_profile_next",
    "observe_candidate_profile_outcome",
})


class LiveCanaryExecutorError(ValueError):
    pass


def _accounts_module():
    spec = importlib.util.spec_from_file_location(
        "job_apply_accounts_canary_executor", Path(__file__).with_name("job_apply_accounts.py")
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


ACCOUNTS = _accounts_module()


def _canary_module():
    spec = importlib.util.spec_from_file_location(
        "job_apply_account_canary_executor_authority",
        Path(__file__).with_name("job_apply_account_canary.py"),
    )
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


CANARY = _canary_module()


def _fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("utf-8")).hexdigest()


def validate_live_request(value: Any) -> dict[str, Any]:
    common = {
        "capabilityRef", "binding", "portalName", "portalUrl",
        "accountFormFingerprint", "emailControlFingerprint",
    }
    password_fields = common | {
        "passwordControlFingerprint", "createAccountControlFingerprint",
    }
    email_only_fields = common | {
        "termsControlFingerprint", "termsDocumentFingerprint", "nextControlFingerprint",
        "passwordControlFingerprint", "createAccountControlFingerprint",
    }
    if not isinstance(value, dict) or set(value) not in (password_fields, email_only_fields):
        raise LiveCanaryExecutorError("live canary request is invalid")
    if not isinstance(value["capabilityRef"], str) or re.fullmatch(r"canary_[0-9a-f]{64}", value["capabilityRef"]) is None:
        raise LiveCanaryExecutorError("live canary capability is invalid")
    if not isinstance(value["portalName"], str) or not value["portalName"].strip() or len(value["portalName"]) > 160:
        raise LiveCanaryExecutorError("live canary portal name is invalid")
    try:
        portal = urlsplit(value["portalUrl"])
        port = portal.port
    except (TypeError, ValueError):
        raise LiveCanaryExecutorError("live canary portal is invalid") from None
    if (
        portal.scheme != "https" or not portal.hostname or portal.username is not None
        or portal.password is not None or portal.fragment or portal.query
        or not portal.path.startswith("/")
        or (port is not None and port != 443)
    ):
        raise LiveCanaryExecutorError("live canary requires one exact named HTTPS portal")
    canonical_url = urlunsplit(("https", portal.netloc, portal.path, "", ""))
    binding = value["binding"]
    if not isinstance(binding, dict):
        raise LiveCanaryExecutorError("live canary binding is invalid")
    for field in set(value) - {"capabilityRef", "binding", "portalName", "portalUrl", "passwordControlFingerprint", "createAccountControlFingerprint"}:
        if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
            raise LiveCanaryExecutorError("live canary control binding is invalid")
    if set(value) == email_only_fields:
        if value["passwordControlFingerprint"] is not None or value["createAccountControlFingerprint"] is not None:
            raise LiveCanaryExecutorError("email-only canary forbids credential controls")
        if binding.get("flowKind") != "email_only_candidate_profile" or binding.get("termsDocumentFingerprint") != value["termsDocumentFingerprint"]:
            raise LiveCanaryExecutorError("email-only canary binding is invalid")
        resolved = ACCOUNTS.normalize_realm(canonical_url)
        if (
            resolved.get("status") != "resolved"
            or resolved.get("adapterId") != "oracle-recruiting"
            or resolved.get("realmRef") != binding.get("realmRef")
            or resolved.get("flowKind") != binding.get("flowKind")
        ):
            raise LiveCanaryExecutorError("email-only canary realm binding is invalid")
        component_fields = (
            "accountFormFingerprint", "emailControlFingerprint",
            "termsControlFingerprint", "termsDocumentFingerprint",
            "nextControlFingerprint",
        )
        aggregate = _fingerprint(":".join(value[field] for field in component_fields))
        if aggregate != binding.get("accountCreationControlsFingerprint"):
            raise LiveCanaryExecutorError("email-only canary aggregate binding is invalid")
        for field in component_fields:
            if binding.get(field) != value[field]:
                raise LiveCanaryExecutorError("email-only canary component binding is invalid")
        if binding.get("passwordControlFingerprint") is not None or binding.get("createAccountControlFingerprint") is not None:
            raise LiveCanaryExecutorError("email-only canary credential binding is invalid")
        if binding.get("portalFingerprint") != _fingerprint(canonical_url):
            raise LiveCanaryExecutorError("email-only canary portal binding is invalid")
        if binding.get("portalNameFingerprint") != _fingerprint(value["portalName"]):
            raise LiveCanaryExecutorError("email-only canary portal name binding is invalid")
    else:
        for field in ("passwordControlFingerprint", "createAccountControlFingerprint"):
            if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
                raise LiveCanaryExecutorError("live canary control binding is invalid")
    return {**value, "portalUrl": canonical_url}


def validate_stable_live_request(value: Any) -> dict[str, Any]:
    """Validate the claim-independent, final owner-approved request."""
    if not isinstance(value, dict) or "capabilityRef" in value:
        raise LiveCanaryExecutorError("stable live canary request is invalid")
    binding = value.get("binding")
    try:
        final_scope = CANARY.validate_final_scope(binding)
        exact_binding = CANARY.execution_binding(
            final_scope, "00000000-0000-4000-8000-000000000000"
        )
        exact = validate_live_request({
            **value, "binding": exact_binding,
            "capabilityRef": "canary_" + "0" * 64,
        })
    except (CANARY.CanaryAuthorityError, LiveCanaryExecutorError) as error:
        raise LiveCanaryExecutorError(str(error)) from None
    exact.pop("capabilityRef")
    exact["binding"] = final_scope
    return exact


class LiveAccountCanaryExecutor:
    """Closed Store-owned T007 boundary with one native email-only adapter."""

    def __init__(self, authority: Any, store: Any, native_provider: Any):
        self._authority = authority
        self._store = store
        self._native_provider = native_provider

    def execute(self, request: dict[str, Any], *, now: datetime) -> dict[str, Any]:
        exact = validate_live_request(request)
        if getattr(self._native_provider, "provider_id", None) != "macos-accessibility":
            raise LiveCanaryExecutorError("live account canary native boundary is unavailable")
        return self._store.execute_live_email_only_account(
            exact, authority=self._authority, provider=self._native_provider, now=now,
        )

    def execute_approved(
        self, request: dict[str, Any], approval_ref: str, *,
        owner_label: str, now: datetime,
    ) -> dict[str, Any]:
        """Acquire/recover, issue, and execute contiguously after stable approval."""
        exact = validate_stable_live_request(request)
        claim = self._store.acquire_or_recover_live_email_only_claim(
            exact, owner_label=owner_label,
        )
        binding = CANARY.execution_binding(exact["binding"], claim["claimId"])
        # Make the top-level attempt recoverable before the separately durable
        # authority ledger is consumed. A retry may safely resume this exact
        # prepared operation only while the approval remains unconsumed.
        self._store.prepare_live_email_only_account_execution(exact, binding)
        capability = self._authority.issue(binding, approval_ref, now=now)
        return self.execute(
            {**exact, "binding": binding, "capabilityRef": capability["capabilityRef"]},
            now=now,
        )
