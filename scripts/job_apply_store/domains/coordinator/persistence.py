"""Crash-safe coordinator journal persistence and recovery."""

from __future__ import annotations

import json
import os
from typing import Any

from ... import io, normalization
from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...validation import jobs_resumes, sessions


_CANONICAL_RUNTIME = {
    "SCHEMA_VERSION": SCHEMA_VERSION,
    "StoreError": StoreError,
    "_canonical_json": normalization._canonical_json,
    "_require_object": io.require_object,
    "_safe_session_id": normalization._safe_session_id,
    "_set_private_mode": io._set_private_mode,
    "_validate_claim_record": sessions._validate_claim_record,
    "_validate_history_event_for_write": sessions._validate_history_event_for_write,
    "_validate_job_record": jobs_resumes._validate_job_record,
    "atomic_write_json": io.atomic_write_json,
    "exclusive_file_lock": io.exclusive_file_lock,
    "json": json,
    "os": os,
    "read_json_object": io.read_json_object,
    "validate_version": io.validate_version,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class CoordinatorPersistenceMixin:
    """Coordinator persistence composed ahead of the compatibility Store."""

    def _ensure_coordinator_files_locked(self) -> None:
        if not self.coordinator_path.exists():
            _late("atomic_write_json")(
                self.coordinator_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "claim": None},
            )
        if not self.coordinator_journal_path.exists():
            _late("atomic_write_json")(
                self.coordinator_journal_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "operation": None},
            )

    def _ensure_coordinator_files(self) -> None:
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._ensure_coordinator_files_locked()
            self._roll_forward_locked()

    def _load_coordinator_document(self) -> dict[str, Any]:
        document = _late("read_json_object")(self.coordinator_path, "coordinator")
        _late("validate_version")(document, "coordinator")
        if set(document) != {"schemaVersion", "claim"}:
            raise StoreError("coordinator contains unsupported fields")
        claim = document["claim"]
        if claim is not None:
            _late("_validate_claim_record")(claim)
        return document

    def _load_coordinator_journal(self) -> dict[str, Any]:
        document = _late("read_json_object")(
            self.coordinator_journal_path, "coordinator journal"
        )
        _late("validate_version")(document, "coordinator journal")
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("coordinator journal contains unsupported fields")
        operation = document["operation"]
        if operation is not None:
            operation = _late("_require_object")(
                operation, "coordinator journal operation"
            )
            kind = operation.get("kind")
            if kind == "answer_merge":
                expected = {
                    "kind", "operationId", "at", "winnerKey", "sourceKey",
                    "expectedWinnerRevision", "expectedSourceRevision", "sessions",
                    "resultClaim",
                }
                if set(operation) != expected:
                    raise StoreError("coordinator answer merge operation is invalid")
                for field in ("operationId", "at", "winnerKey", "sourceKey"):
                    if not isinstance(operation.get(field), str) or not operation[field]:
                        raise StoreError("coordinator answer merge operation is invalid")
                if operation["winnerKey"] == operation["sourceKey"]:
                    raise StoreError("coordinator answer merge identity is invalid")
                for field in ("expectedWinnerRevision", "expectedSourceRevision"):
                    revision = operation.get(field)
                    if (
                        not isinstance(revision, int)
                        or isinstance(revision, bool)
                        or revision < 1
                    ):
                        raise StoreError("coordinator answer merge revision is invalid")
                stored_sessions = operation.get("sessions")
                if not isinstance(stored_sessions, list):
                    raise StoreError("coordinator answer merge sessions are invalid")
                identities: set[str] = set()
                for session in stored_sessions:
                    session_document = _late("_require_object")(
                        session, "coordinator answer merge session"
                    )
                    _late("_validate_session_document")(session_document)
                    identity = session_document["applicationId"]
                    if identity in identities:
                        raise StoreError(
                            "coordinator answer merge sessions are duplicated"
                        )
                    identities.add(identity)
                result_claim = operation.get("resultClaim")
                if result_claim is not None:
                    _late("_validate_claim_record")(result_claim)
                return document
            if kind == "answer_resolution":
                expected = {
                    "kind", "operationId", "jobId", "at", "answerKey",
                    "expectedJobRevision", "expectedSessionRevision",
                    "expectedAnswerRevision", "sourceStatus", "targetStatus",
                    "session", "resultClaim",
                }
                if set(operation) != expected:
                    raise StoreError(
                        "coordinator answer resolution operation is invalid"
                    )
                job_id = _late("_safe_session_id")(operation.get("jobId", ""))
                if not all(
                    isinstance(operation.get(field), str) and operation[field]
                    for field in ("operationId", "at", "answerKey")
                ):
                    raise StoreError(
                        "coordinator answer resolution operation is invalid"
                    )
                for field in (
                    "expectedJobRevision", "expectedSessionRevision",
                    "expectedAnswerRevision",
                ):
                    revision = operation.get(field)
                    if (
                        not isinstance(revision, int)
                        or isinstance(revision, bool)
                        or revision < 1
                    ):
                        raise StoreError(
                            "coordinator answer resolution revision is invalid"
                        )
                if (
                    operation.get("sourceStatus") != "needs_info"
                    or operation.get("targetStatus") not in {"needs_info", "ready"}
                ):
                    raise StoreError(
                        "coordinator answer resolution transition is invalid"
                    )
                session = _late("_require_object")(
                    operation.get("session"), "coordinator session"
                )
                _late("_validate_session_document")(session)
                if session.get("applicationId") != job_id:
                    raise StoreError(
                        "coordinator answer resolution session is invalid"
                    )
                if operation.get("resultClaim") is not None:
                    raise StoreError(
                        "coordinator answer resolution cannot create a claim"
                    )
                return document
            common = {
                "kind", "operationId", "jobId", "at", "historyEvent",
                "resultClaim",
            }
            transition = {"sourceStatus", "targetStatus", "expectedRevision"}
            expected = common | (
                transition if kind in {"acquire", "review_restart"} else set()
            )
            if kind == "handoff":
                expected = common | transition | {"session"}
            if (
                kind not in {"acquire", "review_restart", "recover", "handoff"}
                or set(operation) != expected
            ):
                raise StoreError("coordinator journal operation is invalid")
            job_id = _late("_safe_session_id")(operation.get("jobId", ""))
            if not all(
                isinstance(operation.get(field), str) and operation[field]
                for field in ("operationId", "at")
            ):
                raise StoreError("coordinator journal operation is invalid")
            event = _late("_require_object")(
                operation.get("historyEvent"), "coordinator history event"
            )
            _late("_validate_history_event_for_write")(event)
            if event.get("applicationId") != job_id:
                raise StoreError("coordinator history identity does not match")
            if kind in {"acquire", "review_restart", "handoff"}:
                revision = operation.get("expectedRevision")
                if (
                    not isinstance(revision, int)
                    or isinstance(revision, bool)
                    or revision < 1
                ):
                    raise StoreError("coordinator journal revision is invalid")
            if kind == "acquire" and (
                operation.get("sourceStatus") != "ready"
                or operation.get("targetStatus") != "in_progress"
            ):
                raise StoreError("coordinator acquisition transition is invalid")
            if kind == "review_restart" and (
                operation.get("sourceStatus") != "awaiting_review"
                or operation.get("targetStatus") != "in_progress"
            ):
                raise StoreError("coordinator review restart transition is invalid")
            if kind == "handoff":
                if (
                    operation.get("sourceStatus") != "in_progress"
                    or operation.get("targetStatus")
                    not in {"needs_info", "awaiting_review"}
                ):
                    raise StoreError("coordinator handoff transition is invalid")
                session = _late("_require_object")(
                    operation.get("session"), "coordinator session"
                )
                _late("_validate_session_document")(session)
                if session.get("applicationId") != job_id:
                    raise StoreError("coordinator session identity does not match")
            result_claim = operation.get("resultClaim")
            if kind == "handoff":
                if result_claim is not None:
                    raise StoreError("coordinator handoff must release its claim")
            else:
                claim = _late("_validate_claim_record")(result_claim)
                if claim["jobId"] != job_id:
                    raise StoreError("coordinator claim identity does not match")
        return document

    def _history_event_for_operation(
        self, operation_id: str, job: dict[str, Any], event: str, status: str, at: str
    ) -> dict[str, Any]:
        record = {
            "schemaVersion": _late("SCHEMA_VERSION"),
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
        _late("_validate_history_event_for_write")(record)
        return record

    def _history_event_is_idempotent_locked(self, event: dict[str, Any]) -> bool:
        _late("_validate_history_event_for_write")(event)
        matching = [
            item
            for item in self.read_history()
            if item.get("eventId") == event["eventId"]
        ]
        if not matching:
            return False
        normalized = _late("_canonical_json")(event)
        if all(_late("_canonical_json")(item) == normalized for item in matching):
            return True
        raise StoreError("history event id collision")

    def _append_history_event_idempotent_locked(self, event: dict[str, Any]) -> None:
        if self._history_event_is_idempotent_locked(event):
            return
        runtime_json = _late("json")
        runtime_os = _late("os")
        encoded = (
            runtime_json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n"
        ).encode("utf-8")
        descriptor = runtime_os.open(
            self.history_path,
            runtime_os.O_WRONLY | runtime_os.O_CREAT | runtime_os.O_APPEND,
            0o600,
        )
        original_size = runtime_os.fstat(descriptor).st_size
        try:
            offset = 0
            while offset < len(encoded):
                written = runtime_os.write(descriptor, encoded[offset:])
                if written <= 0:
                    raise StoreError("history append was incomplete")
                offset += written
            runtime_os.fsync(descriptor)
        except BaseException:
            runtime_os.ftruncate(descriptor, original_size)
            runtime_os.fsync(descriptor)
            raise
        finally:
            runtime_os.close(descriptor)
        _late("_set_private_mode")(self.history_path, 0o600)

    def _repair_pending_history_tail_locked(self) -> None:
        journal = self._load_coordinator_journal()
        if journal["operation"] is None or not self.history_path.exists():
            return
        runtime_os = _late("os")
        descriptor = runtime_os.open(self.history_path, runtime_os.O_RDWR)
        try:
            content = runtime_os.read(
                descriptor, runtime_os.fstat(descriptor).st_size
            )
            if not content or content.endswith(b"\n"):
                return
            last_newline = content.rfind(b"\n")
            runtime_os.ftruncate(descriptor, last_newline + 1)
            runtime_os.fsync(descriptor)
        finally:
            runtime_os.close(descriptor)

    def _roll_forward_locked(self) -> None:
        journal = self._load_coordinator_journal()
        operation = journal["operation"]
        if operation is None:
            return
        write_json = _late("atomic_write_json")
        schema_version = _late("SCHEMA_VERSION")
        if operation["kind"] == "answer_merge":
            answers = self._load_answers_document()
            self._apply_answer_merge_locked(answers, operation)
            write_json(self.answers_path, answers)
            for session in operation["sessions"]:
                write_json(self._session_path(session["applicationId"]), session)
            write_json(
                self.coordinator_path,
                {"schemaVersion": schema_version, "claim": operation["resultClaim"]},
            )
            write_json(
                self.coordinator_journal_path,
                {"schemaVersion": schema_version, "operation": None},
            )
            return
        if operation["kind"] == "answer_resolution":
            job_id = operation["jobId"]
            jobs = self._load_jobs_document()
            current = jobs["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("coordinator journal references a missing job")
            expected = operation["expectedJobRevision"]
            if current["revision"] == expected:
                if current["status"] != operation["sourceStatus"]:
                    raise StoreError("coordinator journal source status drifted")
                updated = dict(current)
                updated["status"] = operation["targetStatus"]
                updated["closedOutcome"] = None
                updated["revision"] = expected + 1
                updated["updatedAt"] = operation["at"]
                _late("_validate_job_record")(job_id, updated)
                jobs["jobs"][job_id] = updated
                jobs["metadata"]["updatedAt"] = operation["at"]
                write_json(self.jobs_path, jobs)
            elif not (
                current["revision"] == expected + 1
                and current["status"] == operation["targetStatus"]
            ):
                raise StoreError("coordinator journal cannot be reconciled")
            session = operation["session"]
            path = self._session_path(job_id)
            existing = self._read_session_projection(path, job_id, current.get("ats"))
            existing_revision = self._session_revision(existing)
            if existing_revision == operation["expectedSessionRevision"]:
                write_json(path, session)
            elif _late("_canonical_json")(existing) != _late("_canonical_json")(
                session
            ):
                raise StoreError("coordinator session cannot be reconciled")
            write_json(
                self.coordinator_path,
                {"schemaVersion": schema_version, "claim": None},
            )
            write_json(
                self.coordinator_journal_path,
                {"schemaVersion": schema_version, "operation": None},
            )
            return
        event = operation.get("historyEvent")
        if event is not None:
            self._history_event_is_idempotent_locked(event)
        job_id = _late("_safe_session_id")(operation.get("jobId", ""))
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
                _late("_validate_job_record")(job_id, updated)
                jobs["jobs"][job_id] = updated
                jobs["metadata"]["updatedAt"] = operation["at"]
                write_json(self.jobs_path, jobs)
            elif not (
                current["revision"] == expected + 1
                and current["status"] == operation["targetStatus"]
            ):
                raise StoreError("coordinator journal cannot be reconciled")
        session = operation.get("session")
        if session is not None:
            _late("_validate_session_document")(session)
            write_json(self._session_path(job_id), session)
        if event is not None:
            self._append_history_event_idempotent_locked(event)
        write_json(
            self.coordinator_path,
            {"schemaVersion": schema_version, "claim": operation.get("resultClaim")},
        )
        write_json(
            self.coordinator_journal_path,
            {"schemaVersion": schema_version, "operation": None},
        )

    def _commit_coordinator_operation_locked(self, operation: dict[str, Any]) -> None:
        event = operation.get("historyEvent")
        if event is not None:
            self._history_event_is_idempotent_locked(event)
        _late("atomic_write_json")(
            self.coordinator_journal_path,
            {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation},
        )
        self._roll_forward_locked()
