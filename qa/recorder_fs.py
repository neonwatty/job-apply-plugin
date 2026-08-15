from __future__ import annotations

import argparse
import base64
import binascii
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import select
import signal
import stat
import sys
from typing import Any, Callable


MAX_REQUEST_BYTES = 16 * 1024 * 1024
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_SESSION_BYTES = 64 * 1024 * 1024
MAX_PATH_BYTES = 512
MAX_SEGMENT_BYTES = 128
MAX_DEPTH = 8
MAX_ENTRIES = 4_096
_SEGMENT = re.compile(r"^[A-Za-z0-9_.-]+$")
_CHECKPOINT = re.compile(
    r"^[0-9]{4}-(?:application-opened|step-advanced|validation-observed|review-reached|final-action-boundary)$"
)
_CHECKPOINT_FILES = {"checkpoint.json", "controls.json", "page.html", "page.png"}
_DIRECTORY_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC
_FILE_WRITE_FLAGS = os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC


class BrokerError(Exception):
    """A stable, value-free broker rejection."""


def _load_exclusive_rename() -> Callable[[int, bytes, int, bytes], int] | None:
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "darwin":
        function = getattr(libc, "renameatx_np", None)
        if function is None:
            return None
        function.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        function.restype = ctypes.c_int

        def call(src_fd: int, src: bytes, dst_fd: int, dst: bytes) -> int:
            if function(src_fd, src, dst_fd, dst, 0x00000004) == 0:
                return 0
            return ctypes.get_errno()

        return call
    if sys.platform.startswith("linux"):
        function = getattr(libc, "renameat2", None)
        if function is None:
            return None
        function.argtypes = [
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_int,
            ctypes.c_char_p,
            ctypes.c_uint,
        ]
        function.restype = ctypes.c_int

        def call(src_fd: int, src: bytes, dst_fd: int, dst: bytes) -> int:
            if function(src_fd, src, dst_fd, dst, 1) == 0:
                return 0
            return ctypes.get_errno()

        return call
    return None


_EXCLUSIVE_RENAME = _load_exclusive_rename()


def _exclusive_rename_raw(
    src_dir_fd: int,
    src_name: bytes,
    dst_dir_fd: int,
    dst_name: bytes,
) -> int:
    if _EXCLUSIVE_RENAME is None:
        return errno.ENOSYS
    return _EXCLUSIVE_RENAME(src_dir_fd, src_name, dst_dir_fd, dst_name)


def _direct_name(name: str) -> bytes:
    if (
        not isinstance(name, str)
        or name in {"", ".", ".."}
        or not _SEGMENT.fullmatch(name)
        or len(name.encode("utf-8")) > MAX_SEGMENT_BYTES
    ):
        raise BrokerError("unsafe-path")
    return name.encode("utf-8")


def exclusive_rename(
    src_dir_fd: int,
    src_name: str,
    dst_dir_fd: int,
    dst_name: str,
) -> None:
    source = _direct_name(src_name)
    destination = _direct_name(dst_name)
    result = _exclusive_rename_raw(src_dir_fd, source, dst_dir_fd, destination)
    if result == 0:
        return
    if result == errno.EEXIST:
        raise BrokerError("destination-exists")
    if result == errno.ENOSYS:
        raise BrokerError("exclusive-rename-unsupported")
    raise BrokerError("rename-failed")


def _parts(relative: str, *, allow_root: bool = False) -> tuple[str, ...]:
    if not isinstance(relative, str) or "\\" in relative or "\x00" in relative:
        raise BrokerError("unsafe-path")
    if len(relative.encode("utf-8")) > MAX_PATH_BYTES:
        raise BrokerError("unsafe-path")
    if allow_root and relative == "":
        return ()
    parts = tuple(relative.split("/"))
    if (
        not parts
        or relative.startswith("/")
        or len(parts) > MAX_DEPTH
        or any(part in {"", ".", ".."} or not _SEGMENT.fullmatch(part) for part in parts)
        or any(len(part.encode("utf-8")) > MAX_SEGMENT_BYTES for part in parts)
    ):
        raise BrokerError("unsafe-path")
    return tuple(parts)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise BrokerError("write-failed")
        view = view[written:]


