"""Exact per-profile owner locks and runtime identity markers."""

import errno
import fcntl
import json
import os
import stat
import sys

from .paths import (
    Ambiguous,
    FILE_MODE,
    _entry_stat,
    _identity,
)


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


def _owner_name(profile, *, _runtime=None):
    return ".job-apply-qa-owner-" + profile


def _ownership_name(profile, *, _runtime=None):
    return ".ownership-" + profile + ".lock"


def _open_owner(paths, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    ownership_fd = None
    owner_fd = None
    name = runtime._owner_name(paths.name)
    ownership_name = runtime._ownership_name(paths.name)
    try:
        flags = runtime.os.O_RDWR | getattr(runtime.os, "O_NOFOLLOW", 0)
        try:
            ownership_fd = runtime.os.open(
                ownership_name, flags, dir_fd=paths.root_fd
            )
        except FileNotFoundError:
            try:
                ownership_fd = runtime.os.open(
                    ownership_name,
                    flags | runtime.os.O_CREAT | runtime.os.O_EXCL,
                    runtime.FILE_MODE,
                    dir_fd=paths.root_fd,
                )
            except FileExistsError:
                ownership_fd = runtime.os.open(
                    ownership_name, flags, dir_fd=paths.root_fd
                )
        ownership = runtime.os.fstat(ownership_fd)
        ownership_current = runtime._entry_stat(paths.root_fd, ownership_name)
        if (
            not runtime.stat.S_ISREG(ownership.st_mode)
            or ownership.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(ownership.st_mode) != runtime.FILE_MODE
            or ownership.st_dev != paths.root_st.st_dev
            or ownership.st_nlink != 1
            or runtime._identity(ownership)
            != runtime._identity(ownership_current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        # This lock lives in the stable managed root rather than any owner,
        # profile, or runtime entry that an attacker can replace together.
        runtime.fcntl.flock(
            ownership_fd, runtime.fcntl.LOCK_EX | runtime.fcntl.LOCK_NB
        )
        flags = runtime.os.O_RDWR | getattr(runtime.os, "O_NOFOLLOW", 0)
        try:
            owner_fd = runtime.os.open(name, flags, dir_fd=paths.home_fd)
        except FileNotFoundError:
            try:
                owner_fd = runtime.os.open(
                    name,
                    flags | runtime.os.O_CREAT | runtime.os.O_EXCL,
                    runtime.FILE_MODE,
                    dir_fd=paths.home_fd,
                )
            except FileExistsError:
                owner_fd = runtime.os.open(name, flags, dir_fd=paths.home_fd)
        before = runtime.os.fstat(owner_fd)
        current = runtime._entry_stat(paths.home_fd, name)
        if (
            not runtime.stat.S_ISREG(before.st_mode)
            or before.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(before.st_mode) != runtime.FILE_MODE
            or before.st_dev != paths.home_st.st_dev
            or before.st_nlink != 1
            or runtime._identity(before) != runtime._identity(current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        # The home directory is the trusted descriptor above the replaceable
        # managed root. Retain this lock for the supervisor's full lifetime so
        # replacing the root cannot create a second per-profile owner.
        runtime.fcntl.flock(
            owner_fd, runtime.fcntl.LOCK_EX | runtime.fcntl.LOCK_NB
        )
        return ownership_fd, owner_fd
    except BlockingIOError:
        if owner_fd is not None:
            runtime.os.close(owner_fd)
        if ownership_fd is not None:
            runtime.os.close(ownership_fd)
        return None
    except OSError:
        if owner_fd is not None:
            runtime.os.close(owner_fd)
        if ownership_fd is not None:
            runtime.os.close(ownership_fd)
        raise runtime.Ambiguous("profile state is ambiguous")


def _observe_owner(paths, *, _runtime=None):
    """Observe complete per-profile ownership without creating or changing it."""
    runtime = _resolve_runtime(_runtime)
    ownership_fd = None
    owner_fd = None
    try:
        flags = runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0)
        ownership_name = runtime._ownership_name(paths.name)
        ownership_fd = runtime.os.open(
            ownership_name, flags, dir_fd=paths.root_fd
        )
        ownership = runtime.os.fstat(ownership_fd)
        ownership_current = runtime._entry_stat(paths.root_fd, ownership_name)
        if (
            not runtime.stat.S_ISREG(ownership.st_mode)
            or ownership.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(ownership.st_mode) != runtime.FILE_MODE
            or ownership.st_dev != paths.root_st.st_dev
            or ownership.st_nlink != 1
            or runtime._identity(ownership)
            != runtime._identity(ownership_current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        runtime.fcntl.flock(
            ownership_fd, runtime.fcntl.LOCK_EX | runtime.fcntl.LOCK_NB
        )

        owner_name = runtime._owner_name(paths.name)
        owner_fd = runtime.os.open(owner_name, flags, dir_fd=paths.home_fd)
        owner = runtime.os.fstat(owner_fd)
        owner_current = runtime._entry_stat(paths.home_fd, owner_name)
        if (
            not runtime.stat.S_ISREG(owner.st_mode)
            or owner.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(owner.st_mode) != runtime.FILE_MODE
            or owner.st_dev != paths.home_st.st_dev
            or owner.st_nlink != 1
            or runtime._identity(owner) != runtime._identity(owner_current)
        ):
            raise OSError(errno.EPERM, "unsafe")
        runtime.fcntl.flock(
            owner_fd, runtime.fcntl.LOCK_EX | runtime.fcntl.LOCK_NB
        )
        return ownership_fd, owner_fd
    except BlockingIOError:
        if owner_fd is not None:
            runtime.os.close(owner_fd)
        if ownership_fd is not None:
            runtime.os.close(ownership_fd)
        return None
    except OSError:
        if owner_fd is not None:
            runtime.os.close(owner_fd)
        if ownership_fd is not None:
            runtime.os.close(ownership_fd)
        raise runtime.Ambiguous("profile state is ambiguous")


def _write_owner_runtime(owner_fd, runtime_st, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    payload = runtime.json.dumps(
        {"device": runtime_st.st_dev, "inode": runtime_st.st_ino},
        separators=(",", ":"),
    ).encode("ascii")
    runtime.os.pwrite(owner_fd, payload, 0)
    runtime.os.ftruncate(owner_fd, len(payload))
    runtime.os.fsync(owner_fd)


def _owner_matches_runtime(paths, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    fd = None
    try:
        name = runtime._owner_name(paths.name)
        before = runtime._entry_stat(paths.home_fd, name)
        fd = runtime.os.open(
            name,
            runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0),
            dir_fd=paths.home_fd,
        )
        opened = runtime.os.fstat(fd)
        if (
            not runtime.stat.S_ISREG(opened.st_mode)
            or opened.st_uid != runtime.os.getuid()
            or runtime.stat.S_IMODE(opened.st_mode) != runtime.FILE_MODE
            or opened.st_dev != paths.home_st.st_dev
            or opened.st_nlink != 1
            or runtime._identity(before) != runtime._identity(opened)
            or opened.st_size > 128
            or paths.runtime_fd is None
        ):
            return False
        if opened.st_size == 0:
            return None
        value = runtime.json.loads(runtime.os.read(fd, 129).decode("ascii"))
        return value == {
            "device": paths.runtime_st.st_dev,
            "inode": paths.runtime_st.st_ino,
        }
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    except OSError:
        return False
    finally:
        if fd is not None:
            runtime.os.close(fd)
