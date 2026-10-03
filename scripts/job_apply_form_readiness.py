#!/usr/bin/env python3
"""Deterministic, value-free application-form observation evaluation.

This module validates closed fixture/observation packets. It does not establish
where an observation came from, navigate a browser, transfer a file, inspect
applicant data, or activate a final action. Callers must describe provenance
honestly; a passing report is never independent proof of a live browser state.
"""

from __future__ import annotations

import hashlib
import json
import re
from typing import Any, Iterable, Mapping

from qa.contracts import (
    READINESS_CONTROL_KIND_BY_ROLE,
    READINESS_CONTROL_STATES,
    READINESS_ADAPTER_STATES,
    READINESS_FINAL_CONTROL_STATES,
    READINESS_OBSERVATION_KEYS,
    READINESS_SCHEMA_VERSION,
    READINESS_UPLOAD_CAPABILITY_STATES,
    PLATFORM_CONTROL_KINDS,
    ContractError,
    validate_fixture,
    validate_readiness_observation,
)


PROOF_SCOPE = "closed-observation-only"


def normalize_ats_platform(value: str) -> str:
    """Compare display-style saved ATS names with canonical form platform IDs."""
    return re.sub(r"[ _]+", "-", value.strip().lower())


FORM_MANIFEST_KEYS = {
    "schemaVersion", "platformFamily", "observationRevision",
    "requiredControlIds", "controlSetFingerprint", "complete",
}
LIVE_FORM_KEYS = {"schemaVersion", "platformFamily", "observationRevision", "complete", "controls"}
LIVE_CONTROL_KEYS = {"id", "role", "required"}
LIVE_CONTROL_ID = re.compile(r"[a-z][a-z0-9._-]{0,127}\Z", re.ASCII)


class FormReadinessError(ValueError):
    """A closed readiness-contract failure with a value-free diagnostic."""


