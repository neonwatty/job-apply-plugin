"""Session history operations composed ahead of the Store facade."""

from __future__ import annotations

import copy
import hmac
import json
import re
import uuid
from pathlib import Path
from typing import Any

from ... import constants, io, normalization, sessions_runtime
from ...constants import _ATS_UNSET
from ...errors import StoreError
from ...validation import sessions


_RUNTIME_PROVIDER = lambda: {}


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its facade's late-bound collaborators."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    if name in runtime:
        return runtime[name]
    if name in {"ANSWER_MATCH_MODULE", "FORM_READINESS_MODULE"}:
        return sessions_runtime.companion({
            "ANSWER_MATCH_MODULE": "job_apply_answer_match",
            "FORM_READINESS_MODULE": "job_apply_form_readiness",
        }[name])
    return _CANONICAL[name]


_CANONICAL = {
    'HISTORY_EVENTS': constants.HISTORY_EVENTS,
    'REPLAY_ATS': constants.REPLAY_ATS,
    'REPLAY_TRANSITIONS': constants.REPLAY_TRANSITIONS,
    'SCHEMA_VERSION': constants.SCHEMA_VERSION,
    '_require_object': io.require_object,
    '_safe_session_id': normalization._safe_session_id,
    '_validate_history_event_for_write': sessions._validate_history_event_for_write,
    '_validate_history_event_record': sessions._validate_history_event_record,
    'exclusive_file_lock': io.exclusive_file_lock,
    'json': json,
    'utc_now': sessions_runtime.utc_now,
    'uuid': uuid,
    'validate_version': io.validate_version,
}


class SessionHistoryMixin:
    """Plain history mixin with no independent Store state."""

    def read_history(self) -> list[dict[str, Any]]:
        if not self.history_path.exists():
            return []
        events: list[dict[str, Any]] = []
        try:
            with self.history_path.open(encoding="utf-8") as source:
                for number, line in enumerate(source, 1):
                    if not line.strip():
                        continue
                    event = _late('json').loads(line)
                    _late('_require_object')(event, f"history line {number}")
                    _late('validate_version')(event, f"history line {number}")
                    _late('_validate_history_event_record')(event)
                    events.append(event)
        except (OSError, UnicodeError, _late('json').JSONDecodeError) as error:
            raise StoreError(f"cannot read valid history JSONL at {self.history_path}") from error
        return events


    def append_history(self, incoming: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        allowed = {
            "applicationId",
            "event",
            "company",
            "role",
            "ats",
            "status",
            "answerKeys",
            "at",
        }
        unexpected = set(incoming) - allowed
        if unexpected:
            raise StoreError("history event contains unsupported fields")
        application_id = _late('_safe_session_id')(incoming.get("applicationId", ""))
        event_name = incoming.get("event")
        answer_keys = incoming.get("answerKeys", [])

        event = {
            "schemaVersion": _late('SCHEMA_VERSION'),
            "eventId": str(_late('uuid').uuid4()),
            "at": incoming.get("at") or _late('utc_now')(),
            **incoming,
            "applicationId": application_id,
            "event": event_name,
            "answerKeys": answer_keys,
        }
        _late('_validate_history_event_for_write')(event)
        with _late('exclusive_file_lock')(self.store_lock_path):
            answers = self._load_answers_document()
            for key in event["answerKeys"]:
                resolved = self._resolve_answer_key_in_document(answers, key)
                if resolved not in answers["answers"]:
                    raise StoreError(
                        "history answerKey does not reference an existing answer"
                    )
            self._append_history_event_idempotent_locked(event)
        return event


    def record_replay_transition(
        self, application_id: str, transition: str, ats: str
    ) -> dict[str, Any]:
        """Record one value-free replay lifecycle transition idempotently.

        The replay coordinator serializes calls for a run. This method keeps the
        canonical history/session formats authoritative and repairs a missing
        session if a prior process stopped after the append.
        """

        application_id = _late('_safe_session_id')(application_id)
        if transition not in _late('REPLAY_TRANSITIONS'):
            raise StoreError("replay transition is unsupported")
        if ats not in _late('REPLAY_ATS'):
            raise StoreError("replay ATS is unsupported")

        self.initialize()
        history = self.read_history()
        application_events = [
            event
            for event in history
            if event["applicationId"] == application_id
            and event["event"] in _late('HISTORY_EVENTS')
        ]
        if any(
            event.get("ats") not in {None, ats} for event in application_events
        ):
            raise StoreError("replay lifecycle ATS does not match")
        names = [event["event"] for event in application_events]
        if any(name in {"completed", "abandoned", "failed"} for name in names):
            raise StoreError("replay lifecycle is terminal")

        started_indexes = [
            index for index, name in enumerate(names) if name == "started"
        ]
        reviewed_indexes = [
            index for index, name in enumerate(names) if name == "reviewed"
        ]
        if reviewed_indexes and (
            not started_indexes or reviewed_indexes[0] < started_indexes[0]
        ):
            raise StoreError("replay lifecycle is out of order")
        if transition == "reviewed" and not started_indexes:
            raise StoreError("replay lifecycle has not started")

        path = self._session_path(application_id)
        session = self.load_session(application_id) if path.exists() else None
        if session is not None:
            if session.get("ats") not in {None, ats}:
                raise StoreError("replay session ATS does not match")
            if session["status"] in {"completed", "abandoned"}:
                raise StoreError("replay session is terminal")

        changed = transition not in names
        if changed:
            self.append_history(
                {
                    "applicationId": application_id,
                    "event": transition,
                    "ats": ats,
                    "status": "active" if transition == "started" else "review",
                    "answerKeys": [],
                }
            )

        session_status = "review" if transition == "reviewed" else "active"
        session_step = "review" if transition == "reviewed" else "application"
        if session is not None:
            if transition == "started" and session["status"] == "review":
                return {
                    "applicationId": application_id,
                    "transition": transition,
                    "changed": changed,
                }
        self.save_session(
            application_id,
            {
                "status": session_status,
                "ats": ats,
                "step": session_step,
                "answerKeys": [],
                "pendingFields": [],
            },
        )
        return {
            "applicationId": application_id,
            "transition": transition,
            "changed": changed,
        }
