"""Validation and correlation for value-free replay session artifacts."""

from __future__ import annotations

import os
from pathlib import Path
import re
import stat
from typing import Any

from qa.oracle_io import (
    OracleError,
    _inspect_json_tree,
    _json_tree_has_forbidden_value_key,
    _parse_json,
    _read_regular_file,
    _valid_application_id,
    _validate_string_fields,
)
from scripts.job_apply_answer_match import CONFIDENCE_BANDS, REASON_CODES

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
REPLAY_SESSION_EXTENSION_KEYS = {
    "attemptRevision",
    "readiness",
    "blockers",
    "approvals",
    "browserHandoff",
}
PENDING_KEYS = {
    "question", "state", "answerKey", "sensitive", "scopeFingerprint",
    "questionFingerprint", "fieldClass", "matchConfidence", "matchReasonCodes",
    "matchAnswerRevision", "reference",
}
SESSION_STATUSES = {"active", "review", "completed", "abandoned"}
ANSWER_STATES = {"confirmed", "inferred", "missing", "sensitive"}


def _validate_session(value: Any, expected_id: str) -> None:
    _inspect_json_tree(value, "invalid session artifact")
    if not isinstance(value, dict) or set(value) - (
        SESSION_KEYS | REPLAY_SESSION_EXTENSION_KEYS
    ):
        raise OracleError("invalid session artifact")
    extension_keys = set(value) & REPLAY_SESSION_EXTENSION_KEYS
    if extension_keys and extension_keys != REPLAY_SESSION_EXTENSION_KEYS:
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
        if "scopeFingerprint" in pending and (
            not isinstance(pending["scopeFingerprint"], str)
            or re.fullmatch(r"[0-9a-f]{64}", pending["scopeFingerprint"]) is None
        ):
            raise OracleError("invalid session artifact")
        for fingerprint in ("scopeFingerprint", "questionFingerprint"):
            if fingerprint in pending and (
                not isinstance(pending[fingerprint], str)
                or re.fullmatch(r"[0-9a-f]{64}", pending[fingerprint]) is None
            ):
                raise OracleError("invalid session artifact")
        if "reference" in pending and (
            not isinstance(pending["reference"], str)
            or re.fullmatch(r"pending_[a-f0-9]{32}", pending["reference"]) is None
        ):
            raise OracleError("invalid session artifact")
        if "fieldClass" in pending and (
            not isinstance(pending["fieldClass"], str)
            or re.fullmatch(r"[a-z][a-z0-9_]{0,63}", pending["fieldClass"])
            is None
        ):
            raise OracleError("invalid session artifact")
        if (
            "matchConfidence" in pending
            and pending["matchConfidence"] not in CONFIDENCE_BANDS
        ):
            raise OracleError("invalid session artifact")
        if "matchReasonCodes" in pending and (
            not isinstance(pending["matchReasonCodes"], list)
            or not all(code in REASON_CODES for code in pending["matchReasonCodes"])
        ):
            raise OracleError("invalid session artifact")
        if "matchAnswerRevision" in pending and (
            not isinstance(pending["matchAnswerRevision"], int)
            or isinstance(pending["matchAnswerRevision"], bool)
            or pending["matchAnswerRevision"] < 1
        ):
            raise OracleError("invalid session artifact")
    if extension_keys:
        handoff = value["browserHandoff"]
        expected_handoff = {
            "active": ("not_required", "none"),
            "review": ("ready_for_owner", "final-review-required"),
        }.get(value["status"])
        if (
            value["attemptRevision"] is not None
            or value["readiness"] is not None
            or value["blockers"] != []
            or value["approvals"] != []
            or not isinstance(handoff, dict)
            or set(handoff) != {"state", "reasonCode", "revision"}
            or expected_handoff is None
            or (handoff.get("state"), handoff.get("reasonCode"))
            != expected_handoff
            or not isinstance(handoff.get("revision"), int)
            or isinstance(handoff.get("revision"), bool)
            or handoff["revision"] != 1
        ):
            raise OracleError("invalid session artifact")


def _session_results(
    root_descriptor: int, reviewed_application_ids: set[str], *,
    max_session_entries: int,
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
                if entry_count > max_session_entries:
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
