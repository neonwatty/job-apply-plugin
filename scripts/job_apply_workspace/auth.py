"""Workspace authentication, Store error mapping, and lifecycle privacy."""

from __future__ import annotations

import secrets
from http import HTTPStatus
from typing import Any, Callable

from . import runtime


class AuthMixin:
    """Security and redacted error behavior shared by all routes."""

    def _valid_host(self) -> bool:
        if self.headers.get("Host") != self.server.expected_host:
            self._error(
                HTTPStatus.FORBIDDEN,
                "request host is not the workspace",
                "host_rejected",
            )
            return False
        return True

    def _authorized_api(self, mutation: bool = False) -> bool:
        if not self._valid_host():
            return False
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.token}"
        compare_digest = runtime().get("compare_digest", secrets.compare_digest)
        if not compare_digest(authorization, expected):
            self._error(
                HTTPStatus.UNAUTHORIZED,
                "workspace token is missing or invalid",
                "token_rejected",
            )
            return False
        if mutation and self.headers.get("Origin") != self.server.origin:
            self._error(
                HTTPStatus.FORBIDDEN,
                "request origin is not the workspace",
                "origin_rejected",
            )
            return False
        return True

    def _store_call(self, callback: Callable[[], Any]) -> None:
        store_module = runtime()["STORE_MODULE"]
        try:
            result = callback()
        except store_module.StoreError as error:
            message = str(error)
            if "revision conflict" in message:
                self._error(HTTPStatus.CONFLICT, message, "revision_conflict")
            elif "stale" in message:
                self._error(HTTPStatus.CONFLICT, message, "stale_conflict")
            elif "baseline changed" in message:
                self._error(HTTPStatus.CONFLICT, message, "baseline_conflict")
            elif "does not exist" in message:
                self._error(HTTPStatus.NOT_FOUND, message, "not_found")
            elif "nonterminal application session" in message:
                self._error(
                    HTTPStatus.CONFLICT, message, "session_reference_blocked"
                )
            elif "claimed job" in message:
                self._error(HTTPStatus.CONFLICT, message, "claim_blocked")
            elif "referenced by an active session" in message:
                self._error(
                    HTTPStatus.CONFLICT, message, "session_reference_blocked"
                )
            elif "referenced by durable history" in message:
                self._error(
                    HTTPStatus.CONFLICT, message, "history_reference_blocked"
                )
            elif "referenced by a job" in message:
                self._error(HTTPStatus.CONFLICT, message, "job_reference_blocked")
            elif "active job URL already exists" in message:
                self._error(
                    HTTPStatus.CONFLICT, message, "duplicate_active_blocked"
                )
            else:
                self._error(HTTPStatus.BAD_REQUEST, message, "store_rejected")
        except OSError:
            self._error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "storage operation failed",
                "storage_error",
            )
        else:
            self._json(HTTPStatus.OK, result)

    def _lifecycle_call(
        self,
        record_type: str,
        operation: str,
        record_id: str,
        callback: Callable[[], Any],
        projection: Callable[[Any], Any] | None = None,
    ) -> None:
        store_module = runtime()["STORE_MODULE"]
        try:
            result = callback()
        except store_module.StoreError as error:
            code, safe_message, counts = self._lifecycle_blocker(
                record_type, operation, record_id, str(error)
            )
            status = (
                HTTPStatus.NOT_FOUND
                if code == "not_found"
                else HTTPStatus.CONFLICT
                if code != "store_rejected"
                else HTTPStatus.BAD_REQUEST
            )
            self._error(
                status,
                safe_message,
                code,
                {
                    "recordType": record_type,
                    "operation": operation,
                    "counts": counts,
                },
            )
        except OSError:
            self._error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "storage operation failed",
                "storage_error",
            )
        else:
            self._json(HTTPStatus.OK, projection(result) if projection else result)

    def _lifecycle_blocker(
        self, record_type: str, operation: str, record_id: str, message: str
    ) -> tuple[str, str, dict[str, int]]:
        if "revision conflict" in message:
            return (
                "revision_conflict",
                "This record changed elsewhere. Refresh and review the latest revision.",
                {},
            )
        if "does not exist" in message and message != "assigned resume does not exist":
            return "not_found", "This record no longer exists.", {}
        mappings = (
            (
                "claimed job",
                "claim_blocked",
                "This job has a coordinator claim that must be released or completed first.",
                lambda: {"claims": 1},
            ),
            (
                "nonterminal application session",
                "session_reference_blocked",
                "This job has a nonterminal application session that must be completed or abandoned first.",
                lambda: {"nonterminalSessions": 1},
            ),
            (
                "referenced by an active session",
                "session_reference_blocked",
                "This answer is referenced by an active session and cannot be permanently deleted.",
                lambda: self._answer_reference_counts(record_id),
            ),
            (
                "referenced by application history",
                "history_reference_blocked",
                "This answer is referenced by protected application history and cannot be permanently deleted.",
                lambda: self._answer_reference_counts(record_id),
            ),
            (
                "still referenced by a job",
                "job_reference_blocked",
                "This resume is referenced by one or more jobs. Reassign or delete those jobs first.",
                lambda: self._resume_reference_counts(record_id),
            ),
            (
                "active job URL already exists",
                "duplicate_active_blocked",
                "An active job with the same canonical identity already exists.",
                lambda: {"duplicateActiveRecords": 1},
            ),
            (
                "active resume file already exists",
                "duplicate_active_blocked",
                "An active resume with the same canonical file identity already exists.",
                lambda: {"duplicateActiveRecords": 1},
            ),
            (
                "assigned resume does not exist",
                "assigned_resume_blocked",
                "This job's assigned resume is unavailable. Restore or reassign that resume first.",
                lambda: {"unavailableAssignedResumes": 1},
            ),
            (
                "answer is the target of an immutable redirect",
                "redirect_target_blocked",
                "This answer is a canonical redirect target and cannot be moved or deleted.",
                lambda: {},
            ),
            (
                "resume is assigned to an active job",
                "job_reference_blocked",
                "This resume is assigned to an active job. Reassign that job first.",
                lambda: self._resume_reference_counts(record_id, active_only=True),
            ),
            (
                "default resume is used by an active job",
                "default_reference_blocked",
                "This default resume is in use by active jobs. Assign another default first.",
                lambda: self._resume_reference_counts(record_id, active_only=True),
            ),
        )
        for fragment, code, safe_message, counts_factory in mappings:
            if fragment in message:
                return code, safe_message, counts_factory()
        return (
            "store_rejected",
            "The canonical store rejected this lifecycle operation.",
            {},
        )

    def _answer_reference_counts(self, key: str) -> dict[str, int]:
        answer = self.server.store.get_answer(key, include_trashed=True)
        references = answer.get("referenceCounts", {}) if answer else {}
        return {
            "sessions": int(references.get("sessions", 0)),
            "history": int(references.get("history", 0)),
        }

    def _resume_reference_counts(
        self, resume_id: str, active_only: bool = False
    ) -> dict[str, int]:
        jobs = self.server.store.list_jobs(include_trashed=True)
        references = sum(
            job.get("resumeId") == resume_id
            and (not active_only or job.get("deletedAt") is None)
            for job in jobs
        )
        if active_only:
            resume = self.server.store.get_resume(resume_id, include_trashed=True)
            if resume and resume.get("default"):
                references += sum(
                    job.get("resumeId") is None and job.get("deletedAt") is None
                    for job in jobs
                )
        return {"jobReferences": references}

    def _expected_revision(self, payload: dict[str, Any]) -> int | None:
        revision = payload.get("expectedRevision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            self._error(
                HTTPStatus.BAD_REQUEST,
                "expectedRevision must be a positive integer",
            )
            return None
        return revision
