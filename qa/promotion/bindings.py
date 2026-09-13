"""Descriptor-bound private-session primitives for fixture promotion."""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
import secrets
import stat
import sys
from typing import Any

from qa.recorder_fs import exclusive_rename_available


MAX_JSON_BYTES = 1024 * 1024

_POSIX_DESCRIPTOR_SUPPORT = (
    os.name == "posix"
    and hasattr(os, "O_DIRECTORY")
    and hasattr(os, "O_NOFOLLOW")
    and hasattr(os, "O_CLOEXEC")
    and os.open in getattr(os, "supports_dir_fd", set())
    and os.stat in getattr(os, "supports_dir_fd", set())
    and os.mkdir in getattr(os, "supports_dir_fd", set())
    and os.unlink in getattr(os, "supports_dir_fd", set())
    and os.rmdir in getattr(os, "supports_dir_fd", set())
    and os.scandir in getattr(os, "supports_fd", set())
)


class PromotionError(ValueError):
    """A stable, value-free promotion diagnostic."""


@dataclass
class _SessionBinding:
    private: Path
    session: Path
    private_descriptor: int
    session_descriptor: int
    private_identity: os.stat_result
    session_identity: os.stat_result
    mount_identity: tuple[int, int]

    def close(self) -> None:
        os.close(self.session_descriptor)
        os.close(self.private_descriptor)


@dataclass
class _PrivateBinding(_SessionBinding):
    candidate: Path
    candidate_descriptor: int
    candidate_identity: os.stat_result

    def close(self) -> None:
        os.close(self.candidate_descriptor)
        super().close()


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _json_bytes(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        + "\n"
    ).encode("utf-8")


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return (left.st_dev, left.st_ino) == (right.st_dev, right.st_ino)


