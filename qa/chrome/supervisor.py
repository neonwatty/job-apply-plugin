"""Exact launcher-child supervision and bounded child termination."""

import json
import hmac
import os
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys
import time

from .control import ControlHandler, ControlServer
from .discovery import _browser_path_hash, _cdp_browser_path, _probe_cdp
from .owner import _owner_matches_runtime, _ownership_name
from .paths import (
    FILE_MODE,
    MAX_BODY,
    ORIGIN,
    REQUEST_TIMEOUT,
    SHUTDOWN_TIMEOUT,
    STARTUP_TIMEOUT,
    Ambiguous,
    _atomic_json,
    _entry_stat,
    _identity,
    _safe_regular,
)


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


def _read_new_devtools(
    paths, launched_at, child, expected_port, *, _runtime=None
):
    runtime = _resolve_runtime(_runtime)
    deadline = runtime.time.monotonic() + runtime.STARTUP_TIMEOUT
    while runtime.time.monotonic() < deadline:
        if child.poll() is not None:
            break
        browser_path = runtime._cdp_browser_path(expected_port)
        if browser_path is not None:
            return expected_port, browser_path
        try:
            before = runtime._entry_stat(paths.profile_fd, "DevToolsActivePort")
            if (
                runtime.stat.S_ISREG(before.st_mode)
                and before.st_uid == runtime.os.getuid()
                and before.st_dev == paths.profile_st.st_dev
                and before.st_nlink == 1
                and not runtime.stat.S_IMODE(before.st_mode) & 0o022
                and before.st_mtime_ns >= launched_at
                and before.st_size <= 256
            ):
                fd = runtime.os.open(
                    "DevToolsActivePort",
                    runtime.os.O_RDONLY
                    | getattr(runtime.os, "O_NOFOLLOW", 0),
                    dir_fd=paths.profile_fd,
                )
                try:
                    opened = runtime.os.fstat(fd)
                    data = runtime.os.read(fd, 257)
                    final = runtime.os.fstat(fd)
                    current = runtime._entry_stat(
                        paths.profile_fd, "DevToolsActivePort"
                    )
                finally:
                    runtime.os.close(fd)
                values = (opened, current, final)
                if (
                    runtime._identity(before)
                    == runtime._identity(opened)
                    == runtime._identity(current)
                    and all(runtime.stat.S_ISREG(value.st_mode) for value in values)
                    and all(value.st_uid == runtime.os.getuid() for value in values)
                    and all(
                        value.st_dev == paths.profile_st.st_dev for value in values
                    )
                    and all(value.st_nlink == 1 for value in values)
                    and all(
                        not runtime.stat.S_IMODE(value.st_mode) & 0o022
                        for value in values
                    )
                ):
                    lines = data.decode("ascii").splitlines()
                    if (
                        len(lines) == 2
                        and lines[0].isdigit()
                        and runtime.re.fullmatch(
                            r"/devtools/browser/[A-Za-z0-9._-]+", lines[1]
                        )
                    ):
                        port = int(lines[0])
                        if port == expected_port and runtime._probe_cdp(
                            port, browser_path=lines[1]
                        ):
                            return port, lines[1]
        except (OSError, UnicodeDecodeError, ValueError):
            pass
        runtime.time.sleep(0.04)
    return None


