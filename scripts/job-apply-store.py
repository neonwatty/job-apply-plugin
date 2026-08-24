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
import stat
import sys
import tempfile
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit


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
JOB_STATUSES = {
    "saved",
    "needs_info",
    "ready",
    "in_progress",
    "awaiting_review",
    "applied",
    "closed",
}
JOB_CLOSED_OUTCOMES = {
    "rejected",
    "withdrawn",
    "expired",
    "duplicate",
    "not_interested",
}
JOB_TRANSITIONS = {
    "saved": {"needs_info", "ready", "closed"},
    "needs_info": {"saved", "ready", "in_progress", "closed"},
    "ready": {"saved", "needs_info", "in_progress", "closed"},
    "in_progress": {"needs_info", "awaiting_review", "closed"},
    "awaiting_review": {"in_progress", "applied", "closed"},
    "applied": {"closed"},
    "closed": {"saved"},
}
FACT_SOURCES = {"user", "resume", "agent", "migration"}
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


@contextmanager
def exclusive_file_lock(path: Path):
    """Serialize read-modify-write operations across local clients."""

    _ensure_private_dir(path.parent)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    _set_private_mode(path, 0o600)
    try:
        if os.name == "nt":
            import msvcrt

            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"0")
                os.fsync(descriptor)
            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":
            import msvcrt

            os.lseek(descriptor, 0, os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


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


def normalize_job_url(url: str) -> str:
    if not isinstance(url, str) or not url.strip():
        raise StoreError("job URL must be a non-empty string")
    try:
        parsed = urlsplit(url.strip())
        port = parsed.port
    except ValueError as error:
        raise StoreError("job URL is invalid") from error
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise StoreError("job URL must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise StoreError("job URL must not contain credentials")
    hostname = parsed.hostname.lower()
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    default_port = (parsed.scheme.lower(), port) in {("http", 80), ("https", 443)}
    netloc = hostname if port is None or default_port else f"{hostname}:{port}"
    path = parsed.path or "/"
    return urlunsplit((parsed.scheme.lower(), netloc, path, parsed.query, ""))


def normalize_resume_path(path: str) -> str:
    if not isinstance(path, str) or not path.strip() or "\0" in path:
        raise StoreError("resume path must be a non-empty absolute path")
    expanded = Path(path.strip()).expanduser()
    if not expanded.is_absolute():
        raise StoreError("resume path must be absolute")
    return os.path.normpath(str(expanded))


def observe_resume_file(path: str) -> dict[str, Any]:
    normalized = normalize_resume_path(path)
    try:
        metadata = Path(normalized).stat()
    except FileNotFoundError:
        return {"exists": False, "size": None, "modifiedAt": None}
    if not stat.S_ISREG(metadata.st_mode):
        raise StoreError("resume path must identify a regular file")
    modified = datetime.fromtimestamp(metadata.st_mtime, timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")
    return {"exists": True, "size": metadata.st_size, "modifiedAt": modified}


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


def _json_pointer_segment(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _merge_object_patch(
    target: dict[str, Any], patch: dict[str, Any], prefix: str = ""
) -> tuple[dict[str, Any], list[str]]:
    """Apply an object merge patch and return changed JSON-pointer paths."""

    updated = dict(target)
    changed: list[str] = []
    for key, value in patch.items():
        if not isinstance(key, str) or not key:
            raise StoreError("profile patch keys must be non-empty strings")
        path = f"{prefix}/{_json_pointer_segment(key)}"
        if value is None:
            if key in updated:
                del updated[key]
                changed.append(path)
            continue
        current = updated.get(key)
        if isinstance(value, dict):
            base = current if isinstance(current, dict) else {}
            nested, nested_changed = _merge_object_patch(base, value, path)
            if nested_changed or not isinstance(current, dict):
                updated[key] = nested
                changed.extend(nested_changed or [path])
            continue
        if current != value:
            updated[key] = value
            changed.append(path)
    return updated, changed


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


def _validate_job_record(key: str, value: Any) -> dict[str, Any]:
    record = _require_object(value, "job record")
    allowed = {
        "id",
        "url",
        "normalizedUrl",
        "source",
        "sourceId",
        "role",
        "company",
        "location",
        "workplaceType",
        "employmentType",
        "compensation",
        "description",
        "ats",
        "priority",
        "status",
        "closedOutcome",
        "resumeId",
        "notes",
        "provenance",
        "lastCheckedAt",
        "revision",
        "createdAt",
        "updatedAt",
        "deletedAt",
    }
    if set(record) - allowed:
        raise StoreError("job record contains unsupported fields")
    if record.get("id") != key:
        raise StoreError("job record id does not match its index")
    _safe_session_id(key)
    normalized = normalize_job_url(record.get("url", ""))
    if record.get("normalizedUrl") != normalized:
        raise StoreError("job record normalized URL does not match")
    if record.get("status") not in JOB_STATUSES:
        raise StoreError("job status is unsupported")
    closed_outcome = record.get("closedOutcome")
    if record["status"] == "closed":
        if closed_outcome not in JOB_CLOSED_OUTCOMES:
            raise StoreError("closed job requires a supported outcome")
    elif closed_outcome is not None:
        raise StoreError("open job cannot have a closed outcome")
    priority = record.get("priority", 0)
    if not isinstance(priority, int) or isinstance(priority, bool) or not 0 <= priority <= 5:
        raise StoreError("job priority must be an integer from 0 to 5")
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("job revision must be a positive integer")
    provenance = record.get("provenance", {})
    _require_object(provenance, "job provenance")
    _validate_optional_strings(
        record,
        {
            "url",
            "normalizedUrl",
            "source",
            "sourceId",
            "role",
            "company",
            "location",
            "workplaceType",
            "employmentType",
            "compensation",
            "description",
            "ats",
            "closedOutcome",
            "resumeId",
            "notes",
            "lastCheckedAt",
            "createdAt",
            "updatedAt",
            "deletedAt",
        },
        "job record",
    )
    if not isinstance(record.get("createdAt"), str) or not record["createdAt"]:
        raise StoreError("job record has no creation timestamp")
    if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
        raise StoreError("job record has no update timestamp")
    return record


def _validate_resume_record(key: str, value: Any) -> dict[str, Any]:
    record = _require_object(value, "resume record")
    allowed = {
        "id",
        "label",
        "path",
        "tags",
        "default",
        "observedSize",
        "observedModifiedAt",
        "revision",
        "createdAt",
        "updatedAt",
        "deletedAt",
    }
    if set(record) - allowed:
        raise StoreError("resume record contains unsupported fields")
    if record.get("id") != key:
        raise StoreError("resume record id does not match its index")
    _safe_session_id(key)
    if not isinstance(record.get("label"), str) or not record["label"].strip():
        raise StoreError("resume label must be a non-empty string")
    if record.get("path") != normalize_resume_path(record.get("path", "")):
        raise StoreError("resume path is not normalized")
    tags = record.get("tags", [])
    if not isinstance(tags, list) or not all(
        isinstance(item, str) and item.strip() for item in tags
    ):
        raise StoreError("resume tags must be non-empty strings")
    if len(set(tags)) != len(tags):
        raise StoreError("resume tags must be unique")
    if not isinstance(record.get("default"), bool):
        raise StoreError("resume default must be a boolean")
    observed_size = record.get("observedSize")
    if observed_size is not None and (
        not isinstance(observed_size, int)
        or isinstance(observed_size, bool)
        or observed_size < 0
    ):
        raise StoreError("resume observed size is invalid")
    revision = record.get("revision")
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("resume revision must be a positive integer")
    _validate_optional_strings(
        record,
        {
            "observedModifiedAt",
            "createdAt",
            "updatedAt",
            "deletedAt",
        },
        "resume record",
    )
    if not isinstance(record.get("createdAt"), str) or not record["createdAt"]:
        raise StoreError("resume record has no creation timestamp")
    if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
        raise StoreError("resume record has no update timestamp")
    return record


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
        self.jobs_path = self.root / "jobs.json"
        self.resumes_path = self.root / "resumes.json"
        self.history_path = self.root / "applications.jsonl"
        self.sessions_path = self.root / "sessions"
        self.store_lock_path = self.root / ".store.lock"
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
            "jobs": str(self.jobs_path),
            "resumes": str(self.resumes_path),
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
        if self.jobs_path.exists():
            self._load_jobs_document()
        if self.resumes_path.exists():
            self._load_resumes_document()
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
                "revision": 1,
                "factProvenance": {},
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

        if not self.jobs_path.exists():
            now = utc_now()
            atomic_write_json(
                self.jobs_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "jobs": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.resumes_path.exists():
            now = utc_now()
            atomic_write_json(
                self.resumes_path,
                {
                    "schemaVersion": SCHEMA_VERSION,
                    "resumes": {},
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
        metadata = _require_object(document.get("metadata"), "profile.metadata")
        revision = metadata.get("revision", 1)
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise StoreError("profile revision must be a positive integer")
        provenance = _require_object(
            metadata.get("factProvenance", {}), "profile fact provenance"
        )
        for path, value in provenance.items():
            if not isinstance(path, str) or not path.startswith("/"):
                raise StoreError("profile fact provenance path is invalid")
            record = _require_object(value, "profile fact provenance record")
            if set(record) != {"source", "updatedAt"}:
                raise StoreError("profile fact provenance record is invalid")
            if record.get("source") not in FACT_SOURCES:
                raise StoreError("profile fact provenance source is unsupported")
            if not isinstance(record.get("updatedAt"), str) or not record["updatedAt"]:
                raise StoreError("profile fact provenance timestamp is invalid")
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

    def _load_jobs_document(self) -> dict[str, Any]:
        document = read_json_object(self.jobs_path, "jobs")
        validate_version(document, "jobs")
        jobs = _require_object(document.get("jobs"), "jobs.jobs")
        _require_object(document.get("metadata"), "jobs.metadata")
        for key, record in jobs.items():
            if not isinstance(key, str) or not key:
                raise StoreError("job index keys must be non-empty strings")
            _validate_job_record(key, record)
        return document

    def _load_resumes_document(self) -> dict[str, Any]:
        document = read_json_object(self.resumes_path, "resumes")
        validate_version(document, "resumes")
        resumes = _require_object(document.get("resumes"), "resumes.resumes")
        _require_object(document.get("metadata"), "resumes.metadata")
        active_defaults = 0
        for key, record in resumes.items():
            if not isinstance(key, str) or not key:
                raise StoreError("resume index keys must be non-empty strings")
            item = _validate_resume_record(key, record)
            if item["default"] and item.get("deletedAt") is None:
                active_defaults += 1
        if active_defaults > 1:
            raise StoreError("resume store has more than one active default")
        return document

    def get_profile(self) -> dict[str, Any]:
        self.initialize()
        return self._load_profile_document()["profile"]

    def inspect_profile(self) -> dict[str, Any]:
        self.initialize()
        document = self._load_profile_document()
        metadata = document["metadata"]
        return {
            "profile": document["profile"],
            "revision": metadata.get("revision", 1),
            "factProvenance": metadata.get("factProvenance", {}),
            "updatedAt": metadata.get("updatedAt"),
        }

    def replace_profile(self, profile: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        incoming = _require_object(profile, "profile")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_profile_document()
            document["profile"] = incoming
            document["metadata"]["updatedAt"] = utc_now()
            document["metadata"]["revision"] = (
                document["metadata"].get("revision", 1) + 1
            )
            document["metadata"]["factProvenance"] = {}
            atomic_write_json(self.profile_path, document)
        return document["profile"]

    def patch_profile(
        self,
        patch: dict[str, Any],
        expected_revision: int,
        source: str,
    ) -> dict[str, Any]:
        self.initialize()
        incoming = _require_object(patch, "profile patch")
        if not incoming:
            raise StoreError("profile patch must not be empty")
        if source not in FACT_SOURCES:
            raise StoreError("profile fact source is unsupported")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_profile_document()
            metadata = document["metadata"]
            revision = metadata.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("profile revision conflict")
            updated, changed = _merge_object_patch(document["profile"], incoming)
            if not changed:
                return self.inspect_profile()
            now = utc_now()
            provenance = dict(metadata.get("factProvenance", {}))
            for path in changed:
                prefix = f"{path}/"
                for stale in [
                    key
                    for key in provenance
                    if key.startswith(prefix) or path.startswith(f"{key}/")
                ]:
                    provenance.pop(stale, None)
                provenance[path] = {"source": source, "updatedAt": now}
            document["profile"] = updated
            metadata["factProvenance"] = provenance
            metadata["revision"] = revision + 1
            metadata["updatedAt"] = now
            atomic_write_json(self.profile_path, document)
        return {
            "profile": updated,
            "revision": revision + 1,
            "factProvenance": provenance,
            "updatedAt": now,
        }

    def get_preferences(self) -> dict[str, Any]:
        preferences = self.get_profile().get("preferences", {})
        return _require_object(preferences, "profile.preferences")

    def set_preferences(
        self, preferences: dict[str, Any], replace: bool = False
    ) -> dict[str, Any]:
        self.initialize()
        incoming = _require_object(preferences, "preferences")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_profile_document()
            profile = document["profile"]
            if replace:
                updated = dict(incoming)
            else:
                current = profile.get("preferences", {})
                updated = dict(_require_object(current, "profile.preferences"))
                updated.update(incoming)
            profile["preferences"] = updated
            document["metadata"]["updatedAt"] = utc_now()
            document["metadata"]["revision"] = (
                document["metadata"].get("revision", 1) + 1
            )
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

    def _require_active_resume(self, resume_id: str | None) -> None:
        if resume_id is None:
            return
        if not isinstance(resume_id, str):
            raise StoreError("job resume id must be a string")
        _safe_session_id(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("assigned resume does not exist")

    def create_job(self, incoming: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        allowed = {
            "id",
            "url",
            "source",
            "sourceId",
            "role",
            "company",
            "location",
            "workplaceType",
            "employmentType",
            "compensation",
            "description",
            "ats",
            "priority",
            "status",
            "closedOutcome",
            "resumeId",
            "notes",
            "provenance",
            "lastCheckedAt",
        }
        if set(incoming) - allowed:
            raise StoreError("job input contains unsupported fields")
        url = incoming.get("url")
        normalized_url = normalize_job_url(url)
        job_id = incoming.get("id") or f"job-{uuid.uuid4()}"
        _safe_session_id(job_id)
        status = incoming.get("status", "saved")
        if status != "saved":
            raise StoreError("new jobs must start with saved status")
        now = utc_now()
        record = {
            **incoming,
            "id": job_id,
            "url": url.strip(),
            "normalizedUrl": normalized_url,
            "priority": incoming.get("priority", 0),
            "status": status,
            "closedOutcome": incoming.get("closedOutcome"),
            "provenance": incoming.get("provenance", {}),
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        _validate_job_record(job_id, record)
        with exclusive_file_lock(self.store_lock_path):
            self._require_active_resume(incoming.get("resumeId"))
            document = self._load_jobs_document()
            if job_id in document["jobs"]:
                raise StoreError("job id already exists")
            duplicate = next(
                (
                    item
                    for item in document["jobs"].values()
                    if item.get("deletedAt") is None
                    and item.get("normalizedUrl") == normalized_url
                ),
                None,
            )
            if duplicate is not None:
                raise StoreError("active job URL already exists")
            document["jobs"][job_id] = record
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.jobs_path, document)
        return record

    def get_job(self, job_id: str, include_trashed: bool = False) -> dict[str, Any] | None:
        self.initialize()
        _safe_session_id(job_id)
        record = self._load_jobs_document()["jobs"].get(job_id)
        if record is None or (record.get("deletedAt") is not None and not include_trashed):
            return None
        return _require_object(record, "job record")

    def list_jobs(
        self, status: str | None = None, include_trashed: bool = False
    ) -> list[dict[str, Any]]:
        self.initialize()
        if status is not None and status not in JOB_STATUSES:
            raise StoreError("job status is unsupported")
        records = []
        for record in self._load_jobs_document()["jobs"].values():
            if record.get("deletedAt") is not None and not include_trashed:
                continue
            if status is not None and record.get("status") != status:
                continue
            records.append(record)
        return sorted(
            records,
            key=lambda item: (
                -item.get("priority", 0),
                item.get("createdAt", ""),
                item["id"],
            ),
        )

    def _preflight_job_record(self, record: dict[str, Any]) -> dict[str, Any]:
        errors: list[str] = []
        warnings: list[str] = []
        profile = self._load_profile_document()["profile"]
        if not profile:
            errors.append("profile_empty")
        resumes = self._load_resumes_document()["resumes"]
        resume_id = record.get("resumeId")
        if resume_id is None:
            default = next(
                (
                    item
                    for item in resumes.values()
                    if item.get("deletedAt") is None and item.get("default")
                ),
                None,
            )
            resume_id = default["id"] if default is not None else None
        resume = resumes.get(resume_id) if resume_id is not None else None
        if resume is None or resume.get("deletedAt") is not None:
            errors.append("resume_missing")
        else:
            observation = observe_resume_file(resume["path"])
            if not observation["exists"]:
                errors.append("resume_file_missing")
            elif (
                observation["size"] != resume.get("observedSize")
                or observation["modifiedAt"] != resume.get("observedModifiedAt")
            ):
                warnings.append("resume_file_changed")
        if not record.get("role"):
            warnings.append("role_missing")
        if not record.get("company"):
            warnings.append("company_missing")
        return {
            "id": record["id"],
            "revision": record["revision"],
            "ready": not errors,
            "resumeId": resume_id,
            "errors": errors,
            "warnings": warnings,
        }

    def preflight_job(self, job_id: str) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        record = self._load_jobs_document()["jobs"].get(job_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("job does not exist")
        return self._preflight_job_record(record)

    def update_job(
        self, job_id: str, patch: dict[str, Any], expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        allowed = {
            "url",
            "source",
            "sourceId",
            "role",
            "company",
            "location",
            "workplaceType",
            "employmentType",
            "compensation",
            "description",
            "ats",
            "priority",
            "resumeId",
            "notes",
            "provenance",
            "lastCheckedAt",
        }
        if not patch or set(patch) - allowed:
            raise StoreError("job patch contains unsupported fields")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            if "resumeId" in patch:
                self._require_active_resume(patch["resumeId"])
            updated = {**current, **patch}
            if "url" in patch:
                updated["url"] = patch["url"].strip()
                updated["normalizedUrl"] = normalize_job_url(patch["url"])
                duplicate = next(
                    (
                        item
                        for key, item in document["jobs"].items()
                        if key != job_id
                        and item.get("deletedAt") is None
                        and item.get("normalizedUrl") == updated["normalizedUrl"]
                    ),
                    None,
                )
                if duplicate is not None:
                    raise StoreError("active job URL already exists")
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    def transition_job(
        self,
        job_id: str,
        status: str,
        expected_revision: int,
        closed_outcome: str | None = None,
        user_confirmed: bool = False,
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        if status not in JOB_STATUSES:
            raise StoreError("job status is unsupported")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            if status == current["status"]:
                return current
            if status not in JOB_TRANSITIONS[current["status"]]:
                raise StoreError("job status transition is unsupported")
            if status == "applied" and not user_confirmed:
                raise StoreError("applied status requires explicit user confirmation")
            if status == "ready" and not self._preflight_job_record(current)["ready"]:
                raise StoreError("job is not ready")
            updated = dict(current)
            updated["status"] = status
            updated["closedOutcome"] = closed_outcome if status == "closed" else None
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    def trash_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_job_deleted(job_id, expected_revision, restore=False)

    def restore_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_job_deleted(job_id, expected_revision, restore=True)

    def _set_job_deleted(
        self, job_id: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                return current
            if restore:
                self._require_active_resume(current.get("resumeId"))
                duplicate = next(
                    (
                        item
                        for key, item in document["jobs"].items()
                        if key != job_id
                        and item.get("deletedAt") is None
                        and item.get("normalizedUrl") == current["normalizedUrl"]
                    ),
                    None,
                )
                if duplicate is not None:
                    raise StoreError("active job URL already exists")
            updated = dict(current)
            updated["deletedAt"] = None if restore else utc_now()
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    def delete_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(job_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None:
                return {"deleted": False, "id": job_id}
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("job must be trashed before permanent deletion")
            del document["jobs"][job_id]
            document["metadata"]["updatedAt"] = utc_now()
            atomic_write_json(self.jobs_path, document)
        return {"deleted": True, "id": job_id}

    def create_resume(self, incoming: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        allowed = {"id", "label", "path", "tags", "default"}
        if set(incoming) - allowed:
            raise StoreError("resume input contains unsupported fields")
        resume_id = incoming.get("id") or f"resume-{uuid.uuid4()}"
        _safe_session_id(resume_id)
        label = incoming.get("label")
        path = normalize_resume_path(incoming.get("path", ""))
        tags_input = incoming.get("tags", [])
        if not isinstance(tags_input, list):
            raise StoreError("resume tags must be a list")
        tags = [
            item.strip() if isinstance(item, str) else item for item in tags_input
        ]
        observation = observe_resume_file(path)
        now = utc_now()
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_resumes_document()
            if resume_id in document["resumes"]:
                raise StoreError("resume id already exists")
            if any(
                item.get("deletedAt") is None and item.get("path") == path
                for item in document["resumes"].values()
            ):
                raise StoreError("active resume path already exists")
            active = [
                item
                for item in document["resumes"].values()
                if item.get("deletedAt") is None
            ]
            make_default = incoming.get("default", not active)
            if not isinstance(make_default, bool):
                raise StoreError("resume default must be a boolean")
            if make_default:
                for key, item in list(document["resumes"].items()):
                    if item.get("deletedAt") is None and item.get("default"):
                        changed = dict(item)
                        changed["default"] = False
                        changed["revision"] += 1
                        changed["updatedAt"] = now
                        document["resumes"][key] = changed
            record = {
                "id": resume_id,
                "label": label.strip() if isinstance(label, str) else label,
                "path": path,
                "tags": tags,
                "default": make_default,
                "observedSize": observation["size"],
                "observedModifiedAt": observation["modifiedAt"],
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
                "deletedAt": None,
            }
            _validate_resume_record(resume_id, record)
            document["resumes"][resume_id] = record
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.resumes_path, document)
        return record

    def get_resume(
        self, resume_id: str, include_trashed: bool = False
    ) -> dict[str, Any] | None:
        self.initialize()
        _safe_session_id(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or (record.get("deletedAt") is not None and not include_trashed):
            return None
        return _require_object(record, "resume record")

    def list_resumes(self, include_trashed: bool = False) -> list[dict[str, Any]]:
        self.initialize()
        records = [
            record
            for record in self._load_resumes_document()["resumes"].values()
            if include_trashed or record.get("deletedAt") is None
        ]
        return sorted(
            records,
            key=lambda item: (
                not item.get("default", False),
                item.get("label", "").casefold(),
                item["id"],
            ),
        )

    def update_resume(
        self, resume_id: str, patch: dict[str, Any], expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        allowed = {"label", "path", "tags"}
        if not patch or set(patch) - allowed:
            raise StoreError("resume patch contains unsupported fields")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            updated = {**current, **patch}
            if "label" in patch and isinstance(patch["label"], str):
                updated["label"] = patch["label"].strip()
            if "tags" in patch:
                if not isinstance(patch["tags"], list):
                    raise StoreError("resume tags must be a list")
                updated["tags"] = [
                    item.strip() if isinstance(item, str) else item
                    for item in patch["tags"]
                ]
            if "path" in patch:
                path = normalize_resume_path(patch["path"])
                if any(
                    key != resume_id
                    and item.get("deletedAt") is None
                    and item.get("path") == path
                    for key, item in document["resumes"].items()
                ):
                    raise StoreError("active resume path already exists")
                observation = observe_resume_file(path)
                updated["path"] = path
                updated["observedSize"] = observation["size"]
                updated["observedModifiedAt"] = observation["modifiedAt"]
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_resume_record(resume_id, updated)
            document["resumes"][resume_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.resumes_path, document)
        return updated

    def set_default_resume(
        self, resume_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_resumes_document()
            target = document["resumes"].get(resume_id)
            if target is None or target.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if target["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if target["default"]:
                return target
            now = utc_now()
            for key, item in list(document["resumes"].items()):
                if item.get("deletedAt") is not None:
                    continue
                if item.get("default") or key == resume_id:
                    changed = dict(item)
                    changed["default"] = key == resume_id
                    changed["revision"] += 1
                    changed["updatedAt"] = now
                    document["resumes"][key] = changed
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.resumes_path, document)
            return document["resumes"][resume_id]

    def check_resume(self, resume_id: str) -> dict[str, Any]:
        record = self.get_resume(resume_id, include_trashed=True)
        if record is None:
            raise StoreError("resume does not exist")
        current = observe_resume_file(record["path"])
        changed = (
            current["size"] != record.get("observedSize")
            or current["modifiedAt"] != record.get("observedModifiedAt")
        )
        return {
            "id": resume_id,
            "exists": current["exists"],
            "changed": changed,
            "observedSize": record.get("observedSize"),
            "observedModifiedAt": record.get("observedModifiedAt"),
            "currentSize": current["size"],
            "currentModifiedAt": current["modifiedAt"],
        }

    def trash_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_resume_deleted(resume_id, expected_revision, restore=False)

    def restore_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_resume_deleted(resume_id, expected_revision, restore=True)

    def _set_resume_deleted(
        self, resume_id: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                return current
            if restore:
                if any(
                    key != resume_id
                    and item.get("deletedAt") is None
                    and item.get("path") == current["path"]
                    for key, item in document["resumes"].items()
                ):
                    raise StoreError("active resume path already exists")
            else:
                jobs = self._load_jobs_document()["jobs"].values()
                if any(
                    item.get("deletedAt") is None
                    and item.get("resumeId") == resume_id
                    for item in jobs
                ):
                    raise StoreError("resume is assigned to an active job")
            updated = dict(current)
            updated["deletedAt"] = None if restore else utc_now()
            if not restore:
                updated["default"] = False
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = utc_now()
            _validate_resume_record(resume_id, updated)
            document["resumes"][resume_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.resumes_path, document)
        return updated

    def delete_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        _safe_session_id(resume_id)
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None:
                return {"deleted": False, "id": resume_id}
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("resume must be trashed before permanent deletion")
            if any(
                item.get("resumeId") == resume_id
                for item in self._load_jobs_document()["jobs"].values()
            ):
                raise StoreError("resume is still referenced by a job")
            del document["resumes"][resume_id]
            document["metadata"]["updatedAt"] = utc_now()
            atomic_write_json(self.resumes_path, document)
        return {"deleted": True, "id": resume_id}

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
    commands.add_parser("profile-inspect")
    profile_replace = commands.add_parser("profile-replace")
    profile_replace.add_argument("--input", required=True)
    profile_patch = commands.add_parser("profile-patch")
    profile_patch.add_argument("--input", required=True)
    profile_patch.add_argument("--expected-revision", required=True, type=int)
    profile_patch.add_argument("--source", required=True, choices=sorted(FACT_SOURCES))
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

    job_create = commands.add_parser("job-create")
    job_create.add_argument("--input", required=True)
    job_get = commands.add_parser("job-get")
    job_get.add_argument("--id", required=True)
    job_get.add_argument("--include-trashed", action="store_true")
    job_list = commands.add_parser("job-list")
    job_list.add_argument("--status")
    job_list.add_argument("--include-trashed", action="store_true")
    job_preflight = commands.add_parser("job-preflight")
    job_preflight.add_argument("--id", required=True)
    job_update = commands.add_parser("job-update")
    job_update.add_argument("--id", required=True)
    job_update.add_argument("--input", required=True)
    job_update.add_argument("--expected-revision", required=True, type=int)
    job_transition = commands.add_parser("job-transition")
    job_transition.add_argument("--id", required=True)
    job_transition.add_argument("--status", required=True)
    job_transition.add_argument("--closed-outcome")
    job_transition.add_argument("--expected-revision", required=True, type=int)
    job_transition.add_argument("--user-confirmed", action="store_true")
    job_trash = commands.add_parser("job-trash")
    job_trash.add_argument("--id", required=True)
    job_trash.add_argument("--expected-revision", required=True, type=int)
    job_restore = commands.add_parser("job-restore")
    job_restore.add_argument("--id", required=True)
    job_restore.add_argument("--expected-revision", required=True, type=int)
    job_delete = commands.add_parser("job-delete")
    job_delete.add_argument("--id", required=True)
    job_delete.add_argument("--expected-revision", required=True, type=int)

    resume_create = commands.add_parser("resume-create")
    resume_create.add_argument("--input", required=True)
    resume_get = commands.add_parser("resume-get")
    resume_get.add_argument("--id", required=True)
    resume_get.add_argument("--include-trashed", action="store_true")
    resume_list = commands.add_parser("resume-list")
    resume_list.add_argument("--include-trashed", action="store_true")
    resume_update = commands.add_parser("resume-update")
    resume_update.add_argument("--id", required=True)
    resume_update.add_argument("--input", required=True)
    resume_update.add_argument("--expected-revision", required=True, type=int)
    resume_default = commands.add_parser("resume-set-default")
    resume_default.add_argument("--id", required=True)
    resume_default.add_argument("--expected-revision", required=True, type=int)
    resume_check = commands.add_parser("resume-check")
    resume_check.add_argument("--id", required=True)
    resume_trash = commands.add_parser("resume-trash")
    resume_trash.add_argument("--id", required=True)
    resume_trash.add_argument("--expected-revision", required=True, type=int)
    resume_restore = commands.add_parser("resume-restore")
    resume_restore.add_argument("--id", required=True)
    resume_restore.add_argument("--expected-revision", required=True, type=int)
    resume_delete = commands.add_parser("resume-delete")
    resume_delete.add_argument("--id", required=True)
    resume_delete.add_argument("--expected-revision", required=True, type=int)

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
    if command == "profile-inspect":
        return store.inspect_profile()
    if command == "profile-replace":
        return store.replace_profile(_read_input(args.input))
    if command == "profile-patch":
        return store.patch_profile(
            _read_input(args.input), args.expected_revision, args.source
        )
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
    if command == "job-create":
        return store.create_job(_read_input(args.input))
    if command == "job-get":
        return store.get_job(args.id, include_trashed=args.include_trashed)
    if command == "job-list":
        return store.list_jobs(args.status, include_trashed=args.include_trashed)
    if command == "job-preflight":
        return store.preflight_job(args.id)
    if command == "job-update":
        return store.update_job(
            args.id, _read_input(args.input), args.expected_revision
        )
    if command == "job-transition":
        return store.transition_job(
            args.id,
            args.status,
            args.expected_revision,
            closed_outcome=args.closed_outcome,
            user_confirmed=args.user_confirmed,
        )
    if command == "job-trash":
        return store.trash_job(args.id, args.expected_revision)
    if command == "job-restore":
        return store.restore_job(args.id, args.expected_revision)
    if command == "job-delete":
        return store.delete_job(args.id, args.expected_revision)
    if command == "resume-create":
        return store.create_resume(_read_input(args.input))
    if command == "resume-get":
        return store.get_resume(args.id, include_trashed=args.include_trashed)
    if command == "resume-list":
        return store.list_resumes(include_trashed=args.include_trashed)
    if command == "resume-update":
        return store.update_resume(
            args.id, _read_input(args.input), args.expected_revision
        )
    if command == "resume-set-default":
        return store.set_default_resume(args.id, args.expected_revision)
    if command == "resume-check":
        return store.check_resume(args.id)
    if command == "resume-trash":
        return store.trash_resume(args.id, args.expected_revision)
    if command == "resume-restore":
        return store.restore_resume(args.id, args.expected_revision)
    if command == "resume-delete":
        return store.delete_resume(args.id, args.expected_revision)
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
