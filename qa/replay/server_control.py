"""Authenticated lifecycle control for isolated replay fixture servers."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
from typing import Any
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from qa.replay.run_state import REPO_ROOT
from qa.replay.secure_io import CoordinatorError, MAX_JSON_BYTES
from qa.server import ReplayHTTPServer


STARTUP_TIMEOUT_SECONDS = 10
REQUEST_TIMEOUT_SECONDS = 5


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _opaque(kind: str, label: str, *, _runtime: Any | None = None) -> str:
    runtime = _resolve_runtime(_runtime)
    return f"{kind}:" + runtime.hashlib.sha256(label.encode()).hexdigest()


def _revision(label: str, *, _runtime: Any | None = None) -> str:
    runtime = _resolve_runtime(_runtime)
    return "sha256:" + runtime.hashlib.sha256(label.encode()).hexdigest()


def _post_claimed_action(
    base_url: str,
    token: str,
    lease: dict[str, Any],
    authorization: dict[str, Any],
    step_id: str,
    safety_checks: dict[str, bool] | None = None,
    *,
    _runtime: Any | None = None,
) -> tuple[int, dict[str, Any]]:
    runtime = _resolve_runtime(_runtime)
    safe = safety_checks or {
        "loginRequired": False,
        "captchaPresent": False,
        "mfaRequired": False,
        "accountCreationRequired": False,
        "controlAccessible": True,
        "redirected": False,
    }
    request = runtime.urllib.request.Request(
        base_url + "/__qa/auto-submit/final-action",
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Origin": base_url,
            "X-QA-Run-Token": token,
        },
        data=runtime.json.dumps(
            {
                "stepId": step_id,
                "applicationRef": lease["applicationRef"],
                "leaseId": lease["leaseId"],
                "attempt": lease["attempt"],
                "authorization": authorization,
                "safetyChecks": safe,
            }
        ).encode(),
    )
    try:
        with runtime.urllib.request.urlopen(
            request, timeout=runtime.REQUEST_TIMEOUT_SECONDS
        ) as response:
            return response.status, runtime.json.loads(
                response.read(runtime.MAX_JSON_BYTES).decode()
            )
    except runtime.urllib.error.HTTPError as error:
        status = error.code
        try:
            try:
                body = runtime.json.loads(
                    error.read(runtime.MAX_JSON_BYTES).decode()
                )
            except (UnicodeError, runtime.json.JSONDecodeError):
                body = {"error": "invalid isolated response"}
        finally:
            error.close()
        return status, body


def _start_server(
    fixture_path: Path,
    expected_resume_filename: str,
    shutdown_token: str,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    server_environment = runtime.os.environ.copy()
    server_environment["JOB_APPLY_QA_SHUTDOWN_TOKEN"] = shutdown_token
    try:
        process = runtime.subprocess.Popen(
            [
                runtime.sys.executable,
                "-m",
                "qa.server",
                "--fixture",
                str(fixture_path),
                "--port",
                "0",
                "--expected-resume-filename",
                expected_resume_filename,
            ],
            cwd=runtime.REPO_ROOT,
            stdin=runtime.subprocess.DEVNULL,
            stdout=runtime.subprocess.PIPE,
            stderr=runtime.subprocess.DEVNULL,
            text=True,
            start_new_session=True,
            env=server_environment,
        )
    except OSError:
        raise CoordinatorError("fixture server startup failed") from None

    lines: queue.Queue[str] = runtime.queue.Queue(maxsize=1)
    assert process.stdout is not None
    reader = runtime.threading.Thread(
        target=lambda: lines.put(process.stdout.readline()), daemon=True
    )
    reader.start()
    try:
        line = lines.get(timeout=runtime.STARTUP_TIMEOUT_SECONDS)
        startup = runtime.json.loads(line)
        if (
            set(startup) != {"url", "port", "fixtureId"}
            or startup["fixtureId"] == ""
            or startup["url"] != f"http://127.0.0.1:{startup['port']}"
            or not isinstance(startup["port"], int)
        ):
            raise ValueError
        process.returncode = 0
        return startup
    except (runtime.queue.Empty, runtime.json.JSONDecodeError, TypeError, ValueError):
        process.terminate()
        try:
            process.wait(timeout=2)
        except runtime.subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)
        raise CoordinatorError("fixture server startup failed") from None
    finally:
        process.stdout.close()


def _fetch_state(url: str, *, _runtime: Any | None = None) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    url = runtime._base_url(url)
    try:
        request = runtime.urllib.request.Request(url + "/__qa/state", method="GET")
        with runtime.urllib.request.urlopen(
            request, timeout=runtime.REQUEST_TIMEOUT_SECONDS
        ) as response:
            if response.status != 200:
                raise CoordinatorError("fixture server unavailable")
            body = response.read(runtime.MAX_JSON_BYTES + 1)
        if len(body) > runtime.MAX_JSON_BYTES:
            raise CoordinatorError("invalid fixture server state")
        state = runtime.json.loads(body.decode())
    except CoordinatorError:
        raise
    except (
        OSError,
        UnicodeError,
        runtime.json.JSONDecodeError,
        runtime.urllib.error.URLError,
    ):
        raise CoordinatorError("fixture server unavailable") from None
    if (
        not isinstance(state, dict)
        or set(state) != {"events", "finalActionActivations"}
        or not isinstance(state["events"], list)
        or not isinstance(state["finalActionActivations"], int)
        or isinstance(state["finalActionActivations"], bool)
        or state["finalActionActivations"] < 0
    ):
        raise CoordinatorError("invalid fixture server state")
    return state


def _base_url(url: str, *, _runtime: Any | None = None) -> str:
    runtime = _resolve_runtime(_runtime)
    parsed = runtime.urlsplit(url)
    base = f"{parsed.scheme}://{parsed.netloc}"
    if runtime.re.fullmatch(
        r"http://127\.0\.0\.1:[1-9][0-9]{0,4}", base
    ) is None:
        raise CoordinatorError("invalid run state")
    return base


def _authenticated_request(
    url: str,
    path: str,
    token: str,
    method: str = "GET",
    *,
    _runtime: Any | None = None,
) -> tuple[int, bytes]:
    runtime = _resolve_runtime(_runtime)
    try:
        request = runtime.urllib.request.Request(
            runtime._base_url(url) + path,
            headers={"X-QA-Run-Token": token},
            method=method,
        )
        with runtime.urllib.request.urlopen(
            request, timeout=runtime.REQUEST_TIMEOUT_SECONDS
        ) as response:
            return response.status, response.read(runtime.MAX_JSON_BYTES + 1)
    except runtime.urllib.error.HTTPError as error:
        status = error.code
        try:
            error.read()
        finally:
            error.close()
        return status, b""
    except (OSError, runtime.urllib.error.URLError):
        raise CoordinatorError("fixture server unavailable") from None


def _verify_identity(
    state: dict[str, Any], *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    status, body = runtime._authenticated_request(
        state["url"], "/__qa/identity", state["shutdownToken"]
    )
    try:
        identity = runtime.json.loads(body.decode())
    except (UnicodeError, runtime.json.JSONDecodeError):
        identity = None
    if status != 200 or identity != {"fixtureId": state["fixtureId"]}:
        raise CoordinatorError("fixture server identity mismatch")


def _shutdown_server(
    url: str,
    token: str,
    required: bool = True,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        status, _body = runtime._authenticated_request(
            url, "/__qa/shutdown", token, method="POST"
        )
    except CoordinatorError:
        if required:
            raise
        return
    if status != 204 and required:
        raise CoordinatorError("fixture server shutdown failed")


def _shutdown_authenticated_run_if_available(
    state: dict[str, Any], *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    try:
        runtime._verify_identity(state)
    except CoordinatorError as error:
        if str(error) != "fixture server unavailable":
            raise
    else:
        runtime._shutdown_server(
            state["url"], state["shutdownToken"], required=True
        )


def _shutdown_authenticated_run(
    state: dict[str, Any], *, _runtime: Any | None = None
) -> None:
    runtime = _resolve_runtime(_runtime)
    runtime._verify_identity(state)
    runtime._shutdown_server(state["url"], state["shutdownToken"], required=True)
