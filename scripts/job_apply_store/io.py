"""Private filesystem primitives for versioned Store documents."""

from __future__ import annotations

import json
import os
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from .constants import SCHEMA_VERSION
from .errors import StoreError


def _value(runtime: dict[str, Any] | None, name: str, fallback: Any) -> Any:
    return fallback if runtime is None else runtime.get(name, fallback)


def _set_private_mode(
    path: Path, mode: int, *, _runtime: dict[str, Any] | None = None,
) -> None:
    runtime_os = _value(_runtime, "os", os)
    if runtime_os.name != "nt":
        runtime_os.chmod(path, mode)


def _ensure_private_dir(
    path: Path, *, _runtime: dict[str, Any] | None = None,
) -> None:
    path.mkdir(parents=True, exist_ok=True, mode=0o700)
    _set_private_mode(path, 0o700, _runtime=_runtime)


@contextmanager
def exclusive_file_lock(
    path: Path, *, _runtime: dict[str, Any] | None = None,
):
    """Serialize read-modify-write operations across local clients."""

    runtime_os = _value(_runtime, "os", os)
    _ensure_private_dir(path.parent, _runtime=_runtime)
    descriptor = runtime_os.open(path, runtime_os.O_RDWR | runtime_os.O_CREAT, 0o600)
    _set_private_mode(path, 0o600, _runtime=_runtime)
    try:
        if runtime_os.name == "nt":
            import msvcrt

            if runtime_os.fstat(descriptor).st_size == 0:
                runtime_os.write(descriptor, b"0")
                runtime_os.fsync(descriptor)
            runtime_os.lseek(descriptor, 0, runtime_os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_EX)
        yield
    finally:
        if runtime_os.name == "nt":
            import msvcrt

            runtime_os.lseek(descriptor, 0, runtime_os.SEEK_SET)
            msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(descriptor, fcntl.LOCK_UN)
        runtime_os.close(descriptor)


def _fsync_directory(
    path: Path, *, _runtime: dict[str, Any] | None = None,
) -> None:
    runtime_os = _value(_runtime, "os", os)
    if runtime_os.name == "nt":
        return
    try:
        descriptor = runtime_os.open(path, runtime_os.O_RDONLY)
    except OSError:
        return
    try:
        runtime_os.fsync(descriptor)
    except OSError:
        pass
    finally:
        runtime_os.close(descriptor)


def atomic_write_json(
    path: Path,
    payload: dict[str, Any],
    *,
    _runtime: dict[str, Any] | None = None,
) -> None:
    """Replace a JSON document atomically without risking the previous file."""

    runtime_os = _value(_runtime, "os", os)
    runtime_path = _value(_runtime, "Path", Path)
    _ensure_private_dir(path.parent, _runtime=_runtime)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=path.parent,
            prefix=f".{path.name}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = runtime_path(temporary.name)
            json.dump(payload, temporary, indent=2, sort_keys=True, ensure_ascii=False)
            temporary.write("\n")
            temporary.flush()
            runtime_os.fsync(temporary.fileno())
        _set_private_mode(temporary_path, 0o600, _runtime=_runtime)
        runtime_os.replace(temporary_path, path)
        temporary_path = None
        _set_private_mode(path, 0o600, _runtime=_runtime)
        _fsync_directory(path.parent, _runtime=_runtime)
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def read_json_object(path: Path, label: str) -> dict[str, Any]:
    try:
        with path.open(encoding="utf-8") as source:
            value = json.load(source)
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise StoreError(f"cannot read valid {label} JSON at {path}") from error
    return require_object(value, label)


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise StoreError(f"{label} must be a JSON object")
    return value


def validate_version(document: dict[str, Any], label: str) -> None:
    version = document.get("schemaVersion")
    if isinstance(version, bool) or not isinstance(version, int):
        raise StoreError(f"{label} has no valid schemaVersion")
    if version > SCHEMA_VERSION:
        raise StoreError(f"{label} uses unsupported future schemaVersion {version}")
    if version != SCHEMA_VERSION:
        raise StoreError(f"{label} uses unsupported schemaVersion {version}")
