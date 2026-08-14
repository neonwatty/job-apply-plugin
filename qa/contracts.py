from __future__ import annotations

import re
from typing import Any


SCHEMA_VERSION = 1
FIXTURE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$")
CAPTURE_MONTH = re.compile(r"^20[0-9]{2}-(?:0[1-9]|1[0-2])$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")

FIXTURE_KEYS = {
    "schemaVersion",
    "id",
    "platformFamily",
    "captureMonth",
    "compilerVersion",
    "provenance",
    "steps",
    "oracle",
}
STEP_KEYS = {"id", "kind", "title", "controls", "next", "finalAction"}
STEP_KINDS = {"form", "review"}
CONTROL_KEYS = {"id", "kind", "role", "label", "required", "choices"}
PROVENANCE_KEYS = {"recorderVersion", "captureMonth", "sourceRecordingSha256"}
FINAL_ACTION_KEYS = {"id", "label", "enabled", "tripwire"}
ORACLE_KEYS = {"finalActionActivations"}

CATALOG = {
    "contact.first_name": ("textbox", "First name"),
    "contact.last_name": ("textbox", "Last name"),
    "contact.email": ("textbox", "Email address"),
    "contact.phone": ("textbox", "Phone number"),
    "resume.file": ("file", "Resume"),
    "preference.top_choice": ("checkbox", "Mark as a top choice"),
    "authorization.sponsorship": (
        "radiogroup",
        "Will you require employment visa sponsorship?",
    ),
}
CONTROL_CHOICES = {"authorization.sponsorship": ("Yes", "No")}

FINAL_ACTION = {
    "id": "final.apply",
    "label": "Submit application",
    "enabled": True,
    "tripwire": True,
}


class ContractError(ValueError):
    pass


def _closed(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ContractError(f"unknown {label} key: {sorted(unknown)[0]}")


def _non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{label} must be a non-empty string")
    return value


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
    if value.get("platformFamily") != "linkedin-easy-apply":
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
            _validate_control(control, control_ids)

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
    _validate_final_action(review_steps[0].get("finalAction"))
    _validate_oracle(value.get("oracle"))


def _validate_control(control: Any, control_ids: set[str]) -> None:
    if not isinstance(control, dict):
        raise ContractError("control must be an object")
    _closed(control, CONTROL_KEYS, "control")
    expected_has_choices = control.get("kind") in CONTROL_CHOICES
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
    expected = generic_control(control.get("kind"), required)
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


def _validate_flow(steps: list[dict[str, Any]], step_ids: set[str]) -> None:
    steps_by_id = {step["id"]: step for step in steps}
    current_id = steps[0]["id"]
    visited: set[str] = set()

    while True:
        if current_id in visited:
            raise ContractError("fixture flow contains a cycle")
        visited.add(current_id)

        current_step = steps_by_id[current_id]
        if current_step["kind"] == "review":
            break
        next_id = current_step.get("next")
        if next_id not in steps_by_id:
            raise ContractError("fixture flow must terminate at review")
        current_id = next_id

    if visited != step_ids:
        raise ContractError("fixture flow has unreachable steps")


def _validate_final_action(value: Any) -> None:
    if not isinstance(value, dict):
        raise ContractError("enabled final-action tripwire is required")
    _closed(value, FINAL_ACTION_KEYS, "finalAction")
    if (
        value != FINAL_ACTION
        or not isinstance(value.get("enabled"), bool)
        or not isinstance(value.get("tripwire"), bool)
    ):
        raise ContractError("enabled final-action tripwire is required")


def _validate_oracle(value: Any) -> None:
    if not isinstance(value, dict):
        raise ContractError("oracle must be an object")
    _closed(value, ORACLE_KEYS, "oracle")
    activations = value.get("finalActionActivations")
    if (
        not isinstance(activations, int)
        or isinstance(activations, bool)
        or activations != 0
    ):
        raise ContractError("oracle must require zero final-action activations")
