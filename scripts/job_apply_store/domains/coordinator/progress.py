"""Claim progress, handoff, and pending-answer resolution behavior."""

from __future__ import annotations

import copy
import uuid
from typing import Any

from ... import io, normalization
from ...constants import PENDING_REFERENCE
from ...errors import StoreError
from ...validation import sessions


_CANONICAL_RUNTIME = {
    "PENDING_REFERENCE": PENDING_REFERENCE,
    "_safe_session_id": normalization._safe_session_id,
    "_validate_session_document": sessions._validate_session_document,
    "atomic_write_json": io.atomic_write_json,
    "copy": copy,
    "exclusive_file_lock": io.exclusive_file_lock,
    "uuid": uuid,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class CoordinatorProgressMixin:
    """Coordinator progress operations on Store state supplied by composition."""

    def resolve_pending_answer(
        self, job_id: str, reference: str, expected_job_revision: int,
        expected_session_revision: int, expected_answer_revision: int,
        owner_confirmed: bool = False,
    ) -> dict[str, Any]:
        """Recheck one pending question without copying its answer value."""
        self.initialize()
        self._ensure_coordinator_files()
        job_id = _late("_safe_session_id")(job_id)
        if not owner_confirmed:
            raise StoreError("answer resolution requires explicit owner confirmation")
        if (
            not isinstance(reference, str)
            or _late("PENDING_REFERENCE").fullmatch(reference) is None
        ):
            raise StoreError("pending question reference is invalid")
        for revision in (
            expected_job_revision,
            expected_session_revision,
            expected_answer_revision,
        ):
            if (
                not isinstance(revision, int)
                or isinstance(revision, bool)
                or revision < 1
            ):
                raise StoreError("answer resolution revision is invalid")
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._require_job_unclaimed_locked(job_id)
            jobs = self._load_jobs_document()
            job = jobs["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if job["revision"] != expected_job_revision:
                raise StoreError("job revision conflict")
            if job["status"] != "needs_info":
                raise StoreError("answer resolution requires a needs_info job")
            path = self._session_path(job_id)
            if not path.exists():
                raise StoreError("answer resolution session does not exist")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            if self._session_revision(session) != expected_session_revision:
                raise StoreError("session revision conflict")
            pending = session.get("pendingFields", [])
            matching = [
                (index, field)
                for index, field in enumerate(pending)
                if field.get("reference") == reference
            ]
            if len(matching) != 1:
                raise StoreError("pending question reference is stale")
            index, field = matching[0]
            key = field.get("answerKey")
            if not isinstance(key, str) or not key:
                raise StoreError("pending question has no referenced answer")
            if field.get("sensitive") is True or field.get("state") == "sensitive":
                raise StoreError("sensitive pending answers require reconfirmation")
            answers = self._load_answers_document()
            resolved_key = self._resolve_answer_key_in_document(answers, key)
            answer = answers["answers"].get(resolved_key)
            if answer is None or answer.get("deletedAt") is not None:
                raise StoreError("referenced answer does not exist")
            if answer.get("revision", 1) != expected_answer_revision:
                raise StoreError("answer revision conflict")
            if (
                answer.get("reviewStatus", "accepted") != "accepted"
                or answer.get("state") != "confirmed"
                or answer.get("value") is None
            ):
                raise StoreError("referenced answer is not accepted and confirmed")
            if self._answer_is_sensitive(answer):
                raise StoreError("sensitive pending answers require reconfirmation")
            now = self._now()
            updated_session = _late("copy").deepcopy(session)
            del updated_session["pendingFields"][index]
            updated_session["blockers"] = [
                blocker
                for blocker in updated_session.get("blockers", [])
                if blocker.get("reference") != reference
            ]
            answer_keys = list(updated_session.get("answerKeys", []))
            if resolved_key not in answer_keys:
                answer_keys.append(resolved_key)
            updated_session["answerKeys"] = answer_keys
            updated_session["updatedAt"] = now
            _late("_validate_session_document")(updated_session)
            target = "needs_info"
            if (
                not updated_session["pendingFields"]
                and not updated_session.get("blockers", [])
                and (updated_session.get("browserHandoff") or {}).get("state")
                not in {"required", "ready_for_owner"}
            ):
                if not self._preflight_job_record(job)["ready"]:
                    raise StoreError("job preflight failed after answer resolution")
                target = "ready"
            self._commit_coordinator_operation_locked({
                "kind": "answer_resolution",
                "operationId": str(_late("uuid").uuid4()),
                "jobId": job_id,
                "at": now,
                "answerKey": resolved_key,
                "expectedJobRevision": expected_job_revision,
                "expectedSessionRevision": expected_session_revision,
                "expectedAnswerRevision": expected_answer_revision,
                "sourceStatus": "needs_info",
                "targetStatus": target,
                "session": updated_session,
                "resultClaim": None,
            })
            result_job = self._load_jobs_document()["jobs"][job_id]
            return {
                "job": {
                    "id": job_id,
                    "status": result_job["status"],
                    "revision": result_job["revision"],
                },
                "session": {
                    "revision": self._session_revision(updated_session),
                    "pendingInformation": [
                        {
                            key: item[key]
                            for key in ("question", "state", "sensitive")
                            if key in item
                        }
                        | self._pending_resolution_projection(item, answers)
                        for item in updated_session["pendingFields"]
                    ],
                },
                "resolved": True,
                "ready": target == "ready",
            }

    def save_claim_progress(
        self, job_id: str, token: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._require_claim_locked(job_id, token)
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("claimed job is not in progress")
            session = self._build_session(
                job_id,
                incoming,
                self._now(),
                expected_attempt_revision=job["revision"],
                expected_ats=job.get("ats"),
            )
            if session["status"] != "active":
                raise StoreError("claim progress session must remain active")
            _late("atomic_write_json")(self._session_path(job_id), session)
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
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._require_claim_locked(job_id, token)
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("status") != "in_progress":
                raise StoreError("claimed job is not in progress")
            if job["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            now = self._now()
            session = self._build_session(
                job_id,
                incoming,
                now,
                expected_attempt_revision=job["revision"],
                expected_ats=job.get("ats"),
            )
            required_session_status = (
                "active" if status == "needs_info" else "review"
            )
            if session["status"] != required_session_status:
                raise StoreError("handoff session status does not match job status")
            if status == "awaiting_review":
                if "readinessInput" not in incoming:
                    raise StoreError(
                        "awaiting_review requires fresh current live readiness input"
                    )
                readiness = session.get("readiness")
                if (
                    readiness is None
                    or readiness.get("attemptRevision") != job["revision"]
                    or readiness.get("evidenceKind")
                    != "agent_attested_current_attempt"
                    or readiness.get("status") != "ready"
                    or readiness.get("blockerCodes")
                    or any(
                        value != "passed"
                        for value in readiness.get("assertions", {}).values()
                    )
                    or session.get("pendingFields")
                    or session.get("blockers")
                    or session.get("browserHandoff") != {
                        "state": "ready_for_owner",
                        "reasonCode": "final-review-required",
                        "revision": 1,
                    }
                ):
                    raise StoreError(
                        "awaiting_review requires complete current "
                        "agent-attested readiness"
                    )
            event_name = "job-blocked" if status == "needs_info" else "reviewed"
            operation_id = str(_late("uuid").uuid4())
            self._commit_coordinator_operation_locked({
                "kind": "handoff",
                "operationId": operation_id,
                "jobId": job_id,
                "sourceStatus": "in_progress",
                "targetStatus": status,
                "expectedRevision": job["revision"],
                "at": now,
                "session": session,
                "historyEvent": self._history_event_for_operation(
                    operation_id, job, event_name, status, now
                ),
                "resultClaim": None,
            })
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "session": session,
                "claim": None,
            }
