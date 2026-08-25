#!/usr/bin/env python3
"""Secure loopback companion workspace for canonical Job Apply records."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import secrets
import signal
import sys
import threading
import webbrowser
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable
from urllib.parse import unquote, urlsplit

LOOPBACK = "127.0.0.1"
MAX_BODY_BYTES = 64 * 1024
MAX_BULK_URLS = 50
ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = ROOT / "workspace"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


def load_store_module() -> Any:
    path = Path(__file__).resolve().with_name("job-apply-store.py")
    spec = importlib.util.spec_from_file_location("job_apply_store", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load the canonical Job Apply store")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE_MODULE = load_store_module()


class WorkspaceServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, root: Path, port: int, token: str | None = None):
        self.store = STORE_MODULE.Store(root)
        self.store.initialize()
        self.token = token or secrets.token_urlsafe(32)
        super().__init__((LOOPBACK, port), WorkspaceHandler)
        self.origin = f"http://{LOOPBACK}:{self.server_port}"
        self.expected_host = f"{LOOPBACK}:{self.server_port}"


class WorkspaceHandler(BaseHTTPRequestHandler):
    server: WorkspaceServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:
        # Never log request fragments/tokens. The token is never sent in a URL.
        sys.stderr.write("workspace: " + fmt % args + "\n")

    def end_headers(self) -> None:
        if self.close_connection:
            self.send_header("Connection", "close")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data:; connect-src 'self'; base-uri 'none'; "
            "form-action 'self'; frame-ancestors 'none'",
        )
        super().end_headers()

    def _send_bytes(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status: int, payload: Any) -> None:
        body = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode()
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _error(self, status: int, message: str, code: str = "request_error") -> None:
        # Error paths may reject before reading a request body. Never let unread,
        # attacker-controlled bytes become another HTTP/1.1 request.
        self.close_connection = True
        self._json(status, {"error": {"code": code, "message": message}})

    def _valid_host(self) -> bool:
        if self.headers.get("Host") != self.server.expected_host:
            self._error(HTTPStatus.FORBIDDEN, "request host is not the workspace", "host_rejected")
            return False
        return True

    def _authorized_api(self, mutation: bool = False) -> bool:
        if not self._valid_host():
            return False
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.server.token}"
        if not secrets.compare_digest(authorization, expected):
            self._error(HTTPStatus.UNAUTHORIZED, "workspace token is missing or invalid", "token_rejected")
            return False
        if mutation and self.headers.get("Origin") != self.server.origin:
            self._error(HTTPStatus.FORBIDDEN, "request origin is not the workspace", "origin_rejected")
            return False
        return True

    def _path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")
            return None
        try:
            decoded = unquote(parsed.path, errors="strict")
        except UnicodeError:
            self._error(HTTPStatus.BAD_REQUEST, "request path is invalid")
            return None
        if decoded != parsed.path or "\\" in decoded or ".." in decoded:
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")
            return None
        return decoded

    def _read_json(self) -> dict[str, Any] | None:
        if self.headers.get("Content-Type") != "application/json":
            self._error(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "Content-Type must be application/json")
            return None
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self._error(HTTPStatus.LENGTH_REQUIRED, "a valid Content-Length is required")
            return None
        if length > MAX_BODY_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body is too large")
            return None
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "request body must be valid JSON")
            return None
        if not isinstance(payload, dict):
            self._error(HTTPStatus.BAD_REQUEST, "request body must be a JSON object")
            return None
        return payload

    def _store_call(self, callback: Callable[[], Any]) -> None:
        try:
            result = callback()
        except STORE_MODULE.StoreError as error:
            message = str(error)
            if "revision conflict" in message:
                self._error(HTTPStatus.CONFLICT, message, "revision_conflict")
            elif "does not exist" in message:
                self._error(HTTPStatus.NOT_FOUND, message, "not_found")
            else:
                self._error(HTTPStatus.BAD_REQUEST, message, "store_rejected")
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed", "storage_error")
        else:
            self._json(HTTPStatus.OK, result)

    def _expected_revision(self, payload: dict[str, Any]) -> int | None:
        revision = payload.get("expectedRevision")
        if (
            not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 1
        ):
            self._error(
                HTTPStatus.BAD_REQUEST,
                "expectedRevision must be a positive integer",
            )
            return None
        return revision

    def do_HEAD(self) -> None:
        path = self._path()
        if path is None or not self._valid_host():
            return
        asset = ASSETS.get(path)
        if asset is None:
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")
            return
        try:
            body = (ASSET_ROOT / asset[0]).read_bytes()
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "workspace asset is unavailable")
            return
        self._send_bytes(HTTPStatus.OK, body, asset[1])

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path.startswith("/api/"):
            if not self._authorized_api():
                return
            self._get_api(path)
            return
        if not self._valid_host():
            return
        asset = ASSETS.get(path)
        if asset is None:
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")
            return
        try:
            body = (ASSET_ROOT / asset[0]).read_bytes()
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "workspace asset is unavailable")
            return
        self._send_bytes(HTTPStatus.OK, body, asset[1])

    def _get_api(self, path: str) -> None:
        if path == "/api/state":
            self._store_call(lambda: {
                "jobs": self.server.store.list_jobs(),
                "resumes": self.server.store.list_resumes(),
            })
            return
        if path == "/api/jobs":
            self._store_call(lambda: {"jobs": self.server.store.list_jobs()})
            return
        if path == "/api/resumes":
            self._store_call(lambda: {"resumes": self.server.store.list_resumes()})
            return
        parts = path.split("/")
        if len(parts) == 4 and parts[1:3] == ["api", "jobs"]:
            job_id = parts[3]
            self._store_call(lambda: self._require_job(job_id))
            return
        if len(parts) == 5 and parts[1:3] == ["api", "jobs"] and parts[4] == "preflight":
            self._store_call(lambda: self.server.store.preflight_job(parts[3]))
            return
        self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")

    def _require_job(self, job_id: str) -> dict[str, Any]:
        job = self.server.store.get_job(job_id)
        if job is None:
            raise STORE_MODULE.StoreError("job does not exist")
        return job

    def do_POST(self) -> None:
        self._mutate("POST")

    def do_PATCH(self) -> None:
        self._mutate("PATCH")

    def _mutate(self, method: str) -> None:
        path = self._path()
        if path is None or not self._authorized_api(mutation=True):
            return
        payload = self._read_json()
        if payload is None:
            return
        if method == "POST" and path == "/api/jobs":
            job = payload.get("job")
            if not isinstance(job, dict) or set(payload) != {"job"}:
                self._error(HTTPStatus.BAD_REQUEST, "body must contain only a job object")
                return
            self._store_call(lambda: self.server.store.create_job(job, origin="human"))
            return
        if method == "POST" and path == "/api/jobs/bulk":
            self._bulk_create(payload)
            return
        parts = path.split("/")
        if len(parts) == 4 and parts[1:3] == ["api", "jobs"] and method == "PATCH":
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(payload.get("patch"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(lambda: self.server.store.update_job(
                parts[3], payload["patch"], expected_revision, origin="human"
            ))
            return
        if len(parts) == 5 and parts[1:3] == ["api", "jobs"]:
            job_id, action = parts[3], parts[4]
            if action == "transition" and method == "POST":
                allowed = {"status", "expectedRevision", "closedOutcome", "userConfirmed"}
                if set(payload) - allowed or not {"status", "expectedRevision"} <= set(payload):
                    self._error(HTTPStatus.BAD_REQUEST, "transition body is invalid")
                    return
                if not isinstance(payload["status"], str):
                    self._error(HTTPStatus.BAD_REQUEST, "transition status must be a string")
                    return
                if "closedOutcome" in payload and payload["closedOutcome"] is not None and not isinstance(payload["closedOutcome"], str):
                    self._error(HTTPStatus.BAD_REQUEST, "closedOutcome must be a string or null")
                    return
                if "userConfirmed" in payload and not isinstance(payload["userConfirmed"], bool):
                    self._error(HTTPStatus.BAD_REQUEST, "userConfirmed must be a boolean")
                    return
                expected_revision = self._expected_revision(payload)
                if expected_revision is None:
                    return
                self._store_call(lambda: self.server.store.transition_job(
                    job_id,
                    payload["status"],
                    expected_revision,
                    closed_outcome=payload.get("closedOutcome"),
                    user_confirmed=payload.get("userConfirmed") is True,
                ))
                return
            if action == "trash" and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(HTTPStatus.BAD_REQUEST, "trash body requires expectedRevision")
                    return
                expected_revision = self._expected_revision(payload)
                if expected_revision is None:
                    return
                self._store_call(lambda: self.server.store.trash_job(job_id, expected_revision))
                return
        self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")

    def _bulk_create(self, payload: dict[str, Any]) -> None:
        urls = payload.get("urls")
        if set(payload) != {"urls"} or not isinstance(urls, list) or not urls or len(urls) > MAX_BULK_URLS:
            self._error(HTTPStatus.BAD_REQUEST, f"urls must contain 1 to {MAX_BULK_URLS} items")
            return
        results = []
        for index, url in enumerate(urls):
            try:
                if not isinstance(url, str):
                    raise STORE_MODULE.StoreError("job URL must be a string")
                job = self.server.store.create_job({"url": url}, origin="human")
                results.append({"index": index, "url": url, "ok": True, "job": job})
            except (STORE_MODULE.StoreError, OSError) as error:
                results.append({"index": index, "url": url, "ok": False, "error": str(error)})
        self._json(HTTPStatus.OK, {"results": results})

    def do_OPTIONS(self) -> None:
        if not self._valid_host():
            return
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "cross-origin preflight is not supported", "method_rejected")

    def do_PUT(self) -> None:
        self._method_rejected()

    def do_DELETE(self) -> None:
        self._method_rejected()

    def _method_rejected(self) -> None:
        if not self._valid_host():
            return
        self._error(HTTPStatus.METHOD_NOT_ALLOWED, "method not allowed", "method_rejected")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Start the local Job Apply Jobs workspace")
    parser.add_argument(
        "--root",
        help=f"canonical store root (default: ${STORE_MODULE.STORE_ENV} or ~/.job-apply)",
    )
    parser.add_argument("--port", type=int, default=0, help="loopback port (default: choose a free port)")
    parser.add_argument("--no-open", action="store_true", help="do not open the default browser")
    parser.add_argument("--json", action="store_true", help="print startup details as one JSON line")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    if not 0 <= args.port <= 65535:
        print("job-apply-workspace: port must be between 0 and 65535", file=sys.stderr)
        return 2
    configured = args.root or os.environ.get(STORE_MODULE.STORE_ENV)
    store_root = Path(configured).expanduser() if configured else Path.home() / ".job-apply"
    try:
        server = WorkspaceServer(store_root, args.port)
    except (OSError, STORE_MODULE.StoreError) as error:
        print(f"job-apply-workspace: unable to start: {error}", file=sys.stderr)
        return 2
    url = f"{server.origin}/#token={server.token}"
    details = {"url": url, "origin": server.origin, "host": LOOPBACK, "port": server.server_port}
    if args.json:
        print(json.dumps(details, separators=(",", ":")), flush=True)
    else:
        print(f"Job Apply workspace: {url}", flush=True)
        print("Press Ctrl-C to stop. Data stays in the canonical local store.", flush=True)
    if not args.no_open:
        threading.Timer(0.15, lambda: webbrowser.open(url)).start()

    stopping = threading.Event()

    def stop(_signum: int | None = None, _frame: Any = None) -> None:
        if not stopping.is_set():
            stopping.set()
            threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGINT", "SIGTERM", "SIGBREAK"):
        sig = getattr(signal, name, None)
        if sig is not None:
            signal.signal(sig, stop)
    try:
        server.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        stop()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
