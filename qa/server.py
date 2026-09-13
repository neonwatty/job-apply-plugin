from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import signal
import sys
import threading
from typing import Any

from qa.contracts import ContractError, validate_fixture
from qa.server_auth import (
    HOST,
    INVALID_BODY,
    JSON_CONTENT_TYPE,
    TOKEN,
    authorize_post,
    has_local_host,
    has_run_token,
)
from qa.server_events import handle_event
from qa.server_final_action import (
    SAFETY_CHECK_KEYS,
    handle_auto_submit_final_action,
    handle_final_action,
)
from scripts.job_apply_policy import PolicyStore


MAX_BODY_BYTES = 64 * 1024
MAX_EVENTS = 10_000
RENDERER_ROOT = Path(__file__).resolve().parent / "renderer"
STATIC_ROUTES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}
SECURITY_HEADERS = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": (
        "default-src 'self'; script-src 'self'; style-src 'self'; "
        "connect-src 'self'; img-src 'self'; object-src 'none'; "
        "base-uri 'none'; frame-ancestors 'none'"
    ),
}
SAFE_FILENAME = re.compile(r"^[^/\\\x00-\x1f\x7f]{1,255}$")


class ReplayHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(
        self,
        fixture: dict[str, Any],
        port: int,
        expected_resume_filename: str = "synthetic-resume.pdf",
        shutdown_token: str | None = None,
        auto_submit_policy_root: Path | None = None,
    ):
        super().__init__((HOST, port), ReplayRequestHandler)
        self.fixture = fixture
        self.expected_resume_filename = expected_resume_filename
        self.shutdown_token = shutdown_token
        self.auto_submit_policy = (
            PolicyStore(auto_submit_policy_root)
            if auto_submit_policy_root is not None
            else None
        )
        self.events: list[dict[str, str]] = []
        self.final_action_activations = 0
        self.state_lock = threading.Lock()
        self.steps = {step["id"]: step for step in fixture["steps"]}
        self.controls: dict[str, tuple[dict[str, Any], str]] = {}
        for step in fixture["steps"]:
            for control in step["controls"]:
                self.controls[control["id"]] = (control, step["id"])


