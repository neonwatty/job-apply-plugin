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


def exclusive_rename_available() -> bool:
    """Return whether this runtime can atomically rename without replacement."""

    return _EXCLUSIVE_RENAME is not None
