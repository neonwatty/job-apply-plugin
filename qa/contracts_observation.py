from __future__ import annotations

from typing import Any

from qa.contracts_fixture import validate_fixture
from qa.contracts_model import (
    READINESS_ADAPTER_STATES,
    READINESS_CONTROL_KEYS,
    READINESS_CONTROL_KIND_BY_ROLE,
    READINESS_CONTROL_STATES,
    READINESS_FINAL_CONTROL_STATES,
    READINESS_OBSERVATION_KEYS,
    READINESS_SCHEMA_VERSION,
    READINESS_UPLOAD_CAPABILITY_STATES,
    ContractError,
    _closed,
)


def validate_readiness_observation(
    value: Any, fixture: dict[str, Any]
) -> None:
    """Validate closed, value-free evidence for one fixture revision.

    The observation deliberately carries no source labels, values, filenames,
    paths, URLs, timestamps, browser handles, or application identifiers.
    Control identity and expected kind come only from the committed fixture.
    """

    validate_fixture(fixture)
    if not isinstance(value, dict):
        raise ContractError("readiness observation must be an object")
    _closed(value, READINESS_OBSERVATION_KEYS, "readiness observation")
    if set(value) != READINESS_OBSERVATION_KEYS:
        raise ContractError("readiness observation is incomplete")
    schema_version = value.get("schemaVersion")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != READINESS_SCHEMA_VERSION
    ):
        raise ContractError("unsupported readiness schemaVersion")
    if value.get("platformFamily") != fixture.get("platformFamily"):
        raise ContractError("readiness platform family mismatch")
    revision = value.get("observationRevision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise ContractError("readiness observationRevision must be positive")
    if value.get("adapterState") not in READINESS_ADAPTER_STATES:
        raise ContractError("unsupported readiness adapter state")
    if value.get("uploadCapability") not in READINESS_UPLOAD_CAPABILITY_STATES:
        raise ContractError("unsupported readiness upload capability")
    if value.get("finalControlState") not in READINESS_FINAL_CONTROL_STATES:
        raise ContractError("unsupported readiness final control state")

    fixture_controls = {
        control["id"]: control
        for step in fixture["steps"]
        for control in step["controls"]
    }
    observations = value.get("controls")
    if not isinstance(observations, list):
        raise ContractError("readiness controls must be an array")
    observed_ids: set[str] = set()
    for observed in observations:
        if not isinstance(observed, dict):
            raise ContractError("readiness control must be an object")
        _closed(observed, READINESS_CONTROL_KEYS, "readiness control")
        if set(observed) != READINESS_CONTROL_KEYS:
            raise ContractError("readiness control is incomplete")
        control_id = observed.get("controlId")
        if not isinstance(control_id, str) or control_id not in fixture_controls:
            raise ContractError("readiness control is unknown")
        if control_id in observed_ids:
            raise ContractError("duplicate readiness control")
        observed_ids.add(control_id)
        expected_kind = READINESS_CONTROL_KIND_BY_ROLE.get(
            fixture_controls[control_id]["role"]
        )
        if observed.get("kind") != expected_kind:
            raise ContractError("readiness control kind mismatch")
        if observed.get("state") not in READINESS_CONTROL_STATES[expected_kind]:
            raise ContractError("unsupported readiness control state")
        control_revision = observed.get("observationRevision")
        if (
            not isinstance(control_revision, int)
            or isinstance(control_revision, bool)
            or control_revision < 1
        ):
            raise ContractError(
                "readiness control observationRevision must be positive"
            )

    validation_errors = value.get("validationErrorControlIds")
    if (
        not isinstance(validation_errors, list)
        or not all(isinstance(item, str) for item in validation_errors)
        or len(validation_errors) != len(set(validation_errors))
        or validation_errors != sorted(validation_errors)
        or not set(validation_errors) <= set(fixture_controls)
    ):
        raise ContractError("readiness validation errors are invalid")
