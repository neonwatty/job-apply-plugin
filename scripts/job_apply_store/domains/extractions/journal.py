"""Crash-safe journal storage for resume extraction operations."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, read_json_object, require_object, validate_version


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


class ExtractionJournalMixin:
    """Journal reads, initialization, recovery, and atomic multi-file commits."""

    def _load_extractions_document(self) -> dict[str, Any]:
        document = _late("read_json_object", read_json_object)(
            self.resume_extractions_path, "resume proposals"
        )
        validator = _late("_validate_extractions_document")
        if validator is None:
            raise RuntimeError("extraction document validation is not bound")
        return validator(document)

    def _load_extraction_requests_document(self) -> dict[str, Any]:
        document = _late("read_json_object", read_json_object)(
            self.resume_extraction_requests_path, "resume extraction requests"
        )
        validator = _late("_validate_extraction_requests_document")
        if validator is None:
            raise RuntimeError("extraction request validation is not bound")
        return validator(document)

    def _load_extraction_journal(self) -> dict[str, Any]:
        document = _late("read_json_object", read_json_object)(
            self.resume_extraction_journal_path, "resume proposal journal"
        )
        _late("validate_version", validate_version)(
            document, "resume proposal journal"
        )
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("resume proposal journal contains unsupported fields")
        operation = document["operation"]
        if operation is not None:
            item = _late("_require_object", require_object)(
                operation, "resume proposal journal operation"
            )
            legacy_keys = {
                "kind",
                "operationId",
                "profileDocument",
                "proposalsDocument",
            }
            expanded_keys = legacy_keys | {"requestsDocument", "resumesDocument"}
            if frozenset(item) not in {frozenset(legacy_keys), frozenset(expanded_keys)}:
                raise StoreError("resume proposal journal operation is invalid")
            if item.get("kind") not in {
                "create", "review", "request-create", "request-close",
                "request-retry", "request-complete", "resume-request-close",
            }:
                raise StoreError("resume proposal journal operation is invalid")
            if set(item) == legacy_keys and item["kind"] not in {"create", "review"}:
                raise StoreError("resume proposal journal operation is invalid")
            safe_id = _late("_safe_session_id")
            if safe_id is None:
                raise RuntimeError("session identity validation is not bound")
            safe_id(item.get("operationId", ""))
            if item.get("profileDocument") is not None:
                self._validate_profile_document_value(
                    _late("_require_object", require_object)(
                        item["profileDocument"], "journal profile"
                    )
                )
            if item.get("proposalsDocument") is not None:
                _late("_validate_extractions_document")(
                    _late("_require_object", require_object)(
                        item["proposalsDocument"], "journal proposals"
                    )
                )
            if "requestsDocument" in item and item["requestsDocument"] is not None:
                _late("_validate_extraction_requests_document")(
                    _late("_require_object", require_object)(
                        item["requestsDocument"], "journal requests"
                    )
                )
            if "resumesDocument" in item and item["resumesDocument"] is not None:
                resumes = _late("_require_object", require_object)(
                    item["resumesDocument"], "journal resumes"
                )
                _late("validate_version", validate_version)(resumes, "resumes")
                if set(resumes) != {"schemaVersion", "resumes", "metadata"}:
                    raise StoreError("resume proposal journal operation is invalid")
                validate_resume = _late("_validate_resume_record")
                for key, record in _late("_require_object", require_object)(
                    resumes["resumes"], "resumes"
                ).items():
                    validate_resume(key, record)
        return document

    def _ensure_extraction_files_locked(self) -> None:
        write = _late("atomic_write_json", atomic_write_json)
        schema_version = _late("SCHEMA_VERSION", SCHEMA_VERSION)
        if not self.resume_extractions_path.exists():
            now = _utc_now()
            write(
                self.resume_extractions_path,
                {
                    "schemaVersion": schema_version,
                    "proposals": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )
        if not self.resume_extraction_journal_path.exists():
            write(
                self.resume_extraction_journal_path,
                {"schemaVersion": schema_version, "operation": None},
            )

    def _ensure_extraction_requests_file_locked(self) -> None:
        self._ensure_extraction_files_locked()
        if not self.resume_extraction_requests_path.exists():
            now = _utc_now()
            _late("atomic_write_json", atomic_write_json)(
                self.resume_extraction_requests_path,
                {
                    "schemaVersion": _late("SCHEMA_VERSION", SCHEMA_VERSION),
                    "requests": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

    def _roll_forward_extraction_locked(self) -> None:
        journal = self._load_extraction_journal()
        operation = journal["operation"]
        if operation is None:
            return
        write = _late("atomic_write_json", atomic_write_json)
        if operation.get("profileDocument") is not None:
            write(self.profile_path, operation["profileDocument"])
        if operation.get("proposalsDocument") is not None:
            write(self.resume_extractions_path, operation["proposalsDocument"])
        if operation.get("requestsDocument") is not None:
            write(self.resume_extraction_requests_path, operation["requestsDocument"])
        if operation.get("resumesDocument") is not None:
            write(self.resumes_path, operation["resumesDocument"])
        write(
            self.resume_extraction_journal_path,
            {"schemaVersion": _late("SCHEMA_VERSION", SCHEMA_VERSION), "operation": None},
        )

    def _commit_extraction_operation_locked(
        self,
        kind: str,
        profile_document: dict[str, Any] | None,
        proposals_document: dict[str, Any] | None,
        requests_document: dict[str, Any] | None = None,
        resumes_document: dict[str, Any] | None = None,
    ) -> None:
        runtime_uuid = _late("uuid", uuid)
        operation = {
            "kind": kind,
            "operationId": f"extraction-{runtime_uuid.uuid4()}",
            "profileDocument": profile_document,
            "proposalsDocument": proposals_document,
            "requestsDocument": requests_document,
            "resumesDocument": resumes_document,
        }
        _late("atomic_write_json", atomic_write_json)(
            self.resume_extraction_journal_path,
            {
                "schemaVersion": _late("SCHEMA_VERSION", SCHEMA_VERSION),
                "operation": operation,
            },
        )
        self._roll_forward_extraction_locked()
