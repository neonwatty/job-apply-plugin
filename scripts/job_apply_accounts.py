#!/usr/bin/env python3
"""Secret-free account automation contracts.

This module is deliberately a control plane.  It normalizes proven portal realms
and describes platform capability, but it cannot create, retrieve, or fill a
credential.
"""

from __future__ import annotations

import hashlib
import re
from typing import Any
from urllib.parse import parse_qsl, urlsplit


REALM_DESCRIPTOR_VERSION = 1
FLOW_PASSWORD = "password_candidate_account"
FLOW_EMAIL_ONLY = "email_only_candidate_profile"
FLOW_ACCOUNT_NOT_REQUIRED = "account_not_required"
LIFECYCLE_STATES = {
    "discovered", "credential_provisioned", "signup_in_progress", "active",
    "verification_required", "reset_required", "failed_definitive", "ambiguous",
}
PASSWORD_STRATEGIES = {"unique_per_realm", "shared", "custom", "ask_each_time"}
_WORKDAY_JOBS = re.compile(
    r"^(?P<tenant>[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.(?P<cell>wd[1-9][0-9]*)\.myworkdayjobs\.com$"
)
_WORKDAY_CORE = re.compile(r"^wd[1-9][0-9]*\.myworkday\.com$")
_ORACLE_HOST = re.compile(
    r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.fa\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.oraclecloud\.com$"
)
_ORACLE_PATH = re.compile(
    r"^/hcmUI/CandidateExperience/(?P<locale>[a-z]{2}(?:-[A-Z]{2})?)/sites/(?P<site>[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?)/job/(?P<job>[1-9][0-9]*)(?:/apply/email)?/?$"
)
_GREENHOUSE_HOSTS = {"boards.greenhouse.io", "job-boards.greenhouse.io"}
_GREENHOUSE_APPLICATION_PATH = re.compile(
    r"^/[a-z0-9](?:[a-z0-9_-]{0,126}[a-z0-9])?/jobs/[1-9][0-9]*/?$"
)
_CREDENTIAL_QUERY_KEY = re.compile(
    r"(?:^|[_-])(?:access[_-]?token|auth|authorization|cookie|credential|passcode|password|recovery|secret|session|token)(?:$|[_-])",
    re.IGNORECASE,
)


class AccountContractError(ValueError):
    """A safe, value-free account contract error."""


def _unresolved(reason: str) -> dict[str, Any]:
    return {"status": "unresolved", "reasonCode": reason}


class WorkdayRealmAdapter:
    """Resolve only Workday authorities that prove tenant identity."""

    adapter_id = "workday"

    def resolve(self, parsed: Any, host: str) -> dict[str, Any]:
        jobs_match = _WORKDAY_JOBS.fullmatch(host)
        if jobs_match is None:
            reason = "ambiguous_auth_gateway" if _WORKDAY_CORE.fullmatch(host) else "adapter_unresolved"
            return _unresolved(reason)
        tenant = jobs_match.group("tenant")
        cell = jobs_match.group("cell")
        descriptor = f"workday:v{REALM_DESCRIPTOR_VERSION}:{cell}:{tenant}"
        return {
            "status": "resolved",
            "adapterId": self.adapter_id,
            "descriptorVersion": REALM_DESCRIPTOR_VERSION,
            "descriptor": descriptor,
            "realmRef": hashlib.sha256(descriptor.encode("utf-8")).hexdigest(),
            "authorityKind": "tenant-host",
            "flowKind": FLOW_PASSWORD,
            "credentialRequired": True,
        }


class OracleRecruitingRealmAdapter:
    """Resolve an Oracle Recruiting tenant and career site, never a job."""

    adapter_id = "oracle-recruiting"

    def resolve(self, parsed: Any, host: str) -> dict[str, Any]:
        if _ORACLE_HOST.fullmatch(host) is None:
            return _unresolved("adapter_unresolved")
        # Oracle identity is intentionally stricter than Workday: no query,
        # encoded path, repeated slash, or alternate CandidateExperience shape.
        if parsed.query or "%" in parsed.path or "//" in parsed.path:
            return _unresolved("oracle_recruiting_path_unproven")
        match = _ORACLE_PATH.fullmatch(parsed.path)
        if match is None:
            return _unresolved("oracle_recruiting_path_unproven")
        site = match.group("site")
        descriptor = f"oracle-recruiting:v{REALM_DESCRIPTOR_VERSION}:{host}:{site}"
        return {
            "status": "resolved",
            "adapterId": self.adapter_id,
            "descriptorVersion": REALM_DESCRIPTOR_VERSION,
            "descriptor": descriptor,
            "realmRef": hashlib.sha256(descriptor.encode("utf-8")).hexdigest(),
            "authorityKind": "tenant-site",
            "flowKind": FLOW_EMAIL_ONLY,
            "credentialRequired": False,
        }


REALM_ADAPTERS = (WorkdayRealmAdapter(), OracleRecruitingRealmAdapter())


