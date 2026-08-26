#!/usr/bin/env python3
"""Secure loopback companion workspace for canonical Job Apply records."""

from __future__ import annotations

import argparse
import base64
import binascii
import importlib.util
import json
import os
import re
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
MAX_UPLOAD_BYTES = 10 * 1024 * 1024
# Base64 is 4/3 of the decoded body. The small allowance covers the JSON
# envelope, metadata, and escaping without making ordinary routes unbounded.
MAX_UPLOAD_BODY_BYTES = ((MAX_UPLOAD_BYTES + 2) // 3) * 4 + MAX_BODY_BYTES
MAX_BULK_URLS = 50
ROOT = Path(__file__).resolve().parent.parent
ASSET_ROOT = ROOT / "workspace"
ASSETS = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}


def loopback_authority(port: int) -> tuple[str, str]:
    if port == 80:
        return f"http://{LOOPBACK}", LOOPBACK
    return f"http://{LOOPBACK}:{port}", f"{LOOPBACK}:{port}"


def load_store_module() -> Any:
    path = Path(__file__).resolve().with_name("job-apply-store.py")
    spec = importlib.util.spec_from_file_location("job_apply_store", path)
    if spec is None or spec.loader is None:
        raise RuntimeError("unable to load the canonical Job Apply store")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


STORE_MODULE = load_store_module()


def public_resume(record: dict[str, Any]) -> dict[str, Any]:
    """Project resume metadata without filesystem or document identity data."""

    hidden = {"path", "managedFile", "originalFilename", "digest"}
    return {key: value for key, value in record.items() if key not in hidden}


