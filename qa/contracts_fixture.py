from __future__ import annotations

from typing import Any

from qa.contracts_flow import (
    _validate_final_action,
    _validate_flow,
    _validate_lever_flow,
    _validate_oracle,
)
from qa.contracts_model import (
    CAPTURE_MONTH,
    CATALOG,
    CONTROL_CHOICES,
    CONTROL_KEYS,
    FIXTURE_ID,
    FIXTURE_KEYS,
    PLATFORM_CONTROL_KINDS,
    PROVENANCE_KEYS,
    SCHEMA_VERSION,
    SHA256,
    STEP_KEYS,
    STEP_KINDS,
    ContractError,
    _closed,
    _non_empty_string,
)


def generic_control(kind: str, required: bool) -> dict[str, Any]:
    if not isinstance(required, bool):
        raise ContractError("control required must be a boolean")
    try:
        role, label = CATALOG[kind]
    except (KeyError, TypeError) as error:
        raise ContractError(f"unsupported control kind: {kind}") from error
    control = {
        "id": kind,
        "kind": kind,
        "role": role,
        "label": label,
        "required": required,
    }
    if kind in CONTROL_CHOICES:
        control["choices"] = list(CONTROL_CHOICES[kind])
    return control


def validate_fixture(value: dict[str, Any]) -> None:
    if not isinstance(value, dict):
        raise ContractError("fixture must be an object")
    _closed(value, FIXTURE_KEYS, "fixture")

    schema_version = value.get("schemaVersion")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != SCHEMA_VERSION
    ):
        raise ContractError("unsupported fixture schemaVersion")

    fixture_id = value.get("id")
    if not isinstance(fixture_id, str) or not FIXTURE_ID.fullmatch(fixture_id):
        raise ContractError("invalid fixture id")
    platform_family = value.get("platformFamily")
    if platform_family not in PLATFORM_CONTROL_KINDS:
        raise ContractError("unsupported platform family")

    capture_month = value.get("captureMonth")
    if (
        not isinstance(capture_month, str)
        or not CAPTURE_MONTH.fullmatch(capture_month)
    ):
        raise ContractError("invalid capture month")

    _non_empty_string(value.get("compilerVersion"), "compilerVersion")
    _validate_provenance(value.get("provenance"), capture_month)

    steps = value.get("steps")
    if not isinstance(steps, list):
        raise ContractError("steps must be an array")

    step_ids: set[str] = set()
    control_ids: set[str] = set()
    review_steps: list[dict[str, Any]] = []
    for step in steps:
        if not isinstance(step, dict):
            raise ContractError("step must be an object")
        _closed(step, STEP_KEYS, "step")

        step_id = _non_empty_string(step.get("id"), "step id")
        step_kind = _non_empty_string(step.get("kind"), "step kind")
        if step_kind not in STEP_KINDS:
            raise ContractError(f"unsupported step kind: {step_kind}")
        _non_empty_string(step.get("title"), "step title")
        if step_id in step_ids:
            raise ContractError("duplicate step id")
        step_ids.add(step_id)

        controls = step.get("controls")
        if not isinstance(controls, list):
            raise ContractError("controls must be an array")
        for control in controls:
            _validate_control(control, control_ids, platform_family)

        if step["kind"] == "review":
            review_steps.append(step)

    if len(review_steps) != 1:
        raise ContractError("review step is required")

    for step in steps:
        if step["kind"] == "review":
            if "next" in step:
                raise ContractError("review step cannot have a next target")
            continue
        next_target = step.get("next")
        if not isinstance(next_target, str) or not next_target.strip():
            raise ContractError("next target must be a non-empty string")
        if next_target not in step_ids:
            raise ContractError("next target does not exist")
        if "finalAction" in step:
            raise ContractError("final action is only allowed on review step")

    _validate_flow(steps, step_ids)
    if platform_family == "lever":
        _validate_lever_flow(steps)
    _validate_final_action(review_steps[0].get("finalAction"))
    _validate_oracle(value.get("oracle"))


def _validate_control(
    control: Any, control_ids: set[str], platform_family: str
) -> None:
    if not isinstance(control, dict):
        raise ContractError("control must be an object")
    _closed(control, CONTROL_KEYS, "control")
    kind = control.get("kind")
    if kind in CATALOG and kind not in PLATFORM_CONTROL_KINDS[platform_family]:
        raise ContractError("control kind is not supported for platform")
    expected_has_choices = kind in CONTROL_CHOICES
    if "choices" in control and not expected_has_choices:
        raise ContractError("control choices are not supported")

    control_id = control.get("id")
    if isinstance(control_id, str) and control_id in control_ids:
        raise ContractError("duplicate control id")
    if isinstance(control_id, str):
        control_ids.add(control_id)

    required = control.get("required")
    if not isinstance(required, bool):
        raise ContractError("control required must be a boolean")
    expected = generic_control(kind, required)
    for key in ("id", "role", "label", "required", "choices"):
        if key not in expected and key not in control:
            continue
        if control.get(key) != expected[key]:
            raise ContractError(f"control {control_id} has non-catalog {key}")


def _validate_provenance(value: Any, fixture_capture_month: str) -> None:
    if not isinstance(value, dict):
        raise ContractError("provenance must be an object")
    _closed(value, PROVENANCE_KEYS, "provenance")
    _non_empty_string(value.get("recorderVersion"), "recorderVersion")

    capture_month = value.get("captureMonth")
    if (
        not isinstance(capture_month, str)
        or not CAPTURE_MONTH.fullmatch(capture_month)
    ):
        raise ContractError("invalid provenance capture month")
    if capture_month != fixture_capture_month:
        raise ContractError("provenance capture month must match fixture")

    digest = value.get("sourceRecordingSha256")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise ContractError("invalid source recording sha256")
