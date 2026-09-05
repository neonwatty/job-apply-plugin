"""Pure Store normalization, fingerprint, and JSON-pointer primitives."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .constants import (
    JOB_ORIGINS,
    JOB_PROVENANCE_ORIGINS,
    SESSION_ID,
    _MISSING,
)
from .errors import StoreError


def _value(runtime: dict[str, Any] | None, name: str, fallback: Any) -> Any:
    return fallback if runtime is None else runtime.get(name, fallback)


def normalize_question(question: str) -> str:
    if not isinstance(question, str) or not question.strip():
        raise StoreError("question must be a non-empty string")
    normalized = unicodedata.normalize("NFKC", question).lower().strip()
    normalized = re.sub(r"[^\w\s]", " ", normalized, flags=re.UNICODE)
    return " ".join(normalized.split())


def answer_key(question: str, scope: dict[str, Any] | None = None) -> str:
    normalized = normalize_question(question)
    scope_json = json.dumps(scope or {}, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(f"v1\0{normalized}\0{scope_json}".encode("utf-8")).hexdigest()
    return f"question.{digest}"


def normalize_job_url(url: str) -> str:
    if not isinstance(url, str) or not url.strip():
        raise StoreError("job URL must be a non-empty string")
    try:
        parsed = urlsplit(url.strip())
        port = parsed.port
    except ValueError as error:
        raise StoreError("job URL is invalid") from error
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise StoreError("job URL must use HTTP or HTTPS")
    if parsed.username is not None or parsed.password is not None:
        raise StoreError("job URL must not contain credentials")
    hostname = parsed.hostname.lower()
    if ":" in hostname and not hostname.startswith("["):
        hostname = f"[{hostname}]"
    default_port = (parsed.scheme.lower(), port) in {("http", 80), ("https", 443)}
    netloc = hostname if port is None or default_port else f"{hostname}:{port}"
    return urlunsplit((parsed.scheme.lower(), netloc, parsed.path or "/", parsed.query, ""))


def _job_origin(origin: str) -> str:
    if origin not in JOB_ORIGINS:
        raise StoreError("job origin must be human or agent")
    return origin


def _nonempty_job_value(value: Any) -> bool:
    return value is not None and (not isinstance(value, str) or bool(value.strip()))


def _normalized_job_source(value: Any) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip().lower()


def _job_observation_source(record: dict[str, Any]) -> str:
    return _normalized_job_source(record.get("source")) or "manual"


def _job_field_provenance(
    provenance: dict[str, Any], field: str,
) -> dict[str, Any] | None:
    value = provenance.get(f"/{_json_pointer_segment(field)}")
    if not isinstance(value, dict) or value.get("origin") not in JOB_PROVENANCE_ORIGINS:
        return None
    return value


def _agent_may_update_job_field(
    record: dict[str, Any], provenance: dict[str, Any], field: str,
) -> bool:
    authored = _job_field_provenance(provenance, field)
    if authored is not None:
        return authored["origin"] == "agent"
    return not _nonempty_job_value(record.get(field))


def _migration_may_update_job_field(
    record: dict[str, Any], provenance: dict[str, Any], field: str,
) -> bool:
    if not _nonempty_job_value(record.get(field)):
        return True
    authored = _job_field_provenance(provenance, field)
    return authored is not None and authored["origin"] == "migration"


def _reject_supplied_migration_provenance(provenance: dict[str, Any]) -> None:
    if any(
        isinstance(value, dict) and value.get("origin") == "migration"
        for value in provenance.values()
    ):
        raise StoreError("migration provenance is reserved for guided legacy imports")


def _validate_migration_provenance_replacement(
    current: dict[str, Any], replacement: dict[str, Any],
) -> None:
    protected_paths = {
        path
        for path in set(current) | set(replacement)
        if (
            isinstance(current.get(path), dict)
            and current[path].get("origin") == "migration"
        )
        or (
            isinstance(replacement.get(path), dict)
            and replacement[path].get("origin") == "migration"
        )
    }
    if any(current.get(path) != replacement.get(path) for path in protected_paths):
        raise StoreError("migration provenance is reserved for guided legacy imports")


def _stamp_job_provenance(
    provenance: dict[str, Any],
    fields: list[str] | set[str],
    origin: str,
    observation_source: str,
    updated_at: str,
) -> dict[str, Any]:
    stamped = dict(provenance)
    for field in fields:
        stamped[f"/{_json_pointer_segment(field)}"] = {
            "origin": origin,
            "observationSource": observation_source,
            "updatedAt": updated_at,
        }
    return stamped


def normalize_resume_path(
    path: str, *, _runtime: dict[str, Any] | None = None,
) -> str:
    if not isinstance(path, str) or not path.strip() or "\0" in path:
        raise StoreError("resume path must be a non-empty absolute path")
    runtime_path = _value(_runtime, "Path", Path)
    runtime_os = _value(_runtime, "os", os)
    expanded = runtime_path(path.strip()).expanduser()
    if not expanded.is_absolute():
        raise StoreError("resume path must be absolute")
    return runtime_os.path.normpath(str(expanded))


def observe_resume_file(
    path: str, *, _runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    runtime_path = _value(_runtime, "Path", Path)
    normalized = normalize_resume_path(path, _runtime=_runtime)
    try:
        metadata = runtime_path(normalized).stat()
    except FileNotFoundError:
        return {"exists": False, "size": None, "modifiedAt": None}
    if not stat.S_ISREG(metadata.st_mode):
        raise StoreError("resume path must identify a regular file")
    return {
        "exists": True,
        "size": metadata.st_size,
        "modifiedAt": _resume_modified_at(metadata),
    }


def _resume_modified_at(metadata: os.stat_result) -> str:
    return datetime.fromtimestamp(metadata.st_mtime, timezone.utc).isoformat(
        timespec="seconds"
    ).replace("+00:00", "Z")


def _is_reparse_point(metadata: os.stat_result) -> bool:
    attributes = getattr(metadata, "st_file_attributes", 0)
    marker = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & marker)


def _managed_resume_digest_cache_identity(
    metadata: os.stat_result,
    *,
    platform_name: str | None = None,
    _runtime: dict[str, Any] | None = None,
) -> tuple[int, int, int, int, int] | None:
    """Return metadata that reliably changes after in-place content writes."""

    runtime_os = _value(_runtime, "os", os)
    if (runtime_os.name if platform_name is None else platform_name) == "nt":
        # Python exposes Windows creation time as st_ctime, not change time.
        return None
    return (
        metadata.st_dev,
        metadata.st_ino,
        metadata.st_size,
        metadata.st_mtime_ns,
        metadata.st_ctime_ns,
    )


def _safe_session_id(application_id: str) -> str:
    if (
        not isinstance(application_id, str)
        or not SESSION_ID.fullmatch(application_id)
        or ".." in application_id
    ):
        raise StoreError("application id contains unsupported characters")
    return application_id


def _validate_optional_strings(
    document: dict[str, Any], fields: set[str], label: str,
) -> None:
    for field in fields:
        if field in document and document[field] is not None and not isinstance(
            document[field], str
        ):
            raise StoreError(f"{label}.{field} must be a string")


def _json_pointer_segment(value: str) -> str:
    return value.replace("~", "~0").replace("/", "~1")


def _canonical_json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _scope_fingerprint(value: dict[str, Any]) -> str:
    return hashlib.sha256(_canonical_json(value).encode("utf-8")).hexdigest()


def _question_fingerprint(value: str) -> str:
    normalized = " ".join(value.split()).casefold()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _top_level_pointer_key(pointer: str) -> str:
    if not isinstance(pointer, str) or not pointer.startswith("/") or "/" in pointer[1:]:
        raise StoreError("atomic profile paths must identify one top-level fact")
    encoded = pointer[1:]
    if not encoded or re.search(r"~(?![01])", encoded):
        raise StoreError("atomic profile path is invalid")
    return encoded.replace("~1", "/").replace("~0", "~")


def _json_pointer_value(document: Any, pointer: str) -> Any:
    current = document
    for encoded in pointer.split("/")[1:]:
        key = encoded.replace("~1", "/").replace("~0", "~")
        if not isinstance(current, dict) or key not in current:
            return None
        current = current[key]
    return current


def _decode_json_pointer(pointer: str) -> list[str]:
    if not isinstance(pointer, str) or not pointer.startswith("/") or pointer == "/":
        raise StoreError("proposal path is invalid")
    segments = []
    for encoded in pointer.split("/")[1:]:
        if not encoded or re.search(r"~(?![01])", encoded):
            raise StoreError("proposal path is invalid")
        segments.append(encoded.replace("~1", "/").replace("~0", "~"))
    return segments


def _pointer_lookup(document: Any, pointer: str) -> tuple[bool, Any]:
    current = document
    for key in _decode_json_pointer(pointer):
        if not isinstance(current, dict) or key not in current:
            return False, None
        current = current[key]
    return True, current


def _pointer_baseline(document: dict[str, Any], pointer: str) -> dict[str, Any]:
    segments = _decode_json_pointer(pointer)
    current: Any = document
    ancestors: list[dict[str, Any]] = []
    encoded = ""
    for key in segments[:-1]:
        encoded += f"/{_json_pointer_segment(key)}"
        exists = isinstance(current, dict) and key in current
        value = current[key] if exists else None
        baseline = {"path": encoded, "exists": exists}
        if exists and isinstance(value, dict):
            baseline["container"] = True
            baseline["empty"] = not value
        elif exists:
            baseline["value"] = value
        ancestors.append(baseline)
        current = value if exists else _MISSING
    exists, value = _pointer_lookup(document, pointer)
    result: dict[str, Any] = {"exists": exists, "ancestors": ancestors}
    if exists:
        result["value"] = value
    return result


def _json_values_equal(left: Any, right: Any) -> bool:
    """Compare JSON values without Python's boolean/number equivalence."""

    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if left is None or right is None:
        return left is right
    if isinstance(left, dict) or isinstance(right, dict):
        return (
            isinstance(left, dict)
            and isinstance(right, dict)
            and left.keys() == right.keys()
            and all(_json_values_equal(left[key], right[key]) for key in left)
        )
    if isinstance(left, list) or isinstance(right, list):
        return (
            isinstance(left, list)
            and isinstance(right, list)
            and len(left) == len(right)
            and all(
                _json_values_equal(left_item, right_item)
                for left_item, right_item in zip(left, right)
            )
        )
    if isinstance(left, (int, float)) or isinstance(right, (int, float)):
        return isinstance(left, (int, float)) and isinstance(right, (int, float)) and left == right
    return isinstance(left, str) and isinstance(right, str) and left == right


def _replacement_scope(baseline: dict[str, Any]) -> dict[str, Any] | None:
    """Return the existing non-object ancestor a child acceptance would replace."""

    for ancestor in baseline["ancestors"]:
        if ancestor["exists"] and ancestor.get("container") is not True:
            return {"path": ancestor["path"], "value": ancestor.get("value")}
    return None


def _set_pointer_value(
    document: dict[str, Any], pointer: str, value: Any, *, replace_ancestors: bool,
) -> None:
    segments = _decode_json_pointer(pointer)
    current = document
    for key in segments[:-1]:
        child = current.get(key, _MISSING)
        if child is _MISSING or child is None:
            child = {}
            current[key] = child
        elif not isinstance(child, dict):
            if not replace_ancestors:
                raise StoreError("proposal path conflicts with an existing fact")
            child = {}
            current[key] = child
        current = child
    current[segments[-1]] = value
