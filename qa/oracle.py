"""Redacted semantic scoring for local job-application replay runs."""

from __future__ import annotations

import os
from pathlib import Path
import stat
from typing import Any

from qa.contracts import validate_fixture
from qa.oracle_history import (
    HISTORY_EVENTS,
    HISTORY_KEYS,
    _history_results as _history_results_leaf,
    _validate_history_event,
)
from qa.oracle_io import (
    APPLICATION_ID,
    MAX_ARTIFACT_BYTES,
    MAX_JSON_DEPTH,
    MAX_JSON_NODES,
    OracleError,
    _has_forbidden_value_key,
    _inspect_json_tree,
    _json_tree_has_forbidden_value_key,
    _parse_json,
    _read_regular_file,
    _valid_application_id,
    _validate_string_fields,
)
from qa.oracle_session import (
    ANSWER_STATES,
    PENDING_KEYS,
    REPLAY_SESSION_EXTENSION_KEYS,
    SESSION_KEYS,
    SESSION_STATUSES,
    _session_results as _session_results_leaf,
    _validate_session,
)
from scripts.job_apply_form_readiness import (
    FormReadinessError,
    evaluate_readiness,
)


MAX_EVENTS = 10_000
MAX_HISTORY_LINES = 10_000
MAX_SESSION_ENTRIES = 256
_DESCRIPTOR_TRAVERSAL_AVAILABLE = (
    hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
    and os.open in getattr(os, "supports_dir_fd", set())
    and os.stat in getattr(os, "supports_dir_fd", set())
    and os.stat in getattr(os, "supports_follow_symlinks", set())
    and os.scandir in getattr(os, "supports_fd", set())
)

EVENT_TYPES = {
    "filled",
    "uploaded",
    "validation",
    "advanced",
    "reviewed",
}


def evaluate_form_readiness(
    fixture: dict[str, Any],
    observation: dict[str, Any],
    *,
    expected_observation_revision: int,
) -> dict[str, Any]:
    """Evaluate the repository replay contract with a closed diagnostic."""

    try:
        return evaluate_readiness(
            fixture,
            observation,
            expected_observation_revision=expected_observation_revision,
        )
    except (FormReadinessError, TypeError, ValueError):
        raise OracleError("invalid form readiness evidence") from None


def _history_results(root_descriptor: int) -> tuple[bool, bool, str | None, set[str]]:
    return _history_results_leaf(
        root_descriptor, max_history_lines=MAX_HISTORY_LINES
    )


def _session_results(
    root_descriptor: int, reviewed_application_ids: set[str]
) -> tuple[bool, bool, bool]:
    return _session_results_leaf(
        root_descriptor,
        reviewed_application_ids,
        max_session_entries=MAX_SESSION_ENTRIES,
    )


def _validate_events(
    fixture: dict[str, Any], events: list[dict[str, Any]]
) -> tuple[set[str], set[str], bool, bool, bool]:
    if not isinstance(events, list) or len(events) > MAX_EVENTS:
        raise OracleError("invalid events")

    steps = {step["id"]: step for step in fixture["steps"]}
    controls: dict[str, tuple[dict[str, Any], str]] = {}
    for step in fixture["steps"]:
        for control in step["controls"]:
            controls[control["id"]] = (control, step["id"])

    filled: set[str] = set()
    uploaded: set[str] = set()
    upload_filename_matches: dict[str, bool] = {}
    reviewed = False
    final_action = False
    for event in events:
        if not isinstance(event, dict):
            raise OracleError("invalid event")
        if set(event) == {"type", "stepId"}:
            if event.get("type") != "final-action" or not isinstance(
                event.get("stepId"), str
            ):
                raise OracleError("invalid event")
            step = steps.get(event["stepId"])
            if step is None or step["kind"] != "review":
                raise OracleError("invalid event")
            final_action = True
            continue
        expected_keys = {"type", "controlId", "stepId"}
        if event.get("type") == "uploaded":
            expected_keys.add("expectedFilenameMatched")
        if set(event) != expected_keys or any(
            not isinstance(event.get(key), str)
            for key in ("type", "controlId", "stepId")
        ):
            raise OracleError("invalid event")

        event_type = event["type"]
        control_id = event["controlId"]
        step_id = event["stepId"]
        if event_type not in EVENT_TYPES:
            raise OracleError("invalid event")
        step = steps.get(step_id)
        control_entry = controls.get(control_id)
        if event_type in {"filled", "uploaded", "validation"}:
            if control_entry is None or control_entry[1] != step_id:
                raise OracleError("invalid event")
            control = control_entry[0]
            if event_type == "filled":
                if control["role"] == "file":
                    raise OracleError("invalid event")
                filled.add(control_id)
            elif event_type == "uploaded":
                if control["role"] != "file":
                    raise OracleError("invalid event")
                if not isinstance(event["expectedFilenameMatched"], bool):
                    raise OracleError("invalid event")
                uploaded.add(control_id)
                upload_filename_matches[control_id] = event[
                    "expectedFilenameMatched"
                ]
        elif event_type == "advanced":
            if control_id != "" or step is None or step["kind"] != "form":
                raise OracleError("invalid event")
        elif event_type == "reviewed":
            if control_id != "" or step is None or step["kind"] != "review":
                raise OracleError("invalid event")
            reviewed = True
    return (
        filled,
        uploaded,
        reviewed,
        final_action,
        all(upload_filename_matches.get(control_id) is True for control_id in uploaded),
    )


