"""Private file storage primitives for resume records."""

from __future__ import annotations

import hashlib
import os
import secrets
import stat
import tempfile
import uuid
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from ...errors import StoreError


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


class ResumeStorageMixin:
    """Secure staging, observation, installation, and recovery of resumes."""

    def _load_resumes_document(self) -> dict[str, Any]:
        runtime = _runtime()
        document = runtime["read_json_object"](self.resumes_path, "resumes")
        runtime["validate_version"](document, "resumes")
        resumes = runtime["_require_object"](document.get("resumes"), "resumes.resumes")
        runtime["_require_object"](document.get("metadata"), "resumes.metadata")
        active_defaults = 0
        for key, record in resumes.items():
            if not isinstance(key, str) or not key:
                raise StoreError("resume index keys must be non-empty strings")
            item = runtime["_validate_resume_record"](key, record)
            if item["default"] and item.get("deletedAt") is None:
                active_defaults += 1
        if active_defaults > 1:
            raise StoreError("resume store has more than one active default")
        return document

    def _managed_resume_path(self, record: dict[str, Any]) -> Path:
        if record.get("storageKind") != "managed":
            raise StoreError("resume is not managed")
        candidate = self.resume_files_path / record["managedFile"]
        try:
            if candidate.parent.resolve(strict=False) != self.resume_files_path.resolve(strict=False):
                raise StoreError("managed resume file identity is invalid")
        except OSError:
            raise StoreError("managed resume file identity is invalid") from None
        return candidate

    def _resume_path(self, record: dict[str, Any]) -> Path:
        if record.get("storageKind") == "managed":
            return self._managed_resume_path(record)
        return _runtime().get("Path", Path)(record["path"])

    def _resume_for_acquisition(self, record: dict[str, Any]) -> dict[str, Any]:
        resolved = dict(record)
        resolved["path"] = str(self._resume_path(record))
        return resolved

    @staticmethod
    def _private_file_digest(path: Path) -> str | None:
        runtime = _runtime()
        os_module = runtime.get("os", os)
        stat_module = runtime.get("stat", stat)
        flags = os_module.O_RDONLY | getattr(os_module, "O_BINARY", 0)
        if hasattr(os_module, "O_NOFOLLOW"):
            flags |= os_module.O_NOFOLLOW
        descriptor: int | None = None
        try:
            if path.is_symlink():
                return None
            descriptor = os_module.open(path, flags)
            metadata = os_module.fstat(descriptor)
            if not stat_module.S_ISREG(metadata.st_mode) or metadata.st_size > runtime["RESUME_MAX_BYTES"]:
                return None
            digest = runtime.get("hashlib", hashlib).sha256()
            while True:
                chunk = os_module.read(descriptor, 1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            return digest.hexdigest()
        except OSError:
            return None
        finally:
            if descriptor is not None:
                os_module.close(descriptor)

    def _managed_resume_observation(
        self,
        record: dict[str, Any],
        *,
        digest_cache: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        runtime = _runtime()
        stat_module = runtime.get("stat", stat)
        path = self._managed_resume_path(record)
        cache_key = record["id"]
        missing = {"exists": False, "size": None, "modifiedAt": None, "digest": None}
        try:
            metadata = path.lstat()
        except OSError:
            return missing
        if path.is_symlink() or not stat_module.S_ISREG(metadata.st_mode) or metadata.st_size > runtime["RESUME_MAX_BYTES"]:
            return missing
        identity = (
            metadata.st_dev, metadata.st_ino, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns,
        )
        cache_identity = runtime["_managed_resume_digest_cache_identity"](metadata)
        now = self._now_datetime()
        cached = digest_cache.get(cache_key) if digest_cache is not None else None
        duration = runtime.get("timedelta", timedelta)
        if (
            cache_identity is not None
            and cached is not None
            and cached.get("identity") == cache_identity
            and duration(0) <= now - cached["checkedAt"]
            < duration(seconds=runtime["OVERVIEW_DIGEST_CACHE_SECONDS"])
        ):
            return {
                "exists": True, "size": metadata.st_size,
                "modifiedAt": runtime["_resume_modified_at"](metadata),
                "digest": cached["digest"],
            }
        digest = self._private_file_digest(path)
        if digest is None:
            return missing
        try:
            after = path.lstat()
        except OSError:
            return missing
        after_identity = (
            after.st_dev, after.st_ino, after.st_size,
            after.st_mtime_ns, after.st_ctime_ns,
        )
        if after_identity != identity or not stat_module.S_ISREG(after.st_mode):
            return missing
        observation = {
            "exists": True, "size": after.st_size,
            "modifiedAt": runtime["_resume_modified_at"](after), "digest": digest,
        }
        after_cache_identity = runtime["_managed_resume_digest_cache_identity"](after)
        if digest_cache is not None and after_cache_identity is not None:
            digest_cache[cache_key] = {
                "identity": after_cache_identity, "digest": digest, "checkedAt": now,
            }
        return observation

    @staticmethod
    def _new_resume_content_revision() -> str:
        """Create an opaque content identity unrelated to bytes or metadata revision."""
        secret_module = _runtime().get("secrets", secrets)
        return "content_" + secret_module.token_urlsafe(32)

    def _recover_resume_files_locked(self) -> None:
        """Recover interrupted swaps and collect private staging artifacts."""
        runtime = _runtime()
        os_module = runtime.get("os", os)
        if not self.resumes_path.exists():
            records: list[dict[str, Any]] = []
        else:
            records = list(self._load_resumes_document()["resumes"].values())
        referenced = {
            record["managedFile"]: record for record in records
            if record.get("storageKind") == "managed"
        }
        for temporary in self.resume_files_path.glob(".*.tmp"):
            try:
                temporary.unlink()
            except OSError:
                pass
        clock = runtime.get("datetime", datetime)
        zone = runtime.get("timezone", timezone)
        recovery_cutoff = clock.now(zone.utc).timestamp() - runtime["UPLOAD_RECOVERY_GRACE_SECONDS"]
        for temporary in self.resume_files_path.glob(".browser-upload.*"):
            try:
                if temporary.stat().st_mtime <= recovery_cutoff:
                    temporary.unlink()
            except OSError:
                pass
        for managed_file, record in referenced.items():
            canonical = self.resume_files_path / managed_file
            expected_digest = record["digest"]
            quarantines = sorted(self.resume_files_path.glob(f".{managed_file}.*.quarantine"))
            if not quarantines:
                continue
            if self._private_file_digest(canonical) != expected_digest:
                recoverable = next((
                    candidate for candidate in quarantines
                    if self._private_file_digest(candidate) == expected_digest
                ), None)
                if recoverable is not None:
                    try:
                        canonical.unlink()
                    except FileNotFoundError:
                        pass
                    os_module.replace(recoverable, canonical)
                    runtime["_set_private_mode"](canonical, 0o600)
            if self._private_file_digest(canonical) == expected_digest:
                for quarantine in quarantines:
                    try:
                        quarantine.unlink()
                    except OSError:
                        pass
        for quarantine in self.resume_files_path.glob(".*.quarantine"):
            try:
                quarantine.unlink()
            except OSError:
                pass
        for candidate in self.resume_files_path.iterdir():
            if candidate.name.startswith(".") or candidate.name in referenced:
                continue
            if candidate.suffix.lower() in runtime["RESUME_MEDIA_TYPES"]:
                try:
                    candidate.unlink()
                except OSError:
                    pass
        runtime["_fsync_directory"](self.resume_files_path)

    def _stage_resume_import(self, source_value: Any, resume_id: str) -> dict[str, Any]:
        runtime = _runtime()
        os_module = runtime.get("os", os)
        stat_module = runtime.get("stat", stat)
        path_type = runtime.get("Path", Path)
        source = path_type(runtime["normalize_resume_path"](source_value))
        extension = source.suffix.lower()
        if extension not in runtime["RESUME_MEDIA_TYPES"]:
            raise StoreError("resume format must be PDF, DOCX, or UTF-8 TXT")
        runtime["_ensure_private_dir"](self.resume_files_path)
        flags = os_module.O_RDONLY | getattr(os_module, "O_BINARY", 0)
        if hasattr(os_module, "O_NOFOLLOW"):
            flags |= os_module.O_NOFOLLOW
        staged_path: Path | None = None
        descriptor: int | None = None
        try:
            try:
                if source.is_symlink():
                    raise StoreError("resume source must be a readable regular file")
            except OSError:
                raise StoreError("resume source must be a readable regular file") from None
            try:
                descriptor = os_module.open(source, flags)
            except OSError:
                raise StoreError("resume source must be a readable regular file") from None
            before = os_module.fstat(descriptor)
            if not stat_module.S_ISREG(before.st_mode):
                raise StoreError("resume source must be a readable regular file")
            if before.st_size > runtime["RESUME_MAX_BYTES"]:
                raise StoreError("resume file exceeds the 10 MiB limit")
            digest = runtime.get("hashlib", hashlib).sha256()
            temporary = runtime.get("tempfile", tempfile)
            with temporary.NamedTemporaryFile(
                mode="wb", dir=self.resume_files_path, prefix=f".{resume_id}.",
                suffix=".tmp", delete=False,
            ) as staged:
                staged_path = path_type(staged.name)
                total = 0
                while True:
                    chunk = os_module.read(
                        descriptor, min(1024 * 1024, runtime["RESUME_MAX_BYTES"] + 1 - total)
                    )
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > runtime["RESUME_MAX_BYTES"]:
                        raise StoreError("resume file exceeds the 10 MiB limit")
                    staged.write(chunk)
                    digest.update(chunk)
                staged.flush()
                os_module.fsync(staged.fileno())
            after = os_module.fstat(descriptor)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (
                after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns
            ):
                raise StoreError("resume source changed during import")
            runtime["_set_private_mode"](staged_path, 0o600)
            media_type, size, modified_at = runtime["_validate_resume_bytes"](staged_path, extension)
            result = {
                "path": staged_path, "managedFile": f"{resume_id}{extension}",
                "originalFilename": source.name, "mediaType": media_type,
                "digest": digest.hexdigest(), "observedSize": size,
                "observedModifiedAt": modified_at,
            }
            staged_path = None
            return result
        finally:
            if descriptor is not None:
                os_module.close(descriptor)
            if staged_path is not None and staged_path.exists():
                try:
                    staged_path.unlink()
                except OSError:
                    pass

    @contextmanager
    def _temporary_resume_source(self, original_filename: Any, content: bytes):
        """Materialize bounded browser bytes privately for canonical path ingestion."""
        runtime = _runtime()
        path_type = runtime.get("Path", Path)
        if (
            not isinstance(original_filename, str) or not original_filename
            or path_type(original_filename).name != original_filename
            or "\0" in original_filename
        ):
            raise StoreError("resume filename is invalid")
        extension = path_type(original_filename).suffix.lower()
        if extension not in runtime["RESUME_MEDIA_TYPES"]:
            raise StoreError("resume format must be PDF, DOCX, or UTF-8 TXT")
        if not isinstance(content, bytes):
            raise StoreError("resume content is invalid")
        if len(content) > runtime["RESUME_MAX_BYTES"]:
            raise StoreError("resume file exceeds the 10 MiB limit")
        runtime["_ensure_private_dir"](self.resume_files_path)
        temporary_path: Path | None = None
        try:
            with runtime.get("tempfile", tempfile).NamedTemporaryFile(
                mode="wb", dir=self.resume_files_path, prefix=".browser-upload.",
                suffix=extension, delete=False,
            ) as staged:
                temporary_path = path_type(staged.name)
                staged.write(content)
                staged.flush()
                runtime.get("os", os).fsync(staged.fileno())
            runtime["_set_private_mode"](temporary_path, 0o600)
            yield temporary_path
        finally:
            if temporary_path is not None:
                try:
                    temporary_path.unlink()
                except OSError:
                    # A successful canonical commit must stay successful. The
                    # private orphan is collected after the recovery grace.
                    pass

    @contextmanager
    def _staged_resume(self, source_value: Any, resume_id: str):
        staged = self._stage_resume_import(source_value, resume_id)
        try:
            yield staged
        finally:
            try:
                staged["path"].unlink()
            except FileNotFoundError:
                pass

    def _install_staged_resume(
        self,
        staged: dict[str, Any],
        destination: Path,
        write_metadata,
        previous: Path | None = None,
        rollback_metadata=None,
    ) -> None:
        runtime = _runtime()
        os_module = runtime.get("os", os)
        quarantine: Path | None = None
        installed = False
        try:
            if previous is not None and previous.exists():
                nonce = runtime.get("uuid", uuid).uuid4().hex
                quarantine = self.resume_files_path / f".{previous.name}.{nonce}.quarantine"
                os_module.replace(previous, quarantine)
            os_module.replace(staged["path"], destination)
            installed = True
            runtime["_set_private_mode"](destination, 0o600)
            runtime["_fsync_directory"](self.resume_files_path)
            write_metadata()
        except Exception:
            if installed:
                try:
                    destination.unlink()
                except FileNotFoundError:
                    pass
            if quarantine is not None and quarantine.exists():
                os_module.replace(quarantine, previous)
            runtime["_fsync_directory"](self.resume_files_path)
            if rollback_metadata is not None:
                rollback_metadata()
            raise
        else:
            if quarantine is not None:
                try:
                    quarantine.unlink()
                except OSError:
                    pass
            runtime["_fsync_directory"](self.resume_files_path)
