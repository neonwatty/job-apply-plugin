"""Validated, descriptor-retaining storage for dedicated QA profiles."""

import errno
import json
import os
import re
import secrets
import stat
import sys


PROFILE_RE = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
DIR_MODE = 0o700
FILE_MODE = 0o600
STARTUP_TIMEOUT = 8.0
REQUEST_TIMEOUT = 1.0
SHUTDOWN_TIMEOUT = 4.0
MAX_BODY = 4096
MAX_CONTROL_CONNECTIONS = 8
ORIGIN = "qa-chrome://local"
ROOT_NAME = ".job-apply-qa"


class UserError(Exception):
    pass


class Ambiguous(UserError):
    pass


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


def fail(message, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    raise runtime.UserError(message)


def emit(payload, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    runtime.sys.stdout.write(
        runtime.json.dumps(payload, separators=(",", ":"), sort_keys=True) + "\n"
    )


def validate_profile(value, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    if not isinstance(value, str) or not runtime.PROFILE_RE.fullmatch(value):
        runtime.fail("invalid profile identifier")
    return value


def _identity(st):
    return st.st_dev, st.st_ino


def _entry_stat(parent_fd, name, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    return runtime.os.stat(name, dir_fd=parent_fd, follow_symlinks=False)


def _entry_absent(parent_fd, name, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    try:
        runtime._entry_stat(parent_fd, name)
        return False
    except FileNotFoundError:
        return True


def _validate_dir_stat(st, device, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    return (
        runtime.stat.S_ISDIR(st.st_mode)
        and st.st_uid == runtime.os.getuid()
        and runtime.stat.S_IMODE(st.st_mode) == runtime.DIR_MODE
        and st.st_dev == device
    )


def _open_child_dir(parent_fd, name, device, create=False, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    if create:
        try:
            runtime.os.mkdir(name, runtime.DIR_MODE, dir_fd=parent_fd)
        except FileExistsError:
            pass
        except OSError:
            runtime.fail("managed storage is unsafe")
    fd = None
    try:
        before = runtime._entry_stat(parent_fd, name)
        fd = runtime.os.open(
            name,
            runtime.os.O_RDONLY
            | getattr(runtime.os, "O_DIRECTORY", 0)
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            dir_fd=parent_fd,
        )
        opened = runtime.os.fstat(fd)
        current = runtime._entry_stat(parent_fd, name)
        if (
            not runtime._validate_dir_stat(before, device)
            or not runtime._validate_dir_stat(opened, device)
            or runtime._identity(before) != runtime._identity(opened)
            or runtime._identity(current) != runtime._identity(opened)
        ):
            raise OSError(errno.EPERM, "unsafe")
        return fd, opened
    except OSError:
        if fd is not None:
            runtime.os.close(fd)
        runtime.fail("managed storage is unsafe")


def _open_home(*, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    path = runtime.os.path.abspath(runtime.os.path.expanduser("~"))
    fd = None
    try:
        before = runtime.os.lstat(path)
        fd = runtime.os.open(
            path,
            runtime.os.O_RDONLY
            | getattr(runtime.os, "O_DIRECTORY", 0)
            | getattr(runtime.os, "O_NOFOLLOW", 0),
        )
        opened = runtime.os.fstat(fd)
        current = runtime.os.lstat(path)
        if (
            not runtime.stat.S_ISDIR(before.st_mode)
            or before.st_uid != runtime.os.getuid()
            or runtime._identity(before) != runtime._identity(opened)
            or runtime._identity(current) != runtime._identity(opened)
        ):
            raise OSError(errno.EPERM, "unsafe")
        return fd, opened, path
    except OSError:
        if fd is not None:
            runtime.os.close(fd)
        runtime.fail("managed storage is unsafe")


class BoundPaths:
    """Open, retained descriptors for every managed ancestor used by one command."""

    def __init__(self, profile, create_base=False, create_profile=False):
        self.name = profile
        self.home_fd, self.home_st, self.home_path = _open_home()
        self.root_fd = self.profiles_fd = self.runtime_root_fd = None
        self.profile_fd = self.runtime_fd = None
        try:
            self.root_fd, self.root_st = _open_child_dir(
                self.home_fd, ROOT_NAME, self.home_st.st_dev, create=create_base
            )
            self.profiles_fd, self.profiles_st = _open_child_dir(
                self.root_fd, "chrome-profiles", self.root_st.st_dev,
                create=create_base,
            )
            self.runtime_root_fd, self.runtime_root_st = _open_child_dir(
                self.root_fd, "runtime", self.root_st.st_dev, create=create_base
            )
            if create_profile or not _entry_absent(self.profiles_fd, profile):
                self.profile_fd, self.profile_st = _open_child_dir(
                    self.profiles_fd, profile, self.root_st.st_dev,
                    create=create_profile,
                )
            if not _entry_absent(self.runtime_root_fd, profile):
                self.runtime_fd, self.runtime_st = _open_child_dir(
                    self.runtime_root_fd, profile, self.root_st.st_dev
                )
        except BaseException:
            self.close()
            raise

    @classmethod
    def existing(cls, profile):
        home_fd, _home_st, _home_path = _open_home()
        try:
            absent = _entry_absent(home_fd, ROOT_NAME)
        finally:
            os.close(home_fd)
        if absent:
            return None
        return cls(profile)

    @property
    def profile_path(self):
        return os.path.join(
            self.home_path, ROOT_NAME, "chrome-profiles", self.name
        )

    def revalidate(self):
        pairs = [
            (self.home_fd, ROOT_NAME, self.root_fd),
            (self.root_fd, "chrome-profiles", self.profiles_fd),
            (self.root_fd, "runtime", self.runtime_root_fd),
        ]
        if self.profile_fd is not None:
            pairs.append((self.profiles_fd, self.name, self.profile_fd))
        if self.runtime_fd is not None:
            pairs.append((self.runtime_root_fd, self.name, self.runtime_fd))
        try:
            for parent_fd, name, child_fd in pairs:
                if _identity(_entry_stat(parent_fd, name)) != _identity(
                    os.fstat(child_fd)
                ):
                    raise OSError(errno.EPERM, "changed")
        except OSError:
            raise Ambiguous("profile state is ambiguous")

    def create_runtime(self):
        if self.runtime_fd is not None or not _entry_absent(
            self.runtime_root_fd, self.name
        ):
            raise Ambiguous("profile state is ambiguous")
        try:
            os.mkdir(self.name, DIR_MODE, dir_fd=self.runtime_root_fd)
        except OSError:
            raise Ambiguous("profile state is ambiguous")
        self.runtime_fd, self.runtime_st = _open_child_dir(
            self.runtime_root_fd, self.name, self.root_st.st_dev
        )

    def close(self):
        attributes = (
            "runtime_fd",
            "profile_fd",
            "runtime_root_fd",
            "profiles_fd",
            "root_fd",
            "home_fd",
        )
        for attr in attributes:
            fd = getattr(self, attr, None)
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
                setattr(self, attr, None)


def _safe_regular(dir_fd, name, device, max_bytes=MAX_BODY, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    fd = None
    try:
        before = runtime._entry_stat(dir_fd, name)
        fd = runtime.os.open(
            name,
            runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0),
            dir_fd=dir_fd,
        )
        opened = runtime.os.fstat(fd)
        current = runtime._entry_stat(dir_fd, name)
        for value in (before, opened, current):
            if (
                not runtime.stat.S_ISREG(value.st_mode)
                or value.st_uid != runtime.os.getuid()
                or runtime.stat.S_IMODE(value.st_mode) != runtime.FILE_MODE
                or value.st_dev != device
                or value.st_size > max_bytes
                or value.st_nlink != 1
            ):
                raise OSError(errno.EPERM, "unsafe")
        if (
            runtime._identity(before) != runtime._identity(opened)
            or runtime._identity(current) != runtime._identity(opened)
        ):
            raise OSError(errno.EPERM, "changed")
        data = runtime.os.read(fd, max_bytes + 1)
        final = runtime.os.fstat(fd)
        if (
            runtime._identity(final) != runtime._identity(opened)
            or final.st_size != opened.st_size
            or runtime.stat.S_IMODE(final.st_mode) != runtime.FILE_MODE
            or final.st_uid != runtime.os.getuid()
            or final.st_dev != device
        ):
            raise OSError(errno.EPERM, "changed")
        return data
    except OSError:
        raise Ambiguous("profile state is ambiguous")
    finally:
        if fd is not None:
            runtime.os.close(fd)


def _read_json(paths, name, keys, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    if paths.runtime_fd is None:
        raise Ambiguous("profile state is ambiguous")
    paths.revalidate()
    try:
        value = runtime.json.loads(
            runtime._safe_regular(
                paths.runtime_fd, name, paths.runtime_st.st_dev
            ).decode("utf-8")
        )
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise Ambiguous("profile state is ambiguous")
    if not isinstance(value, dict) or set(value) != set(keys):
        raise Ambiguous("profile state is ambiguous")
    return value


def _atomic_json(paths, name, value, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    paths.revalidate()
    payload = runtime.json.dumps(
        value, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    temp = "." + name + "." + runtime.secrets.token_hex(8)
    fd = None
    try:
        fd = runtime.os.open(
            temp,
            runtime.os.O_WRONLY
            | runtime.os.O_CREAT
            | runtime.os.O_EXCL
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            runtime.FILE_MODE,
            dir_fd=paths.runtime_fd,
        )
        runtime.os.write(fd, payload)
        runtime.os.fsync(fd)
        created = runtime.os.fstat(fd)
        runtime.os.close(fd)
        fd = None
        runtime.os.link(
            temp,
            name,
            src_dir_fd=paths.runtime_fd,
            dst_dir_fd=paths.runtime_fd,
            follow_symlinks=False,
        )
        runtime.os.unlink(temp, dir_fd=paths.runtime_fd)
        runtime.os.fsync(paths.runtime_fd)
        published = runtime._entry_stat(paths.runtime_fd, name)
        if (
            runtime._identity(created) != runtime._identity(published)
            or published.st_nlink != 1
        ):
            raise OSError(errno.EPERM, "publication")
        paths.revalidate()
        return runtime._identity(published)
    except OSError:
        raise Ambiguous("profile state is ambiguous")
    finally:
        if fd is not None:
            runtime.os.close(fd)
        try:
            runtime.os.unlink(temp, dir_fd=paths.runtime_fd)
        except OSError:
            pass
