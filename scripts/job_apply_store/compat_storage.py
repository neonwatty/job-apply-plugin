"""Late-bound facade compatibility adapters for storage."""

from __future__ import annotations

import os
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from .compat_runtime import runtime as _runtime


def _optional_email(value: Any, label: str) -> str | None:
    return _runtime()['_account_validation']._optional_email(value, label)


def _validate_automation_settings_record(value: Any) -> dict[str, Any]:
    return _runtime()['_account_validation']._validate_automation_settings_record(
        value, accounts_module=_runtime()['ACCOUNTS_MODULE']
    )


def _validate_employer_account_record(key: str, value: Any) -> dict[str, Any]:
    return _runtime()['_account_validation']._validate_employer_account_record(
        key,
        value,
        accounts_module=_runtime()['ACCOUNTS_MODULE'],
        credentials_module=_runtime()['CREDENTIALS_MODULE'],
    )


def utc_now() -> str:
    return _runtime()['datetime'].now(_runtime()['timezone'].utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _require_object(value: Any, label: str) -> dict[str, Any]:
    return _runtime()['_io'].require_object(value, label)


def _fact_group_label(value: Any) -> str:
    return _runtime()['_profile_validation']._fact_group_label(value)


def _fact_group_paths(value: Any) -> list[str]:
    return _runtime()['_profile_validation']._fact_group_paths(value)


def _fact_group_order(value: Any) -> int:
    return _runtime()['_profile_validation']._fact_group_order(value)


def _validate_fact_group_record(group_id: str, value: Any) -> dict[str, Any]:
    return _runtime()['_profile_validation']._validate_fact_group_record(group_id, value)


def _set_private_mode(path: Path, mode: int) -> None:
    _runtime()['_io']._set_private_mode(path, mode, _runtime=_runtime())


def _ensure_private_dir(path: Path) -> None:
    _runtime()['_io']._ensure_private_dir(path, _runtime=_runtime())


@contextmanager
def exclusive_file_lock(path: Path):
    """Serialize read-modify-write operations across local clients."""

    with _runtime()['_io'].exclusive_file_lock(path, _runtime=_runtime()):
        yield


def _fsync_directory(path: Path) -> None:
    _runtime()['_io']._fsync_directory(path, _runtime=_runtime())


def atomic_write_json(path: Path, payload: dict[str, Any]) -> None:
    """Replace a JSON document atomically without risking the previous file."""

    _runtime()['_io'].atomic_write_json(path, payload, _runtime=_runtime())


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    return _runtime()['_io'].read_json_object(path, label)


def validate_version(document: dict[str, Any], label: str) -> None:
    _runtime()['_io'].validate_version(document, label)


def normalize_question(question: str) -> str:
    return _runtime()['_normalization'].normalize_question(question)


def answer_key(question: str, scope: dict[str, Any] | None = None) -> str:
    return _runtime()['_normalization'].answer_key(question, scope)


def normalize_job_url(url: str) -> str:
    return _runtime()['_normalization'].normalize_job_url(url)


def normalize_resume_path(path: str) -> str:
    return _runtime()['_normalization'].normalize_resume_path(path, _runtime=_runtime())


def observe_resume_file(path: str) -> dict[str, Any]:
    return _runtime()['_normalization'].observe_resume_file(path, _runtime=_runtime())


def _resume_modified_at(metadata: os.stat_result) -> str:
    return _runtime()['_normalization']._resume_modified_at(metadata)


def _validate_resume_bytes(path: Path, extension: str) -> tuple[str, int, str]:
    """Validate a private staged copy without disclosing its path or content."""

    media_type = _runtime()['RESUME_MEDIA_TYPES'].get(extension)
    if media_type is None:
        raise _runtime()['StoreError']("resume format must be PDF, DOCX, or UTF-8 TXT")
    try:
        metadata = path.stat()
        size = metadata.st_size
        if size > _runtime()['RESUME_MAX_BYTES']:
            raise _runtime()['StoreError']("resume file exceeds the 10 MiB limit")
        if size == 0:
            raise _runtime()['StoreError']("resume file is empty")
        if extension == ".pdf":
            with path.open("rb") as source:
                if source.read(5) != b"%PDF-":
                    raise _runtime()['StoreError']("resume content does not match its extension")
        elif extension == ".docx":
            try:
                with _runtime()['zipfile'].ZipFile(path) as archive:
                    names = set(archive.namelist())
                    if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                        raise _runtime()['StoreError']("resume content does not match its extension")
                    bad_member = next(
                        (
                            name
                            for name in names
                            if name.startswith("/")
                            or ".." in _runtime()['Path'](name.replace("\\", "/")).parts
                        ),
                        None,
                    )
                    if bad_member is not None:
                        raise _runtime()['StoreError']("resume content does not match its extension")
            except (OSError, _runtime()['zipfile'].BadZipFile):
                raise _runtime()['StoreError']("resume content does not match its extension") from None
        else:
            data = path.read_bytes()
            if b"\0" in data:
                raise _runtime()['StoreError']("resume content does not match its extension")
            try:
                data.decode("utf-8")
            except UnicodeDecodeError:
                raise _runtime()['StoreError']("resume content does not match its extension") from None
    except _runtime()['StoreError']:
        raise
    except OSError:
        raise _runtime()['StoreError']("resume file could not be validated") from None
    return media_type, size, _runtime()['_resume_modified_at'](metadata)


def _safe_session_id(application_id: str) -> str:
    return _runtime()['_normalization']._safe_session_id(application_id)


def _is_reparse_point(metadata: os.stat_result) -> bool:
    return _runtime()['_normalization']._is_reparse_point(metadata)


def _managed_resume_digest_cache_identity(
    metadata: os.stat_result,
    *,
    platform_name: str | None = None,
) -> tuple[int, int, int, int, int] | None:
    """Return metadata that reliably changes after in-place content writes."""

    return _runtime()['_normalization']._managed_resume_digest_cache_identity(
        metadata,
        platform_name=platform_name,
        _runtime=_runtime(),
    )


def _validate_optional_strings(
    document: dict[str, Any], fields: set[str], label: str
) -> None:
    _runtime()['_normalization']._validate_optional_strings(document, fields, label)


__all__ = [
    '_optional_email',
    '_validate_automation_settings_record',
    '_validate_employer_account_record',
    'utc_now',
    '_require_object',
    '_fact_group_label',
    '_fact_group_paths',
    '_fact_group_order',
    '_validate_fact_group_record',
    '_set_private_mode',
    '_ensure_private_dir',
    'exclusive_file_lock',
    '_fsync_directory',
    'atomic_write_json',
    'read_json_object',
    'validate_version',
    'normalize_question',
    'answer_key',
    'normalize_job_url',
    'normalize_resume_path',
    'observe_resume_file',
    '_resume_modified_at',
    '_validate_resume_bytes',
    '_safe_session_id',
    '_is_reparse_point',
    '_managed_resume_digest_cache_identity',
    '_validate_optional_strings',
]
