#!/usr/bin/env python3
"""Local, versioned storage helper for the Job Apply plugin.

All successful commands emit JSON on stdout. Errors are deliberately terse and
never include stored values. The helper uses only the Python standard library.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import stat
import sys
import tempfile
import unicodedata
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
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
    "job-started",
    "claim-recovered",
    "job-blocked",
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
JOB_ORIGINS = {"human", "agent"}
JOB_PROVENANCE_ORIGINS = JOB_ORIGINS | {"migration"}
JOB_INGEST_FIELDS = {
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
    "notes",
    "lastCheckedAt",
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
CLAIM_LEASE_SECONDS = 300
CLAIM_HEARTBEAT_SECONDS = 60
LEGACY_SEARCH_ROOT = ".claude-job-searches"
LEGACY_SEARCH_MAX_FILES = 100
LEGACY_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024
LEGACY_SEARCH_MAX_TOTAL_BYTES = 20 * 1024 * 1024
LEGACY_SEARCH_MAX_ENTRIES = 5_000


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


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _job_origin(origin: str) -> str:
    if origin not in JOB_ORIGINS:
        raise StoreError("job origin must be human or agent")
    return origin


def _nonempty_job_value(value: Any) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _normalized_job_source(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


def _job_observation_source(record: dict[str, Any]) -> str:
    return _normalized_job_source(record.get("source")) or "manual"


def _job_field_provenance(
    provenance: dict[str, Any], field: str
) -> dict[str, Any] | None:
    value = provenance.get(f"/{_json_pointer_segment(field)}")
    if not isinstance(value, dict) or value.get("origin") not in JOB_PROVENANCE_ORIGINS:
        return None
    return value


def _agent_may_update_job_field(
    record: dict[str, Any], provenance: dict[str, Any], field: str
) -> bool:
    authored = _job_field_provenance(provenance, field)
    if authored is not None:
        return authored["origin"] == "agent"
    return not _nonempty_job_value(record.get(field))


def _migration_may_update_job_field(
    record: dict[str, Any], provenance: dict[str, Any], field: str
) -> bool:
    if not _nonempty_job_value(record.get(field)):
        return True
    authored = _job_field_provenance(provenance, field)
    if authored is not None:
        return authored["origin"] == "migration"
    return False


def _reject_supplied_migration_provenance(provenance: dict[str, Any]) -> None:
    if any(
        isinstance(value, dict) and value.get("origin") == "migration"
        for value in provenance.values()
    ):
        raise StoreError("migration provenance is reserved for guided legacy imports")


def _validate_migration_provenance_replacement(
    current: dict[str, Any], replacement: dict[str, Any]
) -> None:
    protected_paths = {
        path
        for path in set(current) | set(replacement)
        if (
            isinstance(current.get(path), dict)
            and current[path].get("origin") == "migration"
        )
        or (
            isinstance(replacement.get(path), dict)
            and replacement[path].get("origin") == "migration"
        )
    }
    if any(current.get(path) != replacement.get(path) for path in protected_paths):
        raise StoreError("migration provenance is reserved for guided legacy imports")


def _stamp_job_provenance(
    provenance: dict[str, Any],
    fields: list[str] | set[str],
    origin: str,
    observation_source: str,
    updated_at: str,
) -> dict[str, Any]:
    stamped = dict(provenance)
    for field in fields:
        stamped[f"/{_json_pointer_segment(field)}"] = {
            "origin": origin,
            "observationSource": observation_source,
            "updatedAt": updated_at,
        }
    return stamped


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
            "createdAt",
            "updatedAt",
            "rememberedWithConsentAt",
            "deletedAt",
        },
        "answer record",
    )
    revision = record.get("revision", 1)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
        raise StoreError("answer revision must be a positive integer")
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


def _validate_claim_record(value: Any) -> dict[str, Any]:
    claim = _require_object(value, "coordinator claim")
    required = {
        "claimId", "jobId", "ownerLabel", "tokenHash", "acquiredAt",
        "heartbeatAt", "expiresAt",
    }
    if set(claim) != required or not all(
        isinstance(claim.get(field), str) and claim[field] for field in required
    ):
        raise StoreError("coordinator claim is invalid")
    _safe_session_id(claim["jobId"])
    return claim


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
        "legacySources",
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
    legacy_sources = record.get("legacySources", [])
    if not isinstance(legacy_sources, list):
        raise StoreError("job legacySources must be an array")
    for source in legacy_sources:
        source = _require_object(source, "job legacy source")
        if set(source) != {"sourceKind", "relativePath", "entryId", "sourceSha256"}:
            raise StoreError("job legacy source contains unsupported fields")
        if source.get("sourceKind") != "timestamped-search-report":
            raise StoreError("job legacy source kind is unsupported")
        relative_path = source.get("relativePath")
        if (
            not isinstance(relative_path, str)
            or not relative_path
            or Path(relative_path).name != relative_path
            or not relative_path.startswith("search-")
            or not relative_path.endswith(".md")
        ):
            raise StoreError("job legacy source path is invalid")
        if not isinstance(source.get("entryId"), str) or not re.fullmatch(
            r"legacy-entry-[0-9a-f]{24}", source["entryId"]
        ):
            raise StoreError("job legacy source entry id is invalid")
        if not isinstance(source.get("sourceSha256"), str) or not re.fullmatch(
            r"[0-9a-f]{64}", source["sourceSha256"]
        ):
            raise StoreError("job legacy source digest is invalid")
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
    def __init__(self, root: Path, legacy_profile: Path | None = None, clock=None):
        self.root = root.expanduser()
        self.profile_path = self.root / "profile.json"
        self.answers_path = self.root / "answers.json"
        self.jobs_path = self.root / "jobs.json"
        self.resumes_path = self.root / "resumes.json"
        self.history_path = self.root / "applications.jsonl"
        self.sessions_path = self.root / "sessions"
        self.coordinator_path = self.root / "coordinator.json"
        self.coordinator_journal_path = self.root / "coordinator-journal.json"
        self.store_lock_path = self.root / ".store.lock"
        self.auto_submit_policy_path = self.root / "auto-submit"
        self.legacy_profile = (
            legacy_profile.expanduser()
            if legacy_profile is not None
            else Path.home() / ".claude-job-profile.json"
        )
        self.clock = clock or (lambda: datetime.now(timezone.utc))

    def _now_datetime(self) -> datetime:
        value = self.clock()
        if not isinstance(value, datetime):
            raise StoreError("coordinator clock returned an invalid value")
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _now(self) -> str:
        return self._now_datetime().isoformat(timespec="seconds").replace("+00:00", "Z")

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
            "coordinator": str(self.coordinator_path),
            "coordinatorJournal": str(self.coordinator_journal_path),
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
        coordinator_exists = (
            self.coordinator_path.exists() or self.coordinator_journal_path.exists()
        )
        if self.history_path.exists() and not coordinator_exists:
            self.read_history()
        if self.coordinator_path.exists():
            self._load_coordinator_document()
        if self.coordinator_journal_path.exists():
            self._load_coordinator_journal()

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

        if coordinator_exists:
            with exclusive_file_lock(self.store_lock_path):
                self._ensure_coordinator_files_locked()
                self._repair_pending_history_tail_locked()
                self._roll_forward_locked()
                self.read_history()

        return {"initialized": True, "migratedLegacyProfile": migrated, **self.paths()}

    def _ensure_coordinator_files_locked(self) -> None:
        if not self.coordinator_path.exists():
            atomic_write_json(
                self.coordinator_path,
                {"schemaVersion": SCHEMA_VERSION, "claim": None},
            )
        if not self.coordinator_journal_path.exists():
            atomic_write_json(
                self.coordinator_journal_path,
                {"schemaVersion": SCHEMA_VERSION, "operation": None},
            )

    def _ensure_coordinator_files(self) -> None:
        with exclusive_file_lock(self.store_lock_path):
            self._ensure_coordinator_files_locked()
            self._roll_forward_locked()

    def _load_coordinator_document(self) -> dict[str, Any]:
        document = read_json_object(self.coordinator_path, "coordinator")
        validate_version(document, "coordinator")
        if set(document) != {"schemaVersion", "claim"}:
            raise StoreError("coordinator contains unsupported fields")
        claim = document["claim"]
        if claim is not None:
            _validate_claim_record(claim)
        return document

    def _load_coordinator_journal(self) -> dict[str, Any]:
        document = read_json_object(self.coordinator_journal_path, "coordinator journal")
        validate_version(document, "coordinator journal")
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("coordinator journal contains unsupported fields")
        operation = document["operation"]
        if operation is not None:
            operation = _require_object(operation, "coordinator journal operation")
            kind = operation.get("kind")
            common = {"kind", "operationId", "jobId", "at", "historyEvent", "resultClaim"}
            transition = {"sourceStatus", "targetStatus", "expectedRevision"}
            expected = common | (transition if kind == "acquire" else set())
            if kind == "handoff":
                expected = common | transition | {"session"}
            if kind not in {"acquire", "recover", "handoff"} or set(operation) != expected:
                raise StoreError("coordinator journal operation is invalid")
            job_id = _safe_session_id(operation.get("jobId", ""))
            if not all(
                isinstance(operation.get(field), str) and operation[field]
                for field in ("operationId", "at")
            ):
                raise StoreError("coordinator journal operation is invalid")
            event = _require_object(operation.get("historyEvent"), "coordinator history event")
            _validate_history_event(event)
            if event.get("applicationId") != job_id:
                raise StoreError("coordinator history identity does not match")
            if kind in {"acquire", "handoff"}:
                revision = operation.get("expectedRevision")
                if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
                    raise StoreError("coordinator journal revision is invalid")
            if kind == "acquire":
                if operation.get("sourceStatus") != "ready" or operation.get("targetStatus") != "in_progress":
                    raise StoreError("coordinator acquisition transition is invalid")
            if kind == "handoff":
                if operation.get("sourceStatus") != "in_progress" or operation.get("targetStatus") not in {"needs_info", "awaiting_review"}:
                    raise StoreError("coordinator handoff transition is invalid")
                session = _require_object(operation.get("session"), "coordinator session")
                _validate_session_document(session)
                if session.get("applicationId") != job_id:
                    raise StoreError("coordinator session identity does not match")
            result_claim = operation.get("resultClaim")
            if kind == "handoff":
                if result_claim is not None:
                    raise StoreError("coordinator handoff must release its claim")
            else:
                claim = _validate_claim_record(result_claim)
                if claim["jobId"] != job_id:
                    raise StoreError("coordinator claim identity does not match")
        return document

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
        return self._profile_inspection(self._load_profile_document())

    @staticmethod
    def _profile_inspection(document: dict[str, Any]) -> dict[str, Any]:
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
                return self._profile_inspection(document)
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

    @staticmethod
    def _answer_view(record: dict[str, Any]) -> dict[str, Any]:
        view = dict(record)
        view.setdefault("revision", 1)
        view.setdefault("createdAt", record.get("updatedAt"))
        view.setdefault("deletedAt", None)
        return view

    def get_answer(
        self, key: str, include_trashed: bool = False
    ) -> dict[str, Any] | None:
        self.initialize()
        answers = self._load_answers_document()["answers"]
        answer = answers.get(key)
        if answer is None or (
            answer.get("deletedAt") is not None and not include_trashed
        ):
            return None
        return self._answer_view(_require_object(answer, "answer record"))

    def list_answers(
        self, state: str | None = None, include_trashed: bool = False
    ) -> list[dict[str, Any]]:
        self.initialize()
        if state is not None and state not in ANSWER_STATES:
            raise StoreError("answer state is unsupported")
        records = []
        for record in self._load_answers_document()["answers"].values():
            if record.get("deletedAt") is not None and not include_trashed:
                continue
            if state is not None and record.get("state") != state:
                continue
            records.append(self._answer_view(record))
        return sorted(
            records,
            key=lambda item: (
                item.get("question") or "",
                item["key"],
            ),
        )

    def find_answer(
        self, question: str, scope: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        self.initialize()
        normalized = normalize_question(question)
        document = self._load_answers_document()
        for record in document["answers"].values():
            item = _require_object(record, "answer record")
            if item.get("deletedAt") is not None:
                continue
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
                return self._answer_view(item)
        direct = document["answers"].get(answer_key(question, scope))
        if direct is None or direct.get("deletedAt") is not None:
            return None
        return self._answer_view(direct)

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

        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            current = document["answers"].get(key)
            if current is not None and current.get("deletedAt") is not None:
                raise StoreError("answer is trashed")
            now = utc_now()
            record = dict(_require_object(current or {}, "answer record"))
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
                    "createdAt": record.get("createdAt") or now,
                    "updatedAt": now,
                    "deletedAt": None,
                    "revision": (
                        record.get("revision", 1) + 1 if current is not None else 1
                    ),
                }
            )
            if state == "confirmed":
                record["confirmedAt"] = incoming.get("confirmedAt") or now
            else:
                record["confirmedAt"] = incoming.get("confirmedAt")
            if requires_consent:
                record["rememberedWithConsentAt"] = now
            else:
                record.pop("rememberedWithConsentAt", None)

            _validate_answer_record(key, record)
            document["answers"][key] = record
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.answers_path, document)
        return record

    def update_answer(
        self,
        key: str,
        patch: dict[str, Any],
        expected_revision: int,
        remember_sensitive: bool = False,
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        allowed = {
            "question",
            "aliases",
            "value",
            "state",
            "source",
            "scope",
            "sensitivity",
        }
        if not patch or set(patch) - allowed:
            raise StoreError("answer patch contains unsupported fields")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            current = document["answers"].get(key)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("answer does not exist")
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            updated = {**current, **patch}
            aliases = updated.get("aliases", [])
            if not isinstance(aliases, list) or not all(
                isinstance(alias, str) for alias in aliases
            ):
                raise StoreError("answer aliases must be strings")
            normalized_aliases: list[str] = []
            for alias in aliases:
                normalized = normalize_question(alias)
                if normalized not in normalized_aliases:
                    normalized_aliases.append(normalized)
            updated["aliases"] = normalized_aliases
            scope = updated.get("scope", {})
            if not isinstance(scope, dict):
                raise StoreError("answer scope must be a JSON object")
            state = updated.get("state")
            if state not in ANSWER_STATES:
                raise StoreError("answer state is unsupported")
            sensitivity = updated.get(
                "sensitivity", "high" if state == "sensitive" else "none"
            )
            if sensitivity not in SENSITIVITY_LEVELS:
                raise StoreError("answer sensitivity is unsupported")
            value = updated.get("value")
            if state == "confirmed" and value is None:
                raise StoreError("confirmed answers require a value")
            if state == "missing" and value is not None:
                raise StoreError("missing answers cannot contain a value")
            requires_consent = value is not None and (
                state == "sensitive" or sensitivity != "none"
            )
            changed_sensitive_value = (
                value != current.get("value")
                or not current.get("rememberedWithConsentAt")
            )
            if requires_consent and changed_sensitive_value and not remember_sensitive:
                raise StoreError(
                    "sensitive answer value requires explicit remember consent"
                )
            now = utc_now()
            updated["sensitivity"] = sensitivity
            updated["revision"] = revision + 1
            updated["createdAt"] = current.get("createdAt") or current.get("updatedAt") or now
            updated["updatedAt"] = now
            updated["deletedAt"] = None
            if state == "confirmed":
                if state != current.get("state") or value != current.get("value"):
                    updated["confirmedAt"] = now
                else:
                    updated["confirmedAt"] = current.get("confirmedAt") or now
            else:
                updated["confirmedAt"] = None
            if requires_consent:
                if changed_sensitive_value:
                    updated["rememberedWithConsentAt"] = now
            else:
                updated.pop("rememberedWithConsentAt", None)
            _validate_answer_record(key, updated)
            document["answers"][key] = updated
            document["metadata"]["updatedAt"] = now
            atomic_write_json(self.answers_path, document)
        return self._answer_view(updated)

    def trash_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        return self._set_answer_deleted(key, expected_revision, restore=False)

    def restore_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        return self._set_answer_deleted(key, expected_revision, restore=True)

    def _set_answer_deleted(
        self, key: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            current = document["answers"].get(key)
            if current is None:
                raise StoreError("answer does not exist")
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                return self._answer_view(current)
            updated = dict(current)
            updated["deletedAt"] = None if restore else utc_now()
            updated["revision"] = revision + 1
            updated["updatedAt"] = utc_now()
            _validate_answer_record(key, updated)
            document["answers"][key] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.answers_path, document)
        return self._answer_view(updated)

    def delete_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_answers_document()
            current = document["answers"].get(key)
            if current is None:
                return {"deleted": False, "key": key}
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("answer must be trashed before permanent deletion")
            for session in self._list_sessions_uninitialized():
                if key in session.get("answerKeys", []) or any(
                    field.get("answerKey") == key
                    for field in session.get("pendingFields", [])
                ):
                    raise StoreError("answer is referenced by an active session")
            del document["answers"][key]
            document["metadata"]["updatedAt"] = utc_now()
            atomic_write_json(self.answers_path, document)
        return {"deleted": True, "key": key}

    def _require_active_resume(self, resume_id: str | None) -> None:
        if resume_id is None:
            return
        if not isinstance(resume_id, str):
            raise StoreError("job resume id must be a string")
        _safe_session_id(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("assigned resume does not exist")

    def create_job(
        self, incoming: dict[str, Any], origin: str = "human"
    ) -> dict[str, Any]:
        self.initialize()
        origin = _job_origin(origin)
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
        incoming_provenance = _require_object(
            incoming.get("provenance", {}), "job provenance"
        )
        _reject_supplied_migration_provenance(incoming_provenance)
        stamped_fields = {
            field
            for field in JOB_INGEST_FIELDS
            if field in incoming and _nonempty_job_value(incoming[field])
        }
        record = {
            **incoming,
            "id": job_id,
            "url": url.strip(),
            "normalizedUrl": normalized_url,
            "priority": incoming.get("priority", 0),
            "status": status,
            "closedOutcome": incoming.get("closedOutcome"),
            "provenance": _stamp_job_provenance(
                incoming_provenance,
                stamped_fields,
                origin,
                _job_observation_source(incoming),
                now,
            ),
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
        self,
        job_id: str,
        patch: dict[str, Any],
        expected_revision: int,
        origin: str = "human",
    ) -> dict[str, Any]:
        self.initialize()
        origin = _job_origin(origin)
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
            current_provenance = _require_object(
                current.get("provenance", {}), "job provenance"
            )
            provenance = current_provenance
            provenance_changed = False
            if origin == "human" and "provenance" in patch:
                provenance = _require_object(patch["provenance"], "job provenance")
                _validate_migration_provenance_replacement(
                    current_provenance, provenance
                )
                provenance_changed = provenance != current_provenance
            accepted: dict[str, Any] = {}
            for field, value in patch.items():
                if field == "provenance":
                    continue
                if origin in {"agent", "migration"} and not _nonempty_job_value(value):
                    continue
                if origin == "agent" and not _agent_may_update_job_field(
                    current, current_provenance, field
                ):
                    continue
                if origin == "migration" and not _migration_may_update_job_field(
                    current, current_provenance, field
                ):
                    continue
                accepted[field] = value
            if "resumeId" in accepted:
                self._require_active_resume(accepted["resumeId"])
            updated = {**current, **accepted}
            if "url" in accepted:
                updated["normalizedUrl"] = normalize_job_url(accepted["url"])
                updated["url"] = accepted["url"].strip()
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
            changed = [
                field
                for field in accepted
                if current.get(field) != updated.get(field)
            ]
            if not changed and not provenance_changed:
                return current
            now = utc_now()
            updated["provenance"] = _stamp_job_provenance(
                provenance,
                changed,
                origin,
                _job_observation_source(updated),
                now,
            )
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = now
            _validate_job_record(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            atomic_write_json(self.jobs_path, document)
        return updated

    @staticmethod
    def _job_upsert_payload(payload: dict[str, Any]) -> list[Any]:
        if set(payload) != {"jobs"}:
            raise StoreError("job upsert input must contain only a jobs array")
        jobs = payload.get("jobs")
        if not isinstance(jobs, list):
            raise StoreError("job upsert input.jobs must be an array")
        return jobs

    @staticmethod
    def _canonical_upsert_input(payload: dict[str, Any]) -> dict[str, Any]:
        normalized: list[Any] = []
        for value in Store._job_upsert_payload(payload):
            if not isinstance(value, dict):
                normalized.append(value)
                continue
            item: dict[str, Any] = {}
            for field, field_value in value.items():
                if isinstance(field_value, str):
                    field_value = field_value.strip()
                item[field] = field_value
            normalized.append(item)
        return {"jobs": normalized}

    @staticmethod
    def _upsert_token(
        document: dict[str, Any], payload: dict[str, Any], origin: str
    ) -> str:
        bound = {
            "version": 1,
            "origin": _job_origin(origin),
            "input": Store._canonical_upsert_input(payload),
            "jobsDocument": document,
        }
        return "job-upsert-v1." + hashlib.sha256(
            _canonical_json(bound).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _deterministic_job_id(item: dict[str, Any]) -> str:
        identity = f"url\0{item['normalizedUrl']}"
        return "job-" + hashlib.sha256(identity.encode("utf-8")).hexdigest()[:24]

    @staticmethod
    def _normalize_upsert_item(value: Any) -> dict[str, Any]:
        item = _require_object(value, "job upsert item")
        if set(item) - JOB_INGEST_FIELDS:
            raise StoreError("job upsert item contains unsupported fields")
        if not _nonempty_job_value(item.get("url")):
            raise StoreError("job upsert item requires a URL")
        string_fields = JOB_INGEST_FIELDS - {"priority"}
        for field in string_fields:
            if field in item and item[field] is not None and not isinstance(
                item[field], str
            ):
                raise StoreError(f"job upsert item.{field} must be a string")
        priority = item.get("priority")
        if priority is not None and (
            not isinstance(priority, int)
            or isinstance(priority, bool)
            or not 0 <= priority <= 5
        ):
            raise StoreError("job upsert item.priority must be an integer from 0 to 5")
        normalized: dict[str, Any] = {}
        for field, field_value in item.items():
            if not _nonempty_job_value(field_value):
                continue
            normalized[field] = (
                field_value.strip() if isinstance(field_value, str) else field_value
            )
        normalized["normalizedUrl"] = normalize_job_url(normalized["url"])
        normalized["url"] = normalized["url"].strip()
        if "source" in normalized:
            normalized["source"] = normalized["source"].strip()
        if "sourceId" in normalized:
            normalized["sourceId"] = normalized["sourceId"].strip()
        return normalized

    @staticmethod
    def _source_identity(record: dict[str, Any]) -> tuple[str, str] | None:
        source = _normalized_job_source(record.get("source"))
        source_id = record.get("sourceId")
        if source and isinstance(source_id, str) and source_id.strip():
            return source, source_id.strip()
        return None

    def _plan_job_upsert(
        self,
        document: dict[str, Any],
        payload: dict[str, Any],
        origin: str,
        now: str,
        *,
        _allow_migration: bool = False,
        _target_ids: list[str | None] | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
        if not (_allow_migration and origin == "migration"):
            origin = _job_origin(origin)
        raw_jobs = self._job_upsert_payload(payload)
        normalized: list[dict[str, Any] | None] = []
        errors: list[str | None] = []
        for value in raw_jobs:
            try:
                normalized.append(self._normalize_upsert_item(value))
                errors.append(None)
            except StoreError as error:
                normalized.append(None)
                errors.append(str(error))

        conflict_indexes: set[int] = set()
        identities: dict[tuple[str, ...], list[int]] = {}
        for index, item in enumerate(normalized):
            if item is None:
                continue
            keys = [("url", item["normalizedUrl"])]
            source_identity = self._source_identity(item)
            if source_identity is not None:
                keys.append(("source", *source_identity))
            for key in keys:
                identities.setdefault(key, []).append(index)
        for indexes in identities.values():
            canonical = {
                _canonical_json(normalized[index]) for index in indexes
            }
            if len(canonical) > 1:
                conflict_indexes.update(indexes)

        simulated = json.loads(json.dumps(document))
        decisions: list[dict[str, Any]] = []
        changed_document = False
        for index, item in enumerate(normalized):
            if item is None:
                decisions.append(
                    {"index": index, "action": "invalid", "reason": errors[index]}
                )
                continue
            if index in conflict_indexes:
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "reason": "differing duplicate identities in input",
                    }
                )
                continue

            jobs = simulated["jobs"]
            target_id = _target_ids[index] if _target_ids is not None else None
            target_matches = (
                [jobs[target_id]] if target_id is not None and target_id in jobs else []
            )
            url_matches = [
                record
                for record in jobs.values()
                if record.get("normalizedUrl") == item["normalizedUrl"]
            ]
            source_identity = self._source_identity(item)
            source_matches = (
                [
                    record
                    for record in jobs.values()
                    if self._source_identity(record) == source_identity
                ]
                if source_identity is not None
                else []
            )
            matches = {
                record["id"]: record
                for record in url_matches + source_matches + target_matches
            }
            if (
                len(url_matches) > 1
                or len(source_matches) > 1
                or len(matches) > 1
                or any(record.get("deletedAt") is not None for record in matches.values())
            ):
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "reason": "job identities do not resolve to one active record",
                    }
                )
                continue

            current = next(iter(matches.values()), None)
            if current is not None:
                provenance = _require_object(
                    current.get("provenance", {}), "job provenance"
                )
                current_source = self._source_identity(current)
                source_changed = (
                    _nonempty_job_value(current.get("source"))
                    and _nonempty_job_value(item.get("source"))
                    and _normalized_job_source(current.get("source"))
                    != _normalized_job_source(item.get("source"))
                )
                source_id_changed = (
                    _nonempty_job_value(current.get("sourceId"))
                    and _nonempty_job_value(item.get("sourceId"))
                    and current.get("sourceId", "").strip()
                    != item.get("sourceId", "").strip()
                )
                migration_identity_refresh = origin == "migration" and (
                    current.get("normalizedUrl") == item["normalizedUrl"]
                    or target_id == current["id"]
                )
                migration_url_refresh = (
                    origin == "migration"
                    and target_id == current["id"]
                    and _migration_may_update_job_field(
                        current, provenance, "url"
                    )
                )
                if (
                    (
                        current.get("normalizedUrl") != item["normalizedUrl"]
                        and not migration_url_refresh
                    )
                    or (
                        (
                            current_source is not None
                            and source_identity is not None
                            and current_source != source_identity
                        )
                        or source_changed
                        or source_id_changed
                    )
                    and not migration_identity_refresh
                ):
                    decisions.append(
                        {
                            "index": index,
                            "action": "conflict",
                            "id": current["id"],
                            "reason": "incoming identity is incompatible with stored identity",
                        }
                    )
                    continue
                accepted: dict[str, Any] = {}
                for field in JOB_INGEST_FIELDS:
                    if field not in item or (field == "url" and not migration_url_refresh):
                        continue
                    value = item[field]
                    if origin == "agent" and not _agent_may_update_job_field(
                        current, provenance, field
                    ):
                        continue
                    if origin == "migration" and not _migration_may_update_job_field(
                        current, provenance, field
                    ):
                        continue
                    if current.get(field) != value:
                        accepted[field] = value
                if not accepted:
                    decisions.append(
                        {"index": index, "action": "noop", "id": current["id"]}
                    )
                    continue
                updated = {**current, **accepted}
                if "url" in accepted:
                    updated["normalizedUrl"] = item["normalizedUrl"]
                updated["provenance"] = _stamp_job_provenance(
                    provenance,
                    list(accepted),
                    origin,
                    _job_observation_source(updated),
                    now,
                )
                updated["revision"] = current["revision"] + 1
                updated["updatedAt"] = now
                _validate_job_record(current["id"], updated)
                jobs[current["id"]] = updated
                decisions.append(
                    {
                        "index": index,
                        "action": "update",
                        "id": current["id"],
                        "fields": sorted(accepted),
                    }
                )
                changed_document = True
                continue

            job_id = self._deterministic_job_id(item)
            if job_id in jobs:
                decisions.append(
                    {
                        "index": index,
                        "action": "conflict",
                        "id": job_id,
                        "reason": "deterministic job id is already in use",
                    }
                )
                continue
            incoming = {key: value for key, value in item.items() if key != "normalizedUrl"}
            fields = [field for field in JOB_INGEST_FIELDS if field in incoming]
            record = {
                **incoming,
                "id": job_id,
                "normalizedUrl": item["normalizedUrl"],
                "priority": incoming.get("priority", 0),
                "status": "saved",
                "closedOutcome": None,
                "provenance": _stamp_job_provenance(
                    {}, fields, origin, _job_observation_source(incoming), now
                ),
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
                "deletedAt": None,
            }
            try:
                _validate_job_record(job_id, record)
            except StoreError as error:
                decisions.append(
                    {"index": index, "action": "invalid", "reason": str(error)}
                )
                continue
            jobs[job_id] = record
            decisions.append({"index": index, "action": "create", "id": job_id})
            changed_document = True

        if changed_document:
            simulated["metadata"]["updatedAt"] = now
        return simulated, decisions, changed_document

    @staticmethod
    def _upsert_result(
        token: str, decisions: list[dict[str, Any]], committed: bool
    ) -> dict[str, Any]:
        counts = {action: 0 for action in ("create", "update", "noop", "conflict", "invalid")}
        for decision in decisions:
            counts[decision["action"]] += 1
        return {
            "token": token,
            "summary": counts,
            "decisions": decisions,
            "committed": committed,
        }

    def preview_job_upsert(
        self, payload: dict[str, Any], origin: str
    ) -> dict[str, Any]:
        document = self._load_jobs_document()
        token = self._upsert_token(document, payload, origin)
        _, decisions, _ = self._plan_job_upsert(document, payload, origin, utc_now())
        return self._upsert_result(token, decisions, committed=False)

    def commit_job_upsert(
        self, payload: dict[str, Any], origin: str, token: str
    ) -> dict[str, Any]:
        if not isinstance(token, str) or not token:
            raise StoreError("job upsert commit requires a preview token")
        with exclusive_file_lock(self.store_lock_path):
            document = self._load_jobs_document()
            expected = self._upsert_token(document, payload, origin)
            if not hmac.compare_digest(token, expected):
                raise StoreError("job upsert preview token rejected because the store or input drifted")
            planned, decisions, changed = self._plan_job_upsert(
                document, payload, origin, utc_now()
            )
            if changed:
                atomic_write_json(self.jobs_path, planned)
        return self._upsert_result(token, decisions, committed=changed)

    @staticmethod
    def _read_legacy_search_file(
        root_descriptor: int | None,
        root: Path,
        name: str,
        metadata: os.stat_result,
    ) -> bytes:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = (
                os.open(root / name, flags)
                if root_descriptor is None
                else os.open(name, flags, dir_fd=root_descriptor)
            )
        except OSError as error:
            raise StoreError("legacy search report cannot be opened safely") from error
        try:
            opened = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened.st_mode)
                or opened.st_dev != metadata.st_dev
                or opened.st_ino != metadata.st_ino
                or opened.st_size != metadata.st_size
            ):
                raise StoreError("legacy search report changed during discovery")
            chunks: list[bytes] = []
            total = 0
            while True:
                chunk = os.read(descriptor, min(65536, LEGACY_SEARCH_MAX_FILE_BYTES + 1 - total))
                if not chunk:
                    break
                chunks.append(chunk)
                total += len(chunk)
                if total > LEGACY_SEARCH_MAX_FILE_BYTES:
                    raise StoreError("legacy search report exceeds the per-file byte limit")
            closed = os.fstat(descriptor)
            if closed.st_size != opened.st_size:
                raise StoreError("legacy search report changed during discovery")
            return b"".join(chunks)
        finally:
            os.close(descriptor)

    @staticmethod
    def _parse_legacy_search_report(
        relative_path: str, source_sha256: str, text: str
    ) -> list[dict[str, Any]]:
        lines = text.splitlines()
        starts = [index for index, line in enumerate(lines) if line.startswith("###")]
        items: list[dict[str, Any]] = []
        heading_identities = [
            re.sub(r"^###\s+\d+\.\s*", "", lines[start]).strip()
            for start in starts
        ]
        heading_totals = {
            identity: heading_identities.count(identity)
            for identity in set(heading_identities)
        }
        content_occurrences: dict[str, int] = {}
        for ordinal, start in enumerate(starts, 1):
            end = starts[ordinal] if ordinal < len(starts) else len(lines)
            heading = lines[start]
            heading_identity = heading_identities[ordinal - 1]
            content_identity = heading_identity
            if heading_totals[heading_identity] > 1:
                content_identity = "\n".join(
                    [heading_identity, *lines[start + 1 : end]]
                ).strip()
            content_occurrence = content_occurrences.get(content_identity, 0) + 1
            content_occurrences[content_identity] = content_occurrence
            entry_id = "legacy-entry-" + hashlib.sha256(
                f"{relative_path}\0{content_identity}\0{content_occurrence}".encode("utf-8")
            ).hexdigest()[:24]
            item_id = "legacy-item-" + hashlib.sha256(
                entry_id.encode("utf-8")
            ).hexdigest()[:24]
            locator = {
                "sourceKind": "timestamped-search-report",
                "relativePath": relative_path,
                "entryId": entry_id,
                "sourceSha256": source_sha256,
            }

            heading_match = re.fullmatch(r"###\s+\d+\.\s+(.+?)\s+—\s+(.+)", heading)
            if heading_match is None:
                items.append({"itemId": item_id, "state": "invalid", "reason": "unsupported_heading", "source": locator})
                continue
            role = heading_match.group(1).strip()
            company = re.sub(r"\s+\(Score:\s*[^)]*\)\s*$", "", heading_match.group(2)).strip()
            if not role or not company:
                items.append({"itemId": item_id, "state": "invalid", "reason": "incomplete_heading", "source": locator})
                continue

            labels: dict[str, str] = {}
            duplicate = False
            for line in lines[start + 1 : end]:
                field = re.fullmatch(r"- \*\*([^*]+)\*\*:\s*(.*)", line)
                if field is None:
                    continue
                label = field.group(1).strip().lower()
                if label in labels:
                    duplicate = True
                    break
                labels[label] = field.group(2).strip()
            if duplicate:
                items.append({"itemId": item_id, "state": "invalid", "reason": "duplicate_field", "source": locator})
                continue

            url_candidates = []
            for label in ("url", "apply"):
                value = labels.get(label, "")
                if re.fullmatch(r"https?://\S+", value):
                    try:
                        normalized = normalize_job_url(value)
                    except StoreError:
                        continue
                    url_candidates.append((value, normalized))
            unique_urls = {normalized for _value, normalized in url_candidates}
            if not url_candidates:
                items.append({"itemId": item_id, "state": "invalid", "reason": "missing_url", "source": locator})
                continue
            if len(unique_urls) != 1:
                items.append({"itemId": item_id, "state": "invalid", "reason": "ambiguous_url", "source": locator})
                continue

            job: dict[str, Any] = {"url": url_candidates[0][0], "role": role, "company": company}
            mappings = {
                "source": "source",
                "location": "location",
                "salary": "compensation",
                "description": "description",
            }
            for label, canonical in mappings.items():
                if labels.get(label):
                    job[canonical] = labels[label]
            items.append({"itemId": item_id, "state": "valid", "source": locator, "job": job})
        return items

    def _discover_legacy_jobs(self) -> dict[str, Any]:
        root = Path.home() / LEGACY_SEARCH_ROOT
        try:
            root_metadata = root.lstat()
        except FileNotFoundError:
            return {"root": f"~/{LEGACY_SEARCH_ROOT}", "manifest": [], "items": []}
        except OSError as error:
            raise StoreError("legacy search root cannot be inspected") from error
        if not stat.S_ISDIR(root_metadata.st_mode) or stat.S_ISLNK(root_metadata.st_mode):
            raise StoreError("legacy search root must be a regular directory")

        root_descriptor: int | None = None
        if os.name != "nt":
            root_flags = (
                os.O_RDONLY
                | getattr(os, "O_DIRECTORY", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            try:
                root_descriptor = os.open(root, root_flags)
            except OSError as error:
                raise StoreError("legacy search root cannot be opened safely") from error
        manifest: list[dict[str, Any]] = []
        items: list[dict[str, Any]] = []
        aggregate = 0
        try:
            opened_root = (
                root.lstat()
                if root_descriptor is None
                else os.fstat(root_descriptor)
            )
            if (
                not stat.S_ISDIR(opened_root.st_mode)
                or opened_root.st_dev != root_metadata.st_dev
                or opened_root.st_ino != root_metadata.st_ino
            ):
                raise StoreError("legacy search root changed during discovery")
            paths = sorted(
                name
                for name in os.listdir(root if root_descriptor is None else root_descriptor)
                if name.startswith("search-") and name.endswith(".md")
            )
            if len(paths) > LEGACY_SEARCH_MAX_FILES:
                raise StoreError("legacy search discovery exceeds the file limit")
            for name in paths:
                try:
                    metadata = (
                        (root / name).lstat()
                        if root_descriptor is None
                        else os.stat(
                            name, dir_fd=root_descriptor, follow_symlinks=False
                        )
                    )
                except OSError as error:
                    raise StoreError("legacy search report cannot be inspected") from error
                if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
                    raise StoreError("legacy search reports must be regular files")
                if metadata.st_size > LEGACY_SEARCH_MAX_FILE_BYTES:
                    raise StoreError("legacy search report exceeds the per-file byte limit")
                aggregate += metadata.st_size
                if aggregate > LEGACY_SEARCH_MAX_TOTAL_BYTES:
                    raise StoreError("legacy search discovery exceeds the aggregate byte limit")
                raw = self._read_legacy_search_file(
                    root_descriptor, root, name, metadata
                )
                try:
                    decoded = raw.decode("utf-8")
                except UnicodeDecodeError as error:
                    raise StoreError("legacy search report is not valid UTF-8") from error
                digest = hashlib.sha256(raw).hexdigest()
                manifest.append({"relativePath": name, "sourceSha256": digest, "size": len(raw)})
                items.extend(self._parse_legacy_search_report(name, digest, decoded))
                if len(items) > LEGACY_SEARCH_MAX_ENTRIES:
                    raise StoreError("legacy search discovery exceeds the entry limit")
        finally:
            if root_descriptor is not None:
                os.close(root_descriptor)
        if root_descriptor is None:
            try:
                closed_root = root.lstat()
            except OSError as error:
                raise StoreError("legacy search root changed during discovery") from error
            if (
                not stat.S_ISDIR(closed_root.st_mode)
                or closed_root.st_dev != root_metadata.st_dev
                or closed_root.st_ino != root_metadata.st_ino
            ):
                raise StoreError("legacy search root changed during discovery")
        return {"root": f"~/{LEGACY_SEARCH_ROOT}", "manifest": manifest, "items": items}

    def _migration_jobs_snapshot(self) -> tuple[dict[str, Any], Any]:
        if self.jobs_path.exists():
            document = self._load_jobs_document()
            return document, document
        document = {
            "schemaVersion": SCHEMA_VERSION,
            "jobs": {},
            "metadata": {"createdAt": "1970-01-01T00:00:00Z", "updatedAt": "1970-01-01T00:00:00Z"},
        }
        return document, {"state": "missing"}

    @staticmethod
    def _selected_legacy_items(
        discovery: dict[str, Any],
        selected: list[str],
        *,
        unknown_message: str = "legacy job selection contains an unknown item id",
    ) -> list[dict[str, Any]]:
        if len(selected) != len(set(selected)):
            raise StoreError("legacy job selection contains duplicate item ids")
        indexed = {item["itemId"]: item for item in discovery["items"]}
        chosen: list[dict[str, Any]] = []
        for item_id in selected:
            item = indexed.get(item_id)
            if item is None:
                raise StoreError(unknown_message)
            if item["state"] != "valid":
                raise StoreError("legacy job selection contains an invalid item")
            chosen.append(item)
        return chosen

    @staticmethod
    def _legacy_jobs_token(
        discovery: dict[str, Any], selected: list[str], chosen: list[dict[str, Any]], snapshot: Any
    ) -> str:
        bound = {
            "version": 1,
            "origin": "migration",
            "selection": selected,
            "payloads": [item["job"] for item in chosen],
            "selectedLocators": [item["source"] for item in chosen],
            "manifest": discovery["manifest"],
            "jobsSnapshot": snapshot,
        }
        return "legacy-jobs-v1." + hashlib.sha256(_canonical_json(bound).encode("utf-8")).hexdigest()

    def _plan_legacy_jobs(
        self, document: dict[str, Any], chosen: list[dict[str, Any]], now: str
    ) -> tuple[dict[str, Any], list[dict[str, Any]], bool]:
        payload = {"jobs": [item["job"] for item in chosen]}
        target_ids: list[str | None] = []
        for item in chosen:
            locator = item["source"]
            identity = (
                locator["sourceKind"],
                locator["relativePath"],
                locator["entryId"],
            )
            matches = [
                record["id"]
                for record in document["jobs"].values()
                if any(
                    (
                        source["sourceKind"],
                        source["relativePath"],
                        source["entryId"],
                    )
                    == identity
                    for source in record.get("legacySources", [])
                )
            ]
            if len(matches) > 1:
                raise StoreError("legacy source locator resolves to multiple jobs")
            target_ids.append(matches[0] if matches else None)
        planned, decisions, changed = self._plan_job_upsert(
            document,
            payload,
            "migration",
            now,
            _allow_migration=True,
            _target_ids=target_ids,
        )
        for item, decision in zip(chosen, decisions):
            decision["itemId"] = item["itemId"]
            if decision["action"] in {"conflict", "invalid"}:
                continue
            record = planned["jobs"][decision["id"]]
            sources = list(record.get("legacySources", []))
            locator = item["source"]
            identity = (locator["sourceKind"], locator["relativePath"], locator["entryId"])
            replaced = False
            merged = []
            for source in sources:
                source_identity = (source["sourceKind"], source["relativePath"], source["entryId"])
                if source_identity == identity:
                    merged.append(locator)
                    replaced = True
                else:
                    merged.append(source)
            if not replaced:
                merged.append(locator)
            merged.sort(key=lambda source: (source["relativePath"], source["entryId"]))
            if merged != sources:
                record["legacySources"] = merged
                if decision["action"] == "noop":
                    record["revision"] += 1
                    record["updatedAt"] = now
                    decision["action"] = "update"
                    decision["fields"] = ["legacySources"]
                elif decision["action"] == "update":
                    decision["fields"] = sorted(set(decision.get("fields", [])) | {"legacySources"})
                changed = True
                planned["metadata"]["updatedAt"] = now
                _validate_job_record(record["id"], record)
        if document["metadata"].get("createdAt") == "1970-01-01T00:00:00Z" and changed:
            planned["metadata"]["createdAt"] = now
        return planned, decisions, changed

    @staticmethod
    def _legacy_result(
        discovery: dict[str, Any], selected: list[str], decisions: list[dict[str, Any]] | None = None,
        token: str | None = None, committed: bool = False,
    ) -> dict[str, Any]:
        result = {"root": discovery["root"], "manifest": discovery["manifest"], "items": discovery["items"], "selected": selected, "committed": committed}
        if decisions is not None:
            counts = {action: 0 for action in ("create", "update", "noop", "conflict", "invalid")}
            for decision in decisions:
                counts[decision["action"]] += 1
            result.update({"token": token, "summary": counts, "decisions": decisions})
        return result

    def preview_legacy_jobs(self, selected: list[str]) -> dict[str, Any]:
        discovery = self._discover_legacy_jobs()
        if not selected:
            return self._legacy_result(discovery, [])
        chosen = self._selected_legacy_items(discovery, selected)
        document, snapshot = self._migration_jobs_snapshot()
        token = self._legacy_jobs_token(discovery, selected, chosen, snapshot)
        _planned, decisions, _changed = self._plan_legacy_jobs(document, chosen, utc_now())
        return self._legacy_result(discovery, selected, decisions, token)

    def commit_legacy_jobs(self, selected: list[str], token: str) -> dict[str, Any]:
        if not selected or not isinstance(token, str) or not token:
            raise StoreError("legacy job commit requires selection and a preview token")
        with exclusive_file_lock(self.store_lock_path):
            discovery = self._discover_legacy_jobs()
            chosen = self._selected_legacy_items(
                discovery,
                selected,
                unknown_message=(
                    "legacy job preview token rejected because the source, selection, input, or store drifted"
                ),
            )
            document, snapshot = self._migration_jobs_snapshot()
            expected = self._legacy_jobs_token(discovery, selected, chosen, snapshot)
            if not hmac.compare_digest(token, expected):
                raise StoreError("legacy job preview token rejected because the source, selection, input, or store drifted")
            planned, decisions, changed = self._plan_legacy_jobs(document, chosen, utc_now())
            if changed:
                atomic_write_json(self.jobs_path, planned)
        return self._legacy_result(discovery, selected, decisions, token, changed)

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
            self._require_job_unclaimed_locked(job_id)
            if status == current["status"]:
                return current
            if status not in JOB_TRANSITIONS[current["status"]]:
                raise StoreError("job status transition is unsupported")
            if status == "in_progress":
                raise StoreError("in_progress requires atomic job-acquire")
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

    @staticmethod
    def _token_hash(token: str) -> str:
        if not isinstance(token, str) or not token:
            raise StoreError("claim token is required")
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _new_claim_token() -> str:
        # Keep the full 32-byte random payload while ensuring argparse can
        # always consume the bearer token as a separate option value.
        return f"claim_{secrets.token_urlsafe(32)}"

    def _public_claim(self, claim: dict[str, Any] | None) -> dict[str, Any] | None:
        if claim is None:
            return None
        public = {key: value for key, value in claim.items() if key != "tokenHash"}
        public["expired"] = self._now_datetime() >= self._parse_time(claim["expiresAt"])
        return public

    @staticmethod
    def _parse_time(value: str) -> datetime:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (AttributeError, ValueError) as error:
            raise StoreError("coordinator timestamp is invalid") from error
        if parsed.tzinfo is None:
            raise StoreError("coordinator timestamp is invalid")
        return parsed.astimezone(timezone.utc)

    def claim_status(self) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        claim = self._load_coordinator_document()["claim"]
        return {
            "claim": self._public_claim(claim),
            "leaseSeconds": CLAIM_LEASE_SECONDS,
            "heartbeatSeconds": CLAIM_HEARTBEAT_SECONDS,
        }

    def _require_claim_locked(
        self, job_id: str, token: str, allow_expired: bool = False
    ) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if claim is None or claim["jobId"] != job_id:
            raise StoreError("job is not held by this claim")
        if not hmac.compare_digest(claim["tokenHash"], self._token_hash(token)):
            raise StoreError("claim token is invalid")
        job = self._load_jobs_document()["jobs"].get(job_id)
        if job is None or job.get("deletedAt") is not None or job.get("status") != "in_progress":
            raise StoreError("claimed job is not in progress")
        if not allow_expired and self._now_datetime() >= self._parse_time(claim["expiresAt"]):
            raise StoreError("claim has expired; use explicit recovery")
        return claim

    def _require_job_unclaimed_locked(self, job_id: str) -> None:
        if not self.coordinator_path.exists():
            return
        claim = self._load_coordinator_document()["claim"]
        if claim is not None and claim["jobId"] == job_id:
            raise StoreError("claimed job requires a coordinator operation")

    def _history_event_for_operation(
        self, operation_id: str, job: dict[str, Any], event: str, status: str, at: str
    ) -> dict[str, Any]:
        record = {
            "schemaVersion": SCHEMA_VERSION,
            "eventId": f"coordinator-{operation_id}",
            "applicationId": job["id"],
            "event": event,
            "status": status,
            "answerKeys": [],
            "at": at,
        }
        for field in ("company", "role", "ats"):
            if isinstance(job.get(field), str):
                record[field] = job[field]
        _validate_history_event(record)
        return record

    def _append_history_event_idempotent_locked(self, event: dict[str, Any]) -> None:
        existing = self.read_history()
        if any(item.get("eventId") == event["eventId"] for item in existing):
            return
        _validate_history_event(event)
        encoded = (json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")
        descriptor = os.open(
            self.history_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600
        )
        original_size = os.fstat(descriptor).st_size
        try:
            offset = 0
            while offset < len(encoded):
                written = os.write(descriptor, encoded[offset:])
                if written <= 0:
                    raise StoreError("history append was incomplete")
                offset += written
            os.fsync(descriptor)
        except BaseException:
            os.ftruncate(descriptor, original_size)
            os.fsync(descriptor)
            raise
        finally:
            os.close(descriptor)
        _set_private_mode(self.history_path, 0o600)

    def _repair_pending_history_tail_locked(self) -> None:
        journal = self._load_coordinator_journal()
        if journal["operation"] is None or not self.history_path.exists():
            return
        descriptor = os.open(self.history_path, os.O_RDWR)
        try:
            content = os.read(descriptor, os.fstat(descriptor).st_size)
            if not content or content.endswith(b"\n"):
                return
            last_newline = content.rfind(b"\n")
            os.ftruncate(descriptor, last_newline + 1)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _roll_forward_locked(self) -> None:
        journal = self._load_coordinator_journal()
        operation = journal["operation"]
        if operation is None:
            return
        job_id = _safe_session_id(operation.get("jobId", ""))
        if "targetStatus" in operation:
            jobs = self._load_jobs_document()
            current = jobs["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("coordinator journal references a missing job")
            expected = operation["expectedRevision"]
            if current["revision"] == expected:
                if current["status"] != operation["sourceStatus"]:
                    raise StoreError("coordinator journal source status drifted")
                updated = dict(current)
                updated["status"] = operation["targetStatus"]
                updated["closedOutcome"] = None
                updated["revision"] = expected + 1
                updated["updatedAt"] = operation["at"]
                _validate_job_record(job_id, updated)
                jobs["jobs"][job_id] = updated
                jobs["metadata"]["updatedAt"] = operation["at"]
                atomic_write_json(self.jobs_path, jobs)
            elif not (
                current["revision"] == expected + 1
                and current["status"] == operation["targetStatus"]
            ):
                raise StoreError("coordinator journal cannot be reconciled")
        session = operation.get("session")
        if session is not None:
            _validate_session_document(session)
            atomic_write_json(self._session_path(job_id), session)
        event = operation.get("historyEvent")
        if event is not None:
            self._append_history_event_idempotent_locked(event)
        atomic_write_json(
            self.coordinator_path,
            {"schemaVersion": SCHEMA_VERSION, "claim": operation.get("resultClaim")},
        )
        atomic_write_json(
            self.coordinator_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": None},
        )

    def _commit_coordinator_operation_locked(self, operation: dict[str, Any]) -> None:
        atomic_write_json(
            self.coordinator_journal_path,
            {"schemaVersion": SCHEMA_VERSION, "operation": operation},
        )
        self._roll_forward_locked()

    def acquire_ready_job(
        self, job_id: str, owner_label: str, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        _safe_session_id(job_id)
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            coordinator = self._load_coordinator_document()
            current_claim = coordinator["claim"]
            if current_claim is not None:
                if self._now_datetime() >= self._parse_time(current_claim["expiresAt"]):
                    raise StoreError("expired claim requires explicit same-job recovery")
                raise StoreError("another live job claim already exists")
            jobs = self._load_jobs_document()
            job = jobs["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if job["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            if job["status"] != "ready":
                raise StoreError("only a ready job can be acquired")
            preflight = self._preflight_job_record(job)
            if not preflight["ready"]:
                raise StoreError("job is not ready")
            now_dt = self._now_datetime()
            now = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            token = self._new_claim_token()
            claim = {
                "claimId": str(uuid.uuid4()),
                "jobId": job_id,
                "ownerLabel": owner_label.strip(),
                "tokenHash": self._token_hash(token),
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": (now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(uuid.uuid4())
            operation = {
                "kind": "acquire", "operationId": operation_id, "jobId": job_id,
                "sourceStatus": "ready", "targetStatus": "in_progress",
                "expectedRevision": job["revision"], "at": now,
                "historyEvent": self._history_event_for_operation(operation_id, job, "job-started", "in_progress", now),
                "resultClaim": claim,
            }
            self._commit_coordinator_operation_locked(operation)
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "resume": self._load_resumes_document()["resumes"][preflight["resumeId"]],
                "claim": self._public_claim(claim),
                "token": token,
            }

    def heartbeat_claim(self, job_id: str, token: str) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            claim = dict(self._require_claim_locked(job_id, token))
            now_dt = self._now_datetime()
            claim["heartbeatAt"] = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            claim["expiresAt"] = (now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat(timespec="seconds").replace("+00:00", "Z")
            atomic_write_json(self.coordinator_path, {"schemaVersion": SCHEMA_VERSION, "claim": claim})
            return {"claim": self._public_claim(claim)}

    def recover_claim(self, job_id: str, owner_label: str) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        _safe_session_id(job_id)
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        with exclusive_file_lock(self.store_lock_path):
            old = self._load_coordinator_document()["claim"]
            if old is None or old["jobId"] != job_id:
                raise StoreError("explicit recovery must name the expired claimed job")
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("expired claim job is not in progress")
            if self._now_datetime() < self._parse_time(old["expiresAt"]):
                raise StoreError("live claim cannot be recovered")
            now_dt = self._now_datetime()
            now = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            token = self._new_claim_token()
            claim = {
                "claimId": str(uuid.uuid4()), "jobId": job_id,
                "ownerLabel": owner_label.strip(), "tokenHash": self._token_hash(token),
                "acquiredAt": now, "heartbeatAt": now,
                "expiresAt": (now_dt + timedelta(seconds=CLAIM_LEASE_SECONDS)).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(uuid.uuid4())
            self._commit_coordinator_operation_locked({
                "kind": "recover", "operationId": operation_id, "jobId": job_id,
                "at": now,
                "historyEvent": self._history_event_for_operation(operation_id, job, "claim-recovered", "in_progress", now),
                "resultClaim": claim,
            })
            return {"job": job, "claim": self._public_claim(claim), "token": token}

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
            self._require_job_unclaimed_locked(job_id)
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
            self._require_job_unclaimed_locked(job_id)
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

    def _build_session(
        self, application_id: str, incoming: dict[str, Any], now: str | None = None
    ) -> dict[str, Any]:
        allowed = {
            "applicationId", "status", "ats", "company", "role", "url", "step",
            "answerKeys", "pendingFields", "createdAt", "updatedAt",
        }
        if set(incoming) - allowed:
            raise StoreError("session contains unsupported fields")
        application_id = _safe_session_id(application_id)
        if incoming.get("applicationId", application_id) != application_id:
            raise StoreError("session application id does not match path")
        status = incoming.get("status", "active")
        if status not in SESSION_STATUSES:
            raise StoreError("session status is unsupported")
        answer_keys = incoming.get("answerKeys", [])
        if not isinstance(answer_keys, list) or not all(isinstance(item, str) for item in answer_keys):
            raise StoreError("session answerKeys must be strings")
        path = self._session_path(application_id)
        created_at = incoming.get("createdAt")
        if path.exists():
            existing = read_json_object(path, "session")
            _validate_session_document(existing)
            created_at = created_at or existing.get("createdAt")
        timestamp = now or utc_now()
        session = {
            "schemaVersion": SCHEMA_VERSION, **incoming,
            "applicationId": application_id, "status": status,
            "answerKeys": answer_keys,
            "pendingFields": incoming.get("pendingFields", []),
            "createdAt": created_at or timestamp, "updatedAt": timestamp,
        }
        _validate_session_document(session)
        return session

    def save_claim_progress(
        self, job_id: str, token: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        with exclusive_file_lock(self.store_lock_path):
            self._require_claim_locked(job_id, token)
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("claimed job is not in progress")
            session = self._build_session(job_id, incoming, self._now())
            if session["status"] != "active":
                raise StoreError("claim progress session must remain active")
            atomic_write_json(self._session_path(job_id), session)
            return session

    def handoff_claimed_job(
        self,
        job_id: str,
        token: str,
        status: str,
        incoming: dict[str, Any],
        expected_revision: int,
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        if status not in {"needs_info", "awaiting_review"}:
            raise StoreError("claimed handoff status is unsupported")
        with exclusive_file_lock(self.store_lock_path):
            self._require_claim_locked(job_id, token)
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("claimed job is not in progress")
            if job["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            now = self._now()
            session = self._build_session(job_id, incoming, now)
            required_session_status = "active" if status == "needs_info" else "review"
            if session["status"] != required_session_status:
                raise StoreError("handoff session status does not match job status")
            event_name = "job-blocked" if status == "needs_info" else "reviewed"
            operation_id = str(uuid.uuid4())
            self._commit_coordinator_operation_locked({
                "kind": "handoff", "operationId": operation_id, "jobId": job_id,
                "sourceStatus": "in_progress", "targetStatus": status,
                "expectedRevision": job["revision"], "at": now, "session": session,
                "historyEvent": self._history_event_for_operation(operation_id, job, event_name, status, now),
                "resultClaim": None,
            })
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "session": session,
                "claim": None,
            }

    def save_session(
        self, application_id: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        with exclusive_file_lock(self.store_lock_path):
            self._require_generic_session_mutation_allowed_locked(application_id)
            session = self._build_session(application_id, incoming)
            path = self._session_path(application_id)
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
        return self._list_sessions_uninitialized()

    def _list_sessions_uninitialized(self) -> list[dict[str, Any]]:
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
        with exclusive_file_lock(self.store_lock_path):
            self._require_generic_session_mutation_allowed_locked(
                application_id, allow_terminal_delete=True
            )
            path = self._session_path(application_id)
            if not path.exists():
                return {"deleted": False, "applicationId": application_id}
            path.unlink()
            _fsync_directory(self.sessions_path)
            return {"deleted": True, "applicationId": application_id}

    def _require_generic_session_mutation_allowed_locked(
        self, application_id: str, allow_terminal_delete: bool = False
    ) -> None:
        job = self._load_jobs_document()["jobs"].get(application_id)
        if (
            job is not None
            and job.get("deletedAt") is None
            and not (
                allow_terminal_delete and job.get("status") in {"applied", "closed"}
            )
        ):
            raise StoreError("canonical job sessions require a coordinator operation")


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
    get.add_argument("--include-trashed", action="store_true")
    find = commands.add_parser("answer-find")
    find.add_argument("--question", required=True)
    find.add_argument("--scope", default="{}")
    answer_list = commands.add_parser("answer-list")
    answer_list.add_argument("--state")
    answer_list.add_argument("--include-trashed", action="store_true")
    answer_update = commands.add_parser("answer-update")
    answer_update.add_argument("--key", required=True)
    answer_update.add_argument("--input", required=True)
    answer_update.add_argument("--expected-revision", required=True, type=int)
    answer_update.add_argument("--remember-sensitive", action="store_true")
    answer_trash = commands.add_parser("answer-trash")
    answer_trash.add_argument("--key", required=True)
    answer_trash.add_argument("--expected-revision", required=True, type=int)
    answer_restore = commands.add_parser("answer-restore")
    answer_restore.add_argument("--key", required=True)
    answer_restore.add_argument("--expected-revision", required=True, type=int)
    answer_delete = commands.add_parser("answer-delete")
    answer_delete.add_argument("--key", required=True)
    answer_delete.add_argument("--expected-revision", required=True, type=int)

    job_create = commands.add_parser("job-create")
    job_create.add_argument("--input", required=True)
    job_create.add_argument("--origin", choices=sorted(JOB_ORIGINS), default="human")
    job_upsert_preview = commands.add_parser("job-upsert-preview")
    job_upsert_preview.add_argument("--input", required=True)
    job_upsert_preview.add_argument("--origin", choices=sorted(JOB_ORIGINS), required=True)
    job_upsert_commit = commands.add_parser("job-upsert-commit")
    job_upsert_commit.add_argument("--input", required=True)
    job_upsert_commit.add_argument("--origin", choices=sorted(JOB_ORIGINS), required=True)
    job_upsert_commit.add_argument("--token", required=True)
    legacy_jobs_preview = commands.add_parser("legacy-jobs-preview")
    legacy_jobs_preview.add_argument("--select", action="append", default=[])
    legacy_jobs_commit = commands.add_parser("legacy-jobs-commit")
    legacy_jobs_commit.add_argument("--select", action="append", required=True)
    legacy_jobs_commit.add_argument("--confirm", required=True)
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
    job_update.add_argument("--origin", choices=sorted(JOB_ORIGINS), default="human")
    job_transition = commands.add_parser("job-transition")
    job_transition.add_argument("--id", required=True)
    job_transition.add_argument("--status", required=True)
    job_transition.add_argument("--closed-outcome")
    job_transition.add_argument("--expected-revision", required=True, type=int)
    job_transition.add_argument("--user-confirmed", action="store_true")
    job_acquire = commands.add_parser("job-acquire")
    job_acquire.add_argument("--id", required=True)
    job_acquire.add_argument("--owner", required=True)
    job_acquire.add_argument("--expected-revision", required=True, type=int)
    commands.add_parser("claim-status")
    claim_heartbeat = commands.add_parser("claim-heartbeat")
    claim_heartbeat.add_argument("--id", required=True)
    claim_heartbeat.add_argument("--token", required=True)
    claim_recover = commands.add_parser("claim-recover")
    claim_recover.add_argument("--id", required=True)
    claim_recover.add_argument("--owner", required=True)
    claim_progress = commands.add_parser("claim-progress")
    claim_progress.add_argument("--id", required=True)
    claim_progress.add_argument("--token", required=True)
    claim_progress.add_argument("--input", required=True)
    claim_handoff = commands.add_parser("claim-handoff")
    claim_handoff.add_argument("--id", required=True)
    claim_handoff.add_argument("--token", required=True)
    claim_handoff.add_argument("--status", required=True)
    claim_handoff.add_argument("--input", required=True)
    claim_handoff.add_argument("--expected-revision", required=True, type=int)
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
        return store.get_answer(args.key, include_trashed=args.include_trashed)
    if command == "answer-find":
        return store.find_answer(args.question, _scope(args.scope))
    if command == "answer-list":
        return store.list_answers(args.state, include_trashed=args.include_trashed)
    if command == "answer-update":
        return store.update_answer(
            args.key,
            _read_input(args.input),
            args.expected_revision,
            remember_sensitive=args.remember_sensitive,
        )
    if command == "answer-trash":
        return store.trash_answer(args.key, args.expected_revision)
    if command == "answer-restore":
        return store.restore_answer(args.key, args.expected_revision)
    if command == "answer-delete":
        return store.delete_answer(args.key, args.expected_revision)
    if command == "job-create":
        return store.create_job(_read_input(args.input), origin=args.origin)
    if command == "job-upsert-preview":
        return store.preview_job_upsert(_read_input(args.input), args.origin)
    if command == "job-upsert-commit":
        return store.commit_job_upsert(
            _read_input(args.input), args.origin, args.token
        )
    if command == "legacy-jobs-preview":
        return store.preview_legacy_jobs(args.select)
    if command == "legacy-jobs-commit":
        return store.commit_legacy_jobs(args.select, args.confirm)
    if command == "job-get":
        return store.get_job(args.id, include_trashed=args.include_trashed)
    if command == "job-list":
        return store.list_jobs(args.status, include_trashed=args.include_trashed)
    if command == "job-preflight":
        return store.preflight_job(args.id)
    if command == "job-update":
        return store.update_job(
            args.id,
            _read_input(args.input),
            args.expected_revision,
            origin=args.origin,
        )
    if command == "job-transition":
        return store.transition_job(
            args.id,
            args.status,
            args.expected_revision,
            closed_outcome=args.closed_outcome,
            user_confirmed=args.user_confirmed,
        )
    if command == "job-acquire":
        return store.acquire_ready_job(args.id, args.owner, args.expected_revision)
    if command == "claim-status":
        return store.claim_status()
    if command == "claim-heartbeat":
        return store.heartbeat_claim(args.id, args.token)
    if command == "claim-recover":
        return store.recover_claim(args.id, args.owner)
    if command == "claim-progress":
        return store.save_claim_progress(args.id, args.token, _read_input(args.input))
    if command == "claim-handoff":
        return store.handoff_claimed_job(
            args.id,
            args.token,
            args.status,
            _read_input(args.input),
            args.expected_revision,
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