class ReplayRequestHandler(BaseHTTPRequestHandler):
    server: ReplayHTTPServer

    def log_message(self, _format: str, *args: object) -> None:
        return

    def _send(
        self,
        status: int,
        body: bytes = b"",
        content_type: str = "application/json; charset=utf-8",
    ) -> None:
        self.send_response(status)
        for name, value in SECURITY_HEADERS.items():
            self.send_header(name, value)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if body:
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _json(self, status: int, value: dict[str, Any]) -> None:
        self._send(
            status,
            json.dumps(value, separators=(",", ":")).encode("utf-8"),
        )

    def _error(self, status: int, message: str) -> None:
        self._json(status, {"error": message})

    def _read_json(self) -> Any:
        if self.headers.get("Transfer-Encoding") is not None:
            self._error(400, "invalid request body")
            return INVALID_BODY
        lengths = self.headers.get_all("Content-Length", failobj=[])
        if len(lengths) != 1:
            self._error(400, "invalid request body")
            return INVALID_BODY
        try:
            length = int(lengths[0], 10)
        except (TypeError, ValueError):
            self._error(400, "invalid request body")
            return INVALID_BODY
        if length < 0 or length > MAX_BODY_BYTES:
            self._error(400, "invalid request body")
            return INVALID_BODY
        body = self.rfile.read(length)
        if len(body) != length:
            self._error(400, "invalid request body")
            return INVALID_BODY
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(400, "invalid request body")
            return INVALID_BODY


    def _has_local_host(self) -> bool:
        return has_local_host(self)

    def _authorize_post(self) -> bool:
        return authorize_post(self)

    def do_GET(self) -> None:
        if not self._has_local_host():
            self._error(400, "invalid local request")
            return
        if self.path in STATIC_ROUTES:
            filename, content_type = STATIC_ROUTES[self.path]
            try:
                body = (RENDERER_ROOT / filename).read_bytes()
            except OSError:
                self._error(500, "renderer unavailable")
                return
            self._send(200, body, content_type)
            return
        if self.path == "/__qa/fixture":
            self._json(200, self.server.fixture)
            return
        if self.path == "/__qa/upload-policy":
            self._json(
                200,
                {"expectedFilename": self.server.expected_resume_filename},
            )
            return
        if self.path == "/__qa/identity":
            if not self._has_run_token():
                self._error(404, "not found")
                return
            self._json(200, {"fixtureId": self.server.fixture["id"]})
            return
        if self.path == "/__qa/state":
            with self.server.state_lock:
                state = {
                    "events": [dict(event) for event in self.server.events],
                    "finalActionActivations": self.server.final_action_activations,
                }
            self._json(200, state)
            return
        self._error(404, "not found")

    def do_POST(self) -> None:
        if self.path == "/__qa/shutdown":
            if not self._has_local_host() or not self._has_run_token():
                self._error(404, "not found")
                return
            self._send(204)
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return
        if self.path not in {
            "/__qa/event",
            "/__qa/final-action",
            "/__qa/auto-submit/final-action",
        }:
            self._error(404, "not found")
            return
        if not self._authorize_post():
            return
        if self.path == "/__qa/event":
            self._handle_event()
            return
        if self.path == "/__qa/auto-submit/final-action":
            if not self._has_run_token():
                self._error(404, "not found")
                return
            self._handle_auto_submit_final_action()
            return
        if self.path == "/__qa/final-action":
            self._handle_final_action()
            return


    def _handle_event(self) -> None:
        handle_event(self, MAX_EVENTS)

    def _has_run_token(self) -> bool:
        return has_run_token(self)

    def _handle_final_action(self) -> None:
        handle_final_action(self, MAX_EVENTS)

    def _handle_auto_submit_final_action(self) -> None:
        handle_auto_submit_final_action(self)

    def _method_not_allowed(self) -> None:
        self._error(405, "method not allowed")

    do_DELETE = _method_not_allowed
    do_HEAD = _method_not_allowed
    do_OPTIONS = _method_not_allowed
    do_PATCH = _method_not_allowed
    do_PUT = _method_not_allowed


def _load_fixture(path: Path) -> dict[str, Any]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        validate_fixture(value)
    except (OSError, UnicodeError, json.JSONDecodeError, ContractError, TypeError):
        raise ValueError("invalid fixture") from None
    return value


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Serve a compiled QA replay fixture locally"
    )
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--expected-resume-filename", required=True)
    parser.add_argument("--shutdown-token")
    parser.add_argument("--auto-submit-policy-root", type=Path)
    arguments = parser.parse_args(argv)
    if not 0 <= arguments.port <= 65535:
        parser.error("port must be between 0 and 65535")
    if SAFE_FILENAME.fullmatch(arguments.expected_resume_filename) is None:
        parser.error("invalid expected resume filename")
    shutdown_token = arguments.shutdown_token or os.environ.get(
        "JOB_APPLY_QA_SHUTDOWN_TOKEN"
    )
    if shutdown_token is not None and TOKEN.fullmatch(shutdown_token) is None:
        parser.error("invalid shutdown token")
    try:
        fixture = _load_fixture(arguments.fixture)
        server = ReplayHTTPServer(
            fixture,
            arguments.port,
            arguments.expected_resume_filename,
            shutdown_token,
            arguments.auto_submit_policy_root,
        )
    except (ValueError, OSError) as error:
        print(str(error), file=sys.stderr)
        return 2

    port = server.server_address[1]
    print(
        json.dumps(
            {"url": f"http://{HOST}:{port}", "port": port, "fixtureId": fixture["id"]},
            separators=(",", ":"),
        ),
        flush=True,
    )

    def stop(_signum: int, _frame: object) -> None:
        raise KeyboardInterrupt

    previous = signal.signal(signal.SIGTERM, stop)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        signal.signal(signal.SIGTERM, previous)
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
