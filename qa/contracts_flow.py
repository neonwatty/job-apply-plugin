from __future__ import annotations

from typing import Any

from qa.contracts_model import (
    FINAL_ACTION,
    FINAL_ACTION_KEYS,
    LEVER_CONTROL_PROFILE,
    ORACLE_KEYS,
    ContractError,
    _closed,
    _non_empty_string,
)


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


def _validate_lever_flow(steps: list[dict[str, Any]]) -> None:
    if (
        len(steps) != 2
        or steps[0].get("id") != "step-1"
        or steps[0].get("kind") != "form"
        or steps[0].get("title") != "Application form"
        or steps[0].get("next") != "review"
        or steps[1].get("id") != "review"
        or steps[1].get("kind") != "review"
        or steps[1].get("title") != "Review application"
        or steps[1].get("controls") != []
    ):
        raise ContractError("unsupported Lever fixture flow")
    observed = tuple(
        (control.get("kind"), control.get("required"))
        for control in steps[0].get("controls", [])
    )
    if observed != LEVER_CONTROL_PROFILE:
        raise ContractError("unsupported Lever fixture flow")


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
