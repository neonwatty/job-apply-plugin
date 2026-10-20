"""Composed workspace server and route dispatcher."""

from __future__ import annotations

import secrets
import socket
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import (
    LOOPBACK,
    loopback_authority,
    runtime,
)
from .connections import WorkspaceConnection
from .auth import AuthMixin
from .domains.accounts import AccountMutationMixin
from .domains.answers import AnswerMutationMixin
from .domains.jobs import JobMutationMixin
from .domains.profile import ProfileMutationMixin
from .domains.resumes import ResumeMutationMixin
from .http import HttpMixin
from .queries import QueryMixin


def degraded_boot_status(error: Exception) -> dict[str, str]:
    """Classify startup failures without exposing exceptions, values, or paths."""

    message = str(error).lower()
    if "future schemaversion" in message:
        code = "future_store"
        summary = "This store was created by a newer Job Apply version."
    elif any(
        word in message
        for word in ("valid", "invalid", "corrupt", "tampered", "schema")
    ):
        code = "corrupt_store"
        summary = "The local store could not be validated."
    else:
        code = "unavailable_store"
        summary = "The local store is unavailable."
    return {
        "status": "degraded",
        "code": code,
        "summary": summary,
        "guidance": (
            "Stop the workspace, preserve the store directory, and use a "
            "known-good backup or the matching Job Apply version. No data was "
            "repaired or changed."
        ),
    }


class WorkspaceServer(ThreadingHTTPServer):
    daemon_threads = False
    allow_reuse_address = False

    def __init__(self, root: Path, port: int, token: str | None = None):
        # Plugin caches may be replaced while this process is still running.
        # Capture the complete allowlist before touching the Store or binding.
        workspace_runtime = runtime()
        try:
            self.assets = {
                route: ((workspace_runtime["ASSET_ROOT"] / filename).read_bytes(), media_type)
                for route, (filename, media_type) in workspace_runtime["ASSETS"].items()
            }
        except OSError:
            raise OSError("workspace assets are unavailable; reinstall this version and restart") from None
        store_module = runtime()["STORE_MODULE"]
        self.store = store_module.Store(root)
        self.boot_status = {"status": "ready", "code": "ready"}
        try:
            self.store.validate_workspace_startup()
        except (OSError, store_module.StoreError) as error:
            self.boot_status = degraded_boot_status(error)
        else:
            # Only read-only validation failures become degraded workspaces.
            # Initialization may migrate or repair state, so any failure there
            # aborts startup instead of making a no-mutation recovery claim.
            self.store.initialize()
        runtime_secrets = runtime().get("secrets", secrets)
        self.token = token or runtime_secrets.token_urlsafe(32)
        self._connections_lock = threading.Lock()
        self._connections: set[socket.socket] = set()
        self._closing = False
        self._closing_event = threading.Event()
        super().__init__((LOOPBACK, port), WorkspaceHandler)
        self.origin, self.expected_host = loopback_authority(self.server_port)

    def get_request(self):
        connection, address = super().get_request()
        return WorkspaceConnection(connection, self._closing_event), address

    def process_request(self, request, client_address):
        # Register before starting the worker so close cannot miss an accepted socket.
        with self._connections_lock:
            closing = self._closing
            if not closing:
                self._connections.add(request)
        if closing:
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.shutdown_request(request)
            raise

    def shutdown_request(self, request):
        try:
            super().shutdown_request(request)
        finally:
            with self._connections_lock:
                self._connections.discard(request)

    def server_close(self):
        # Stop socket reads/writes, then join workers. Store operations already in
        # progress finish normally before interpreter teardown can begin.
        with self._connections_lock:
            self._closing = True
            self._closing_event.set()
            connections = tuple(self._connections)
        for connection in connections:
            try:
                connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass  # The peer or request worker already closed this socket.
        super().server_close()

    def handle_error(self, request, client_address):
        # A browser disconnect (including shutdown above) is not an app failure.
        if isinstance(sys.exc_info()[1], ConnectionError):
            return
        super().handle_error(request, client_address)


class WorkspaceHandler(
    HttpMixin,
    AuthMixin,
    QueryMixin,
    AccountMutationMixin,
    ProfileMutationMixin,
    AnswerMutationMixin,
    ResumeMutationMixin,
    JobMutationMixin,
    BaseHTTPRequestHandler,
):
    server: WorkspaceServer
    protocol_version = "HTTP/1.1"

    def do_POST(self) -> None:
        self._mutate("POST")

    def do_PATCH(self) -> None:
        self._mutate("PATCH")

    def _mutate(self, method: str) -> None:
        path = self._path()
        if path is None or not self._authorized_api(mutation=True):
            return
        if self.server.boot_status["status"] != "ready":
            self._error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "canonical store is unavailable",
                "store_unavailable",
            )
            return
        parts = path.split("/")
        is_upload = method == "POST" and (
            path == "/api/resumes/import"
            or (
                len(parts) == 5
                and parts[1:3] == ["api", "resumes"]
                and parts[4] in {"replace", "adopt"}
            )
        )
        filename: str | None = None
        content: bytes | None = None
        if is_upload:
            upload = self._read_upload()
            if upload is None:
                return
            payload, filename, content = upload
        else:
            payload = self._read_json()
            if payload is None:
                return
        routes = (
            lambda: self._mutate_accounts(method, path, parts, payload),
            lambda: self._mutate_profile(method, path, parts, payload),
            lambda: self._mutate_answers(method, path, parts, payload),
            lambda: self._mutate_resumes(
                method, path, parts, payload, filename, content
            ),
            lambda: self._mutate_jobs(method, path, parts, payload),
        )
        if not any(route() for route in routes):
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")

    def do_OPTIONS(self) -> None:
        if self._valid_host():
            self._error(
                HTTPStatus.METHOD_NOT_ALLOWED,
                "cross-origin preflight is not supported",
                "method_rejected",
            )

    def do_PUT(self) -> None:
        self._method_rejected()

    def do_DELETE(self) -> None:
        self._method_rejected()

    def _method_rejected(self) -> None:
        if self._valid_host():
            self._error(
                HTTPStatus.METHOD_NOT_ALLOWED,
                "method not allowed",
                "method_rejected",
            )
