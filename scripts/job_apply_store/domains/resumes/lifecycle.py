"""Resume trash, restore, and permanent deletion behavior."""

from __future__ import annotations

import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any

from ...errors import StoreError
from ...io import _fsync_directory, atomic_write_json, exclusive_file_lock
from ...normalization import _safe_session_id
from ...validation.jobs_resumes import _validate_resume_record


def _canonical_validate_content_revision(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(
        r"content_[A-Za-z0-9_-]{32,128}", value
    ) is None:
        raise StoreError("resume content revision is unverifiable")
    return value


_CANONICAL_TRUSTED_FILL = SimpleNamespace(
    TrustedFillError=StoreError,
    validate_content_revision=_canonical_validate_content_revision,
)


def _canonical_validate_resume_record(key: str, value: Any) -> dict[str, Any]:
    return _validate_resume_record(
        key, value, trusted_fill_module=_CANONICAL_TRUSTED_FILL
    )


_CANONICAL_RUNTIME = {
    "_fsync_directory": _fsync_directory,
    "_safe_session_id": _safe_session_id,
    "_validate_resume_record": _canonical_validate_resume_record,
    "atomic_write_json": atomic_write_json,
    "exclusive_file_lock": exclusive_file_lock,
    "os": os,
    "uuid": uuid,
    "utc_now": lambda: datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z"),
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's live globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    if name in runtime:
        return runtime[name]
    return _CANONICAL_RUNTIME[name]


class ResumeLifecycleMixin:
    """Resume lifecycle operations composed ahead of the compatibility Store."""

    def trash_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_resume_deleted(resume_id, expected_revision, restore=False)

    def restore_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_resume_deleted(resume_id, expected_revision, restore=True)

    def _set_resume_deleted(
        self, resume_id: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
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
                    and (
                        (
                            current.get("storageKind") == "managed"
                            and item.get("storageKind") == "managed"
                            and item.get("digest") == current.get("digest")
                        )
                        or (
                            current.get("storageKind") is None
                            and item.get("storageKind") is None
                            and item.get("path") == current.get("path")
                        )
                    )
                    for key, item in document["resumes"].items()
                ):
                    raise StoreError("active resume file already exists")
            else:
                jobs = list(self._load_jobs_document()["jobs"].values())
                if any(
                    item.get("deletedAt") is None
                    and item.get("resumeId") == resume_id
                    for item in jobs
                ):
                    raise StoreError("resume is assigned to an active job")
                if current.get("default") and any(
                    item.get("deletedAt") is None
                    and item.get("resumeId") is None
                    for item in jobs
                ):
                    raise StoreError("default resume is used by an active job")
            updated = dict(current)
            updated["deletedAt"] = None if restore else _late("utc_now")()
            if not restore:
                updated["default"] = False
            elif not any(
                key != resume_id and item.get("deletedAt") is None
                for key, item in document["resumes"].items()
            ):
                updated["default"] = True
            else:
                updated["default"] = False
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = _late("utc_now")()
            _late("_validate_resume_record")(resume_id, updated)
            document["resumes"][resume_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            requests_document = None
            if not restore and self.resume_extraction_requests_path.exists():
                requests_document = self._load_extraction_requests_document()
                open_request = next(
                    (
                        item
                        for item in requests_document["requests"].values()
                        if item["resumeId"] == resume_id
                        and item["status"] == "requested"
                    ),
                    None,
                )
                if open_request is not None:
                    self._close_resume_extraction_request_locked(
                        requests_document,
                        open_request["requestId"],
                        open_request["revision"],
                        "cancelled",
                    )
            if requests_document is not None:
                self._commit_extraction_operation_locked(
                    "resume-request-close",
                    None,
                    None,
                    requests_document,
                    document,
                )
            else:
                _late("atomic_write_json")(self.resumes_path, document)
        return updated

    def delete_resume(self, resume_id: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None:
                return {"deleted": False, "id": resume_id}
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("resume must be trashed before permanent deletion")
            if self.resume_extraction_requests_path.exists() and any(
                item["resumeId"] == resume_id and item["status"] == "requested"
                for item in self._load_extraction_requests_document()[
                    "requests"
                ].values()
            ):
                raise StoreError("resume has an open extraction request")
            if any(
                item.get("resumeId") == resume_id
                for item in self._load_jobs_document()["jobs"].values()
            ):
                raise StoreError("resume is still referenced by a job")
            managed_path = (
                self._managed_resume_path(current)
                if current.get("storageKind") == "managed"
                else None
            )
            quarantine: Path | None = None
            if managed_path is not None and managed_path.exists():
                quarantine = self.resume_files_path / (
                    f".{managed_path.name}.{_late('uuid').uuid4().hex}.quarantine"
                )
                _late("os").replace(managed_path, quarantine)
            del document["resumes"][resume_id]
            document["metadata"]["updatedAt"] = _late("utc_now")()
            try:
                _late("atomic_write_json")(self.resumes_path, document)
            except Exception:
                if quarantine is not None and quarantine.exists():
                    _late("os").replace(quarantine, managed_path)
                    _late("_fsync_directory")(self.resume_files_path)
                raise
            if quarantine is not None:
                try:
                    quarantine.unlink()
                except OSError:
                    pass
                _late("_fsync_directory")(self.resume_files_path)
        return {"deleted": True, "id": resume_id}
