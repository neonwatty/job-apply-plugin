#!/usr/bin/env python3
"""Local, versioned storage helper for the Job Apply plugin.

All successful commands emit JSON on stdout. Errors are deliberately terse and
never include stored values. The helper uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import unicodedata
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA_VERSION = 1
STORE_ENV = "JOB_APPLY_STORE_DIR"
ANSWER_STATES = {"confirmed", "inferred", "missing", "sensitive"}
SENSITIVITY_LEVELS = {"none", "personal", "high"}
HISTORY_EVENTS = {
    "started",
    "progressed",
    "reviewed",
    "completed",
    "abandoned",
    "failed",
}
SESSION_STATUSES = {"active", "review", "completed", "abandoned"}
REPLAY_TRANSITIONS = {"started", "reviewed"}
REPLAY_ATS = {"ashby", "greenhouse", "lever", "linkedin-easy-apply"}
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class StoreError(Exception):
    """An expected, safe-to-display storage failure."""


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StoreError(f"{label} must be a JSON object")
    return value


def _set_private_mode(path: Path, mode: int) -> None:
    if os.name != "nt":
        os.chmod(path, mode)


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    _set_private_mode(path, 0o700)


def _fsync_directory(path: Path) -> None:
    if os.name == "nt":
        return
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    except OSError:
        pass
    finally:
        os.close(descriptor)


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Replace a JSON document atomically without risking the previous file."""

    _ensure_private_dir(path.parent)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, indent=2, sort_keys=True, ensure_ascii=False)
            temporary.write("\n")
            temporary.flush()
            os.fsync(temporary.fileno())
        _set_private_mode(temporary_path, 0o600)
        os.replace(temporary_path, path)
        temporary_path = None
        _set_private_mode(path, 0o600)
        _fsync_directory(path.parent)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        raise StoreError(f"cannot read valid {label} JSON at {path}") from error
    return _require_object(value, label)


def validate_version(document: dict[str, Any], label: str) -> None:
    version = document.get("schemaVersion")
    if not isinstance(version, int):
        raise StoreError(f"{label} has no valid schemaVersion")
    if version > SCHEMA_VERSION:
        raise StoreError(f"{label} uses unsupported future schemaVersion {version}")
    if version != SCHEMA_VERSION:
        raise StoreError(f"{label} uses unsupported schemaVersion {version}")


def normalize_question(question: str) -> str:
    if not isinstance(question, str) or not question.strip():
        raise StoreError("question must be a non-empty string")
    normalized = unicodedata.normalize("NFKC", question).lower().strip()
    normalized = re.sub(r"[^\w\s]", " ", normalized, flags=re.UNICODE)
    return " ".join(normalized.split())


