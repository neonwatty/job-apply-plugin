"""Validation and lifecycle scoring for value-free history artifacts."""

from __future__ import annotations

import io
import json
import os
from typing import Any

from qa.oracle_io import (
    OracleError,
    _inspect_json_tree,
    _read_regular_file,
    _valid_application_id,
    _validate_string_fields,
)

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
    root_descriptor: int, *, max_history_lines: int
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
        if physical_line_count > max_history_lines:
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
