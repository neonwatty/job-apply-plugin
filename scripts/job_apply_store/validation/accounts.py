"""Pure automation-settings and employer-account record validation."""

from __future__ import annotations

import hashlib
import re
from typing import Any

from ..constants import EMAIL_PATTERN
from ..errors import StoreError
from ..io import require_object


def _optional_email(value: Any, label: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise StoreError(f"{label} must be an email address or null")
    normalized = value.strip()
    if len(normalized) > 254 or EMAIL_PATTERN.fullmatch(normalized) is None:
        raise StoreError(f"{label} must be a valid email address")
    return normalized


def _validate_automation_settings_record(
    value: Any, *, accounts_module: Any,
) -> dict[str, Any]:
    record = require_object(value, "automation settings")
    expected = {
        "enabled", "automaticAccountCreation", "signupEmail", "passwordStrategy",
        "revision", "createdAt", "updatedAt",
    }
    if set(record) != expected:
        raise StoreError("automation settings contain unsupported fields")
    if not isinstance(record["enabled"], bool) or not isinstance(
        record["automaticAccountCreation"], bool
    ):
        raise StoreError("automation settings switches must be booleans")
    _optional_email(record["signupEmail"], "signup email")
    if record["passwordStrategy"] not in accounts_module.PASSWORD_STRATEGIES:
        raise StoreError("password strategy is unsupported")
    revision = record["revision"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("automation settings revision must be a positive integer")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(record[field], str) or not record[field]:
            raise StoreError("automation settings timestamp is invalid")
    return record


def _validate_employer_account_record(
    key: str,
    value: Any,
    *,
    accounts_module: Any,
    credentials_module: Any,
) -> dict[str, Any]:
    record = require_object(value, "employer account")
    legacy_expected = {
        "realmRef", "adapterId", "descriptorVersion", "descriptor",
        "signupEmailOverride", "providerId", "credentialRef", "credentialVersion",
        "lifecycleState", "revision", "createdAt", "updatedAt",
    }
    expected = legacy_expected | {"flowKind", "credentialRequired"}
    if set(record) not in (legacy_expected, expected) or record.get("realmRef") != key:
        raise StoreError("employer account record is invalid")
    if not re.fullmatch(r"[0-9a-f]{64}", key):
        raise StoreError("employer account realm reference is invalid")
    descriptor = record["descriptor"]
    adapter_id = record["adapterId"]
    flow_kind = record.get("flowKind", accounts_module.FLOW_PASSWORD)
    credential_required = record.get("credentialRequired", True)
    descriptor_prefix = f"{adapter_id}:v{accounts_module.REALM_DESCRIPTOR_VERSION}:"
    if (
        adapter_id not in {"workday", "oracle-recruiting"}
        or flow_kind
        != {
            "workday": accounts_module.FLOW_PASSWORD,
            "oracle-recruiting": accounts_module.FLOW_EMAIL_ONLY,
        }[adapter_id]
        or credential_required is not (adapter_id == "workday")
        or record["descriptorVersion"] != accounts_module.REALM_DESCRIPTOR_VERSION
        or not isinstance(descriptor, str)
        or not descriptor.startswith(descriptor_prefix)
        or hashlib.sha256(descriptor.encode("utf-8")).hexdigest() != key
    ):
        raise StoreError("employer account realm descriptor is invalid")
    _optional_email(record["signupEmailOverride"], "signup email override")
    provider_id = record["providerId"]
    credential_ref = record["credentialRef"]
    credential_version = record["credentialVersion"]
    lifecycle = record["lifecycleState"]
    if lifecycle not in accounts_module.LIFECYCLE_STATES:
        raise StoreError("account lifecycle state is invalid")
    if provider_id is None:
        provider_free_states = (
            {
                "discovered",
                "signup_in_progress",
                "active",
                "verification_required",
                "failed_definitive",
                "ambiguous",
            }
            if flow_kind == accounts_module.FLOW_EMAIL_ONLY
            else {"discovered", "signup_in_progress", "ambiguous"}
        )
        if (
            credential_ref is not None
            or credential_version is not None
            or lifecycle not in provider_free_states
        ):
            raise StoreError("credential metadata requires the protected provider")
    elif flow_kind == accounts_module.FLOW_EMAIL_ONLY:
        raise StoreError("email-only account cannot have protected credential metadata")
    elif (
        not isinstance(provider_id, str)
        or re.fullmatch(r"[a-z][a-z0-9-]{2,63}", provider_id) is None
        or not isinstance(credential_ref, str)
        or credentials_module.OPAQUE_REF.fullmatch(credential_ref) is None
        or not isinstance(credential_version, int)
        or isinstance(credential_version, bool)
        or credential_version < 1
        or lifecycle == "discovered"
    ):
        raise StoreError("protected credential metadata is invalid")
    revision = record["revision"]
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("employer account revision must be a positive integer")
    for field in ("createdAt", "updatedAt"):
        if not isinstance(record[field], str) or not record[field]:
            raise StoreError("employer account timestamp is invalid")
    return record