def answer_key(question: str, scope: dict[str, Any] | None = None) -> str:
    normalized = normalize_question(question)
    scope_json = json.dumps(scope or {}, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(
        f"v1\0{normalized}\0{scope_json}".encode("utf-8")
    ).hexdigest()
    return f"question.{digest}"


def _safe_session_id(application_id: str) -> str:
    if (
        not isinstance(application_id, str)
        or not SESSION_ID.fullmatch(application_id)
        or ".." in application_id
    ):
        raise StoreError("application id contains unsupported characters")
    return application_id


def _validate_optional_strings(
    document: dict[str, Any], fields: set[str], label: str
) -> None:
    for field in fields:
        if field in document and document[field] is not None and not isinstance(
            document[field], str
        ):
            raise StoreError(f"{label}.{field} must be a string")


def _validate_answer_record(key: str, value: Any) -> dict[str, Any]:
    record = _require_object(value, "answer record")
    if record.get("key") != key:
        raise StoreError("answer record key does not match its index")
    if record.get("state") not in ANSWER_STATES:
        raise StoreError("answer record state is unsupported")
    sensitivity = record.get("sensitivity", "none")
    if sensitivity not in SENSITIVITY_LEVELS:
        raise StoreError("answer record sensitivity is unsupported")
    question = record.get("question")
    if question is not None and not isinstance(question, str):
        raise StoreError("answer record question must be a string")
    aliases = record.get("aliases", [])
    if not isinstance(aliases, list) or not all(
        isinstance(alias, str) for alias in aliases
    ):
        raise StoreError("answer record aliases must be strings")
    _require_object(record.get("scope", {}), "answer record scope")
    value_present = record.get("value") is not None
    if record["state"] == "confirmed" and not value_present:
        raise StoreError("confirmed answer record has no value")
    if record["state"] == "missing" and value_present:
        raise StoreError("missing answer record contains a value")
    if value_present and (
        record["state"] == "sensitive" or sensitivity != "none"
    ):
        consent = record.get("rememberedWithConsentAt")
        if not isinstance(consent, str) or not consent:
            raise StoreError("sensitive answer record has no remember consent marker")
    _validate_optional_strings(
        record,
        {
            "source",
            "confirmedAt",
            "updatedAt",
            "rememberedWithConsentAt",
        },
        "answer record",
    )
    return record


def _validate_history_event(event: dict[str, Any]) -> None:
    allowed = {
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
    if set(event) - allowed:
        raise StoreError("history event contains unsupported fields")
    _safe_session_id(event.get("applicationId", ""))
    if event.get("event") not in HISTORY_EVENTS:
        raise StoreError("history event type is unsupported")
    answer_keys = event.get("answerKeys", [])
    if not isinstance(answer_keys, list) or not all(
        isinstance(item, str) for item in answer_keys
    ):
        raise StoreError("history answerKeys must be strings")
    _validate_optional_strings(
        event,
        {"eventId", "company", "role", "ats", "status", "at"},
        "history event",
    )


def _validate_session_document(session: dict[str, Any]) -> None:
    allowed = {
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
    if set(session) - allowed:
        raise StoreError("session contains unsupported fields")
    _safe_session_id(session.get("applicationId", ""))
    if session.get("status") not in SESSION_STATUSES:
        raise StoreError("session status is unsupported")
    answer_keys = session.get("answerKeys", [])
    if not isinstance(answer_keys, list) or not all(
        isinstance(item, str) for item in answer_keys
    ):
        raise StoreError("session answerKeys must be strings")
    pending_fields = session.get("pendingFields", [])
    if not isinstance(pending_fields, list):
        raise StoreError("session pendingFields must be a list")
    pending_allowed = {"question", "state", "answerKey", "sensitive"}
    for value in pending_fields:
        field = _require_object(value, "pending field")
        if set(field) - pending_allowed:
            raise StoreError("pending field contains unsupported fields")
        _validate_optional_strings(
            field, {"question", "state", "answerKey"}, "pending field"
        )
        if "state" in field and field["state"] not in ANSWER_STATES:
            raise StoreError("pending field state is unsupported")
        if "sensitive" in field and not isinstance(field["sensitive"], bool):
            raise StoreError("pending field sensitive must be a boolean")
    _validate_optional_strings(
        session,
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
        "session",
    )


def _read_input(path: str) -> dict[str, Any]:
    try:
        if path == "-":
            value = json.load(sys.stdin)
        else:
            with Path(path).expanduser().open(encoding="utf-8") as source:
                value = json.load(source)
    except (OSError, json.JSONDecodeError) as error:
        raise StoreError("input is not a readable JSON object") from error
    return _require_object(value, "input")


class Store:
    def __init__(self, root: Path, legacy_profile: Path | None = None):
        self.root = root.expanduser()
        self.profile_path = self.root / "profile.json"
        self.answers_path = self.root / "answers.json"
        self.history_path = self.root / "applications.jsonl"
        self.sessions_path = self.root / "sessions"
        self.auto_submit_policy_path = self.root / "auto-submit"
        self.legacy_profile = (
            legacy_profile.expanduser()
            if legacy_profile is not None
            else Path.home() / ".claude-job-profile.json"
        )

    def paths(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "root": str(self.root),
            "profile": str(self.profile_path),
            "answers": str(self.answers_path),
            "history": str(self.history_path),
            "sessions": str(self.sessions_path),
            "autoSubmitPolicy": str(self.auto_submit_policy_path),
            "legacyProfile": str(self.legacy_profile),
        }

    def initialize(self) -> dict[str, Any]:
        """Validate existing documents, then create only missing store files."""

        if self.profile_path.exists():
            self._load_profile_document()
        if self.answers_path.exists():
            self._load_answers_document()
        if self.history_path.exists():
            self.read_history()

        _ensure_private_dir(self.root)
        _ensure_private_dir(self.sessions_path)
        migrated = False

        if not self.profile_path.exists():
            profile: dict[str, Any] = {}
            metadata: dict[str, Any] = {
                "createdAt": utc_now(),
                "updatedAt": utc_now(),
            }
            if self.legacy_profile.exists():
                profile = read_json_object(self.legacy_profile, "legacy profile")
                metadata["migratedFrom"] = "~/.claude-job-profile.json"
                metadata["migratedAt"] = utc_now()
                migrated = True
            atomic_write_json(
                self.profile_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "profile": profile,
                    "metadata": metadata,
                },
            )

        if not self.answers_path.exists():
            now = utc_now()
            atomic_write_json(
                self.answers_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "answers": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.history_path.exists():
            descriptor = os.open(
                self.history_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600
            )
            os.close(descriptor)
        _set_private_mode(self.history_path, 0o600)

        return {"initialized": True, "migratedLegacyProfile": migrated, **self.paths()}

    def _load_profile_document(self) -> dict[str, Any]:
        document = read_json_object(self.profile_path, "profile")
        validate_version(document, "profile")
        _require_object(document.get("profile"), "profile.profile")
        _require_object(document.get("metadata"), "profile.metadata")
        return document

    def _load_answers_document(self) -> dict[str, Any]:
        document = read_json_object(self.answers_path, "answers")
        validate_version(document, "answers")
        answers = _require_object(document.get("answers"), "answers.answers")
        _require_object(document.get("metadata"), "answers.metadata")
        for key, record in answers.items():
            if not isinstance(key, str) or not key:
                raise StoreError("answer index keys must be non-empty strings")
            _validate_answer_record(key, record)
        return document

    def get_profile(self) -> dict[str, Any]:
        self.initialize()
        return self._load_profile_document()["profile"]

    def replace_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        document = self._load_profile_document()
        document["profile"] = _require_object(profile, "profile")
        document["metadata"]["updatedAt"] = utc_now()
        atomic_write_json(self.profile_path, document)
        return document["profile"]

    def get_preferences(self) -> dict[str, Any]:
        preferences = self.get_profile().get("preferences", {})
        return _require_object(preferences, "profile.preferences")

    def set_preferences(
        self, preferences: dict[str, Any], replace: bool = False
    ) -> dict[str, Any]:
        self.initialize()
        document = self._load_profile_document()
        profile = document["profile"]
        incoming = _require_object(preferences, "preferences")
        if replace:
            updated = dict(incoming)
        else:
            current = profile.get("preferences", {})
            updated = dict(_require_object(current, "profile.preferences"))
            updated.update(incoming)
        profile["preferences"] = updated
        document["metadata"]["updatedAt"] = utc_now()
        atomic_write_json(self.profile_path, document)
        return updated

    def get_answer(self, key: str) -> dict[str, Any] | None:
        self.initialize()
        answers = self._load_answers_document()["answers"]
        answer = answers.get(key)
        if answer is None:
            return None
        return _require_object(answer, "answer record")

    def find_answer(
        self, question: str, scope: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        self.initialize()
        normalized = normalize_question(question)
        document = self._load_answers_document()
        for record in document["answers"].values():
            item = _require_object(record, "answer record")
            candidates = []
            if isinstance(item.get("question"), str):
                candidates.append(normalize_question(item["question"]))
            aliases = item.get("aliases", [])
            if not isinstance(aliases, list) or not all(
                isinstance(alias, str) for alias in aliases
            ):
                raise StoreError("answer record aliases must be strings")
            candidates.extend(normalize_question(alias) for alias in aliases)
            if normalized in candidates and item.get("scope", {}) == (scope or {}):
                return item
        return document["answers"].get(answer_key(question, scope))

    def put_answer(
        self, incoming: dict[str, Any], remember_sensitive: bool = False
    ) -> dict[str, Any]:
        self.initialize()
        question = incoming.get("question")
        scope = incoming.get("scope", {})
        if not isinstance(scope, dict):
            raise StoreError("answer scope must be a JSON object")
        key = incoming.get("key")
        if key is None:
            if not isinstance(question, str):
                raise StoreError("answer requires a question or explicit key")
            key = answer_key(question, scope)
        if not isinstance(key, str) or not key.strip():
            raise StoreError("answer key must be a non-empty string")

        state = incoming.get("state")
        if state not in ANSWER_STATES:
            raise StoreError("answer state is unsupported")
        sensitivity = incoming.get(
            "sensitivity", "high" if state == "sensitive" else "none"
        )
        if sensitivity not in SENSITIVITY_LEVELS:
            raise StoreError("answer sensitivity is unsupported")
        value = incoming.get("value")
        if state == "confirmed" and value is None:
            raise StoreError("confirmed answers require a value")
        if state == "missing" and value is not None:
            raise StoreError("missing answers cannot contain a value")
        requires_consent = value is not None and (
            state == "sensitive" or sensitivity != "none"
        )
        if requires_consent and not remember_sensitive:
            raise StoreError(
                "sensitive answer value requires explicit remember consent"
            )

        aliases = incoming.get("aliases", [])
        if not isinstance(aliases, list) or not all(
            isinstance(alias, str) for alias in aliases
        ):
            raise StoreError("answer aliases must be strings")
        normalized_aliases: list[str] = []
        for alias in aliases:
            normalized = normalize_question(alias)
            if normalized not in normalized_aliases:
                normalized_aliases.append(normalized)

        document = self._load_answers_document()
        current = document["answers"].get(key, {})
        record = dict(_require_object(current, "answer record"))
        record.update(
            {
                "key": key,
                "question": question,
                "aliases": normalized_aliases,
                "value": value,
                "state": state,
                "source": incoming.get("source", "user"),
                "scope": scope,
                "sensitivity": sensitivity,
                "updatedAt": utc_now(),
            }
        )
        if state == "confirmed":
            record["confirmedAt"] = incoming.get("confirmedAt") or utc_now()
        else:
            record["confirmedAt"] = incoming.get("confirmedAt")
        if requires_consent:
            record["rememberedWithConsentAt"] = utc_now()
        else:
            record.pop("rememberedWithConsentAt", None)

        document["answers"][key] = record
        document["metadata"]["updatedAt"] = utc_now()
        atomic_write_json(self.answers_path, document)
        return record

    def read_history(self) -> list[dict[str, Any]]:
        if not self.history_path.exists():
            return []
        events: list[dict[str, Any]] = []
        try:
            with self.history_path.open(encoding="utf-8") as source:
                for number, line in enumerate(source, 1):
                    if not line.strip():
                        continue
                    event = json.loads(line)
                    _require_object(event, f"history line {number}")
                    validate_version(event, f"history line {number}")
                    _validate_history_event(event)
                    events.append(event)
        except (OSError, json.JSONDecodeError) as error:
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
        application_id = _safe_session_id(incoming.get("applicationId", ""))
        event_name = incoming.get("event")
        answer_keys = incoming.get("answerKeys", [])

        event = {
            "schemaVersion": SCHEMA_VERSION,
            "eventId": str(uuid.uuid4()),
            "at": incoming.get("at") or utc_now(),
            **incoming,
            "applicationId": application_id,
            "event": event_name,
            "answerKeys": answer_keys,
        }
        _validate_history_event(event)
        encoded = (json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n").encode(
            "utf-8"
        )
        descriptor = os.open(
            self.history_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        try:
            written = os.write(descriptor, encoded)
            if written != len(encoded):
                raise StoreError("history append was incomplete")
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        _set_private_mode(self.history_path, 0o600)
        return event

    def record_replay_transition(
        self, application_id: str, transition: str, ats: str
    ) -> dict[str, Any]:
        """Record one value-free replay lifecycle transition idempotently.

        The replay coordinator serializes calls for a run. This method keeps the
        canonical history/session formats authoritative and repairs a missing
        session if a prior process stopped after the append.
        """

        application_id = _safe_session_id(application_id)
        if transition not in REPLAY_TRANSITIONS:
            raise StoreError("replay transition is unsupported")
        if ats not in REPLAY_ATS:
            raise StoreError("replay ATS is unsupported")

        self.initialize()
        history = self.read_history()
        application_events = [
            event for event in history if event["applicationId"] == application_id
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

    def _session_path(self, application_id: str) -> Path:
        return self.sessions_path / f"{_safe_session_id(application_id)}.json"

    def save_session(
        self, application_id: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        allowed = {
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
        if set(incoming) - allowed:
            raise StoreError("session contains unsupported fields")
        application_id = _safe_session_id(application_id)
        supplied_id = incoming.get("applicationId", application_id)
        if supplied_id != application_id:
            raise StoreError("session application id does not match path")
        status = incoming.get("status", "active")
        if status not in SESSION_STATUSES:
            raise StoreError("session status is unsupported")
        answer_keys = incoming.get("answerKeys", [])
        if not isinstance(answer_keys, list) or not all(
            isinstance(item, str) for item in answer_keys
        ):
            raise StoreError("session answerKeys must be strings")
        pending_fields = incoming.get("pendingFields", [])

        path = self._session_path(application_id)
        created_at = incoming.get("createdAt")
        if path.exists():
            existing = self.load_session(application_id)
            created_at = created_at or existing.get("createdAt")
        session = {
            "schemaVersion": SCHEMA_VERSION,
            **incoming,
            "applicationId": application_id,
            "status": status,
            "answerKeys": answer_keys,
            "pendingFields": pending_fields,
            "createdAt": created_at or utc_now(),
            "updatedAt": utc_now(),
        }
        _validate_session_document(session)
        atomic_write_json(path, session)
        return session

    def load_session(self, application_id: str) -> dict[str, Any]:
        self.initialize()
        path = self._session_path(application_id)
        if not path.exists():
            raise StoreError("session does not exist")
        session = read_json_object(path, "session")
        validate_version(session, "session")
        _validate_session_document(session)
        if session["applicationId"] != application_id:
            raise StoreError("session application id does not match path")
        return session

    def list_sessions(self) -> list[dict[str, Any]]:
        self.initialize()
        sessions: list[dict[str, Any]] = []
        for path in sorted(self.sessions_path.glob("*.json")):
            session = read_json_object(path, "session")
            validate_version(session, "session")
            _validate_session_document(session)
            if path.stem != session["applicationId"]:
                raise StoreError("session application id does not match path")
            sessions.append(session)
        return sessions

    def delete_session(self, application_id: str) -> dict[str, Any]:
        self.initialize()
        path = self._session_path(application_id)
        if not path.exists():
            return {"deleted": False, "applicationId": application_id}
        path.unlink()
        _fsync_directory(self.sessions_path)
        return {"deleted": True, "applicationId": application_id}


def _scope(value: str) -> dict[str, Any]:
    try:
        return _require_object(json.loads(value), "scope")
    except json.JSONDecodeError as error:
        raise StoreError("scope must be a JSON object") from error


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root",
        help=f"store directory (default: ${STORE_ENV} or ~/.job-apply)",
    )
    parser.add_argument("--legacy-profile", help="legacy profile path override")
    commands = parser.add_subparsers(dest="command", required=True)

    commands.add_parser("init")
    commands.add_parser("paths")
    commands.add_parser("profile-get")
    profile_replace = commands.add_parser("profile-replace")
    profile_replace.add_argument("--input", required=True)
    commands.add_parser("preferences-get")
    preferences_set = commands.add_parser("preferences-set")
    preferences_set.add_argument("--input", required=True)
    preferences_set.add_argument("--replace", action="store_true")

    key = commands.add_parser("answer-key")
    key.add_argument("--question", required=True)
    key.add_argument("--scope", default="{}")
    put = commands.add_parser("answer-put")
    put.add_argument("--input", required=True)
    put.add_argument("--remember-sensitive", action="store_true")
    get = commands.add_parser("answer-get")
    get.add_argument("--key", required=True)
    find = commands.add_parser("answer-find")
    find.add_argument("--question", required=True)
    find.add_argument("--scope", default="{}")

    history_append = commands.add_parser("history-append")
    history_append.add_argument("--input", required=True)
    commands.add_parser("history-list")

    replay_transition = commands.add_parser("replay-transition")
    replay_transition.add_argument("--id", required=True)
    replay_transition.add_argument("--transition", required=True)
    replay_transition.add_argument("--ats", required=True)

    session_save = commands.add_parser("session-save")
    session_save.add_argument("--id", required=True)
    session_save.add_argument("--input", required=True)
    session_load = commands.add_parser("session-load")
    session_load.add_argument("--id", required=True)
    commands.add_parser("session-list")
    session_delete = commands.add_parser("session-delete")
    session_delete.add_argument("--id", required=True)
    return parser


def resolve_store(args: argparse.Namespace) -> Store:
    configured = args.root or os.environ.get(STORE_ENV)
    root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    legacy = Path(args.legacy_profile).expanduser() if args.legacy_profile else None
    return Store(root, legacy)


def run(args: argparse.Namespace) -> Any:
    store = resolve_store(args)
    command = args.command
    if command == "init":
        return store.initialize()
    if command == "paths":
        return store.paths()
    if command == "profile-get":
        return store.get_profile()
    if command == "profile-replace":
        return store.replace_profile(_read_input(args.input))
    if command == "preferences-get":
        return store.get_preferences()
    if command == "preferences-set":
        return store.set_preferences(_read_input(args.input), args.replace)
    if command == "answer-key":
        return {"key": answer_key(args.question, _scope(args.scope))}
    if command == "answer-put":
        return store.put_answer(
            _read_input(args.input), remember_sensitive=args.remember_sensitive
        )
    if command == "answer-get":
        return store.get_answer(args.key)
    if command == "answer-find":
        return store.find_answer(args.question, _scope(args.scope))
    if command == "history-append":
        return store.append_history(_read_input(args.input))
    if command == "history-list":
        store.initialize()
        return store.read_history()
    if command == "replay-transition":
        return store.record_replay_transition(
            args.id, args.transition, args.ats
        )
    if command == "session-save":
        return store.save_session(args.id, _read_input(args.input))
    if command == "session-load":
        return store.load_session(args.id)
    if command == "session-list":
        return store.list_sessions()
    if command == "session-delete":
        return store.delete_session(args.id)
    raise StoreError("unsupported command")


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        result = run(args)
    except StoreError as error:
        print(f"job-apply-store: {error}", file=sys.stderr)
        return 2
    except OSError:
        print("job-apply-store: storage operation failed", file=sys.stderr)
        return 2
    json.dump(result, sys.stdout, indent=2, sort_keys=True, ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
