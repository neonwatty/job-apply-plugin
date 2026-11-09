#!/usr/bin/env python3
"""Value-free oracle for the synthetic employer-account portal."""

from __future__ import annotations

from typing import Any


SCENARIOS = {
    "success": "active",
    "reuse": "active",
    "verification": "verification_required",
    "challenge": "verification_required",
    "consent": "verification_required",
    "reset": "reset_required",
    "definitive_failure": "failed_definitive",
    "ambiguity": "ambiguous",
    "restart": "ambiguous",
}
ORACLE_EMAIL_ONLY_SCENARIOS = {
    "success": "active",
    "verification": "verification_required",
    "definitive_failure": "failed_definitive",
    "ambiguity": "ambiguous",
}


def evaluate(scenario: str, result: dict[str, Any]) -> dict[str, Any]:
    expected = SCENARIOS.get(scenario)
    passed = (
        expected is not None
        and result.get("lifecycleState") == expected
        and result.get("retryAllowed") is False
        and result.get("finalActionAuthorized") is False
        and result.get("secureControlCleared") is True
    )
    return {"scenario": scenario, "passed": passed, "expectedLifecycle": expected}


def evaluate_email_only(scenario: str, result: dict[str, Any]) -> dict[str, Any]:
    expected = ORACLE_EMAIL_ONLY_SCENARIOS.get(scenario)
    passed = (
        expected is not None
        and result.get("lifecycleState") == expected
        and result.get("retryAllowed") is False
        and result.get("finalActionAuthorized") is False
        and result.get("credentialProviderInvocations") == 0
        and result.get("nextActivations") == 1
        and result.get("emailRemoved") is True
    )
    return {"scenario": scenario, "passed": passed, "expectedLifecycle": expected}
