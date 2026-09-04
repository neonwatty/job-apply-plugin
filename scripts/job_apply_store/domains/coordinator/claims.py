"""Exclusive coordinator claim acquisition, renewal, and recovery."""

from __future__ import annotations

import hashlib
import hmac
import secrets
import uuid
from datetime import datetime, timedelta
from typing import Any

from ...constants import CLAIM_HEARTBEAT_SECONDS, CLAIM_LEASE_SECONDS, SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock, read_json_object, validate_version
from ...normalization import _safe_session_id
from ...validation.sessions import _parse_coordinator_time


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


def _late(name: str, fallback: Any) -> Any:
    return _runtime().get(name, fallback)


def _canonical_project_legacy_session(
    session: dict[str, Any], expected_ats: Any = None
) -> dict[str, Any]:
    """Use the unchanged document when no composing facade supplies projection."""
    return session


class CoordinatorClaimsMixin:
    """Claim operations composed ahead of the compatibility Store."""

    @staticmethod
    def _token_hash(token: str) -> str:
        if not isinstance(token, str) or not token:
            raise StoreError("claim token is required")
        return _late("hashlib", hashlib).sha256(token.encode("utf-8")).hexdigest()

    @staticmethod
    def _new_claim_token() -> str:
        # Keep the full 32-byte random payload while ensuring argparse can
        # always consume the bearer token as a separate option value.
        return f"claim_{_late('secrets', secrets).token_urlsafe(32)}"

    def _public_claim(self, claim: dict[str, Any] | None) -> dict[str, Any] | None:
        if claim is None:
            return None
        public = {key: value for key, value in claim.items() if key != "tokenHash"}
        public["expired"] = self._now_datetime() >= self._parse_time(claim["expiresAt"])
        return public

    @staticmethod
    def _parse_time(value: str) -> datetime:
        return _late("_parse_coordinator_time", _parse_coordinator_time)(value)

    def claim_status(self) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        claim = self._load_coordinator_document()["claim"]
        return {
            "claim": self._public_claim(claim),
            "leaseSeconds": _late("CLAIM_LEASE_SECONDS", CLAIM_LEASE_SECONDS),
            "heartbeatSeconds": _late(
                "CLAIM_HEARTBEAT_SECONDS", CLAIM_HEARTBEAT_SECONDS
            ),
        }

    def _require_claim_locked(
        self, job_id: str, token: str, allow_expired: bool = False
    ) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if claim is None or claim["jobId"] != job_id:
            raise StoreError("job is not held by this claim")
        if not _late("hmac", hmac).compare_digest(
            claim["tokenHash"], self._token_hash(token)
        ):
            raise StoreError("claim token is invalid")
        job = self._load_jobs_document()["jobs"].get(job_id)
        if (
            job is None
            or job.get("deletedAt") is not None
            or job.get("status") != "in_progress"
        ):
            raise StoreError("claimed job is not in progress")
        if not allow_expired and self._now_datetime() >= self._parse_time(
            claim["expiresAt"]
        ):
            raise StoreError("claim has expired; use explicit recovery")
        return claim

    def _require_job_unclaimed_locked(self, job_id: str) -> None:
        if not self.coordinator_path.exists():
            return
        claim = self._load_coordinator_document()["claim"]
        if claim is not None and claim["jobId"] == job_id:
            raise StoreError("claimed job requires a coordinator operation")

    def acquire_ready_job(
        self, job_id: str, owner_label: str, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        _late("_safe_session_id", _safe_session_id)(job_id)
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
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
                "claimId": str(_late("uuid", uuid).uuid4()),
                "jobId": job_id,
                "ownerLabel": owner_label.strip(),
                "tokenHash": self._token_hash(token),
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": (
                    now_dt
                    + timedelta(
                        seconds=_late("CLAIM_LEASE_SECONDS", CLAIM_LEASE_SECONDS)
                    )
                ).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(_late("uuid", uuid).uuid4())
            operation = {
                "kind": "acquire",
                "operationId": operation_id,
                "jobId": job_id,
                "sourceStatus": "ready",
                "targetStatus": "in_progress",
                "expectedRevision": job["revision"],
                "at": now,
                "historyEvent": self._history_event_for_operation(
                    operation_id, job, "job-started", "in_progress", now
                ),
                "resultClaim": claim,
            }
            self._commit_coordinator_operation_locked(operation)
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "resume": self._resume_for_acquisition(
                    self._load_resumes_document()["resumes"][preflight["resumeId"]]
                ),
                "claim": self._public_claim(claim),
                "token": token,
            }

    def restart_reviewed_job(
        self,
        job_id: str,
        owner_label: str,
        expected_revision: int,
        owner_confirmed_not_submitted: bool = False,
    ) -> dict[str, Any]:
        """Atomically reclaim one reviewed, owner-confirmed unsubmitted job."""

        self.initialize()
        self._ensure_coordinator_files()
        job_id = _late("_safe_session_id", _safe_session_id)(job_id)
        if owner_confirmed_not_submitted is not True:
            raise StoreError(
                "review restart requires explicit owner confirmation that the "
                "application was not submitted"
            )
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        if (
            not isinstance(expected_revision, int)
            or isinstance(expected_revision, bool)
            or expected_revision < 1
        ):
            raise StoreError("job revision is invalid")

        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
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
            if job["status"] != "awaiting_review":
                raise StoreError("review restart requires an awaiting_review job")

            session_path = self._session_path(job_id)
            if not session_path.exists():
                raise StoreError("review restart requires prior review evidence")
            raw_session = _late("read_json_object", read_json_object)(
                session_path, "session"
            )
            _late("validate_version", validate_version)(raw_session, "session")
            session = _late(
                "_project_legacy_session", _canonical_project_legacy_session
            )(raw_session, job.get("ats"))
            review_envelope = {"attemptRevision", "readiness", "browserHandoff"}
            legacy_review_rebuild = not (review_envelope & set(raw_session))
            if legacy_review_rebuild:
                if (
                    session.get("status") != "review"
                    or session.get("step") != "final_review"
                    or session.get("pendingFields")
                    or session.get("blockers")
                ):
                    raise StoreError(
                        "review restart requires complete prior review evidence"
                    )
            else:
                # The modern 1.3.2 path remains strict. Any partial envelope,
                # explicit null, malformed value, or contradictory evidence is
                # rejected rather than being interpreted as legacy absence.
                readiness = session.get("readiness")
                if (
                    session.get("status") != "review"
                    or session.get("attemptRevision") != job["revision"] - 1
                    or session.get("pendingFields")
                    or session.get("blockers")
                    or readiness is None
                    or readiness.get("status") != "ready"
                    or readiness.get("evidenceKind")
                    != "agent_attested_current_attempt"
                    or readiness.get("attemptRevision")
                    != session.get("attemptRevision")
                    or readiness.get("blockerCodes")
                    or any(
                        value != "passed"
                        for value in readiness.get("assertions", {}).values()
                    )
                    or session.get("browserHandoff") != {
                        "state": "ready_for_owner",
                        "reasonCode": "final-review-required",
                        "revision": 1,
                    }
                ):
                    raise StoreError(
                        "review restart requires complete prior review evidence"
                    )
            job_history = [
                event
                for event in self.read_history()
                if event.get("applicationId") == job_id
            ]
            if (
                not job_history
                or job_history[-1].get("event") != "reviewed"
                or job_history[-1].get("status") != "awaiting_review"
            ):
                raise StoreError("review restart requires prior reviewed history")
            if legacy_review_rebuild and any(
                event.get("event") in {"job-restarted", "legacy-review-rebuild"}
                for event in job_history[:-1]
            ):
                raise StoreError("legacy review restart was already used")

            preflight = self._preflight_job_record(job)
            resumes = self._load_resumes_document()["resumes"]
            resume = resumes.get(preflight.get("resumeId"))
            if (
                not preflight["ready"]
                or resume is None
                or resume.get("storageKind") != "managed"
            ):
                raise StoreError("job is not ready with a current managed resume")

            now_dt = self._now_datetime()
            now = now_dt.isoformat(timespec="seconds").replace("+00:00", "Z")
            token = self._new_claim_token()
            claim = {
                "claimId": str(_late("uuid", uuid).uuid4()),
                "jobId": job_id,
                "ownerLabel": owner_label.strip(),
                "tokenHash": self._token_hash(token),
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": (
                    now_dt
                    + timedelta(
                        seconds=_late("CLAIM_LEASE_SECONDS", CLAIM_LEASE_SECONDS)
                    )
                ).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(_late("uuid", uuid).uuid4())
            operation = {
                "kind": "review_restart",
                "operationId": operation_id,
                "jobId": job_id,
                "sourceStatus": "awaiting_review",
                "targetStatus": "in_progress",
                "expectedRevision": job["revision"],
                "at": now,
                "historyEvent": self._history_event_for_operation(
                    operation_id,
                    job,
                    (
                        "legacy-review-rebuild"
                        if legacy_review_rebuild
                        else "job-restarted"
                    ),
                    "in_progress",
                    now,
                ),
                "resultClaim": claim,
            }
            self._commit_coordinator_operation_locked(operation)
            return {
                "job": self._load_jobs_document()["jobs"][job_id],
                "resume": self._resume_for_acquisition(resume),
                "claim": self._public_claim(claim),
                "token": token,
            }

    def heartbeat_claim(self, job_id: str, token: str) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            claim = dict(self._require_claim_locked(job_id, token))
            now_dt = self._now_datetime()
            claim["heartbeatAt"] = now_dt.isoformat(timespec="seconds").replace(
                "+00:00", "Z"
            )
            claim["expiresAt"] = (
                now_dt
                + timedelta(
                    seconds=_late("CLAIM_LEASE_SECONDS", CLAIM_LEASE_SECONDS)
                )
            ).isoformat(timespec="seconds").replace("+00:00", "Z")
            _late("atomic_write_json", atomic_write_json)(
                self.coordinator_path,
                {
                    "schemaVersion": _late("SCHEMA_VERSION", SCHEMA_VERSION),
                    "claim": claim,
                },
            )
            return {"claim": self._public_claim(claim)}

    def recover_claim(self, job_id: str, owner_label: str) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        _late("_safe_session_id", _safe_session_id)(job_id)
        if not isinstance(owner_label, str) or not owner_label.strip():
            raise StoreError("owner label must be a non-empty string")
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
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
                "claimId": str(_late("uuid", uuid).uuid4()),
                "jobId": job_id,
                "ownerLabel": owner_label.strip(),
                "tokenHash": self._token_hash(token),
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": (
                    now_dt
                    + timedelta(
                        seconds=_late("CLAIM_LEASE_SECONDS", CLAIM_LEASE_SECONDS)
                    )
                ).isoformat(timespec="seconds").replace("+00:00", "Z"),
            }
            operation_id = str(_late("uuid", uuid).uuid4())
            self._commit_coordinator_operation_locked(
                {
                    "kind": "recover",
                    "operationId": operation_id,
                    "jobId": job_id,
                    "at": now,
                    "historyEvent": self._history_event_for_operation(
                        operation_id, job, "claim-recovered", "in_progress", now
                    ),
                    "resultClaim": claim,
                }
            )
            return {"job": job, "claim": self._public_claim(claim), "token": token}