def _require_posix_capabilities(
    *, exclusive_install: bool = False, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    if (
        not runtime._POSIX_DESCRIPTOR_SUPPORT
        or (exclusive_install and not runtime.exclusive_rename_available())
        or not (runtime.sys.platform == "darwin" or runtime.sys.platform.startswith("linux"))
    ):
        raise PromotionError("unsupported platform")


def _descriptor_mount_identity(descriptor: int) -> tuple[int, int]:
    device = os.fstat(descriptor).st_dev
    if sys.platform.startswith("linux"):
        fdinfo = None
        try:
            fdinfo = os.open(
                f"/proc/self/fdinfo/{descriptor}", os.O_RDONLY | os.O_CLOEXEC
            )
            data = os.read(fdinfo, 16 * 1024)
            if os.read(fdinfo, 1):
                raise PromotionError("unsafe mount boundary")
            for line in data.splitlines():
                if line.startswith(b"mnt_id:"):
                    value = line.split(b":", 1)[1].strip()
                    if value.isdigit():
                        return device, int(value)
            raise PromotionError("unsafe mount boundary")
        except PromotionError:
            raise
        except OSError:
            raise PromotionError("unsafe mount boundary") from None
        finally:
            if fdinfo is not None:
                os.close(fdinfo)
    if sys.platform == "darwin":
        return device, device
    raise PromotionError("unsupported platform")


def _require_private_permissions(identity: os.stat_result) -> None:
    if identity.st_uid != os.getuid() or stat.S_IMODE(identity.st_mode) != 0o700:
        raise PromotionError("unsafe private permissions")


def _darwin_mountpoint_bound(
    path: Path,
    identity: os.stat_result,
    descriptor: int,
    *,
    _runtime: Any | None = None,
) -> bool:
    runtime = _resolve_runtime(_runtime)
    if runtime.sys.platform != "darwin":
        return False
    try:
        before = path.lstat()
        mounted = runtime.os.path.ismount(path)
        after = path.lstat()
        opened = runtime.os.fstat(descriptor)
    except (OSError, RuntimeError, ValueError):
        raise PromotionError("unsafe mount boundary") from None
    if not (
        runtime._same_identity(identity, before)
        and runtime._same_identity(identity, after)
        and runtime._same_identity(identity, opened)
    ):
        raise PromotionError("unsafe mount boundary")
    return mounted


def _read_regular_at(
    directory_descriptor: int,
    name: str,
    diagnostic: str,
    *,
    _runtime: Any | None = None,
) -> bytes:
    runtime = _resolve_runtime(_runtime)
    descriptor = None
    try:
        expected = runtime.os.stat(
            name, dir_fd=directory_descriptor, follow_symlinks=False
        )
        if (
            not runtime.stat.S_ISREG(expected.st_mode)
            or expected.st_size > runtime.MAX_JSON_BYTES
        ):
            raise PromotionError(diagnostic)
        descriptor = runtime.os.open(
            name,
            runtime.os.O_RDONLY | runtime.os.O_NOFOLLOW,
            dir_fd=directory_descriptor,
        )
        opened = runtime.os.fstat(descriptor)
        if not runtime.stat.S_ISREG(opened.st_mode) or not runtime._same_identity(
            expected, opened
        ):
            raise PromotionError(diagnostic)
        chunks: list[bytes] = []
        remaining = runtime.MAX_JSON_BYTES + 1
        while remaining:
            chunk = runtime.os.read(descriptor, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        if len(data) > runtime.MAX_JSON_BYTES:
            raise PromotionError(diagnostic)
        return data
    except PromotionError:
        raise
    except (OSError, RuntimeError, ValueError):
        raise PromotionError(diagnostic) from None
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
            runtime._read_regular_at(directory_descriptor, name, diagnostic).decode(
                "utf-8"
            )
        )
    except PromotionError:
        raise
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise PromotionError(diagnostic) from None


def _parse_json_bytes(data: bytes, diagnostic: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise PromotionError(diagnostic) from None


def _open_session_binding(
    session_argument: Path, *, _runtime: Any | None = None
) -> _SessionBinding:
    runtime = _resolve_runtime(_runtime)
    session = runtime.Path(runtime.os.path.abspath(session_argument))
    private = session.parent
    if private.name != ".qa-private" or session.name in {"", ".", ".."}:
        raise PromotionError("unsafe private session path")
    private_descriptor = session_descriptor = None
    binding = None
    try:
        private_identity = private.lstat()
        if not runtime.stat.S_ISDIR(private_identity.st_mode) or runtime.stat.S_ISLNK(
            private_identity.st_mode
        ):
            raise PromotionError("unsafe private session path")
        private_descriptor = runtime.os.open(
            private,
            runtime.os.O_RDONLY | runtime.os.O_DIRECTORY | runtime.os.O_NOFOLLOW,
        )
        if not runtime._same_identity(
            private_identity, runtime.os.fstat(private_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(private_identity)
        mount_identity = runtime._descriptor_mount_identity(private_descriptor)
        session_identity = runtime.os.stat(
            session.name, dir_fd=private_descriptor, follow_symlinks=False
        )
        session_descriptor = runtime.os.open(
            session.name,
            runtime.os.O_RDONLY | runtime.os.O_DIRECTORY | runtime.os.O_NOFOLLOW,
            dir_fd=private_descriptor,
        )
        if not runtime._same_identity(
            session_identity, runtime.os.fstat(session_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(session_identity)
        if (
            session_identity.st_dev != private_identity.st_dev
            or runtime._descriptor_mount_identity(session_descriptor) != mount_identity
            or runtime._darwin_mountpoint_bound(
                session, session_identity, session_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
        binding = runtime._SessionBinding(
            private,
            session,
            private_descriptor,
            session_descriptor,
            private_identity,
            session_identity,
            mount_identity,
        )
        return binding
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("private session changed") from None
    finally:
        if binding is None:
            if session_descriptor is not None:
                runtime.os.close(session_descriptor)
            if private_descriptor is not None:
                runtime.os.close(private_descriptor)


def _open_private_binding(
    candidate_argument: Path, *, _runtime: Any | None = None
) -> _PrivateBinding:
    runtime = _resolve_runtime(_runtime)
    candidate = runtime.Path(runtime.os.path.abspath(candidate_argument))
    if candidate.name != "candidate":
        raise PromotionError("unsafe candidate path")
    session_binding = runtime._open_session_binding(candidate.parent)
    candidate_descriptor = None
    binding = None
    try:
        candidate_identity = runtime.os.stat(
            candidate.name,
            dir_fd=session_binding.session_descriptor,
            follow_symlinks=False,
        )
        candidate_descriptor = runtime.os.open(
            candidate.name,
            runtime.os.O_RDONLY | runtime.os.O_DIRECTORY | runtime.os.O_NOFOLLOW,
            dir_fd=session_binding.session_descriptor,
        )
        if not runtime._same_identity(
            candidate_identity, runtime.os.fstat(candidate_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(candidate_identity)
        if (
            candidate_identity.st_dev != session_binding.session_identity.st_dev
            or runtime._descriptor_mount_identity(candidate_descriptor)
            != session_binding.mount_identity
            or runtime._darwin_mountpoint_bound(
                candidate, candidate_identity, candidate_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
        binding = runtime._PrivateBinding(
            session_binding.private,
            session_binding.session,
            session_binding.private_descriptor,
            session_binding.session_descriptor,
            session_binding.private_identity,
            session_binding.session_identity,
            session_binding.mount_identity,
            candidate,
            candidate_descriptor,
            candidate_identity,
        )
        return binding
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("private session changed") from None
    finally:
        if binding is None:
            if candidate_descriptor is not None:
                runtime.os.close(candidate_descriptor)
            session_binding.close()


def _assert_session_binding(
    binding: _SessionBinding, *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        if not runtime._same_identity(binding.private_identity, binding.private.lstat()):
            raise PromotionError("private session changed")
        if not runtime._same_identity(
            binding.private_identity, runtime.os.fstat(binding.private_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(runtime.os.fstat(binding.private_descriptor))
        if (
            runtime._descriptor_mount_identity(binding.private_descriptor)
            != binding.mount_identity
        ):
            raise PromotionError("unsafe mount boundary")
        named_session = runtime.os.stat(
            binding.session.name,
            dir_fd=binding.private_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_identity(
            binding.session_identity, named_session
        ) or not runtime._same_identity(
            binding.session_identity, runtime.os.fstat(binding.session_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(runtime.os.fstat(binding.session_descriptor))
        if (
            runtime._descriptor_mount_identity(binding.session_descriptor)
            != binding.mount_identity
            or runtime._darwin_mountpoint_bound(
                binding.session, named_session, binding.session_descriptor
            )
        ):
            raise PromotionError("unsafe mount boundary")
    except PromotionError:
        raise
    except OSError:
        raise PromotionError("private session changed") from None


def _assert_private_binding(
    binding: _PrivateBinding, *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    runtime._assert_session_binding(binding)
    try:
        named_candidate = runtime.os.stat(
            binding.candidate.name,
            dir_fd=binding.session_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_identity(
            binding.candidate_identity, named_candidate
        ) or not runtime._same_identity(
            binding.candidate_identity, runtime.os.fstat(binding.candidate_descriptor)
        ):
            raise PromotionError("private session changed")
        runtime._require_private_permissions(
            runtime.os.fstat(binding.candidate_descriptor)
        )
        if (
            runtime._descriptor_mount_identity(binding.candidate_descriptor)
            != binding.mount_identity
            or runtime._darwin_mountpoint_bound(
                binding.session / binding.candidate.name,
                named_candidate,
                binding.candidate_descriptor,
            )
        ):
            raise PromotionError("unsafe mount boundary")
    except OSError:
        raise PromotionError("private session changed") from None


def _atomic_write_at(
    directory_descriptor: int,
    name: str,
    content: bytes,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    temporary = f".{name}.{runtime.secrets.token_hex(8)}.tmp"
    descriptor = None
    try:
        descriptor = runtime.os.open(
            temporary,
            runtime.os.O_WRONLY
            | runtime.os.O_CREAT
            | runtime.os.O_EXCL
            | runtime.os.O_NOFOLLOW,
            0o600,
            dir_fd=directory_descriptor,
        )
        view = memoryview(content)
        while view:
            written = runtime.os.write(descriptor, view)
            view = view[written:]
        runtime.os.fsync(descriptor)
        runtime.os.close(descriptor)
        descriptor = None
        runtime.os.replace(
            temporary,
            name,
            src_dir_fd=directory_descriptor,
            dst_dir_fd=directory_descriptor,
        )
        runtime.os.fsync(directory_descriptor)
    except OSError:
        if descriptor is not None:
            runtime.os.close(descriptor)
        try:
            runtime.os.unlink(temporary, dir_fd=directory_descriptor)
        except OSError:
            pass
        raise PromotionError("candidate write failed") from None
