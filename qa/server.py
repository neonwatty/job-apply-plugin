from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import threading
from typing import Any

from qa.contracts import ContractError, validate_fixture
from scripts.job_apply_policy import PolicyError, PolicyStore


HOST = "127.0.0.1"
MAX_BODY_BYTES = 64 * 1024
MAX_EVENTS = 10_000
INVALID_BODY = object()
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
JSON_CONTENT_TYPE = re.compile(
    r"application/json(?:;[ \t]*charset[ \t]*=[ \t]*utf-8)?",
    re.IGNORECASE,
)


TOKEN = re.compile(r"^[a-f0-9]{64}$")
SAFETY_CHECK_KEYS = {
    "loginRequired",
    "captchaPresent",
    "mfaRequired",
    "accountCreationRequired",
    "controlAccessible",
    "redirected",
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
        hosts = self.headers.get_all("Host", failobj=[])
        expected = f"{HOST}:{self.server.server_address[1]}"
        return len(hosts) == 1 and hosts[0] == expected

    def _authorize_post(self) -> bool:
        if not self._has_local_host():
            self._error(400, "invalid local request")
            return False
        origins = self.headers.get_all("Origin", failobj=[])
        expected_origin = f"http://{HOST}:{self.server.server_address[1]}"
        if len(origins) != 1 or origins[0] != expected_origin:
            self._error(403, "invalid local request")
            return False
        content_types = self.headers.get_all("Content-Type", failobj=[])
        if (
            len(content_types) != 1
            or JSON_CONTENT_TYPE.fullmatch(content_types[0]) is None
        ):
            self._error(415, "invalid content type")
            return False
        return True

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
        value = self._read_json()
        if value is INVALID_BODY:
            return
        if not isinstance(value, dict):
            self._error(400, "invalid semantic event")
            return
        expected_keys = {"type", "controlId", "stepId"}
        if value.get("type") == "uploaded":
            expected_keys.add("expectedFilenameMatched")
        if set(value) != expected_keys:
            self._error(400, "invalid semantic event")
            return
        if any(
            not isinstance(value[key], str)
            for key in ("type", "controlId", "stepId")
        ):
            self._error(400, "invalid semantic event")
            return

        event_type = value["type"]
        control_id = value["controlId"]
        step_id = value["stepId"]
        step = self.server.steps.get(step_id)
        control_entry = self.server.controls.get(control_id)
        valid = False
        if event_type in {"filled", "uploaded", "validation"} and control_entry is not None:
            control, control_step_id = control_entry
            if control_step_id == step_id:
                if event_type == "filled":
                    valid = control["role"] != "file"
                elif event_type == "uploaded":
                    valid = control["role"] == "file" and isinstance(
                        value["expectedFilenameMatched"], bool
                    )
                else:
                    valid = True
        elif event_type == "advanced":
            valid = control_id == "" and step is not None and step["kind"] == "form"
        elif event_type == "reviewed":
            valid = control_id == "" and step is not None and step["kind"] == "review"
        if not valid:
            self._error(400, "invalid semantic event")
            return

        with self.server.state_lock:
            if len(self.server.events) >= MAX_EVENTS:
                event_recorded = False
            else:
                self.server.events.append(dict(value))
                event_recorded = True
        if not event_recorded:
            self._error(503, "event limit reached")
            return
        self._send(204, content_type="application/json; charset=utf-8")

    def _has_run_token(self) -> bool:
        configured = self.server.shutdown_token
        supplied = self.headers.get_all("X-QA-Run-Token", failobj=[])
        return (
            isinstance(configured, str)
            and len(supplied) == 1
            and secrets.compare_digest(supplied[0], configured)
        )

    def _handle_final_action(self) -> None:
        value = self._read_json()
        if value is INVALID_BODY:
            return
        if (
            not isinstance(value, dict)
            or set(value) != {"stepId"}
            or not isinstance(value["stepId"], str)
        ):
            self._error(400, "invalid final action")
            return
        step = self.server.steps.get(value["stepId"])
        if (
            step is None
            or step["kind"] != "review"
            or step.get("finalAction", {}).get("enabled") is not True
            or step.get("finalAction", {}).get("tripwire") is not True
        ):
            self._error(400, "invalid final action")
            return
        with self.server.state_lock:
            overflow = len(self.server.events) - MAX_EVENTS + 1
            if overflow > 0:
                del self.server.events[:overflow]
            self.server.final_action_activations += 1
            self.server.events.append(
                {"type": "final-action", "stepId": value["stepId"]}
            )
        self._error(409, "final action blocked by QA tripwire")

    def _handle_auto_submit_final_action(self) -> None:
        """Atomically consume current persisted policy and activate once.

        This route is unavailable without the coordinator's private per-run
        capability and exact loopback Origin.  It does not accept policy or page
        page identity is closed and revalidated by the persisted authority.
        """
        value = self._read_json()
        if value is INVALID_BODY:
            return
        if (
            not isinstance(value, dict)
            or set(value)
            != {
                "stepId",
                "applicationRef",
                "leaseId",
                "attempt",
                "authorization",
                "safetyChecks",
            }
            or not isinstance(value.get("stepId"), str)
            or not isinstance(value.get("applicationRef"), str)
            or not isinstance(value.get("leaseId"), str)
            or not isinstance(value.get("attempt"), int)
            or isinstance(value.get("attempt"), bool)
            or not isinstance(value.get("authorization"), dict)
        ):
            self._error(400, "invalid claimed final action")
            return
        safety_checks = value["safetyChecks"]
        if (
            not isinstance(safety_checks, dict)
            or set(safety_checks) != SAFETY_CHECK_KEYS
            or any(not isinstance(item, bool) for item in safety_checks.values())
        ):
            self._error(400, "invalid claimed final action")
            return
        if (
            safety_checks["loginRequired"]
            or safety_checks["captchaPresent"]
            or safety_checks["mfaRequired"]
            or safety_checks["accountCreationRequired"]
            or not safety_checks["controlAccessible"]
            or safety_checks["redirected"]
        ):
            self._error(409, "runtime safety boundary blocked final action")
            return
        step = self.server.steps.get(value["stepId"])
        if (
            step is None
            or step["kind"] != "review"
            or step.get("finalAction") != {
                "id": "final.apply",
                "label": "Submit application",
                "enabled": True,
                "tripwire": True,
            }
        ):
            self._error(400, "invalid claimed final action")
            return
        policy = self.server.auto_submit_policy
        if policy is None:
            self._error(404, "not found")
            return
        confirmation: dict[str, Any] = {}

        def activate(claim: dict[str, Any]) -> None:
            nonlocal confirmation
            with self.server.state_lock:
                self.server.final_action_activations += 1
                self.server.events.append(
                    {"type": "final-action", "stepId": value["stepId"]}
                )
                activation_number = self.server.final_action_activations
            confirmation = {
                "eventId": "receipt:" + secrets.token_hex(32),
                "claimId": claim["claimId"],
                "source": "isolated_loopback",
                "observedAt": datetime.now(timezone.utc).isoformat(
                    timespec="seconds"
                ).replace("+00:00", "Z"),
                "confirmationRevision": "sha256:" + hashlib.sha256(
                    f"{self.server.fixture['id']}:{claim['claimId']}:{activation_number}".encode()
                ).hexdigest(),
                "activationObserved": True,
            }
            import hmac
            confirmation["proof"] = hmac.new(
                self.server.shutdown_token.encode(),
                json.dumps(confirmation, sort_keys=True, separators=(",", ":")).encode(),
                hashlib.sha256,
            ).hexdigest()

        try:
            policy.claim_final_action(
                value["applicationRef"],
                value["leaseId"],
                value["attempt"],
                value["authorization"],
                self.server.shutdown_token,
                activation=activate,
            )
        except (PolicyError, OSError):
            self._error(409, "current policy refused final action")
            return
        self._json(200, confirmation)

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
