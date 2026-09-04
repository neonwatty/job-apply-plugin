"""Start, check, stop, and manual-reset command orchestration."""

import json
import os
import socket
import sys
import time

from qa.chrome.control import _control_request, _public_ready
from qa.chrome.discovery import discover_chrome
from qa.chrome.owner import (
    _observe_owner,
    _open_owner,
    _owner_matches_runtime,
    _write_owner_runtime,
)
from qa.chrome.paths import (
    MAX_BODY,
    SHUTDOWN_TIMEOUT,
    STARTUP_TIMEOUT,
    Ambiguous,
    BoundPaths,
    UserError,
    _entry_stat,
    _identity,
    _read_json,
    emit,
    fail,
)
from qa.chrome.supervisor import _remove_stale_devtools, _supervisor


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


def command_start(profile, chrome_path, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    chrome = runtime.discover_chrome(chrome_path)
    setup_deadline = runtime.time.monotonic() + 0.5
    while True:
        try:
            paths = runtime.BoundPaths(
                profile, create_base=True, create_profile=True
            )
            break
        except runtime.UserError:
            if runtime.time.monotonic() >= setup_deadline:
                raise
            runtime.time.sleep(0.02)
    owner = runtime._open_owner(paths)
    if owner is None:
        expected_runtime = (
            runtime._identity(paths.runtime_st)
            if paths.runtime_fd is not None
            else None
        )
        generation = None
        if paths.runtime_fd is not None:
            try:
                initial = runtime._read_json(
                    paths,
                    "state.json",
                    {
                        "version",
                        "profile",
                        "status",
                        "cdpPort",
                        "cdpBrowserPathHash",
                        "generation",
                    },
                )
                if (
                    initial.get("version") == 1
                    and initial.get("profile") == profile
                    and initial.get("status") == "ready"
                ):
                    generation = initial.get("generation")
            except runtime.Ambiguous:
                pass
        paths.close()
        try:
            deadline = runtime.time.monotonic() + runtime.STARTUP_TIMEOUT + 3
            while runtime.time.monotonic() < deadline:
                current = None
                try:
                    current = runtime.BoundPaths.existing(profile)
                    if current is None or current.runtime_fd is None:
                        raise runtime.Ambiguous("profile state is ambiguous")
                    if (
                        expected_runtime is not None
                        and runtime._identity(current.runtime_st)
                        != expected_runtime
                    ):
                        raise runtime.Ambiguous("profile state is ambiguous")
                    if runtime._owner_matches_runtime(current) is False:
                        raise runtime.Ambiguous("profile state is ambiguous")
                    if generation is not None:
                        observed = runtime._read_json(
                            current,
                            "state.json",
                            {
                                "version",
                                "profile",
                                "status",
                                "cdpPort",
                                "cdpBrowserPathHash",
                                "generation",
                            },
                        )
                        if observed.get("generation") != generation:
                            raise runtime.Ambiguous("profile state is ambiguous")
                    state = runtime._control_request(current, "check")
                    runtime.emit(
                        runtime._public_ready(profile, state["cdpPort"])
                    )
                    return
                except runtime.Ambiguous:
                    if (
                        current is not None
                        and expected_runtime is not None
                        and current.runtime_fd is not None
                        and runtime._identity(current.runtime_st)
                        != expected_runtime
                    ):
                        raise
                    if (
                        current is not None
                        and current.runtime_fd is not None
                        and runtime._owner_matches_runtime(current) is False
                    ):
                        raise
                except runtime.UserError:
                    pass
                finally:
                    if current is not None:
                        current.close()
                runtime.time.sleep(0.04)
            raise runtime.Ambiguous("profile state is ambiguous")
        finally:
            pass
    if paths.runtime_fd is not None:
        runtime.os.close(owner[1])
        runtime.os.close(owner[0])
        paths.close()
        raise runtime.Ambiguous("profile state is ambiguous")
    ownership_fd, owner_fd = owner
    try:
        paths.create_runtime()
        runtime._write_owner_runtime(owner_fd, paths.runtime_st)
        runtime._remove_stale_devtools(paths)
        parent_ready, child_ready = runtime.socket.socketpair()
        pid = runtime.os.fork()
        if pid == 0:
            parent_ready.close()
            runtime._supervisor(
                paths,
                chrome,
                ownership_fd,
                owner_fd,
                child_ready.detach(),
            )
        child_ready.close()
        runtime.os.close(ownership_fd)
        ownership_fd = -1
        runtime.os.close(owner_fd)
        owner_fd = -1
        paths.close()
        deadline = runtime.time.monotonic() + runtime.STARTUP_TIMEOUT + 1
        chunks = []
        parent_ready.setblocking(False)
        while runtime.time.monotonic() < deadline:
            try:
                chunk = parent_ready.recv(runtime.MAX_BODY)
                if chunk:
                    chunks.append(chunk)
                    continue
                if chunk == b"":
                    break
            except BlockingIOError:
                pass
            runtime.time.sleep(0.04)
        try:
            answer = runtime.json.loads(b"".join(chunks).decode("ascii"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            answer = {"ok": False}
        if answer.get("ok") is not True or not isinstance(
            answer.get("port"), int
        ):
            runtime.fail("Chrome did not become ready")
        runtime.emit(runtime._public_ready(profile, answer["port"]))
        runtime.sys.stdout.flush()
        parent_ready.sendall(b"ack\n")
        parent_ready.close()
    except BaseException:
        try:
            parent_ready.close()
        except (NameError, OSError):
            pass
        try:
            if owner_fd >= 0:
                runtime.os.close(owner_fd)
            if ownership_fd >= 0:
                runtime.os.close(ownership_fd)
        except OSError:
            pass
        paths.close()
        raise


def command_check(profile, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    paths = runtime.BoundPaths.existing(profile)
    if paths is None:
        runtime.emit({"profile": profile, "status": "stopped"})
        return
    try:
        if paths.profile_fd is None:
            runtime.emit({"profile": profile, "status": "stopped"})
            return
        if paths.runtime_fd is None:
            runtime.emit({"profile": profile, "status": "stopped"})
            return
        state = runtime._control_request(paths, "check")
        runtime.emit(runtime._public_ready(profile, state["cdpPort"]))
    finally:
        paths.close()


def command_stop(profile, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    paths = runtime.BoundPaths.existing(profile)
    if paths is None:
        runtime.emit({"profile": profile, "status": "stopped"})
        return
    try:
        if paths.profile_fd is None or paths.runtime_fd is None:
            runtime.emit({"profile": profile, "status": "stopped"})
            return
        runtime._control_request(paths, "stop")
        deadline = runtime.time.monotonic() + runtime.SHUTDOWN_TIMEOUT + 1
        while runtime.time.monotonic() < deadline:
            try:
                current = runtime._entry_stat(
                    paths.runtime_root_fd, profile
                )
            except FileNotFoundError:
                owner = runtime._observe_owner(paths)
                if owner is None:
                    runtime.time.sleep(0.04)
                    continue
                runtime.os.close(owner[1])
                runtime.os.close(owner[0])
                runtime.emit({"profile": profile, "status": "stopped"})
                return
            if runtime._identity(current) != runtime._identity(paths.runtime_st):
                raise runtime.Ambiguous("profile state is ambiguous")
            runtime.time.sleep(0.04)
        raise runtime.Ambiguous("profile state is ambiguous")
    finally:
        paths.close()


def _manual_profile_path(profile, *, _runtime=None):
    return "~/.job-apply-qa/chrome-profiles/%s" % profile


def _emit_manual_reset(profile, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    runtime.emit(
        {
            "profile": profile,
            "status": "manual-removal-required",
            "profilePath": runtime._manual_profile_path(profile),
        }
    )


def command_reset(profile, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    try:
        paths = runtime.BoundPaths.existing(profile)
    except runtime.Ambiguous:
        runtime.fail("profile state is ambiguous; resolve it before reset guidance")
    if paths is None or paths.profile_fd is None:
        if paths is not None:
            paths.close()
        runtime._emit_manual_reset(profile)
        return
    owner = None
    try:
        owner = runtime._observe_owner(paths)
        if owner is None:
            runtime.fail("profile is active; stop it before reset guidance")
        if paths.runtime_fd is not None:
            runtime.fail(
                "profile state is ambiguous; resolve it before reset guidance"
            )
        paths.revalidate()
        source = runtime._entry_stat(paths.profiles_fd, profile)
        if runtime._identity(source) != runtime._identity(paths.profile_st):
            runtime.fail(
                "profile state is ambiguous; resolve it before reset guidance"
            )
        runtime._emit_manual_reset(profile)
    except runtime.Ambiguous:
        runtime.fail("profile state is ambiguous; resolve it before reset guidance")
    except OSError:
        runtime.fail("managed storage is unsafe")
    finally:
        if owner is not None:
            runtime.os.close(owner[1])
            runtime.os.close(owner[0])
        paths.close()
