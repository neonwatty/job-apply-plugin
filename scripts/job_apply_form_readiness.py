#!/usr/bin/env python3
"""Deterministic, value-free application-form readiness evaluation.

This module evaluates repository-owned fixture observations only. It does not
navigate a browser, transfer a file, inspect applicant data, or activate a final
action. A passing replay report is never evidence that an external browser
upload bridge works in a live application.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from qa.contracts import (
    READINESS_CONTROL_KIND_BY_ROLE,
    READINESS_SCHEMA_VERSION,
    ContractError,
    validate_fixture,
    validate_readiness_observation,
)


PROOF_SCOPE = "repository-replay-only"


class FormReadinessError(ValueError):
    """A closed readiness-contract failure with a value-free diagnostic."""


def _positive_revision(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise FormReadinessError(f"{label} must be a positive integer")
    return value


def make_readiness_observation(
    fixture: dict[str, Any],
    control_states: Mapping[str, str],
    *,
    observation_revision: int,
    adapter_state: str = "accessible",
    upload_capability: str = "available",
    validation_error_control_ids: Iterable[str] = (),
    final_control_state: str = "available",
) -> dict[str, Any]:
    """Build a closed observation from semantic states, never field values."""

    _positive_revision(observation_revision, "observation revision")
    try:
        validate_fixture(fixture)
    except Exception:
        raise FormReadinessError("invalid readiness fixture") from None
    if not isinstance(control_states, Mapping):
        raise FormReadinessError("invalid readiness control states")
    controls_by_id = {
        control["id"]: control
        for step in fixture["steps"]
        for control in step["controls"]
    }
    if not all(
        isinstance(control_id, str) and isinstance(state, str)
        for control_id, state in control_states.items()
    ):
        raise FormReadinessError("invalid readiness control states")
    validation_ids = list(validation_error_control_ids)
    if not all(isinstance(control_id, str) for control_id in validation_ids):
        raise FormReadinessError("invalid readiness validation errors")
    observation = {
        "schemaVersion": READINESS_SCHEMA_VERSION,
        "platformFamily": fixture["platformFamily"],
        "observationRevision": observation_revision,
        "adapterState": adapter_state,
        "uploadCapability": upload_capability,
        "controls": [
            {
                "controlId": control_id,
                "kind": READINESS_CONTROL_KIND_BY_ROLE[
                    controls_by_id.get(control_id, {}).get("role")
                ],
                "state": state,
                "observationRevision": observation_revision,
            }
            for control_id, state in sorted(control_states.items())
            if control_id in controls_by_id
        ],
        "validationErrorControlIds": sorted(validation_ids),
        "finalControlState": final_control_state,
    }
    # Fail rather than silently dropping an unknown control identifier.
    if set(control_states) != set(item["controlId"] for item in observation["controls"]):
        raise FormReadinessError("invalid readiness control states")
    try:
        validate_readiness_observation(observation, fixture)
    except ContractError:
        raise FormReadinessError("invalid readiness observation") from None
    return observation


def evaluate_readiness(
    fixture: dict[str, Any],
    observation: dict[str, Any],
    *,
    expected_observation_revision: int,
) -> dict[str, Any]:
    """Return a deterministic readiness report containing stable IDs only."""

    expected_revision = _positive_revision(
        expected_observation_revision, "expected observation revision"
    )
    try:
        validate_readiness_observation(observation, fixture)
    except Exception:
        raise FormReadinessError("invalid readiness observation") from None

    fixture_controls = {
        control["id"]: control
        for step in fixture["steps"]
        for control in step["controls"]
    }
    required_ids = {
        control_id
        for control_id, control in fixture_controls.items()
        if control["required"]
    }
    required_upload_ids = {
        control_id
        for control_id in required_ids
        if fixture_controls[control_id]["role"] == "file"
    }
    observed = {
        control["controlId"]: control for control in observation["controls"]
    }
    missing_ids = required_ids - set(observed)
    stale_ids = {
        control_id
        for control_id in required_ids & set(observed)
        if observed[control_id]["observationRevision"] != expected_revision
    }
    incomplete_ids: set[str] = set()
    missing_upload_ids: set[str] = set()
    for control_id in required_ids & set(observed):
        item = observed[control_id]
        accepted_state = "accepted" if item["kind"] == "upload" else "complete"
        if item["state"] != accepted_state:
            incomplete_ids.add(control_id)
            if item["kind"] == "upload" and item["state"] == "missing":
                missing_upload_ids.add(control_id)
    missing_upload_ids |= missing_ids & required_upload_ids

    observation_current = (
        observation["observationRevision"] == expected_revision and not stale_ids
    )
    adapter_accessible = observation["adapterState"] == "accessible"
    required_controls_complete = not (missing_ids | stale_ids | incomplete_ids)
    required_uploads_accepted = not (
        (missing_ids | stale_ids | incomplete_ids) & required_upload_ids
    )
    validation_clear = not observation["validationErrorControlIds"]
    final_control_available = observation["finalControlState"] == "available"
    final_action_untouched = observation["finalControlState"] != "activated"

    checks = {
        "observation-current": observation_current,
        "adapter-accessible": adapter_accessible,
        "required-controls-complete": required_controls_complete,
        "required-uploads-accepted": required_uploads_accepted,
        "validation-clear": validation_clear,
        "final-control-available": final_control_available,
        "final-action-untouched": final_action_untouched,
    }
    blockers: set[str] = set()
    if not observation_current:
        blockers.add("readiness-evidence-stale")
    if not adapter_accessible:
        blockers.add("form-observation-inaccessible")
    if missing_ids:
        blockers.add("required-control-evidence-missing")
    if missing_upload_ids:
        blockers.add("required-upload-missing")
    for control_id in incomplete_ids:
        state = observed[control_id]["state"]
        kind = observed[control_id]["kind"]
        if state == "rejected":
            blockers.add(
                "required-upload-rejected"
                if kind == "upload"
                else "required-control-rejected"
            )
        elif state == "unresolved":
            blockers.add("required-control-unresolved")
        elif state == "inaccessible":
            blockers.add("required-control-inaccessible")
        elif state == "missing" and kind != "upload":
            blockers.add("required-control-incomplete")
    if not validation_clear:
        blockers.add("validation-error-present")
    if observation["finalControlState"] == "activated":
        blockers.add("final-action-activated")
    elif observation["finalControlState"] == "inaccessible":
        blockers.add("final-control-inaccessible")
    elif observation["finalControlState"] == "unavailable":
        blockers.add("final-control-unavailable")

    fallback_code = None
    if (
        missing_upload_ids
        and observation["uploadCapability"] == "external-runtime-unavailable"
    ):
        blockers.add("external-upload-capability-unavailable")
        fallback_code = "owner-upload-required"

    unresolved_ids = (
        missing_ids
        | stale_ids
        | incomplete_ids
        | set(observation["validationErrorControlIds"])
    )
    return {
        "schemaVersion": READINESS_SCHEMA_VERSION,
        "proofScope": PROOF_SCOPE,
        "status": "ready" if all(checks.values()) else "blocked",
        "platformFamily": fixture["platformFamily"],
        "observationRevision": observation["observationRevision"],
        "assertions": {
            name: "passed" if passed else "failed" for name, passed in checks.items()
        },
        "unresolvedControlIds": sorted(unresolved_ids),
        "blockerCodes": sorted(blockers),
        "fallbackCode": fallback_code,
    }

