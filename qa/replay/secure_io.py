"""Descriptor-bound storage and atomic I/O for replay runs."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import secrets
import stat
import sys
from typing import Any

from qa.recorder_fs import BrokerError, exclusive_rename


MAX_JSON_BYTES = 1024 * 1024
MAX_RESUME_BYTES = 10 * 1024 * 1024


class CoordinatorError(ValueError):
    """A stable, value-free failure safe to display to the tester."""


@dataclass
class _RunStorage:
    """Own the two directory descriptors anchoring one replay run."""

    run_id: str
    run_root: Path
    canonical_run_root: Path
    root_descriptor: int
    run_descriptor: int

    @classmethod
    def adopt_legacy(
        cls,
        run_id: str,
        run_root: Path,
        root_descriptor: int,
        run_descriptor: int,
        *,
        canonical_run_root: Path | None = None,
    ) -> _RunStorage:
        """Own transferred descriptors without reopening either bound path."""

        return cls(
            run_id=run_id,
            run_root=run_root,
            canonical_run_root=canonical_run_root or run_root,
            root_descriptor=root_descriptor,
            run_descriptor=run_descriptor,
        )

    def close_run(self) -> None:
        if self.run_descriptor >= 0:
            os.close(self.run_descriptor)
            self.run_descriptor = -1

    def close(self) -> None:
        self.close_run()
        if self.root_descriptor >= 0:
            os.close(self.root_descriptor)
            self.root_descriptor = -1

    def detach_legacy(self) -> tuple[int, int]:
        """Transfer descriptor ownership to the legacy facade caller."""

        root_descriptor = self.root_descriptor
        run_descriptor = self.run_descriptor
        self.root_descriptor = -1
        self.run_descriptor = -1
        return root_descriptor, run_descriptor


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _open_private_directory(
    path: Path, diagnostic: str, *, _runtime: Any | None = None
) -> int:
    runtime = _resolve_runtime(_runtime)
    descriptor = None
    try:
        descriptor = runtime.os.open(
            path,
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | getattr(runtime.os, "O_NOFOLLOW", 0),
        )
        metadata = runtime.os.fstat(descriptor)
        if (
            not runtime.stat.S_ISDIR(metadata.st_mode)
            or metadata.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise CoordinatorError(diagnostic)
        return descriptor
    except CoordinatorError:
        if descriptor is not None:
            runtime.os.close(descriptor)
        raise
    except OSError:
        if descriptor is not None:
            runtime.os.close(descriptor)
        raise CoordinatorError(diagnostic) from None


def _verify_directory_binding(
    path: Path,
    descriptor: int,
    diagnostic: str,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        bound = runtime.os.fstat(descriptor)
        current = path.lstat()
    except OSError:
        raise CoordinatorError(diagnostic) from None
    if (
        not runtime.stat.S_ISDIR(current.st_mode)
        or (bound.st_dev, bound.st_ino) != (current.st_dev, current.st_ino)
        or current.st_uid != runtime.os.getuid()
        or runtime.stat.S_IMODE(current.st_mode) != 0o700
    ):
        raise CoordinatorError(diagnostic)


def _create_run_storage(
    runs_root: Path, *, _runtime: Any | None = None
) -> _RunStorage:
    runtime = _resolve_runtime(_runtime)
    root_descriptor = None
    try:
        created = False
        try:
            runs_root.mkdir(mode=0o700)
            created = True
        except FileExistsError:
            pass
        if not runtime.stat.S_ISDIR(runs_root.lstat().st_mode):
            raise OSError
        if created:
            runtime.os.chmod(runs_root, 0o700)
        root_descriptor = runtime._open_private_directory(
            runs_root, "run directory creation failed"
        )
        for _ in range(16):
            date = runtime.datetime.now(runtime.timezone.utc).strftime("%Y%m%d")
            run_id = f"qa-run-{date}-{runtime.secrets.token_hex(4)}"
            run_root = runs_root / run_id
            try:
                runtime.os.mkdir(run_id, 0o700, dir_fd=root_descriptor)
                run_descriptor = runtime.os.open(
                    run_id,
                    runtime.os.O_RDONLY
                    | runtime.os.O_DIRECTORY
                    | getattr(runtime.os, "O_NOFOLLOW", 0),
                    dir_fd=root_descriptor,
                )
                runtime.os.fchmod(run_descriptor, 0o700)
                return _RunStorage(
                    run_id=run_id,
                    run_root=run_root,
                    canonical_run_root=runs_root.resolve() / run_id,
                    root_descriptor=root_descriptor,
                    run_descriptor=run_descriptor,
                )
            except FileExistsError:
                continue
    except OSError:
        pass
    if root_descriptor is not None:
        runtime.os.close(root_descriptor)
    raise CoordinatorError("run directory creation failed")


def _open_run_storage(
    runs_root: Path,
    run_id: str,
    diagnostic: str = "invalid run state",
    *,
    _runtime: Any | None = None,
) -> _RunStorage:
    runtime = _resolve_runtime(_runtime)
    run_root = runs_root / run_id
    root_descriptor = runtime._open_private_directory(runs_root, diagnostic)
    run_descriptor = None
    try:
        run_descriptor = runtime.os.open(
            run_id,
            runtime.os.O_RDONLY
            | runtime.os.O_DIRECTORY
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            dir_fd=root_descriptor,
        )
        metadata = runtime.os.fstat(run_descriptor)
        if (
            metadata.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(metadata.st_mode) != 0o700
        ):
            raise CoordinatorError(diagnostic)
        runtime._verify_directory_binding(runs_root, root_descriptor, diagnostic)
        runtime._verify_directory_binding(run_root, run_descriptor, diagnostic)
        return _RunStorage(
            run_id=run_id,
            run_root=run_root,
            canonical_run_root=runs_root.resolve() / run_id,
            root_descriptor=root_descriptor,
            run_descriptor=run_descriptor,
        )
    except BaseException:
        if run_descriptor is not None:
            runtime.os.close(run_descriptor)
        runtime.os.close(root_descriptor)
        raise


def _read_regular_at(
    directory_descriptor: int,
    name: str,
    limit: int,
    diagnostic: str,
    *,
    _runtime: Any | None = None,
) -> bytes:
    runtime = _resolve_runtime(_runtime)
    descriptor = None
    try:
        descriptor = runtime.os.open(
            name,
            runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0),
            dir_fd=directory_descriptor,
        )
        metadata = runtime.os.fstat(descriptor)
        if (
            not runtime.stat.S_ISREG(metadata.st_mode)
            or metadata.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(metadata.st_mode) != 0o600
            or metadata.st_size > limit
        ):
            raise CoordinatorError(diagnostic)
        chunks: list[bytes] = []
        remaining = limit + 1
        while remaining:
            chunk = runtime.os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > limit:
            raise CoordinatorError(diagnostic)
        return data
    except CoordinatorError:
        raise
    except OSError:
        raise CoordinatorError(diagnostic) from None
    finally:
        if descriptor is not None:
            runtime.os.close(descriptor)


def _read_json_at(
    directory_descriptor: int,
    name: str,
    diagnostic: str,
    *,
    _runtime: Any | None = None,
) -> Any:
    runtime = _resolve_runtime(_runtime)
    try:
        return runtime.json.loads(
            runtime._read_regular_at(
                directory_descriptor,
                name,
                runtime.MAX_JSON_BYTES,
                diagnostic,
            ).decode()
        )
    except (UnicodeError, runtime.json.JSONDecodeError, RecursionError):
        raise CoordinatorError(diagnostic) from None


def _entry_exists_at(
    directory_descriptor: int,
    name: str,
    *,
    _runtime: Any | None = None,
) -> bool:
    runtime = _resolve_runtime(_runtime)
    try:
        runtime.os.stat(name, dir_fd=directory_descriptor, follow_symlinks=False)
        return True
    except FileNotFoundError:
        return False
    except OSError:
        raise CoordinatorError("invalid run state") from None


def _atomic_json_at(
    directory_descriptor: int,
    name: str,
    value: dict[str, Any],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    encoded = (
        runtime.json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    temporary = f".{name}.{runtime.secrets.token_hex(8)}.tmp"
    descriptor = None
    try:
        descriptor = runtime.os.open(
            temporary,
            runtime.os.O_WRONLY
            | runtime.os.O_CREAT
            | runtime.os.O_EXCL
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_descriptor,
        )
        runtime.os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(encoded):
            count = runtime.os.write(descriptor, encoded[written:])
            if count <= 0:
                raise OSError
            written += count
        runtime.os.fsync(descriptor)
        runtime.os.close(descriptor)
        descriptor = None
        runtime.exclusive_rename(
            directory_descriptor, temporary, directory_descriptor, name
        )
        runtime.os.fsync(directory_descriptor)
    except (OSError, BrokerError):
        raise CoordinatorError("run artifact write failed") from None
    finally:
        if descriptor is not None:
            runtime.os.close(descriptor)
        try:
            runtime.os.unlink(temporary, dir_fd=directory_descriptor)
        except FileNotFoundError:
            pass


def _publish_marker_at(
    directory_descriptor: int,
    name: str,
    value: dict[str, Any],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    if name not in {"abandoned.json", "tombstone.json"}:
        raise CoordinatorError("run artifact write failed")
    encoded = (
        runtime.json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n"
    ).encode()
    stem = name.removesuffix(".json")
    temporary = f".marker-{stem}-{runtime.secrets.token_hex(16)}.tmp"
    descriptor = None
    try:
        descriptor = runtime.os.open(
            temporary,
            runtime.os.O_WRONLY
            | runtime.os.O_CREAT
            | runtime.os.O_EXCL
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=directory_descriptor,
        )
        runtime.os.fchmod(descriptor, 0o600)
        written = 0
        while written < len(encoded):
            count = runtime.os.write(descriptor, encoded[written:])
            if count <= 0:
                raise OSError
            written += count
        runtime.os.fsync(descriptor)
        runtime.os.close(descriptor)
        descriptor = None
        runtime.exclusive_rename(
            directory_descriptor, temporary, directory_descriptor, name
        )
        runtime.os.fsync(directory_descriptor)
    except (OSError, BrokerError):
        raise CoordinatorError("run artifact write failed") from None
    finally:
        if descriptor is not None:
            runtime.os.close(descriptor)


def _ensure_marker_at(
    directory_descriptor: int,
    name: str,
    value: dict[str, Any],
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        current = runtime._read_json_at(
            directory_descriptor, name, "invalid run state"
        )
    except CoordinatorError:
        current = None
    if current == value:
        return
    if runtime._entry_exists_at(directory_descriptor, name):
        captured = (
            f".marker-{name.removesuffix('.json')}-"
            f"{runtime.secrets.token_hex(16)}.tmp"
        )
        try:
            expected = runtime.os.stat(
                name, dir_fd=directory_descriptor, follow_symlinks=False
            )
            parent = runtime.os.fstat(directory_descriptor)
            if (
                not runtime.stat.S_ISREG(expected.st_mode)
                or expected.st_uid != runtime.os.getuid()
                or expected.st_dev != parent.st_dev
                or runtime.stat.S_IMODE(expected.st_mode) != 0o600
                or expected.st_size > runtime.MAX_JSON_BYTES
            ):
                raise CoordinatorError("invalid run state")
            runtime.exclusive_rename(
                directory_descriptor, name, directory_descriptor, captured
            )
            observed = runtime.os.stat(
                captured,
                dir_fd=directory_descriptor,
                follow_symlinks=False,
            )
            if not runtime._same_entry(expected, observed):
                runtime._restore_captured_entry(
                    directory_descriptor, captured, name
                )
                raise CoordinatorError("invalid run state")
            runtime.os.fsync(directory_descriptor)
        except CoordinatorError:
            raise
        except (OSError, BrokerError):
            raise CoordinatorError("invalid run state") from None
    runtime._publish_marker_at(directory_descriptor, name, value)


def _same_entry(expected: os.stat_result, observed: os.stat_result) -> bool:
    return (
        expected.st_dev,
        expected.st_ino,
        stat.S_IFMT(expected.st_mode),
    ) == (
        observed.st_dev,
        observed.st_ino,
        stat.S_IFMT(observed.st_mode),
    )


def _restore_captured_entry(
    directory_descriptor: int,
    captured: str,
    original: str,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        runtime.os.stat(
            original, dir_fd=directory_descriptor, follow_symlinks=False
        )
    except FileNotFoundError:
        try:
            runtime.exclusive_rename(
                directory_descriptor,
                captured,
                directory_descriptor,
                original,
            )
        except (OSError, BrokerError):
            pass
    except OSError:
        pass