def normalize_realm(portal_url: str) -> dict[str, Any]:
    """Resolve a proven adapter-owned tenant realm or fail closed.

    No generic hostname, employer name, ATS family, or job path is used as a
    fallback. Workday shared authentication gateways are ambiguous and are
    rejected; only the tenant-bearing jobs authority is accepted.
    """

    if not isinstance(portal_url, str) or not portal_url.strip():
        return _unresolved("portal_url_required")
    try:
        parsed = urlsplit(portal_url.strip())
        raw_host = parsed.hostname or ""
        # An Oracle tenant host is an exact authority.  Silently accepting a
        # DNS-equivalent trailing dot would produce a different portal string
        # than the one independently observed by the native boundary.
        if raw_host.endswith("."):
            return _unresolved("portal_not_proven")
        host = raw_host.lower()
        port = parsed.port
    except ValueError:
        return _unresolved("portal_url_invalid")
    if parsed.scheme.lower() != "https" or not host or port not in (None, 443):
        return _unresolved("portal_not_proven")
    if parsed.username is not None or parsed.password is not None:
        return _unresolved("portal_url_userinfo_rejected")
    if parsed.fragment:
        return _unresolved("portal_url_fragment_rejected")
    try:
        query = parse_qsl(parsed.query, keep_blank_values=True, strict_parsing=False)
    except ValueError:
        return _unresolved("portal_url_invalid")
    if any(_CREDENTIAL_QUERY_KEY.search(key) for key, _value in query):
        return _unresolved("portal_url_credential_parameter_rejected")
    for adapter in REALM_ADAPTERS:
        result = adapter.resolve(parsed, host)
        if result["status"] == "resolved" or result["reasonCode"] != "adapter_unresolved":
            return result
    return _unresolved("adapter_unresolved")


def classify_account_flow(portal_url: str) -> dict[str, Any]:
    """Classify one reviewed ATS account flow without performing effects.

    Credential-bearing flows retain the exact realm proof returned by
    ``normalize_realm``. Greenhouse is deliberately narrower: only the
    reviewed, query-free ordinary application path is known to be accountless.
    It never becomes a stored employer realm.
    """

    realm = normalize_realm(portal_url)
    if realm["status"] == "resolved":
        return {
            **realm,
            "status": "classified",
            "accountRequired": True,
        }
    try:
        parsed = urlsplit(portal_url.strip()) if isinstance(portal_url, str) else None
        host = (parsed.hostname or "").lower() if parsed is not None else ""
        port = parsed.port if parsed is not None else None
    except (AttributeError, ValueError):
        return realm
    if (
        parsed is not None
        and parsed.scheme.lower() == "https"
        and host in _GREENHOUSE_HOSTS
        and port in (None, 443)
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
        and _GREENHOUSE_APPLICATION_PATH.fullmatch(parsed.path) is not None
    ):
        return {
            "status": "classified",
            "adapterId": "greenhouse",
            "flowKind": FLOW_ACCOUNT_NOT_REQUIRED,
            "credentialRequired": False,
            "accountRequired": False,
        }
    return realm


def discover_capability(platform: str, adapter_registry: tuple[Any, ...] = ()) -> dict[str, Any]:
    """Return a side-effect-free capability description.

    Discovery intentionally performs no Keychain call, executable probe, or
    permission check.  The provider remains unavailable until a protected
    executor is implemented in a separately reviewed slice.
    """

    platform_name = platform.lower()
    selected = next(
        (adapter for adapter in adapter_registry if platform_name.startswith(adapter.platform_prefixes)),
        None,
    )
    if selected is not None:
        capability = selected.discover()
    elif platform_name.startswith("win"):
        capability = {"providerId": None, "state": "unsupported", "reasonCode": "provider_not_implemented_windows"}
    elif platform_name.startswith("linux"):
        capability = {"providerId": None, "state": "unsupported", "reasonCode": "provider_not_implemented_linux"}
    else:
        capability = {"providerId": None, "state": "unsupported", "reasonCode": "platform_unsupported"}
    return {
        **capability,
        "credentialOperationsReady": False,
        "syntheticOperationsReady": capability.get("syntheticOperationsReady", False),
        "discoveryMode": "side_effect_free",
    }


def discover_account_flow_capability(platform: str, adapter_registry: tuple[Any, ...] = ()) -> dict[str, Any]:
    """Discover browser account-flow automation independently of credentials."""

    platform_name = platform.lower()
    selected = next(
        (adapter for adapter in adapter_registry if platform_name.startswith(adapter.platform_prefixes)),
        None,
    )
    if selected is not None:
        capability = selected.discover()
    elif platform_name.startswith("win"):
        capability = {"providerId": None, "state": "unsupported", "reasonCode": "account_flow_not_implemented_windows"}
    elif platform_name.startswith("linux"):
        capability = {"providerId": None, "state": "unsupported", "reasonCode": "account_flow_not_implemented_linux"}
    else:
        capability = {"providerId": None, "state": "unsupported", "reasonCode": "platform_unsupported"}
    return {**capability, "discoveryMode": "side_effect_free"}


def public_settings(record: dict[str, Any]) -> dict[str, Any]:
    """Project settings without returning signup identity."""

    return {
        "enabled": record["enabled"],
        "automaticAccountCreation": record["automaticAccountCreation"],
        "passwordStrategy": record["passwordStrategy"],
        "signupEmailConfigured": record["signupEmail"] is not None,
        "revision": record["revision"],
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
    }


def public_account(record: dict[str, Any]) -> dict[str, Any]:
    """Project account metadata without identity or future provider handles."""

    return {
        "realmRef": record["realmRef"],
        "adapterId": record["adapterId"],
        "descriptorVersion": record["descriptorVersion"],
        "flowKind": record.get("flowKind", FLOW_PASSWORD),
        "credentialRequired": record.get("credentialRequired", True),
        "lifecycleState": record["lifecycleState"],
        "signupEmailOverrideConfigured": record["signupEmailOverride"] is not None,
        "providerAssigned": record["providerId"] is not None,
        "credentialVersion": record["credentialVersion"],
        "revision": record["revision"],
        "createdAt": record["createdAt"],
        "updatedAt": record["updatedAt"],
    }


def companion_settings(record: dict[str, Any]) -> dict[str, Any]:
    """Authenticated loopback projection; identity replacement is write-only."""

    return public_settings(record)


def companion_account(record: dict[str, Any]) -> dict[str, Any]:
    """Authenticated loopback projection; identity replacement is write-only."""

    return public_account(record)
