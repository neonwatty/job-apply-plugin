"""Resume extraction request lifecycle operations."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ...constants import (
    EXTRACTION_REQUEST_FAILURE_REASONS,
    EXTRACTION_REQUEST_STATUSES,
)
from ...errors import StoreError
from ...io import exclusive_file_lock
from ...validation.extraction import order_extraction_requests


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's live globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


def _late(name: str, fallback: Any = None) -> Any:
    return _runtime().get(name, fallback)


def _utc_now() -> str:
    provider = _late("utc_now")
    if provider is not None:
        return provider()
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _static_owner() -> type:
    return _runtime().get("Store", ExtractionRequestMixin)


class ExtractionRequestMixin:
    """Create, query, close, and retry resume extraction requests."""

    @staticmethod
    def _new_extraction_request(
        resume: dict[str, Any], supersedes: str | None = None
    ) -> dict[str, Any]:
        now = _utc_now()
        return {
            "requestId": f"request-{_late('uuid', uuid).uuid4()}",
            "resumeId": resume["id"],
            "resumeContentRevision": resume["contentRevision"],
            "revision": 1,
            "status": "requested",
            "createdAt": now,
            "updatedAt": now,
            "closedAt": None,
            "proposalId": None,
            "failureReason": None,
            "supersedesRequestId": supersedes,
        }

    def create_resume_extraction_request(
        self, resume_id: str, expected_resume_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            resumes_document = self._load_resumes_document()
            resume = resumes_document["resumes"].get(resume_id)
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume["revision"] != expected_resume_revision:
                raise StoreError("resume revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            requests_document = self._load_extraction_requests_document()
            if any(
                item["resumeId"] == resume_id and item["status"] == "requested"
                for item in requests_document["requests"].values()
            ):
                raise StoreError("open extraction request already exists")
            if resume.get("contentRevision") is None:
                resume = dict(resume)
                resume["contentRevision"] = self._new_resume_content_revision()
                resume["revision"] += 1
                resume["updatedAt"] = _utc_now()
                _late("_validate_resume_record")(resume_id, resume)
                resumes_document["resumes"][resume_id] = resume
                resumes_document["metadata"]["updatedAt"] = resume["updatedAt"]
            request = _static_owner()._new_extraction_request(resume)
            _late("_validate_extraction_request")(request["requestId"], request)
            requests_document["requests"][request["requestId"]] = request
            requests_document["metadata"]["updatedAt"] = request["updatedAt"]
            self._commit_extraction_operation_locked(
                "request-create", None, None, requests_document,
                resumes_document if resume["revision"] != expected_resume_revision else None,
            )
            return request

    def get_resume_extraction_request(self, request_id: str) -> dict[str, Any] | None:
        self.initialize()
        _late("_safe_session_id")(request_id)
        if not self.resume_extraction_requests_path.exists():
            return None
        return self._load_extraction_requests_document()["requests"].get(request_id)

    def list_resume_extraction_requests(
        self, resume_id: str | None = None, status: str | None = None
    ) -> list[dict[str, Any]]:
        self.initialize()
        if resume_id is not None:
            _late("_safe_session_id")(resume_id)
        if status is not None and status not in _late(
            "EXTRACTION_REQUEST_STATUSES", EXTRACTION_REQUEST_STATUSES
        ):
            raise StoreError("resume extraction request status is unsupported")
        if not self.resume_extraction_requests_path.exists():
            return []
        records = [
            item
            for item in self._load_extraction_requests_document()["requests"].values()
            if (resume_id is None or item["resumeId"] == resume_id)
            and (status is None or item["status"] == status)
        ]
        return _late("order_extraction_requests", order_extraction_requests)(records)

    def _close_resume_extraction_request_locked(
        self, requests_document: dict[str, Any], request_id: str,
        expected_revision: int, status: str, failure_reason: str | None = None,
        proposal_id: str | None = None,
    ) -> dict[str, Any]:
        current = requests_document["requests"].get(request_id)
        if current is None:
            raise StoreError("resume extraction request does not exist")
        if current["revision"] != expected_revision:
            raise StoreError("request revision conflict")
        if current["status"] != "requested":
            raise StoreError("resume extraction request is not open")
        now = _utc_now()
        updated = {
            **current, "status": status, "failureReason": failure_reason,
            "proposalId": proposal_id, "revision": current["revision"] + 1,
            "updatedAt": now, "closedAt": now,
        }
        _late("_validate_extraction_request")(request_id, updated)
        requests_document["requests"][request_id] = updated
        requests_document["metadata"]["updatedAt"] = now
        return updated

    def cancel_resume_extraction_request(
        self, request_id: str, expected_revision: int
    ) -> dict[str, Any]:
        return self._close_extraction_request(request_id, expected_revision, "cancelled")

    def fail_resume_extraction_request(
        self, request_id: str, reason: str, expected_revision: int
    ) -> dict[str, Any]:
        if reason not in _late(
            "EXTRACTION_REQUEST_FAILURE_REASONS", EXTRACTION_REQUEST_FAILURE_REASONS
        ):
            raise StoreError("resume extraction failure reason is unsupported")
        return self._close_extraction_request(
            request_id, expected_revision, "failed", reason
        )

    def _close_extraction_request(
        self, request_id: str, expected_revision: int, status: str,
        failure_reason: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(request_id)
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            document = self._load_extraction_requests_document()
            updated = self._close_resume_extraction_request_locked(
                document, request_id, expected_revision, status, failure_reason
            )
            self._commit_extraction_operation_locked(
                "request-close", None, None, document
            )
            return updated

    def retry_resume_extraction_request(
        self, request_id: str, expected_revision: int,
        expected_resume_revision: int,
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(request_id)
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            document = self._load_extraction_requests_document()
            current = document["requests"].get(request_id)
            if current is None:
                raise StoreError("resume extraction request does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("request revision conflict")
            if current["status"] not in {"failed", "stale"}:
                raise StoreError("resume extraction request cannot be retried")
            resume = self._load_resumes_document()["resumes"].get(current["resumeId"])
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume["revision"] != expected_resume_revision:
                raise StoreError("resume revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            if any(
                item["resumeId"] == resume["id"] and item["status"] == "requested"
                for item in document["requests"].values()
            ):
                raise StoreError("open extraction request already exists")
            request = _static_owner()._new_extraction_request(resume, request_id)
            _late("_validate_extraction_request")(request["requestId"], request)
            document["requests"][request["requestId"]] = request
            document["metadata"]["updatedAt"] = request["updatedAt"]
            self._commit_extraction_operation_locked(
                "request-retry", None, None, document
            )
            return request
