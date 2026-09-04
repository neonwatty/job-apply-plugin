"""Authenticated loopback control for a retained Chrome child."""

import hmac
import http.client
import http.server
import json
import os
import socket
import socketserver
import sys
import threading

from qa.chrome.discovery import _probe_cdp
from qa.chrome.owner import _owner_matches_runtime, _ownership_name
from qa.chrome.paths import (
    MAX_BODY,
    MAX_CONTROL_CONNECTIONS,
    ORIGIN,
    REQUEST_TIMEOUT,
    Ambiguous,
    UserError,
    _entry_stat,
    _identity,
    _read_json,
    _safe_regular,
)


def _resolve_runtime(runtime):
    return sys.modules[__name__] if runtime is None else runtime


def _class_runtime(class_type):
    provider = getattr(class_type, "_runtime_provider", None)
    return _resolve_runtime(None if provider is None else provider())


def _public_ready(profile, port, *, _runtime=None):
    url = "http://127.0.0.1:%d" % port
    return {
        "profile": profile,
        "status": "ready",
        "cdpUrl": url,
        "recorderCommand": (
            "node qa/recorder.mjs record --cdp-url %s "
            "--output .qa-private/REPLACE_WITH_UNIQUE_SESSION_ID" % url
        ),
    }


def _control_request(paths, action, *, _runtime=None):
    runtime = _resolve_runtime(_runtime)
    control = runtime._read_json(
        paths, "control.json", {"version", "port", "token", "generation"}
    )
    state = runtime._read_json(
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
        control["version"] != 1
        or state["version"] != 1
        or state["profile"] != paths.name
        or state["status"] != "ready"
        or not isinstance(control["port"], int)
        or not isinstance(control["token"], str)
        or len(control["token"]) != 64
        or not isinstance(state["cdpBrowserPathHash"], str)
        or len(state["cdpBrowserPathHash"]) != 64
        or control["generation"] != state["generation"]
    ):
        raise runtime.Ambiguous("profile state is ambiguous")
    body = runtime.json.dumps(
        {"action": action, "token": control["token"]}, separators=(",", ":")
    )
    connection = runtime.http.client.HTTPConnection(
        "127.0.0.1", control["port"], timeout=runtime.REQUEST_TIMEOUT
    )
    try:
        connection.request(
            "POST",
            "/control",
            body=body,
            headers={
                "Host": "127.0.0.1:%d" % control["port"],
                "Origin": runtime.ORIGIN,
                "Content-Type": "application/json",
            },
        )
        response = connection.getresponse()
        raw = response.read(runtime.MAX_BODY + 1)
        if response.status != 200 or len(raw) > runtime.MAX_BODY:
            raise runtime.Ambiguous("profile state is ambiguous")
        value = runtime.json.loads(raw.decode("utf-8"))
    except (
        OSError,
        http.client.HTTPException,
        UnicodeDecodeError,
        json.JSONDecodeError,
    ):
        raise runtime.Ambiguous("profile state is ambiguous")
    finally:
        connection.close()
    if (
        action == "check"
        and value == {"status": "ready"}
        and runtime._probe_cdp(
            state["cdpPort"],
            browser_path_hash=state["cdpBrowserPathHash"],
        )
    ):
        return state
    if action == "stop" and value == {"status": "stopping"}:
        return state
    raise runtime.Ambiguous("profile state is ambiguous")


class ControlServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    allow_reuse_address = False
    daemon_threads = True
    block_on_close = False

    def __init__(
        self,
        address,
        handler,
        token,
        child,
        cdp_port,
        browser_path,
        paths,
        ownership_fd,
        published,
    ):
        runtime = _class_runtime(type(self))
        self.runtime = runtime
        self.token = token
        self.child = child
        self.cdp_port = cdp_port
        self.browser_path = browser_path
        self.paths = paths
        self.ownership_fd = ownership_fd
        self.ownership_identity = runtime._identity(
            runtime.os.fstat(ownership_fd)
        )
        self.published = published
        self.connection_slots = runtime.threading.BoundedSemaphore(
            runtime.MAX_CONTROL_CONNECTIONS
        )
        self.stopping = False
        super().__init__(address, handler)

    def get_request(self):
        request, address = super().get_request()
        request.settimeout(self.runtime.REQUEST_TIMEOUT)
        return request, address

    def process_request(self, request, client_address):
        if not self.connection_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.connection_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.connection_slots.release()

    def authorized(self):
        runtime = self.runtime
        try:
            self.paths.revalidate()
            ownership = runtime._entry_stat(
                self.paths.root_fd,
                runtime._ownership_name(self.paths.name),
            )
            if (
                runtime._identity(ownership) != self.ownership_identity
                or runtime._identity(runtime.os.fstat(self.ownership_fd))
                != self.ownership_identity
                or self.published.get("state") is None
                or self.published.get("control") is None
            ):
                return False
            for name in ("state", "control"):
                filename = name + ".json"
                current = runtime._entry_stat(
                    self.paths.runtime_fd, filename
                )
                if runtime._identity(current) != self.published[name]:
                    return False
                runtime._safe_regular(
                    self.paths.runtime_fd,
                    filename,
                    self.paths.runtime_st.st_dev,
                )
            return runtime._owner_matches_runtime(self.paths) is True
        except (OSError, runtime.UserError):
            return False


class ControlHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, status, payload):
        runtime = self.server.runtime
        body = runtime.json.dumps(payload, separators=(",", ":")).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(body)
        except (
            BrokenPipeError,
            ConnectionResetError,
            runtime.socket.timeout,
            OSError,
        ):
            pass

    def do_POST(self):
        server = self.server
        runtime = server.runtime
        expected_host = "127.0.0.1:%d" % server.server_address[1]
        try:
            length = int(self.headers.get("Content-Length", "-1"))
        except ValueError:
            length = -1
        if (
            self.client_address[0] != "127.0.0.1"
            or self.path != "/control"
            or self.headers.get("Host") != expected_host
            or self.headers.get("Origin") != runtime.ORIGIN
            or self.headers.get("Content-Type") != "application/json"
            or not 0 <= length <= runtime.MAX_BODY
        ):
            self._send(400, {"status": "error"})
            return
        try:
            raw = self.rfile.read(length)
        except (runtime.socket.timeout, OSError):
            return
        try:
            request = runtime.json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, runtime.json.JSONDecodeError):
            self._send(400, {"status": "error"})
            return
        if (
            not isinstance(request, dict)
            or set(request) != {"action", "token"}
            or request["action"] not in ("check", "stop")
            or not isinstance(request["token"], str)
            or not runtime.hmac.compare_digest(request["token"], server.token)
        ):
            self._send(400, {"status": "error"})
            return
        if not server.authorized():
            self._send(400, {"status": "error"})
            return
        if request["action"] == "check":
            if server.child.poll() is not None or not runtime._probe_cdp(
                server.cdp_port, browser_path=server.browser_path
            ):
                self._send(400, {"status": "error"})
                return
            payload = {"status": "ready"}
        else:
            server.stopping = True
            payload = {"status": "stopping"}
        self._send(200, payload)

    def log_message(self, *_args):
        pass