def public_resumes(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [public_resume(record) for record in records]


def resume_projection(
    record: dict[str, Any], jobs: list[dict[str, Any]], proposals: list[dict[str, Any]]
) -> dict[str, Any]:
    result = public_resume(record)
    result["assignedJobCount"] = sum(
        item.get("deletedAt") is None and item.get("resumeId") == record["id"]
        for item in jobs
    )
    result["implicitJobCount"] = sum(
        record.get("default") and item.get("deletedAt") is None and item.get("resumeId") is None
        for item in jobs
    )
    related = [item for item in proposals if item.get("resumeId") == record["id"]]
    result["proposalStatus"] = next(
        ("pending" for item in related if item.get("status") == "pending"),
        "completed" if related else None,
    )
    result["pendingConflictCount"] = sum(
        len(item.get("pendingPaths", [])) for item in related if item.get("status") == "pending"
    )
    return result


def public_proposal_summary(record: dict[str, Any]) -> dict[str, Any]:
    allowed = {
        "id", "resumeId", "resumeRevision", "profileRevision",
        "resultProfileRevision", "status",
        "revision", "createdAt", "updatedAt", "supersededBy", "staleReasons",
    }
    summary = {key: value for key, value in record.items() if key in allowed}
    summary["autoFilledCount"] = len(record.get("autoFilledPaths", []))
    summary["pendingCount"] = len(record.get("pendingPaths", []))
    return summary


def public_proposal_detail(
    record: dict[str, Any], inspection: dict[str, Any]
) -> dict[str, Any]:
    detail = public_proposal_summary(record)
    detail["candidate"] = record.get("candidate", {})
    detail["pendingPaths"] = record.get("pendingPaths", [])
    detail["liveProfileRevision"] = inspection["revision"]
    current: dict[str, Any] = {}
    replacements: dict[str, Any] = {}
    for pointer in record.get("pendingPaths", []):
        exists, value = STORE_MODULE._pointer_lookup(inspection["profile"], pointer)
        current[pointer] = {"exists": exists, "value": value if exists else None}
        replacement = STORE_MODULE._replacement_scope(
            STORE_MODULE._pointer_baseline(inspection["profile"], pointer)
        )
        if replacement is not None:
            replacements[pointer] = replacement
    detail["currentValues"] = current
    detail["replacementScopes"] = replacements
    return detail


class WorkspaceServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False

    def __init__(self, root: Path, port: int, token: str | None = None):
        self.store = STORE_MODULE.Store(root)
        self.store.initialize()
        self.token = token or secrets.token_urlsafe(32)
        super().__init__((LOOPBACK, port), WorkspaceHandler)
        self.origin, self.expected_host = loopback_authority(self.server_port)


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
        if re.search(r"%(?![0-9A-Fa-f]{2})", parsed.path):
            self._error(HTTPStatus.BAD_REQUEST, "request path is invalid")
            return None
        return parsed.path

    @staticmethod
    def _answer_key(raw_segment: str) -> str:
        return unquote(raw_segment, errors="strict")

    @staticmethod
    def _encoded_answer_key(raw_segment: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]+", raw_segment):
            raise STORE_MODULE.StoreError("encoded answer key is invalid")
        padding = "=" * (-len(raw_segment) % 4)
        try:
            decoded = base64.b64decode(
                raw_segment + padding, altchars=b"-_", validate=True
            ).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            raise STORE_MODULE.StoreError("encoded answer key is invalid") from None
        if not decoded:
            raise STORE_MODULE.StoreError("encoded answer key is invalid")
        return decoded

    def _read_json(self, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any] | None:
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
        if length > max_bytes:
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

    def _read_upload(self) -> tuple[dict[str, Any], str, bytes] | None:
        payload = self._read_json(MAX_UPLOAD_BODY_BYTES)
        if payload is None:
            return None
        if set(payload) != {"metadata", "filename", "content"}:
            self._error(HTTPStatus.BAD_REQUEST, "upload body requires metadata, filename, and content")
            return None
        metadata, filename, encoded = payload["metadata"], payload["filename"], payload["content"]
        if not isinstance(metadata, dict) or not isinstance(filename, str) or not isinstance(encoded, str):
            self._error(HTTPStatus.BAD_REQUEST, "upload envelope fields have invalid types")
            return None
        if len(encoded) > ((MAX_UPLOAD_BYTES + 2) // 3) * 4 or any(char.isspace() for char in encoded):
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "encoded resume content is too large")
            return None
        try:
            content = base64.b64decode(encoded.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error):
            self._error(HTTPStatus.BAD_REQUEST, "resume content must be strict base64")
            return None
        if len(content) > MAX_UPLOAD_BYTES:
            self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "decoded resume content is too large")
            return None
        return metadata, filename, content

    def _store_call(self, callback: Callable[[], Any]) -> None:
        try:
            result = callback()
        except STORE_MODULE.StoreError as error:
            message = str(error)
            if "revision conflict" in message:
                self._error(HTTPStatus.CONFLICT, message, "revision_conflict")
            elif "stale" in message:
                self._error(HTTPStatus.CONFLICT, message, "stale_conflict")
            elif "baseline changed" in message:
                self._error(HTTPStatus.CONFLICT, message, "baseline_conflict")
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
        if path == "/api/profile":
            self._store_call(self.server.store.inspect_profile)
            return
        if path == "/api/state":
            self._store_call(lambda: {
                "jobs": self.server.store.list_jobs(),
                "resumes": public_resumes(self.server.store.list_resumes()),
            })
            return
        if path == "/api/jobs":
            self._store_call(lambda: {"jobs": self.server.store.list_jobs()})
            return
        if path == "/api/resumes":
            self._store_call(lambda: {"resumes": self._resume_list(False)})
            return
        if path == "/api/resumes/trash":
            self._store_call(lambda: {"resumes": self._resume_list(True)})
            return
        if path == "/api/resume-proposals":
            self._store_call(lambda: {
                "proposals": [
                    public_proposal_summary(item)
                    for item in self.server.store.list_resume_proposals()
                ]
            })
            return
        if path == "/api/answers":
            self._store_call(lambda: self.server.store.query_answers())
            return
        parts = path.split("/")
        if len(parts) == 5 and parts[1:4] == ["api", "answers", "by-key"]:
            def encoded_answer_detail() -> dict[str, Any]:
                answer = self.server.store.get_answer(
                    self._encoded_answer_key(parts[4]), include_trashed=True
                )
                if answer is None:
                    raise STORE_MODULE.StoreError("answer does not exist")
                return answer
            self._store_call(encoded_answer_detail)
            return
        if len(parts) == 4 and parts[1:3] == ["api", "answers"]:
            def answer_detail() -> dict[str, Any]:
                answer = self.server.store.get_answer(
                    self._answer_key(parts[3]), include_trashed=True
                )
                if answer is None:
                    raise STORE_MODULE.StoreError("answer does not exist")
                return answer
            self._store_call(answer_detail)
            return
        if len(parts) == 4 and parts[1:3] == ["api", "resumes"]:
            self._store_call(lambda: self._resume_projection(parts[3]))
            return
        if len(parts) == 5 and parts[1:3] == ["api", "resumes"] and parts[4] == "content":
            self._send_resume_content(parts[3])
            return
        if len(parts) == 4 and parts[1:3] == ["api", "resume-proposals"]:
            self._store_call(lambda: self._proposal_detail(parts[3]))
            return
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

    def _require_resume(self, resume_id: str, include_trashed: bool = False) -> dict[str, Any]:
        resume = self.server.store.get_resume(resume_id, include_trashed=include_trashed)
        if resume is None:
            raise STORE_MODULE.StoreError("resume does not exist")
        return resume

    def _resume_list(self, trashed: bool) -> list[dict[str, Any]]:
        jobs = self.server.store.list_jobs(include_trashed=True)
        proposals = self.server.store.list_resume_proposals()
        records = self.server.store.list_resumes(include_trashed=trashed)
        if trashed:
            records = [item for item in records if item.get("deletedAt") is not None]
        return [resume_projection(item, jobs, proposals) for item in records]

    def _resume_projection(self, resume_id: str) -> dict[str, Any]:
        record = self._require_resume(resume_id, True)
        return resume_projection(
            record,
            self.server.store.list_jobs(include_trashed=True),
            self.server.store.list_resume_proposals(resume_id=resume_id),
        )

    def _proposal_detail(self, proposal_id: str) -> dict[str, Any]:
        proposal = self.server.store.get_resume_proposal(proposal_id)
        if proposal is None:
            raise STORE_MODULE.StoreError("resume proposal does not exist")
        return public_proposal_detail(proposal, self.server.store.inspect_profile())

    def _send_resume_content(self, resume_id: str) -> None:
        try:
            record, content = self.server.store.read_resume_content(resume_id)
        except STORE_MODULE.StoreError as error:
            message = str(error)
            self._error(
                HTTPStatus.NOT_FOUND if "does not exist" in message else HTTPStatus.CONFLICT,
                message,
                "not_found" if "does not exist" in message else "content_unavailable",
            )
            return
        extension = {value: key for key, value in STORE_MODULE.RESUME_MEDIA_TYPES.items()}[record["mediaType"]]
        disposition = "attachment" if extension == ".docx" else "inline"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", record["mediaType"])
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Content-Disposition", f'{disposition}; filename="resume-{resume_id}{extension}"')
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)

    def do_POST(self) -> None:
        self._mutate("POST")

    def do_PATCH(self) -> None:
        self._mutate("PATCH")

    def _mutate(self, method: str) -> None:
        path = self._path()
        if path is None or not self._authorized_api(mutation=True):
            return
        route_parts = path.split("/")
        is_upload = method == "POST" and (
            path == "/api/resumes/import"
            or (
                len(route_parts) == 5
                and route_parts[1:3] == ["api", "resumes"]
                and route_parts[4] in {"replace", "adopt"}
            )
        )
        upload = self._read_upload() if is_upload else None
        payload = None if is_upload else self._read_json()
        if is_upload and upload is None:
            return
        if payload is None:
            if not is_upload:
                return
            metadata, filename, content = upload
            payload = metadata
        if method == "POST" and path == "/api/resumes/import":
            self._store_call(lambda: public_resume(
                self.server.store.create_resume_bytes(payload, filename, content)
            ))
            return
        if method == "PATCH" and path == "/api/profile":
            allowed = {"patch", "expectedRevision", "atomicPaths", "deletedPaths"}
            atomic_paths = payload.get("atomicPaths", [])
            deleted_paths = payload.get("deletedPaths", [])
            if (
                set(payload) - allowed
                or not {"patch", "expectedRevision"} <= set(payload)
                or not isinstance(payload.get("patch"), dict)
                or not payload["patch"]
                or not isinstance(atomic_paths, list)
                or not all(isinstance(item, str) for item in atomic_paths)
                or not isinstance(deleted_paths, list)
                or not all(isinstance(item, str) for item in deleted_paths)
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body requires a non-empty patch object, expectedRevision, and valid path lists",
                )
                return
            try:
                atomic_keys = {
                    STORE_MODULE._top_level_pointer_key(item) for item in atomic_paths
                }
            except STORE_MODULE.StoreError as error:
                self._error(HTTPStatus.BAD_REQUEST, str(error))
                return
            if (
                len(set(atomic_paths)) != len(atomic_paths)
                or len(set(deleted_paths)) != len(deleted_paths)
                or not set(deleted_paths) <= set(atomic_paths)
                or atomic_keys & STORE_MODULE.PROFILE_NAMED_TOP_LEVEL
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "atomic paths must uniquely identify Additional facts and include every deletion",
                )
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(
                lambda: self.server.store.patch_profile(
                    payload["patch"], expected_revision, source="user",
                    atomic_paths=atomic_paths, deleted_paths=deleted_paths,
                )
            )
            return
        if method == "POST" and path == "/api/jobs":
            job = payload.get("job")
            if not isinstance(job, dict) or set(payload) != {"job"}:
                self._error(HTTPStatus.BAD_REQUEST, "body must contain only a job object")
                return
            self._store_call(lambda: self.server.store.create_job(job, origin="human"))
            return
        if method == "POST" and path == "/api/answers/query":
            allowed = {"query", "state", "reviewStatus", "includeTrashed", "trashedOnly", "offset", "limit"}
            if set(payload) - allowed:
                self._error(HTTPStatus.BAD_REQUEST, "answer query contains unsupported fields")
                return
            self._store_call(lambda: self.server.store.query_answers(
                query=payload.get("query", ""), state=payload.get("state"),
                review_status=payload.get("reviewStatus", "accepted"),
                include_trashed=payload.get("includeTrashed", False),
                trashed_only=payload.get("trashedOnly", False),
                offset=payload.get("offset", 0), limit=payload.get("limit", 50),
            ))
            return
        if method == "POST" and path == "/api/answers":
            if set(payload) - {"answer", "expectedRevision", "rememberSensitive"} or not isinstance(payload.get("answer"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body requires an answer object")
                return
            if "rememberSensitive" in payload and not isinstance(
                payload["rememberSensitive"], bool
            ):
                self._error(HTTPStatus.BAD_REQUEST, "rememberSensitive must be a boolean")
                return
            self._store_call(lambda: self.server.store.put_answer(
                payload["answer"], payload.get("rememberSensitive", False), payload.get("expectedRevision")
            ))
            return
        if method == "POST" and path == "/api/answers/observe":
            if set(payload) != {"answer"} or not isinstance(payload.get("answer"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body must contain only an answer object")
                return
            self._store_call(lambda: self.server.store.observe_answer(payload["answer"]))
            return
        if method == "POST" and path == "/api/jobs/bulk":
            self._bulk_create(payload)
            return
        parts = path.split("/")
        encoded_answer_route = (
            len(parts) in {5, 6}
            and parts[1:4] == ["api", "answers", "by-key"]
        )
        legacy_answer_route = len(parts) in {4, 5} and parts[1:3] == ["api", "answers"]
        if method == "PATCH" and (
            (encoded_answer_route and len(parts) == 5)
            or (legacy_answer_route and len(parts) == 4)
        ):
            if set(payload) - {"patch", "expectedRevision", "rememberSensitive"} or not isinstance(payload.get("patch"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            if "rememberSensitive" in payload and not isinstance(
                payload["rememberSensitive"], bool
            ):
                self._error(HTTPStatus.BAD_REQUEST, "rememberSensitive must be a boolean")
                return
            self._store_call(lambda: self.server.store.update_answer(
                (
                    self._encoded_answer_key(parts[4])
                    if encoded_answer_route
                    else self._answer_key(parts[3])
                ),
                payload["patch"], expected_revision,
                payload.get("rememberSensitive", False)
            ))
            return
        if method == "POST" and (
            (encoded_answer_route and len(parts) == 6)
            or (legacy_answer_route and len(parts) == 5)
        ):
            try:
                answer_id, action = (
                    (self._encoded_answer_key(parts[4]), parts[5])
                    if encoded_answer_route
                    else (self._answer_key(parts[3]), parts[4])
                )
            except STORE_MODULE.StoreError as error:
                self._error(HTTPStatus.BAD_REQUEST, str(error))
                return
            if action == "reveal":
                if payload:
                    self._error(HTTPStatus.BAD_REQUEST, "reveal body must be empty")
                    return
                self._store_call(lambda: self.server.store.reveal_answer(answer_id))
                return
            if action == "merge":
                allowed = {
                    "winnerKey", "expectedWinnerRevision", "expectedSourceRevision"
                }
                if set(payload) != allowed:
                    self._error(HTTPStatus.BAD_REQUEST, "answer merge body is invalid")
                    return
                winner_key = payload.get("winnerKey")
                winner_revision = payload.get("expectedWinnerRevision")
                source_revision = payload.get("expectedSourceRevision")
                if (
                    not isinstance(winner_key, str)
                    or not winner_key
                    or not isinstance(winner_revision, int)
                    or isinstance(winner_revision, bool)
                    or winner_revision < 1
                    or not isinstance(source_revision, int)
                    or isinstance(source_revision, bool)
                    or source_revision < 1
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "answer merge body is invalid")
                    return
                self._store_call(lambda: self.server.store.merge_answers(
                    winner_key, answer_id, winner_revision, source_revision
                ))
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            if action in {"accept", "decline"}:
                allowed = {"expectedRevision", "patch", "rememberSensitive"}
                if set(payload) - allowed or not isinstance(payload.get("patch", {}), dict):
                    self._error(HTTPStatus.BAD_REQUEST, "answer review body is invalid")
                    return
                if "rememberSensitive" in payload and not isinstance(
                    payload["rememberSensitive"], bool
                ):
                    self._error(HTTPStatus.BAD_REQUEST, "rememberSensitive must be a boolean")
                    return
                self._store_call(lambda: self.server.store.review_answer(
                    answer_id, "accepted" if action == "accept" else "declined",
                    expected_revision, payload.get("patch"), payload.get("rememberSensitive", False),
                ))
                return
            if set(payload) != {"expectedRevision"}:
                self._error(HTTPStatus.BAD_REQUEST, f"{action} body requires expectedRevision")
                return
            operations = {
                "trash": self.server.store.trash_answer,
                "restore": self.server.store.restore_answer,
                "delete": self.server.store.delete_answer,
            }
            if action in operations:
                operation = operations[action]
                self._store_call(lambda: (
                    operation(answer_id, expected_revision)
                    if action == "delete" else operation(answer_id, expected_revision)
                ))
                return
        if len(parts) == 4 and parts[1:3] == ["api", "resumes"] and method == "PATCH":
            if (
                set(payload) != {"patch", "expectedRevision"}
                or not isinstance(payload.get("patch"), dict)
                or not payload["patch"]
                or set(payload["patch"]) - {"label", "tags"}
            ):
                self._error(HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(lambda: public_resume(self.server.store.update_resume(
                parts[3], payload["patch"], expected_revision
            )))
            return
        if len(parts) == 5 and parts[1:3] == ["api", "resumes"]:
            resume_id, action = parts[3], parts[4]
            if action in {"replace", "adopt"} and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(HTTPStatus.BAD_REQUEST, f"{action} metadata requires expectedRevision")
                    return
                expected_revision = self._expected_revision(payload)
                if expected_revision is None:
                    return
                operation = (
                    self.server.store.update_resume_bytes if action == "replace"
                    else self.server.store.adopt_resume_bytes
                )
                self._store_call(lambda: public_resume(operation(
                    resume_id, filename, content, expected_revision
                )))
                return
            if action in {"default", "trash", "restore", "delete"} and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(HTTPStatus.BAD_REQUEST, f"{action} body requires expectedRevision")
                    return
                expected_revision = self._expected_revision(payload)
                if expected_revision is None:
                    return
                operations = {
                    "default": self.server.store.set_default_resume,
                    "trash": self.server.store.trash_resume,
                    "restore": self.server.store.restore_resume,
                    "delete": self.server.store.delete_resume,
                }
                self._store_call(lambda: public_resume(operations[action](resume_id, expected_revision)))
                return
        if len(parts) == 5 and parts[1:3] == ["api", "resume-proposals"] and parts[4] == "review" and method == "POST":
            if set(payload) - {"decisions", "replacementConfirmations", "expectedRevision", "expectedProfileRevision"} or not {"decisions", "expectedRevision", "expectedProfileRevision"} <= set(payload) or not isinstance(payload.get("decisions"), dict) or not isinstance(payload.get("replacementConfirmations", {}), dict):
                self._error(HTTPStatus.BAD_REQUEST, "review body is invalid")
                return
            expected_revision = self._expected_revision(payload)
            profile_revision = payload.get("expectedProfileRevision")
            if expected_revision is None:
                return
            if not isinstance(profile_revision, int) or isinstance(profile_revision, bool) or profile_revision < 1:
                self._error(HTTPStatus.BAD_REQUEST, "expectedProfileRevision must be a positive integer")
                return
            self._store_call(lambda: public_proposal_summary(
                self.server.store.review_resume_proposal(
                    parts[3], {"decisions": payload["decisions"], "replacementConfirmations": payload.get("replacementConfirmations", {})}, expected_revision, profile_revision
                )
            ))
            return
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
