"""Composed workspace server and route dispatcher."""

from __future__ import annotations

import secrets
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from . import (
    LOOPBACK,
    loopback_authority,
    runtime,
)
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
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, root: Path, port: int, token: str | None = None):
        store_module = runtime()["STORE_MODULE"]
        self.store = store_module.Store(root)
        self.boot_status = {"status": "ready", "code": "ready"}
        try:
            self.store.validate_workspace_startup()
        except (OSError, store_module.StoreError) as error:
            self.boot_status = degraded_boot_status(error)
        else:
            # Validation failures can degrade safely; failed repair must abort.
            self.store.initialize()
        runtime_secrets = runtime().get("secrets", secrets)
        self.token = token or runtime_secrets.token_urlsafe(32)
        super().__init__((LOOPBACK, port), WorkspaceHandler)
        self.origin, self.expected_host = loopback_authority(self.server_port)


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