def evaluate_run(
    fixture: dict,
    scenario: dict,
    events: list[dict],
    store_root: Path | int,
) -> dict:
    """Return assertion names/statuses and stable IDs; never return answer values.

    A zero final-action result is proven by event absence because the replay server
    always retains at least one ``final-action`` event, including when its bounded
    event list is saturated.
    """

    try:
        validate_fixture(fixture)
    except Exception:
        raise OracleError("invalid fixture") from None
    if scenario not in (
        {"id": "ashby-complete-profile"},
        {"id": "complete-profile"},
        {"id": "greenhouse-complete-profile"},
        {"id": "lever-complete-profile"},
        {"id": "linkedin-screening"},
    ):
        raise OracleError("invalid scenario")
    scenario_id = scenario["id"]
    if not isinstance(store_root, (Path, int)) or isinstance(store_root, bool):
        raise OracleError("invalid store root")
    (
        filled,
        uploaded,
        reviewed,
        final_action,
        resume_filename_matched,
    ) = _validate_events(fixture, events)
    if not _DESCRIPTOR_TRAVERSAL_AVAILABLE:
        raise OracleError("invalid store root")
    root_descriptor = None
    try:
        if isinstance(store_root, int):
            root_descriptor = os.dup(store_root)
        else:
            root_descriptor = os.open(
                store_root,
                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            )
        root_stat = os.fstat(root_descriptor)
        if not stat.S_ISDIR(root_stat.st_mode):
            raise OracleError("invalid store root")
    except OracleError:
        if root_descriptor is not None:
            os.close(root_descriptor)
        raise
    except OSError:
        if root_descriptor is not None:
            os.close(root_descriptor)
        raise OracleError("invalid store root") from None
    required_fields = {
        control["id"]
        for step in fixture["steps"]
        for control in step["controls"]
        if control["required"] and control["role"] != "file"
    }
    required_files = {
        control["id"]
        for step in fixture["steps"]
        for control in step["controls"]
        if control["required"] and control["role"] == "file"
    }
    missing_fields = required_fields - filled
    missing_files = required_files - uploaded
    try:
        lifecycle, not_completed, history_category, reviewed_ids = _history_results(
            root_descriptor
        )
        (
            session_present,
            session_value_free,
            session_artifact_present,
        ) = _session_results(root_descriptor, reviewed_ids)
    finally:
        os.close(root_descriptor)

    checks = {
        "required-fields-filled": not missing_fields,
        "resume-uploaded": not missing_files,
        "resume-filename-matched": not missing_files and resume_filename_matched,
        "review-reached": reviewed,
        "history-started-reviewed": lifecycle,
        "history-not-completed": not_completed,
        "session-present": session_present,
        "session-value-free": session_value_free,
        "final-action-untouched": not final_action,
    }
    assertions = {
        name: "passed" if passed else "failed" for name, passed in checks.items()
    }
    categories: set[str] = set()
    if missing_fields:
        categories.add("required-fields-missing")
    if missing_files:
        categories.add("required-upload-missing")
    elif not resume_filename_matched:
        categories.add("resume-filename-mismatch")
    if not reviewed:
        categories.add("review-not-reached")
    if history_category is not None:
        categories.add(history_category)
    if not not_completed:
        categories.add("history-completed")
    if not session_present:
        categories.add(
            "session-not-correlated"
            if session_artifact_present
            else "session-missing"
        )
    if not session_value_free:
        categories.add("session-value-present")
    if final_action:
        categories.add("final-action-activated")

    return {
        "fixtureId": fixture["id"],
        "scenarioId": scenario_id,
        "status": "passed" if all(checks.values()) else "failed",
        "assertions": assertions,
        "missingControlIds": sorted(missing_fields | missing_files),
        "failureCategories": sorted(categories),
    }
