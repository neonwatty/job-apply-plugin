#!/usr/bin/env python3
"""macOS adapter registry for the portable credential-provider contract."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import Any, Callable


def _portable_module():
    name = "job_apply_credentials_portable_runtime"
    if name in sys.modules:
        return sys.modules[name]
    path = Path(__file__).with_name("job_apply_credentials.py")
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


PORTABLE = _portable_module()


class MacOSSecurityFrameworkProvider(PORTABLE.CredentialProvider):
    """Adapter for an injected native Security.framework compound bridge."""

    provider_id = "macos-keychain"

    def __init__(self, native_compound_bridge: Callable[[dict[str, Any]], dict[str, Any]] | None = None):
        self._bridge = native_compound_bridge

    @staticmethod
    def credential_reference(strategy: str, realm_ref: str) -> str:
        return PORTABLE.credential_reference(strategy, realm_ref)

    def capability(self, platform: str | None = None) -> dict[str, Any]:
        supported = (platform or sys.platform).lower().startswith("darwin")
        return {
            "providerId": self.provider_id if supported else None,
            "state": "available" if supported else "unsupported",
            "reasonCode": "native_compound_boundary" if supported else "platform_unsupported",
            "credentialOperationsReady": False,
            "syntheticOperationsReady": supported,
            "discoveryMode": "side_effect_free",
        }

    def provision_or_reuse_and_fill(self, request: dict[str, Any]) -> dict[str, Any]:
        if not sys.platform.startswith("darwin"):
            raise PORTABLE.CredentialProviderError("credential provider is unsupported on this platform")
        if self._bridge is None:
            raise PORTABLE.CredentialProviderError("native protected executor is unavailable")
        receipt = PORTABLE.validate_protected_receipt(self._bridge(dict(request)), self.provider_id)
        if receipt["credentialRef"] != self.credential_reference(request.get("strategy"), request.get("realmRef")):
            raise PORTABLE.CredentialProviderError("native credential reference parity mismatch")
        return receipt


def provider_for_platform(platform: str | None = None, bridge=None):
    return MacOSSecurityFrameworkProvider(bridge) if (platform or sys.platform).lower().startswith("darwin") else None


def capability_for_platform(platform: str | None = None) -> dict[str, Any]:
    return MacOSSecurityFrameworkProvider().capability(platform)


class MacOSCapabilityAdapter:
    platform_prefixes = ("darwin",)

    def discover(self) -> dict[str, Any]:
        return capability_for_platform("darwin")


ADAPTER_REGISTRY = (MacOSCapabilityAdapter(),)
