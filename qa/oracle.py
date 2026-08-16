"""Redacted semantic scoring for local job-application replay runs."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import re
import stat
from typing import Any

from qa.contracts import validate_fixture


MAX_EVENTS = 10_000
MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_HISTORY_LINES = 10_000
MAX_SESSION_ENTRIES = 256
MAX_JSON_DEPTH = 64
MAX_JSON_NODES = 100_000

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
HISTORY_EVENTS = {
    "started",
    "progressed",
    "reviewed",
    "completed",
    "abandoned",
    "failed",
}
HISTORY_KEYS = {
    "schemaVersion",
    "eventId",
    "applicationId",
    "event",
    "company",
    "role",
    "ats",
    "status",
    "answerKeys",
    "at",
}
SESSION_KEYS = {
    "schemaVersion",
    "applicationId",
    "status",
    "ats",
    "company",
    "role",
    "url",
    "step",
    "answerKeys",
    "pendingFields",
    "createdAt",
    "updatedAt",
}
PENDING_KEYS = {"question", "state", "answerKey", "sensitive"}
SESSION_STATUSES = {"active", "review", "completed", "abandoned"}
ANSWER_STATES = {"confirmed", "inferred", "missing", "sensitive"}
APPLICATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class OracleError(ValueError):
    """An invalid untrusted oracle input with a stable, value-free diagnostic."""


def _has_forbidden_value_key(key: str) -> bool:
    lowered = key.lower()
    return lowered == "value" or lowered.endswith("value")


def _json_tree_has_forbidden_value_key(value: Any, diagnostic: str) -> bool:
    stack = [(value, 0)]
    nodes = 0
    forbidden = False
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if depth > MAX_JSON_DEPTH or nodes > MAX_JSON_NODES:
            raise OracleError(diagnostic)
        if isinstance(current, dict):
            for key, child in current.items():
                if not isinstance(key, str):
                    raise OracleError(diagnostic)
                forbidden = forbidden or _has_forbidden_value_key(key)
                stack.append((child, depth + 1))
        elif isinstance(current, list):
            stack.extend((child, depth + 1) for child in current)
    return forbidden


def _inspect_json_tree(value: Any, diagnostic: str) -> None:
    if _json_tree_has_forbidden_value_key(value, diagnostic):
        raise OracleError(diagnostic)


def _validate_string_fields(value: dict[str, Any], fields: set[str]) -> bool:
    return all(
        field not in value
        or value[field] is None
        or isinstance(value[field], str)
        for field in fields
    )


def _valid_application_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and APPLICATION_ID.fullmatch(value) is not None
        and ".." not in value
    )


def _read_regular_file(
    directory_descriptor: int,
    name: str,
    diagnostic: str,
    expected_identity: os.stat_result | None = None,
) -> bytes:
    descriptor = None
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=directory_descriptor,
        )
        try:
            opened_stat = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened_stat.st_mode)
                or opened_stat.st_size > MAX_ARTIFACT_BYTES
                or (
                    expected_identity is not None
                    and (expected_identity.st_dev, expected_identity.st_ino)
                    != (opened_stat.st_dev, opened_stat.st_ino)
                )
            ):
                raise OracleError(diagnostic)
            chunks: list[bytes] = []
            remaining = MAX_ARTIFACT_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > MAX_ARTIFACT_BYTES:
                raise OracleError(diagnostic)
            return data
        finally:
            os.close(descriptor)
            descriptor = None
    except OracleError:
        raise
    except (OSError, ValueError):
        if descriptor is not None:
            os.close(descriptor)
        raise OracleError(diagnostic) from None


def _parse_json(data: bytes, diagnostic: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise OracleError(diagnostic) from None


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


def _validate_history_event(value: Any) -> dict[str, Any]:
    _inspect_json_tree(value, "invalid history artifact")
    if not isinstance(value, dict) or set(value) - HISTORY_KEYS:
        raise OracleError("invalid history artifact")
    if (
        value.get("schemaVersion") != 1
        or isinstance(value.get("schemaVersion"), bool)
        or not _valid_application_id(value.get("applicationId"))
        or value.get("event") not in HISTORY_EVENTS
        or not _validate_string_fields(
            value, {"eventId", "company", "role", "ats", "status", "at"}
        )
    ):
        raise OracleError("invalid history artifact")
    answer_keys = value.get("answerKeys", [])
    if not isinstance(answer_keys, list) or not all(
        isinstance(item, str) for item in answer_keys
    ):
        raise OracleError("invalid history artifact")
    return value


def _history_results(
    root_descriptor: int,
) -> tuple[bool, bool, str | None, set[str]]:
    try:
        data = _read_regular_file(
            root_descriptor,
            "applications.jsonl",
            "invalid history artifact",
        )
    except OracleError as error:
        try:
            os.stat(
                "applications.jsonl",
                dir_fd=root_descriptor,
                follow_symlinks=False,
            )
        except FileNotFoundError:
            return False, True, "history-missing", set()
        except OSError:
            pass
        raise error
    except OSError:
        raise OracleError("invalid history artifact") from None
    lines: list[str] = []
    for physical_line_count, raw_line in enumerate(io.BytesIO(data), 1):
        if physical_line_count > MAX_HISTORY_LINES:
            raise OracleError("invalid history artifact")
        try:
            line = raw_line.decode("utf-8")
        except UnicodeError:
            raise OracleError("invalid history artifact") from None
        if line.strip():
            lines.append(line)
    if not lines:
        return False, True, "history-lifecycle-incomplete", set()

    history: list[dict[str, Any]] = []
    for line in lines:
        try:
            value = json.loads(line)
        except (json.JSONDecodeError, RecursionError):
            raise OracleError("invalid history artifact") from None
        history.append(_validate_history_event(value))

    started_at: dict[str, int] = {}
    lifecycle = False
    reviewed_ids: set[str] = set()
    completed = False
    for index, event in enumerate(history):
        application_id = event["applicationId"]
        if event["event"] == "started" and application_id not in started_at:
            started_at[application_id] = index
        elif event["event"] == "reviewed" and application_id in started_at:
            if started_at[application_id] < index:
                lifecycle = True
                reviewed_ids.add(application_id)
        if event["event"] == "completed":
            completed = True
    category = None if lifecycle else "history-lifecycle-incomplete"
    return lifecycle, not completed, category, reviewed_ids


def _validate_session(value: Any, expected_id: str) -> None:
    _inspect_json_tree(value, "invalid session artifact")
    if not isinstance(value, dict) or set(value) - SESSION_KEYS:
        raise OracleError("invalid session artifact")
    if (
        value.get("schemaVersion") != 1
        or isinstance(value.get("schemaVersion"), bool)
        or not _valid_application_id(value.get("applicationId"))
        or value["applicationId"] != expected_id
        or value.get("status") not in SESSION_STATUSES
        or not _validate_string_fields(
            value,
            {
                "applicationId",
                "status",
                "ats",
                "company",
                "role",
                "url",
                "step",
                "createdAt",
                "updatedAt",
            },
        )
    ):
        raise OracleError("invalid session artifact")
    answer_keys = value.get("answerKeys", [])
    if not isinstance(answer_keys, list) or not all(
        isinstance(item, str) for item in answer_keys
    ):
        raise OracleError("invalid session artifact")
    pending_fields = value.get("pendingFields", [])
    if not isinstance(pending_fields, list):
        raise OracleError("invalid session artifact")
    for pending in pending_fields:
        if not isinstance(pending, dict) or set(pending) - PENDING_KEYS:
            raise OracleError("invalid session artifact")
        if not _validate_string_fields(pending, {"question", "state", "answerKey"}):
            raise OracleError("invalid session artifact")
        if "state" in pending and pending["state"] not in ANSWER_STATES:
            raise OracleError("invalid session artifact")
        if "sensitive" in pending and not isinstance(pending["sensitive"], bool):
            raise OracleError("invalid session artifact")


def _session_results(
    root_descriptor: int, reviewed_application_ids: set[str]
) -> tuple[bool, bool, bool]:
    sessions_descriptor = None
    try:
        sessions_descriptor = os.open(
            "sessions",
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
            dir_fd=root_descriptor,
        )
        directory_stat = os.fstat(sessions_descriptor)
    except FileNotFoundError:
        return False, True, False
    except OSError:
        if sessions_descriptor is not None:
            os.close(sessions_descriptor)
        raise OracleError("invalid session artifacts") from None
    try:
        if not stat.S_ISDIR(directory_stat.st_mode):
            raise OracleError("invalid session artifacts")
        names: list[str] = []
        with os.scandir(sessions_descriptor) as entries:
            for entry_count, entry in enumerate(entries, 1):
                if entry_count > MAX_SESSION_ENTRIES:
                    raise OracleError("invalid session artifacts")
                names.append(entry.name)
    except OracleError:
        os.close(sessions_descriptor)
        raise
    except OSError:
        os.close(sessions_descriptor)
        raise OracleError("invalid session artifacts") from None

    correlated_value_free_session = False
    session_value_free = True
    json_found = False
    try:
        for name in sorted(names):
            try:
                entry_identity = os.stat(
                    name,
                    dir_fd=sessions_descriptor,
                    follow_symlinks=False,
                )
            except OSError:
                raise OracleError("invalid session artifact") from None
            if not stat.S_ISREG(entry_identity.st_mode):
                raise OracleError("invalid session artifact")
            path = Path(name)
            if path.suffix != ".json":
                continue
            json_found = True
            expected_id = path.stem
            if not _valid_application_id(expected_id):
                raise OracleError("invalid session artifact")
            value = _parse_json(
                _read_regular_file(
                    sessions_descriptor,
                    name,
                    "invalid session artifact",
                    entry_identity,
                ),
                "invalid session artifact",
            )
            if _json_tree_has_forbidden_value_key(
                value, "invalid session artifact"
            ):
                session_value_free = False
                continue
            _validate_session(value, expected_id)
            if expected_id in reviewed_application_ids:
                correlated_value_free_session = True
    finally:
        os.close(sessions_descriptor)
    if not json_found:
        return False, True, False
    return correlated_value_free_session, session_value_free, True


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
