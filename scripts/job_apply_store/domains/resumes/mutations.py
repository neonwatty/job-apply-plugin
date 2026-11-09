"""Resume creation, content replacement, adoption, and default selection."""

from __future__ import annotations

import copy
import re
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace
from typing import Any

from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock
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
    "SCHEMA_VERSION": SCHEMA_VERSION,
    "atomic_write_json": atomic_write_json,
    "exclusive_file_lock": exclusive_file_lock,
    "uuid": uuid,
    "utc_now": lambda: datetime.now(timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z"),
    "_safe_session_id": _safe_session_id,
    "_validate_resume_record": _canonical_validate_resume_record,
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


class ResumeMutationMixin:
    """Resume writes operating on Store state supplied by composition."""

    def create_resume(self, incoming: dict[str, Any]) -> dict[str, Any]:
        self.initialize()
        allowed = {"id", "label", "path", "tags", "default"}
        if set(incoming) - allowed:
            raise StoreError("resume input contains unsupported fields")
        resume_id = incoming.get("id") or f"resume-{_late('uuid').uuid4()}"
        _late("_safe_session_id")(resume_id)
        label = incoming.get("label")
        tags_input = incoming.get("tags", [])
        if not isinstance(tags_input, list):
            raise StoreError("resume tags must be a list")
        tags = [
            item.strip() if isinstance(item, str) else item for item in tags_input
        ]
        now = _late("utc_now")()
        with _late("exclusive_file_lock")(self.store_lock_path):
            with self._staged_resume(incoming.get("path", ""), resume_id) as staged:
                document = self._load_resumes_document()
                if resume_id in document["resumes"]:
                    raise StoreError("resume id already exists")
                if any(
                    item.get("storageKind") == "managed"
                    and item.get("digest") == staged["digest"]
                    for item in document["resumes"].values()
                ):
                    raise StoreError("resume file is already managed")
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
                    "storageKind": "managed",
                    "managedFile": staged["managedFile"],
                    "originalFilename": staged["originalFilename"],
                    "mediaType": staged["mediaType"],
                    "digest": staged["digest"],
                    "contentRevision": self._new_resume_content_revision(),
                    "tags": tags,
                    "default": make_default,
                    "observedSize": staged["observedSize"],
                    "observedModifiedAt": staged["observedModifiedAt"],
                    "revision": 1,
                    "createdAt": now,
                    "updatedAt": now,
                    "deletedAt": None,
                }
                _late("_validate_resume_record")(resume_id, record)
                document["resumes"][resume_id] = record
                document["metadata"]["updatedAt"] = now
                destination = self.resume_files_path / staged["managedFile"]
                self._install_staged_resume(
                    staged,
                    destination,
                    lambda: _late("atomic_write_json")(self.resumes_path, document),
                )
        return record

    def import_resume(self, incoming: dict[str, Any]) -> dict[str, Any]:
        return self.create_resume(incoming)

    def create_resume_bytes(
        self, incoming: dict[str, Any], original_filename: str, content: bytes
    ) -> dict[str, Any]:
        with self._temporary_resume_source(original_filename, content) as source:
            return self.create_resume({**incoming, "path": str(source)})

    def update_resume_bytes(
        self,
        resume_id: str,
        original_filename: str,
        content: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        with self._temporary_resume_source(original_filename, content) as source:
            return self.update_resume(
                resume_id, {"path": str(source)}, expected_revision
            )

    def adopt_resume_bytes(
        self,
        resume_id: str,
        original_filename: str,
        content: bytes,
        expected_revision: int,
    ) -> dict[str, Any]:
        with self._temporary_resume_source(original_filename, content) as source:
            return self.adopt_resume(resume_id, str(source), expected_revision)

    def update_resume(
        self, resume_id: str, patch: dict[str, Any], expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        allowed = {"label", "path", "tags"}
        if not patch or set(patch) - allowed:
            raise StoreError("resume patch contains unsupported fields")
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            original_document = copy.deepcopy(document)
            current = document["resumes"].get(resume_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            updated = {
                **current,
                **{key: value for key, value in patch.items() if key != "path"},
            }
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
                if current.get("storageKind") != "managed":
                    raise StoreError("legacy resume bytes require resume-adopt")
                with self._staged_resume(patch["path"], resume_id) as staged:
                    if any(
                        key != resume_id
                        and item.get("storageKind") == "managed"
                        and item.get("digest") == staged["digest"]
                        for key, item in document["resumes"].items()
                    ):
                        raise StoreError("resume file is already managed")
                    updated.update(
                        {
                            "managedFile": staged["managedFile"],
                            "originalFilename": staged["originalFilename"],
                            "mediaType": staged["mediaType"],
                            "digest": staged["digest"],
                            "contentRevision": self._new_resume_content_revision(),
                            "observedSize": staged["observedSize"],
                            "observedModifiedAt": staged["observedModifiedAt"],
                        }
                    )
                    updated["revision"] = current["revision"] + 1
                    updated["updatedAt"] = _late("utc_now")()
                    _late("_validate_resume_record")(resume_id, updated)
                    document["resumes"][resume_id] = updated
                    document["metadata"]["updatedAt"] = updated["updatedAt"]
                    requests_document = None
                    original_requests_document = None
                    if self.resume_extraction_requests_path.exists():
                        requests_document = self._load_extraction_requests_document()
                        original_requests_document = copy.deepcopy(requests_document)
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
                                "stale",
                            )
                    old_path = self._managed_resume_path(current)
                    destination = self.resume_files_path / staged["managedFile"]

                    def rollback_documents() -> None:
                        _late("atomic_write_json")(
                            self.resumes_path, original_document
                        )
                        if original_requests_document is not None:
                            _late("atomic_write_json")(
                                self.resume_extraction_requests_path,
                                original_requests_document,
                            )
                        if self.resume_extraction_journal_path.exists():
                            _late("atomic_write_json")(
                                self.resume_extraction_journal_path,
                                {"schemaVersion": _late("SCHEMA_VERSION"), "operation": None},
                            )

                    self._install_staged_resume(
                        staged,
                        destination,
                        lambda: self._commit_extraction_operation_locked(
                            "resume-request-close",
                            None,
                            None,
                            requests_document,
                            document,
                        )
                        if requests_document is not None
                        else _late("atomic_write_json")(
                            self.resumes_path, document
                        ),
                        previous=old_path,
                        rollback_metadata=rollback_documents,
                    )
            else:
                updated["revision"] = current["revision"] + 1
                updated["updatedAt"] = _late("utc_now")()
                _late("_validate_resume_record")(resume_id, updated)
                document["resumes"][resume_id] = updated
                document["metadata"]["updatedAt"] = updated["updatedAt"]
                _late("atomic_write_json")(self.resumes_path, document)
        return updated

    def adopt_resume(
        self, resume_id: str, source_path: str | None, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self.resume_extraction_journal_path.exists():
                self._roll_forward_extraction_locked()
            document = self._load_resumes_document()
            current = document["resumes"].get(resume_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if current.get("storageKind") == "managed":
                raise StoreError("resume is already managed")
            staged = self._stage_resume_import(
                source_path or current["path"], resume_id
            )
            try:
                if any(
                    key != resume_id
                    and item.get("storageKind") == "managed"
                    and item.get("digest") == staged["digest"]
                    for key, item in document["resumes"].items()
                ):
                    raise StoreError("resume file is already managed")
                updated = {
                    key: value for key, value in current.items() if key != "path"
                }
                updated.update(
                    {
                        "storageKind": "managed",
                        "managedFile": staged["managedFile"],
                        "originalFilename": staged["originalFilename"],
                        "mediaType": staged["mediaType"],
                        "digest": staged["digest"],
                        "contentRevision": self._new_resume_content_revision(),
                        "observedSize": staged["observedSize"],
                        "observedModifiedAt": staged["observedModifiedAt"],
                        "revision": current["revision"] + 1,
                        "updatedAt": _late("utc_now")(),
                    }
                )
                _late("_validate_resume_record")(resume_id, updated)
                document["resumes"][resume_id] = updated
                document["metadata"]["updatedAt"] = updated["updatedAt"]
                self._install_staged_resume(
                    staged,
                    self.resume_files_path / staged["managedFile"],
                    lambda: _late("atomic_write_json")(
                        self.resumes_path, document
                    ),
                )
            finally:
                staged["path"].unlink(missing_ok=True)
        return updated

    def set_default_resume(
        self, resume_id: str, expected_revision: int
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_resumes_document()
            target = document["resumes"].get(resume_id)
            if target is None or target.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if target["revision"] != expected_revision:
                raise StoreError("resume revision conflict")
            if target["default"]:
                return target
            now = _late("utc_now")()
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
            _late("atomic_write_json")(self.resumes_path, document)
            return document["resumes"][resume_id]
