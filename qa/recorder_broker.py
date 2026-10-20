"""Descriptor-safe storage operations for one private recorder session."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import stat

from qa.recorder_fs_ops import (
    MAX_DEPTH,
    MAX_ENTRIES,
    MAX_FILE_BYTES,
    MAX_SESSION_BYTES,
    _CHECKPOINT,
    _CHECKPOINT_FILES,
    _DIRECTORY_FLAGS,
    _FILE_READ_FLAGS,
    _FILE_WRITE_FLAGS,
    BrokerError,
    _direct_name,
    _parts,
    _write_all,
    exclusive_rename,
)


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