def _positive_revision(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise FormReadinessError(f"{label} must be a positive integer")
    return value


def _required_control_ids(fixture: dict[str, Any]) -> list[str]:
    return sorted(
        control["id"]
        for step in fixture["steps"]
        for control in step["controls"]
        if control["required"]
    )


def _control_set_fingerprint(platform_family: str, control_ids: list[str]) -> str:
    payload = json.dumps(
        {
            "platformFamily": platform_family,
            "requiredControlIds": control_ids,
        },
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def make_form_manifest(
    fixture: dict[str, Any], *, observation_revision: int
) -> dict[str, Any]:
    """Attest the complete required-control set observed for this form."""

    revision = _positive_revision(observation_revision, "observation revision")
    try:
        validate_fixture(fixture)
    except Exception:
        raise FormReadinessError("invalid readiness fixture") from None
    control_ids = _required_control_ids(fixture)
    if not control_ids:
        raise FormReadinessError("form manifest requires a required control")
    return {
        "schemaVersion": READINESS_SCHEMA_VERSION,
        "platformFamily": fixture["platformFamily"],
        "observationRevision": revision,
        "requiredControlIds": control_ids,
        "controlSetFingerprint": _control_set_fingerprint(
            fixture["platformFamily"], control_ids
        ),
        "complete": True,
    }


def validate_form_manifest(
    fixture: dict[str, Any], manifest: Any, *, expected_observation_revision: int
) -> None:
    """Fail closed unless the attested complete form exactly matches the fixture."""

    expected = make_form_manifest(
        fixture, observation_revision=expected_observation_revision
    )
    if not isinstance(manifest, dict) or set(manifest) != FORM_MANIFEST_KEYS:
        raise FormReadinessError("invalid form manifest")
    if manifest != expected:
        raise FormReadinessError("form manifest does not match readiness fixture")


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


def validate_live_form(
    form: Any, *, expected_observation_revision: int,
    expected_platform: str | None = None,
) -> dict[str, dict[str, Any]]:
    """Validate a complete, value-free inventory attested from the visible form."""
    revision = _positive_revision(expected_observation_revision, "observation revision")
    if not isinstance(form, dict) or set(form) != LIVE_FORM_KEYS:
        raise FormReadinessError("invalid observed form")
    if (type(form["schemaVersion"]) is not int or form["schemaVersion"] != READINESS_SCHEMA_VERSION
        or type(form["observationRevision"]) is not int or form["observationRevision"] != revision
        or form["complete"] is not True):
        raise FormReadinessError("invalid observed form attestation")
    platform = form["platformFamily"]
    if (not isinstance(platform, str) or platform not in PLATFORM_CONTROL_KINDS
        or (expected_platform and platform != normalize_ats_platform(expected_platform))):
        raise FormReadinessError("observed form platform mismatch")
    raw = form["controls"]
    if not isinstance(raw, list) or not 1 <= len(raw) <= 256:
        raise FormReadinessError("invalid observed form controls")
    controls: dict[str, dict[str, Any]] = {}
    previous = ""
    for control in raw:
        if not isinstance(control, dict) or set(control) != LIVE_CONTROL_KEYS:
            raise FormReadinessError("invalid observed form control")
        control_id = control["id"]
        if (not isinstance(control_id, str) or LIVE_CONTROL_ID.fullmatch(control_id) is None
            or control_id <= previous or not isinstance(control["role"], str)
            or control["role"] not in READINESS_CONTROL_KIND_BY_ROLE
            or type(control["required"]) is not bool):
            raise FormReadinessError("invalid observed form control")
        controls[control_id] = control
        previous = control_id
    if not any(control["required"] for control in controls.values()):
        raise FormReadinessError("observed form has no required control")
    return controls


def make_live_form_manifest(form: dict[str, Any], *, observation_revision: int) -> dict[str, Any]:
    controls = validate_live_form(form, expected_observation_revision=observation_revision)
    required = [control_id for control_id, control in controls.items() if control["required"]]
    payload = json.dumps({"platformFamily": form["platformFamily"], "controls": form["controls"]},
                         ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode("utf-8")
    return {
        "schemaVersion": READINESS_SCHEMA_VERSION,
        "platformFamily": form["platformFamily"],
        "observationRevision": observation_revision,
        "requiredControlIds": required,
        "controlSetFingerprint": "sha256:" + hashlib.sha256(payload).hexdigest(),
        "complete": True,
    }


def validate_live_observation(observation: Any, form: dict[str, Any]) -> None:
    controls = validate_live_form(form, expected_observation_revision=form["observationRevision"])
    if not isinstance(observation, dict) or set(observation) != READINESS_OBSERVATION_KEYS:
        raise FormReadinessError("invalid live observation")
    if (type(observation["schemaVersion"]) is not int or observation["schemaVersion"] != READINESS_SCHEMA_VERSION
        or observation["platformFamily"] != form["platformFamily"]
        or type(observation["observationRevision"]) is not int or observation["observationRevision"] < 1
        or not isinstance(observation["adapterState"], str)
        or observation["adapterState"] not in READINESS_ADAPTER_STATES
        or not isinstance(observation["uploadCapability"], str)
        or observation["uploadCapability"] not in READINESS_UPLOAD_CAPABILITY_STATES
        or not isinstance(observation["finalControlState"], str)
        or observation["finalControlState"] not in READINESS_FINAL_CONTROL_STATES):
        raise FormReadinessError("invalid live observation")
    raw = observation["controls"]
    if not isinstance(raw, list):
        raise FormReadinessError("invalid live observation controls")
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or set(item) != {"controlId", "kind", "state", "observationRevision"}:
            raise FormReadinessError("invalid live observation control")
        control_id = item["controlId"]
        if not isinstance(control_id, str) or control_id not in controls or control_id in seen:
            raise FormReadinessError("invalid live observation control")
        seen.add(control_id)
        kind = READINESS_CONTROL_KIND_BY_ROLE[controls[control_id]["role"]]
        if (item["kind"] != kind or not isinstance(item["state"], str)
            or item["state"] not in READINESS_CONTROL_STATES[kind]
            or type(item["observationRevision"]) is not int or item["observationRevision"] < 1):
            raise FormReadinessError("invalid live observation control")
    errors = observation["validationErrorControlIds"]
    if (not isinstance(errors, list) or any(not isinstance(item, str) for item in errors)
        or errors != sorted(set(errors)) or not set(errors) <= set(controls)):
        raise FormReadinessError("invalid live validation errors")


def make_live_readiness_observation(
    form: dict[str, Any], control_states: Mapping[str, str], *, observation_revision: int,
    adapter_state: str, upload_capability: str,
    validation_error_control_ids: Iterable[str], final_control_state: str,
) -> dict[str, Any]:
    controls = validate_live_form(form, expected_observation_revision=observation_revision)
    if not isinstance(control_states, Mapping) or not set(control_states) <= set(controls):
        raise FormReadinessError("invalid live control states")
    observation = {
        "schemaVersion": READINESS_SCHEMA_VERSION,
        "platformFamily": form["platformFamily"],
        "observationRevision": observation_revision,
        "adapterState": adapter_state,
        "uploadCapability": upload_capability,
        "controls": [{"controlId": control_id,
                      "kind": READINESS_CONTROL_KIND_BY_ROLE[controls[control_id]["role"]],
                      "state": state, "observationRevision": observation_revision}
                     for control_id, state in sorted(control_states.items())],
        "validationErrorControlIds": sorted(validation_error_control_ids),
        "finalControlState": final_control_state,
    }
    validate_live_observation(observation, form)
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
    return _evaluate_controls(
        fixture["platformFamily"], fixture_controls, observation, expected_revision
    )


def evaluate_live_readiness(
    form: dict[str, Any], observation: dict[str, Any], *,
    expected_observation_revision: int,
) -> dict[str, Any]:
    controls = validate_live_form(
        form, expected_observation_revision=expected_observation_revision
    )
    validate_live_observation(observation, form)
    return _evaluate_controls(
        form["platformFamily"], controls, observation,
        expected_observation_revision,
    )


def _evaluate_controls(
    platform_family: str, fixture_controls: dict[str, dict[str, Any]],
    observation: dict[str, Any], expected_revision: int,
) -> dict[str, Any]:
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
        "platformFamily": platform_family,
        "observationRevision": observation["observationRevision"],
        "assertions": {
            name: "passed" if passed else "failed" for name, passed in checks.items()
        },
        "unresolvedControlIds": sorted(unresolved_ids),
        "blockerCodes": sorted(blockers),
        "fallbackCode": fallback_code,
    }
