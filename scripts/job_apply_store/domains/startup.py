"""Store initialization and read-only startup validation."""

from __future__ import annotations

import json
import os
import stat
from typing import Any

from .. import constants, io, normalization, sessions_runtime
from ..errors import StoreError


_RUNTIME_PROVIDER = lambda: {}


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to late-bound facade collaborators."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    if name in runtime:
        return runtime[name]
    return _CANONICAL[name]


_CANONICAL = {
    '_ensure_private_dir': io._ensure_private_dir,
    'exclusive_file_lock': io.exclusive_file_lock,
    'utc_now': sessions_runtime.utc_now,
    'read_json_object': io.read_json_object,
    'atomic_write_json': io.atomic_write_json,
    'SCHEMA_VERSION': constants.SCHEMA_VERSION,
    'os': os,
    '_set_private_mode': io._set_private_mode,
    'stat': stat,
    '_is_reparse_point': normalization._is_reparse_point,
    '_safe_session_id': normalization._safe_session_id,
    '_require_object': io.require_object,
    'json': json,
    'validate_version': io.validate_version,
    '_project_legacy_session': sessions_runtime._project_legacy_session,
}


class StartupMixin:
    """Plain startup mixin; persistent state belongs to StoreBase."""

    def initialize(self) -> dict[str, Any]:
        """Validate existing documents, then create only missing store files."""

        self._validate_existing_documents()

        _late('_ensure_private_dir')(self.root)
        _late('_ensure_private_dir')(self.sessions_path)
        _late('_ensure_private_dir')(self.resume_files_path)
        # A durable extraction operation may describe newly installed managed
        # bytes. Apply its document snapshot before reconciling quarantines so
        # file recovery uses the committed content identity, never stale resume
        # metadata from before the replacement.
        if self.resume_extraction_journal_path.exists():
            with _late('exclusive_file_lock')(self.store_lock_path):
                self._roll_forward_extraction_locked()
        if any(self.resume_files_path.iterdir()):
            with _late('exclusive_file_lock')(self.store_lock_path):
                self._recover_resume_files_locked()
        migrated = False

        if not self.profile_path.exists():
            profile: dict[str, Any] = {}
            metadata: dict[str, Any] = {
                "createdAt": _late('utc_now')(),
                "updatedAt": _late('utc_now')(),
                "revision": 1,
                "factProvenance": {},
            }
            if self.legacy_profile.exists():
                profile = _late('read_json_object')(self.legacy_profile, "legacy profile")
                metadata["migratedFrom"] = "~/.claude-job-profile.json"
                metadata["migratedAt"] = _late('utc_now')()
                migrated = True
            _late('atomic_write_json')(
                self.profile_path,
                {
                    "schemaVersion": _late('SCHEMA_VERSION'),
                    "profile": profile,
                    "metadata": metadata,
                },
            )

        if not self.answers_path.exists():
            now = _late('utc_now')()
            _late('atomic_write_json')(
                self.answers_path,
                {
                    "schemaVersion": _late('SCHEMA_VERSION'),
                    "answers": {},
                    "redirects": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.fact_groups_path.exists():
            now = _late('utc_now')()
            _late('atomic_write_json')(
                self.fact_groups_path,
                {
                    "schemaVersion": _late('SCHEMA_VERSION'),
                    "groups": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.jobs_path.exists():
            now = _late('utc_now')()
            _late('atomic_write_json')(
                self.jobs_path,
                {
                    "schemaVersion": _late('SCHEMA_VERSION'),
                    "jobs": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.resumes_path.exists():
            now = _late('utc_now')()
            _late('atomic_write_json')(
                self.resumes_path,
                {
                    "schemaVersion": _late('SCHEMA_VERSION'),
                    "resumes": {},
                    "metadata": {"createdAt": now, "updatedAt": now},
                },
            )

        if not self.history_path.exists():
            descriptor = _late('os').open(
                self.history_path, _late('os').O_WRONLY | _late('os').O_CREAT | _late('os').O_EXCL, 0o600
            )
            _late('os').close(descriptor)
        _late('_set_private_mode')(self.history_path, 0o600)

        coordinator_exists = (
            self.coordinator_path.exists() or self.coordinator_journal_path.exists()
        )
        if coordinator_exists:
            with _late('exclusive_file_lock')(self.store_lock_path):
                self._ensure_coordinator_files_locked()
                self._repair_pending_history_tail_locked()
                self._roll_forward_locked()
                self.read_history()

        return {"initialized": True, "migratedLegacyProfile": migrated, **self.paths()}


    def validate_workspace_startup(self) -> None:
        """Validate existing documents without creating, repairing, or migrating state."""

        self._validate_existing_documents()


    def _validate_existing_documents(self) -> None:
        """Validate existing store documents without creating or repairing files."""

        if self.profile_path.exists():
            self._load_profile_document()
        if self.fact_groups_path.exists():
            self._load_fact_groups_document()
        if self.answers_path.exists():
            self._load_answers_document()
        if self.jobs_path.exists():
            self._load_jobs_document()
        if self.resumes_path.exists():
            self._load_resumes_document()
        if self.automation_settings_path.exists():
            self._load_automation_settings_document()
        if self.employer_accounts_path.exists():
            self._load_employer_accounts_document()
        if self.account_operation_journal_path.exists():
            self._load_account_operation_journal()
        if self.trusted_fill_path.exists():
            self._load_trusted_fill_document()
        if self.resume_extractions_path.exists():
            self._load_extractions_document()
        if self.resume_extraction_requests_path.exists():
            self._load_extraction_requests_document()
        if self.resume_extraction_journal_path.exists():
            self._load_extraction_journal()
        if self.sessions_path.exists():
            self._validate_existing_session_documents()
        if self.coordinator_path.exists():
            self._load_coordinator_document()
        coordinator_journal = None
        if self.coordinator_journal_path.exists():
            coordinator_journal = self._load_coordinator_journal()
        pending_operation = (
            coordinator_journal["operation"]
            if coordinator_journal is not None
            else None
        )
        pending_history_write = (
            pending_operation is not None
            and pending_operation.get("historyEvent") is not None
        )
        if (
            self.history_path.exists()
            and not pending_history_write
        ):
            self.read_history()


    def _validate_existing_session_documents(self) -> None:
        """Validate canonical session files without following or changing identities."""

        try:
            directory_metadata = self.sessions_path.lstat()
        except OSError:
            raise StoreError("canonical sessions directory cannot be validated") from None
        if _late('stat').S_ISLNK(directory_metadata.st_mode) or _late('_is_reparse_point')(directory_metadata) or not _late('stat').S_ISDIR(
            directory_metadata.st_mode
        ):
            raise StoreError("canonical sessions directory is invalid")
        directory: int | None = None
        if _late('os').name != "nt":
            directory_flags = _late('os').O_RDONLY | getattr(_late('os'), "O_DIRECTORY", 0)
            if hasattr(_late('os'), "O_NOFOLLOW"):
                directory_flags |= _late('os').O_NOFOLLOW
            try:
                directory = _late('os').open(self.sessions_path, directory_flags)
            except OSError:
                raise StoreError("canonical sessions directory cannot be validated") from None
        try:
            opened_directory = (
                self.sessions_path.lstat()
                if directory is None
                else _late('os').fstat(directory)
            )
            if (
                _late('stat').S_ISLNK(opened_directory.st_mode)
                or _late('_is_reparse_point')(opened_directory)
                or not _late('stat').S_ISDIR(opened_directory.st_mode)
                or opened_directory.st_dev != directory_metadata.st_dev
                or opened_directory.st_ino != directory_metadata.st_ino
            ):
                raise StoreError("canonical sessions directory identity changed")
            for name in sorted(_late('os').listdir(self.sessions_path if directory is None else directory)):
                if not name.endswith(".json"):
                    continue
                application_id = _late('_safe_session_id')(name[:-5])
                try:
                    metadata = (
                        (self.sessions_path / name).lstat()
                        if directory is None
                        else _late('os').stat(name, dir_fd=directory, follow_symlinks=False)
                    )
                except OSError:
                    raise StoreError("canonical session cannot be validated") from None
                if _late('stat').S_ISLNK(metadata.st_mode) or _late('_is_reparse_point')(metadata) or not _late('stat').S_ISREG(metadata.st_mode):
                    raise StoreError("canonical session must be a regular file")
                flags = _late('os').O_RDONLY | getattr(_late('os'), "O_NOFOLLOW", 0)
                try:
                    descriptor = (
                        _late('os').open(self.sessions_path / name, flags)
                        if directory is None
                        else _late('os').open(name, flags, dir_fd=directory)
                    )
                except OSError:
                    raise StoreError("canonical session cannot be validated") from None
                try:
                    opened = _late('os').fstat(descriptor)
                    if (
                        opened.st_dev != metadata.st_dev
                        or opened.st_ino != metadata.st_ino
                        or not _late('stat').S_ISREG(opened.st_mode)
                        or _late('_is_reparse_point')(opened)
                    ):
                        raise StoreError("canonical session identity changed")
                    try:
                        with _late('os').fdopen(descriptor, encoding="utf-8") as source:
                            descriptor = -1
                            session = _late('_require_object')(_late('json').load(source), "session")
                    except (OSError, UnicodeError, _late('json').JSONDecodeError):
                        raise StoreError("cannot read valid session JSON") from None
                finally:
                    if descriptor >= 0:
                        _late('os').close(descriptor)
                _late('validate_version')(session, "session")
                _late('_project_legacy_session')(session)
                if session["applicationId"] != application_id:
                    raise StoreError("session application id does not match path")
            closed_directory = self.sessions_path.lstat()
            if (
                _late('stat').S_ISLNK(closed_directory.st_mode)
                or _late('_is_reparse_point')(closed_directory)
                or not _late('stat').S_ISDIR(closed_directory.st_mode)
                or closed_directory.st_dev != directory_metadata.st_dev
                or closed_directory.st_ino != directory_metadata.st_ino
            ):
                raise StoreError("canonical sessions directory identity changed")
        finally:
            if directory is not None:
                _late('os').close(directory)
