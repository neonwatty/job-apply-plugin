"""Read-only resume registry and managed-content operations."""

from __future__ import annotations

import hashlib
import os
import stat
from pathlib import Path
from typing import Any

from ...errors import StoreError
from ...io import require_object
from ...normalization import _safe_session_id, observe_resume_file


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


class ResumeReadMixin:
    """Resume lookups, resolution, integrity checks, and bounded content reads."""

    def read_resume_content(self, resume_id: str) -> tuple[dict[str, Any], bytes]:
        runtime = _runtime()
        os_module = runtime.get("os", os)
        stat_module = runtime.get("stat", stat)
        record = self.get_resume(resume_id)
        if record is None or record.get("storageKind") != "managed":
            raise StoreError("managed resume does not exist")
        path = self._managed_resume_path(record)
        flags = os_module.O_RDONLY | getattr(os_module, "O_BINARY", 0)
        if hasattr(os_module, "O_NOFOLLOW"):
            flags |= os_module.O_NOFOLLOW
        descriptor: int | None = None
        try:
            if path.is_symlink():
                raise OSError
            descriptor = os_module.open(path, flags)
            metadata = os_module.fstat(descriptor)
            limit = runtime["RESUME_MAX_BYTES"]
            if not stat_module.S_ISREG(metadata.st_mode) or not 0 < metadata.st_size <= limit:
                raise OSError
            chunks: list[bytes] = []
            digest = runtime.get("hashlib", hashlib).sha256()
            total = 0
            while True:
                chunk = os_module.read(descriptor, min(1024 * 1024, limit + 1 - total))
                if not chunk:
                    break
                total += len(chunk)
                if total > limit:
                    raise OSError
                digest.update(chunk)
                chunks.append(chunk)
            if total != metadata.st_size or digest.hexdigest() != record["digest"]:
                raise OSError
        except OSError:
            raise StoreError("managed resume content is unavailable") from None
        finally:
            if descriptor is not None:
                os_module.close(descriptor)
        content = b"".join(chunks)
        return record, content

    def resolve_resume(self, resume_id: str | None = None) -> dict[str, Any]:
        """Resolve one active managed resume for trusted local file upload."""
        runtime = _runtime()
        self.initialize()
        records = self._load_resumes_document()["resumes"]
        if resume_id is None:
            record = next((
                item for item in records.values()
                if item.get("deletedAt") is None and item.get("default")
            ), None)
        else:
            runtime.get("_safe_session_id", _safe_session_id)(resume_id)
            record = records.get(resume_id)
            if record is not None and record.get("deletedAt") is not None:
                record = None
        if record is None:
            raise StoreError("active resume does not exist")
        if record.get("storageKind") != "managed":
            raise StoreError("resume must be adopted before use")
        observation = self._managed_resume_observation(record)
        if not observation["exists"] or observation.get("digest") != record["digest"]:
            raise StoreError("managed resume content is unavailable")
        return {
            "id": record["id"], "revision": record["revision"],
            "mediaType": record["mediaType"],
            "path": str(self._managed_resume_path(record)),
        }

    def get_resume(
        self, resume_id: str, include_trashed: bool = False
    ) -> dict[str, Any] | None:
        runtime = _runtime()
        self.initialize()
        runtime.get("_safe_session_id", _safe_session_id)(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or (record.get("deletedAt") is not None and not include_trashed):
            return None
        return runtime.get("_require_object", require_object)(record, "resume record")

    def list_resumes(
        self, include_trashed: bool = False, trashed_only: bool = False
    ) -> list[dict[str, Any]]:
        self.initialize()
        if trashed_only:
            include_trashed = True
        records = [
            record for record in self._load_resumes_document()["resumes"].values()
            if (include_trashed or record.get("deletedAt") is None)
            and (not trashed_only or record.get("deletedAt") is not None)
        ]
        return sorted(records, key=lambda item: (
            not item.get("default", False), item.get("label", "").casefold(), item["id"]
        ))

    def check_resume(self, resume_id: str) -> dict[str, Any]:
        runtime = _runtime()
        record = self.get_resume(resume_id, include_trashed=True)
        if record is None:
            raise StoreError("resume does not exist")
        current = (
            self._managed_resume_observation(record)
            if record.get("storageKind") == "managed"
            else runtime.get("observe_resume_file", observe_resume_file)(
                str(self._resume_path(record))
            )
        )
        changed = (
            current["size"] != record.get("observedSize")
            or current["modifiedAt"] != record.get("observedModifiedAt")
            or (
                record.get("storageKind") == "managed"
                and current.get("digest") != record.get("digest")
            )
        )
        return {
            "id": resume_id, "exists": current["exists"], "changed": changed,
            "observedSize": record.get("observedSize"),
            "observedModifiedAt": record.get("observedModifiedAt"),
            "currentSize": current["size"], "currentModifiedAt": current["modifiedAt"],
            "storageKind": record.get("storageKind", "external"),
        }