def _unlink_identity(dir_fd, name, identity, device, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    if identity is None:
        return True
    try:
        current = runtime._entry_stat(dir_fd, name)
    except FileNotFoundError:
        return True
    if (
        runtime.stat.S_ISREG(current.st_mode)
        and current.st_uid == runtime.os.getuid()
        and runtime.stat.S_IMODE(current.st_mode) == runtime.FILE_MODE
        and current.st_dev == device
        and current.st_nlink == 1
        and runtime._identity(current) == identity
    ):
        runtime.os.unlink(name, dir_fd=dir_fd)
        return True
    return False


def _cleanup_runtime(paths, published, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    try:
        paths.revalidate()
        if not runtime._unlink_identity(
            paths.runtime_fd,
            "state.json",
            published.get("state"),
            paths.runtime_st.st_dev,
        ):
            return
        if not runtime._unlink_identity(
            paths.runtime_fd,
            "control.json",
            published.get("control"),
            paths.runtime_st.st_dev,
        ):
            return
        paths.revalidate()
        runtime.os.rmdir(paths.name, dir_fd=paths.runtime_root_fd)
        runtime.os.fsync(paths.runtime_root_fd)
    except OSError:
        pass


def _terminate_exact_child(child, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    deadline = runtime.time.monotonic() + runtime.SHUTDOWN_TIMEOUT
    if child.poll() is not None:
        child.wait()
        return
    child.terminate()
    try:
        child.wait(timeout=max(0.05, deadline - runtime.time.monotonic()))
        return
    except subprocess.TimeoutExpired:
        child.kill()
    child.wait(timeout=max(0.05, deadline - runtime.time.monotonic()))


def _supervisor(
    paths, chrome, ownership_fd, owner_fd, ready_fd, *, _runtime=None
):
    runtime = _resolve_runtime(_runtime)
    child = None
    server = None
    published = {}
    stopping = {"value": False}
    try:
        runtime.os.setsid()
    except OSError:
        pass
    nullfd = runtime.os.open(runtime.os.devnull, runtime.os.O_RDWR)
    for number in (0, 1, 2):
        runtime.os.dup2(nullfd, number)
    runtime.os.close(nullfd)

    def on_signal(_signum, _frame):
        stopping["value"] = True

    runtime.signal.signal(runtime.signal.SIGTERM, on_signal)
    runtime.signal.signal(runtime.signal.SIGINT, on_signal)
    try:
        paths.revalidate()
        launched_at = runtime.time.time_ns()
        chrome_path, chrome_device, chrome_inode = chrome
        executable = runtime.os.lstat(chrome_path)
        if (
            not runtime.stat.S_ISREG(executable.st_mode)
            or runtime._identity(executable) != (chrome_device, chrome_inode)
            or not executable.st_mode & 0o111
        ):
            raise RuntimeError("executable identity")
        reservation = runtime.socket.socket(
            runtime.socket.AF_INET, runtime.socket.SOCK_STREAM
        )
        reservation.bind(("127.0.0.1", 0))
        cdp_port = reservation.getsockname()[1]
        reservation.close()
        child = runtime.subprocess.Popen(
            [
                chrome_path,
                "--user-data-dir=" + paths.profile_path,
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=%d" % cdp_port,
                "--no-first-run",
                "--no-default-browser-check",
                "--new-window",
            ],
            stdin=runtime.subprocess.DEVNULL,
            stdout=runtime.subprocess.DEVNULL,
            stderr=runtime.subprocess.DEVNULL,
            close_fds=True,
        )
        paths.revalidate()
        executable_after = runtime.os.lstat(chrome_path)
        if runtime._identity(executable_after) != (chrome_device, chrome_inode):
            raise RuntimeError("executable identity")
        devtools = runtime._read_new_devtools(
            paths, launched_at, child, cdp_port
        )
        if devtools is None or stopping["value"]:
            raise RuntimeError("startup")
        port, browser_path = devtools
        token = runtime.secrets.token_hex(32)
        generation = runtime.secrets.token_hex(16)
        server = runtime.ControlServer(
            ("127.0.0.1", 0),
            runtime.ControlHandler,
            token,
            child,
            port,
            browser_path,
            paths,
            ownership_fd,
            published,
        )
        server.runtime = runtime
        server.timeout = 0.2
        published["control"] = runtime._atomic_json(
            paths,
            "control.json",
            {
                "version": 1,
                "port": server.server_address[1],
                "token": token,
                "generation": generation,
            },
        )
        published["state"] = runtime._atomic_json(
            paths,
            "state.json",
            {
                "version": 1,
                "profile": paths.name,
                "status": "ready",
                "cdpPort": port,
                "cdpBrowserPathHash": runtime._browser_path_hash(browser_path),
                "generation": generation,
            },
        )
        readiness = runtime.socket.socket(fileno=ready_fd)
        readiness.settimeout(runtime.REQUEST_TIMEOUT)
        readiness.sendall(
            runtime.json.dumps({"ok": True, "port": port}).encode("ascii")
        )
        readiness.shutdown(runtime.socket.SHUT_WR)
        if readiness.recv(16) != b"ack\n":
            raise RuntimeError("parent acknowledgement")
        readiness.close()
        ready_fd = -1
        while (
            child.poll() is None
            and not server.stopping
            and not stopping["value"]
        ):
            server.handle_request()
    except BaseException:
        if ready_fd >= 0:
            try:
                runtime.os.write(ready_fd, b'{"ok":false}')
            except OSError:
                pass
    finally:
        if ready_fd >= 0:
            runtime.os.close(ready_fd)
        if server is not None:
            server.server_close()
        if child is not None:
            try:
                runtime._terminate_exact_child(child)
            except BaseException:
                pass
        runtime._cleanup_runtime(paths, published)
        paths.close()
        try:
            runtime.os.close(ownership_fd)
        except OSError:
            pass
        try:
            runtime.os.close(owner_fd)
        except OSError:
            pass
        runtime.os._exit(0)


def _remove_stale_devtools(paths, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    try:
        current = runtime._entry_stat(paths.profile_fd, "DevToolsActivePort")
    except FileNotFoundError:
        return
    if (
        not runtime.stat.S_ISREG(current.st_mode)
        or current.st_uid != runtime.os.getuid()
        or current.st_dev != paths.profile_st.st_dev
        or current.st_nlink != 1
    ):
        raise runtime.Ambiguous("profile state is ambiguous")
    paths.revalidate()
    if runtime._identity(
        runtime._entry_stat(paths.profile_fd, "DevToolsActivePort")
    ) != runtime._identity(current):
        raise runtime.Ambiguous("profile state is ambiguous")
    runtime.os.unlink("DevToolsActivePort", dir_fd=paths.profile_fd)
