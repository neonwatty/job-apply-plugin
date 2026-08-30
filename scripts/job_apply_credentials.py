#!/usr/bin/env python3
"""Value-free credential-provider contracts.

Providers may provision or reuse and fill as one protected operation.  No
interface in this module can retrieve, reveal, copy, export, or return a secret.
"""

from __future__ import annotations

import hashlib
import re
from abc import ABC, abstractmethod
from typing import Any


STRATEGIES = {"unique_per_realm", "shared", "custom", "ask_each_time"}
OPAQUE_REF = re.compile(r"^credential_[0-9a-f]{64}$")


class CredentialProviderError(ValueError):
    """A redacted protected-provider failure."""


def _binding(strategy: str, realm_ref: str) -> str:
    if strategy not in {"unique_per_realm", "shared"}:
        raise CredentialProviderError("password strategy requires human attention")
    if not isinstance(realm_ref, str) or re.fullmatch(r"[0-9a-f]{64}", realm_ref) is None:
        raise CredentialProviderError("credential realm reference is invalid")
    return realm_ref if strategy == "unique_per_realm" else "explicit-shared-v1"


def validate_protected_receipt(value: Any, provider_id: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {
        "providerId", "credentialRef", "credentialVersion", "reused", "filled", "secureControlCleared",
    }:
        raise CredentialProviderError("protected provider receipt is invalid")
    if value["providerId"] != provider_id:
        raise CredentialProviderError("protected provider receipt identity mismatch")
    if not isinstance(value["credentialRef"], str) or OPAQUE_REF.fullmatch(value["credentialRef"]) is None:
        raise CredentialProviderError("protected credential reference is invalid")
    if not isinstance(value["credentialVersion"], int) or isinstance(value["credentialVersion"], bool) or value["credentialVersion"] < 1:
        raise CredentialProviderError("protected credential version is invalid")
    if not isinstance(value["reused"], bool) or value["filled"] is not True or value["secureControlCleared"] is not True:
        raise CredentialProviderError("protected provider did not complete compound fill")
    return value


class CredentialProvider(ABC):
    """Platform-neutral, write-only protected credential provider."""

    @property
    @abstractmethod
    def provider_id(self) -> str:
        """Return the adapter-owned stable identifier."""

    @abstractmethod
    def provision_or_reuse_and_fill(self, request: dict[str, Any]) -> dict[str, Any]:
        """Perform the protected compound operation and return metadata only."""


class _SyntheticProtectedProvider(CredentialProvider):
    """Secret-free deterministic double for the committed synthetic portal."""

    provider_id = "synthetic-protected"

    def __init__(self) -> None:
        self._provisioned: set[str] = set()

    def provision_or_reuse_and_fill(self, request: dict[str, Any]) -> dict[str, Any]:
        if not isinstance(request, dict) or set(request) != {
            "realmRef", "strategy", "existingCredentialRef", "secureControlFingerprint",
            "syntheticTargetUrl", "operationFingerprint",
        }:
            raise CredentialProviderError("protected provider request is invalid")
        strategy = request["strategy"]
        expected = "credential_" + hashlib.sha256(_binding(strategy, request["realmRef"]).encode("ascii")).hexdigest()
        existing = request["existingCredentialRef"]
        if existing is not None and existing != expected:
            raise CredentialProviderError("protected credential binding mismatch")
        reused = expected in self._provisioned or existing == expected
        self._provisioned.add(expected)
        return validate_protected_receipt({
            "providerId": self.provider_id,
            "credentialRef": expected,
            "credentialVersion": 1,
            "reused": reused,
            "filled": True,
            "secureControlCleared": True,
        }, self.provider_id)


_SYNTHETIC_TEST_AUTHORITY = object()


def synthetic_provider_for_tests(authority: object) -> CredentialProvider:
    """Construct the deterministic double only for explicit injected tests.

    Product CLI/API code has no access to the authority object and therefore
    cannot select this provider accidentally.
    """

    if authority is not _SYNTHETIC_TEST_AUTHORITY:
        raise CredentialProviderError("synthetic provider requires explicit test injection")
    return _SyntheticProtectedProvider()


def synthetic_test_authority() -> object:
    """Test-only capability; callers must deliberately inject the double."""

    return _SYNTHETIC_TEST_AUTHORITY


def credential_reference(strategy: str, realm_ref: str) -> str:
    """Portable opaque slot derivation shared by every credential adapter."""

    return "credential_" + hashlib.sha256(_binding(strategy, realm_ref).encode("ascii")).hexdigest()