class SessionBroker:
    def __init__(self, root: str):
        self.max_file_bytes = MAX_FILE_BYTES
        self.max_session_bytes = MAX_SESSION_BYTES
        self._closed = False
        root_path = Path(root)
        if not root_path.is_absolute() or root_path.parent.name != ".qa-private":
            raise BrokerError("unsafe-root")
        root_name = root_path.name
        _direct_name(root_name)
        parent_flags = _DIRECTORY_FLAGS
        try:
            self._parent_fd = os.open(str(root_path.parent), parent_flags)
        except OSError:
            raise BrokerError("unsafe-root") from None
        try:
            parent_stat = os.fstat(self._parent_fd)
            if (
                not stat.S_ISDIR(parent_stat.st_mode)
                or parent_stat.st_uid != os.getuid()
                or parent_stat.st_mode & 0o777 != 0o700
            ):
                raise BrokerError("unsafe-root")
            try:
                os.mkdir(root_name, 0o700, dir_fd=self._parent_fd)
            except FileExistsError:
                pass
            try:
                self._root_fd = os.open(root_name, _DIRECTORY_FLAGS, dir_fd=self._parent_fd)
            except OSError:
                raise BrokerError("unsafe-root") from None
            root_stat = os.fstat(self._root_fd)
            if (
                not stat.S_ISDIR(root_stat.st_mode)
                or root_stat.st_uid != os.getuid()
                or root_stat.st_mode & 0o777 != 0o700
            ):
                raise BrokerError("unsafe-root")
            self._parent_identity = (parent_stat.st_dev, parent_stat.st_ino)
            self._root_identity = (root_stat.st_dev, root_stat.st_ino)
        except Exception:
            if hasattr(self, "_root_fd"):
                os.close(self._root_fd)
            os.close(self._parent_fd)
            raise

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        os.close(self._root_fd)
        os.close(self._parent_fd)

    def _ensure_open(self) -> None:
        if self._closed:
            raise BrokerError("broker-closed")
        current_parent = os.fstat(self._parent_fd)
        current_root = os.fstat(self._root_fd)
        if (
            (current_parent.st_dev, current_parent.st_ino) != self._parent_identity
            or (current_root.st_dev, current_root.st_ino) != self._root_identity
            or current_parent.st_uid != os.getuid()
            or current_root.st_uid != os.getuid()
            or current_parent.st_mode & 0o077
            or current_root.st_mode & 0o777 != 0o700
        ):
            raise BrokerError("root-changed")

    def _open_directory(self, parts: tuple[str, ...]) -> int:
        self._ensure_open()
        current = os.dup(self._root_fd)
        try:
            for part in parts:
                next_fd = os.open(part, _DIRECTORY_FLAGS, dir_fd=current)
                os.close(current)
                current = next_fd
            return current
        except OSError:
            os.close(current)
            raise BrokerError("unsafe-path") from None

    def _parent_and_name(self, relative: str) -> tuple[int, str]:
        parts = _parts(relative)
        return self._open_directory(parts[:-1]), parts[-1]

    def mkdir(self, relative: str) -> None:
        parts = _parts(relative)
        parent = self._open_directory(parts[:-1])
        try:
            os.mkdir(parts[-1], 0o700, dir_fd=parent)
            opened = os.open(parts[-1], _DIRECTORY_FLAGS, dir_fd=parent)
            try:
                created = os.fstat(opened)
                if not stat.S_ISDIR(created.st_mode) or created.st_mode & 0o777 != 0o700:
                    raise BrokerError("unsafe-path")
            finally:
                os.close(opened)
        except FileExistsError:
            raise BrokerError("destination-exists") from None
        except OSError:
            raise BrokerError("mkdir-failed") from None
        finally:
            os.close(parent)

    def _session_usage(self) -> tuple[int, int]:
        count = 0
        total = 0

        def walk(directory_fd: int, depth: int) -> None:
            nonlocal count, total
            if depth > MAX_DEPTH:
                raise BrokerError("session-budget")
            try:
                names = os.listdir(directory_fd)
            except OSError:
                raise BrokerError("unsafe-path") from None
            for name in names:
                count += 1
                if count > MAX_ENTRIES:
                    raise BrokerError("session-budget")
                info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    child = os.open(name, _DIRECTORY_FLAGS, dir_fd=directory_fd)
                    try:
                        walk(child, depth + 1)
                    finally:
                        os.close(child)
                elif stat.S_ISREG(info.st_mode):
                    total += info.st_size
                else:
                    raise BrokerError("unsafe-path")

        walk(self._root_fd, 0)
        return count, total

    def _check_budget(self, data_size: int, *, replaced_size: int = 0) -> None:
        if data_size > self.max_file_bytes:
            raise BrokerError("file-budget")
        _, total = self._session_usage()
        if total - replaced_size + data_size > self.max_session_bytes:
            raise BrokerError("session-budget")

    def write_exclusive(self, relative: str, data: bytes) -> None:
        self._check_budget(len(data))
        parent, name = self._parent_and_name(relative)
        fd = None
        try:
            fd = os.open(
                name,
                _FILE_WRITE_FLAGS | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=parent,
            )
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o777 != 0o600:
                raise BrokerError("unsafe-path")
            _write_all(fd, data)
            os.fsync(fd)
        except FileExistsError:
            raise BrokerError("destination-exists") from None
        except OSError:
            raise BrokerError("write-failed") from None
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent)

    def append(self, relative: str, data: bytes) -> None:
        parent, name = self._parent_and_name(relative)
        fd = None
        try:
            fd = os.open(name, _FILE_WRITE_FLAGS | os.O_APPEND, dir_fd=parent)
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode):
                raise BrokerError("unsafe-path")
            self._check_budget(info.st_size + len(data), replaced_size=info.st_size)
            _write_all(fd, data)
        except OSError:
            raise BrokerError("write-failed") from None
        finally:
            if fd is not None:
                os.close(fd)
            os.close(parent)

    def atomic_replace(self, relative: str, data: bytes) -> None:
        parent, name = self._parent_and_name(relative)
        replaced_size = 0
        try:
            try:
                existing = os.stat(name, dir_fd=parent, follow_symlinks=False)
                if not stat.S_ISREG(existing.st_mode):
                    raise BrokerError("unsafe-path")
                replaced_size = existing.st_size
            except FileNotFoundError:
                pass
            self._check_budget(len(data), replaced_size=replaced_size)
            temporary = f".tmp-write-{os.urandom(16).hex()}"
            fd = os.open(
                temporary,
                _FILE_WRITE_FLAGS | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=parent,
            )
            try:
                _write_all(fd, data)
                os.fsync(fd)
            finally:
                os.close(fd)
            try:
                os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
            except OSError:
                os.unlink(temporary, dir_fd=parent)
                raise
        except BrokerError:
            raise
        except OSError:
            raise BrokerError("write-failed") from None
        finally:
            os.close(parent)

    def rename_no_replace(self, source: str, destination: str) -> None:
        src_parts = _parts(source)
        dst_parts = _parts(destination)
        src_parent = self._open_directory(src_parts[:-1])
        dst_parent = self._open_directory(dst_parts[:-1])
        try:
            exclusive_rename(src_parent, src_parts[-1], dst_parent, dst_parts[-1])
        finally:
            os.close(src_parent)
            os.close(dst_parent)

    def _remove_contents(self, directory_fd: int, depth: int) -> None:
        if depth > MAX_DEPTH:
            raise BrokerError("unsafe-path")
        for name in os.listdir(directory_fd):
            info = os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            if stat.S_ISDIR(info.st_mode):
                child = os.open(name, _DIRECTORY_FLAGS, dir_fd=directory_fd)
                try:
                    self._remove_contents(child, depth + 1)
                finally:
                    os.close(child)
                os.rmdir(name, dir_fd=directory_fd)
            elif stat.S_ISREG(info.st_mode):
                os.unlink(name, dir_fd=directory_fd)
            else:
                raise BrokerError("unsafe-path")

    def remove_tree(self, relative: str) -> None:
        parts = _parts(relative)
        parent = self._open_directory(parts[:-1])
        try:
            info = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if stat.S_ISREG(info.st_mode):
                os.unlink(parts[-1], dir_fd=parent)
                return
            if not stat.S_ISDIR(info.st_mode):
                raise BrokerError("unsafe-path")
            child = os.open(parts[-1], _DIRECTORY_FLAGS, dir_fd=parent)
            try:
                self._remove_contents(child, 1)
            finally:
                os.close(child)
            os.rmdir(parts[-1], dir_fd=parent)
        except FileNotFoundError:
            return
        except BrokerError:
            raise
        except OSError:
            raise BrokerError("remove-failed") from None
        finally:
            os.close(parent)

    def _hash_file(self, directory_fd: int, name: str) -> str:
        fd = os.open(name, _FILE_READ_FLAGS, dir_fd=directory_fd)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_size > self.max_file_bytes:
                raise BrokerError("file-budget")
            digest = hashlib.sha256()
            while True:
                chunk = os.read(fd, 64 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
            return digest.hexdigest()
        finally:
            os.close(fd)

    def hash_source_files(self) -> dict[str, str]:
        self._session_usage()
        result: dict[str, str] = {}
        for name in ("events.jsonl", "recording-summary.json"):
            try:
                result[name] = self._hash_file(self._root_fd, name)
            except FileNotFoundError:
                continue
        try:
            checkpoints = os.open("checkpoints", _DIRECTORY_FLAGS, dir_fd=self._root_fd)
        except FileNotFoundError:
            return result
        try:
            for checkpoint in sorted(os.listdir(checkpoints)):
                if checkpoint.startswith(".tmp-"):
                    continue
                if not _CHECKPOINT.fullmatch(checkpoint):
                    raise BrokerError("unsafe-path")
                checkpoint_fd = os.open(checkpoint, _DIRECTORY_FLAGS, dir_fd=checkpoints)
                try:
                    filenames = set(os.listdir(checkpoint_fd))
                    if filenames != _CHECKPOINT_FILES:
                        raise BrokerError("unsafe-path")
                    for filename in sorted(filenames):
                        _direct_name(filename)
                        info = os.stat(filename, dir_fd=checkpoint_fd, follow_symlinks=False)
                        if not stat.S_ISREG(info.st_mode):
                            raise BrokerError("unsafe-path")
                        relative = f"checkpoints/{checkpoint}/{filename}"
                        result[relative] = self._hash_file(checkpoint_fd, filename)
                finally:
                    os.close(checkpoint_fd)
        finally:
            os.close(checkpoints)
        return result

    def list_path(self, relative: str = "") -> list[str]:
        directory = self._open_directory(_parts(relative, allow_root=True))
        try:
            return sorted(os.listdir(directory))
        finally:
            os.close(directory)

    def budget(self) -> dict[str, int]:
        count, total = self._session_usage()
        return {"entries": count, "bytes": total}


_COMMAND_KEYS = {
    "mkdir": {"id", "command", "path"},
    "write-exclusive": {"id", "command", "path", "data"},
    "atomic-replace": {"id", "command", "path", "data"},
    "append": {"id", "command", "path", "data"},
    "remove-tree": {"id", "command", "path"},
    "rename-no-replace": {"id", "command", "source", "destination"},
    "list": {"id", "command", "path"},
    "hash-source-files": {"id", "command"},
    "stat-budget": {"id", "command"},
}


def _decode_data(value: Any) -> bytes:
    if not isinstance(value, str):
        raise BrokerError("invalid-data")
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        raise BrokerError("invalid-data") from None


def _dispatch(broker: SessionBroker, request: Any) -> Any:
    if not isinstance(request, dict):
        raise BrokerError("invalid-request")
    request_id = request.get("id")
    command = request.get("command")
    if not isinstance(request_id, int) or request_id < 0 or command not in _COMMAND_KEYS:
        raise BrokerError("invalid-request")
    if set(request) != _COMMAND_KEYS[command]:
        raise BrokerError("invalid-request")
    if command == "mkdir":
        broker.mkdir(request["path"])
    elif command == "write-exclusive":
        broker.write_exclusive(request["path"], _decode_data(request["data"]))
    elif command == "atomic-replace":
        broker.atomic_replace(request["path"], _decode_data(request["data"]))
    elif command == "append":
        broker.append(request["path"], _decode_data(request["data"]))
    elif command == "remove-tree":
        broker.remove_tree(request["path"])
    elif command == "rename-no-replace":
        broker.rename_no_replace(request["source"], request["destination"])
    elif command == "list":
        return broker.list_path(request["path"])
    elif command == "hash-source-files":
        return broker.hash_source_files()
    elif command == "stat-budget":
        return broker.budget()
    return None


def _bounded_lines(stream: Any, limit: int = MAX_REQUEST_BYTES):
    while True:
        raw = stream.readline(limit + 1)
        if not raw:
            return
        oversized = len(raw) > limit
        if not raw.endswith(b"\n") and not oversized:
            extra = stream.readline(limit + 1)
            if extra:
                oversized = True
                raw = extra
        if oversized:
            while raw and not raw.endswith(b"\n"):
                raw = stream.readline(limit + 1)
            yield None
        else:
            yield raw


def _cleanup_guardian(root_fd: int, root_identity: tuple[int, int], signal_fd: int) -> None:
    try:
        while os.read(signal_fd, 1):
            pass
    except OSError:
        pass
    try:
        current = os.fstat(root_fd)
        if (
            (current.st_dev, current.st_ino) == root_identity
            and stat.S_ISDIR(current.st_mode)
            and current.st_uid == os.getuid()
            and current.st_mode & 0o777 == 0o700
        ):
            try:
                control = os.stat("control.json", dir_fd=root_fd, follow_symlinks=False)
                if stat.S_ISREG(control.st_mode) or stat.S_ISLNK(control.st_mode):
                    os.unlink("control.json", dir_fd=root_fd)
            except FileNotFoundError:
                pass
    except OSError:
        pass
    finally:
        os.close(signal_fd)
        os.close(root_fd)
    os._exit(0)


def _start_cleanup_guardian(broker: SessionBroker) -> tuple[int, int]:
    if not hasattr(os, "fork"):
        raise BrokerError("cleanup-unsupported")
    read_fd, write_fd = os.pipe()
    ready_read, ready_write = os.pipe()
    try:
        pid = os.fork()
    except OSError:
        os.close(read_fd)
        os.close(write_fd)
        os.close(ready_read)
        os.close(ready_write)
        raise BrokerError("cleanup-unavailable") from None
    if pid == 0:
        os.close(write_fd)
        os.close(ready_read)
        try:
            for guardian_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                signal.signal(guardian_signal, signal.SIG_IGN)
            os.setsid()
            os.write(ready_write, b"1")
        except (OSError, ValueError):
            os._exit(1)
        finally:
            os.close(ready_write)
        os.close(broker._parent_fd)
        for descriptor in (0, 1, 2):
            try:
                os.close(descriptor)
            except OSError:
                pass
        _cleanup_guardian(broker._root_fd, broker._root_identity, read_fd)
    os.close(read_fd)
    os.close(ready_write)
    ready = select.select([ready_read], [], [], 2)[0]
    acknowledged = os.read(ready_read, 1) if ready else b""
    os.close(ready_read)
    if acknowledged != b"1":
        os.close(write_fd)
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        raise BrokerError("cleanup-unavailable")
    return pid, write_fd


def _serve(root: str) -> int:
    try:
        broker = SessionBroker(root)
    except Exception:
        sys.stderr.write("broker startup failed\n")
        return 1
    try:
        guardian_pid, guardian_signal = _start_cleanup_guardian(broker)
    except BrokerError:
        broker.close()
        sys.stderr.write("broker startup failed\n")
        return 1
    shutdown_requested = False

    def request_shutdown(_signum: int, _frame: object) -> None:
        nonlocal shutdown_requested
        if shutdown_requested:
            return
        shutdown_requested = True
        raise KeyboardInterrupt

    previous_handlers = {
        broker_signal: signal.signal(broker_signal, request_shutdown)
        for broker_signal in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP)
    }
    try:
        sys.stdout.write('{"ready":true}\n')
        sys.stdout.flush()
        for raw in _bounded_lines(sys.stdin.buffer):
            if raw is None:
                response = {"id": None, "ok": False, "code": "request-budget"}
            else:
                request_id = None
                try:
                    request = json.loads(raw)
                    if isinstance(request, dict) and isinstance(request.get("id"), int):
                        request_id = request["id"]
                    result = _dispatch(broker, request)
                    response = {"id": request_id, "ok": True, "result": result}
                except BrokerError as error:
                    response = {"id": request_id, "ok": False, "code": str(error)}
                except Exception:
                    response = {"id": request_id, "ok": False, "code": "invalid-request"}
            sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
            sys.stdout.flush()
    except KeyboardInterrupt:
        pass
    finally:
        shutdown_requested = True
        try:
            broker.remove_tree("control.json")
        except BrokerError:
            pass
        broker.close()
        os.close(guardian_signal)
        try:
            os.waitpid(guardian_pid, 0)
        except ChildProcessError:
            pass
        for broker_signal, previous_handler in previous_handlers.items():
            signal.signal(broker_signal, previous_handler)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("--root", required=True)
    try:
        arguments = parser.parse_args()
    except SystemExit:
        return 2
    return _serve(arguments.root)


if __name__ == "__main__":
    raise SystemExit(main())
