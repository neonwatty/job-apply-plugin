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

    hidden = {"path", "managedFile", "originalFilename", "digest", "contentRevision"}
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


def unified_trash_projection(store: Any) -> dict[str, Any]:
    """Return one deterministic, redacted view of every recoverable record."""

    jobs = store.list_jobs(include_trashed=True)
    resumes = store.list_resumes(include_trashed=True)
    answers = store.list_answers(include_trashed=True, review_status=None)
    sessions = {item["applicationId"]: item for item in store.list_sessions()}
    claim = store.claim_status()["claim"]
    items: list[dict[str, Any]] = []
    for record in jobs:
        if record.get("deletedAt") is None:
            continue
        session = sessions.get(record["id"])
        items.append({
            "type": "job",
            "id": record["id"],
            "revision": record["revision"],
            "deletedAt": record["deletedAt"],
            "label": record.get("role") or record.get("company") or "Untitled job",
            "secondaryLabel": record.get("company") or "",
            "status": record.get("status", "saved"),
            "blockerCounts": {
                "claims": int(claim is not None and claim.get("jobId") == record["id"]),
                "nonterminalSessions": int(
                    session is not None
                    and session.get("status") not in {"completed", "abandoned"}
                ),
            },
        })
    for record in resumes:
        if record.get("deletedAt") is None:
            continue
        items.append({
            "type": "resume",
            "id": record["id"],
            "revision": record["revision"],
            "deletedAt": record["deletedAt"],
            "label": record.get("label") or "Untitled resume",
            "blockerCounts": {
                "jobReferences": sum(
                    job.get("resumeId") == record["id"] for job in jobs
                ),
            },
        })
    for record in answers:
        if record.get("deletedAt") is None:
            continue
        references = record.get("referenceCounts", {})
        items.append({
            "type": "answer",
            "id": record["key"],
            "revision": record["revision"],
            "deletedAt": record["deletedAt"],
            "label": record.get("question") or record["key"],
            "state": record.get("state"),
            "reviewStatus": record.get("reviewStatus"),
            "blockerCounts": {
                "sessions": references.get("sessions", 0),
                "history": references.get("history", 0),
            },
        })
    items.sort(key=lambda item: (item["type"], item["label"].casefold(), item["id"]))
    counts = {
        kind: sum(item["type"] == kind for item in items)
        for kind in ("job", "resume", "answer")
    }
    return {"items": items, "counts": counts, "total": len(items)}


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
        self.boot_status = {"status": "ready", "code": "ready"}
        try:
            self.store.validate_workspace_startup()
        except (OSError, STORE_MODULE.StoreError) as error:
            self.boot_status = degraded_boot_status(error)
        else:
            # Only read-only validation failures become degraded workspaces.
            # Initialization may migrate or repair state, so any failure there
            # aborts startup instead of making a no-mutation recovery claim.
            self.store.initialize()
        self.token = token or secrets.token_urlsafe(32)
        super().__init__((LOOPBACK, port), WorkspaceHandler)
        self.origin, self.expected_host = loopback_authority(self.server_port)


def degraded_boot_status(error: Exception) -> dict[str, str]:
    """Classify startup failures without exposing exceptions, values, or paths."""

    message = str(error).lower()
    if "future schemaversion" in message:
        code = "future_store"
        summary = "This store was created by a newer Job Apply version."
    elif any(word in message for word in ("valid", "invalid", "corrupt", "tampered", "schema")):
        code = "corrupt_store"
        summary = "The local store could not be validated."
    else:
        code = "unavailable_store"
        summary = "The local store is unavailable."
    return {
        "status": "degraded",
        "code": code,
        "summary": summary,
        "guidance": "Stop the workspace, preserve the store directory, and use a known-good backup or the matching Job Apply version. No data was repaired or changed.",
    }


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

    def _error(
        self,
        status: int,
        message: str,
        code: str = "request_error",
        details: dict[str, Any] | None = None,
    ) -> None:
        # Error paths may reject before reading a request body. Never let unread,
        # attacker-controlled bytes become another HTTP/1.1 request.
        self.close_connection = True
        payload = {"code": code, "message": message}
        if details:
            payload.update(details)
        self._json(status, {"error": payload})

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
            elif "nonterminal application session" in message:
                self._error(HTTPStatus.CONFLICT, message, "session_reference_blocked")
            elif "claimed job" in message:
                self._error(HTTPStatus.CONFLICT, message, "claim_blocked")
            elif "referenced by an active session" in message:
                self._error(HTTPStatus.CONFLICT, message, "session_reference_blocked")
            elif "referenced by durable history" in message:
                self._error(HTTPStatus.CONFLICT, message, "history_reference_blocked")
            elif "referenced by a job" in message:
                self._error(HTTPStatus.CONFLICT, message, "job_reference_blocked")
            elif "active job URL already exists" in message:
                self._error(HTTPStatus.CONFLICT, message, "duplicate_active_blocked")
            else:
                self._error(HTTPStatus.BAD_REQUEST, message, "store_rejected")
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed", "storage_error")
        else:
            self._json(HTTPStatus.OK, result)

    def _lifecycle_call(
        self,
        record_type: str,
        operation: str,
        record_id: str,
        callback: Callable[[], Any],
        projection: Callable[[Any], Any] | None = None,
    ) -> None:
        try:
            result = callback()
        except STORE_MODULE.StoreError as error:
            message = str(error)
            code, safe_message, counts = self._lifecycle_blocker(
                record_type, operation, record_id, message
            )
            status = (
                HTTPStatus.NOT_FOUND if code == "not_found"
                else HTTPStatus.CONFLICT if code != "store_rejected"
                else HTTPStatus.BAD_REQUEST
            )
            self._error(status, safe_message, code, {
                "recordType": record_type,
                "operation": operation,
                "counts": counts,
            })
        except OSError:
            self._error(HTTPStatus.INTERNAL_SERVER_ERROR, "storage operation failed", "storage_error")
        else:
            self._json(HTTPStatus.OK, projection(result) if projection else result)

    def _lifecycle_blocker(
        self, record_type: str, operation: str, record_id: str, message: str
    ) -> tuple[str, str, dict[str, int]]:
        if "revision conflict" in message:
            return "revision_conflict", "This record changed elsewhere. Refresh and review the latest revision.", {}
        if "does not exist" in message and message != "assigned resume does not exist":
            return "not_found", "This record no longer exists.", {}
        mappings = (
            ("claimed job", "claim_blocked", "This job has a coordinator claim that must be released or completed first.", lambda: {"claims": 1}),
            ("nonterminal application session", "session_reference_blocked", "This job has a nonterminal application session that must be completed or abandoned first.", lambda: {"nonterminalSessions": 1}),
            ("referenced by an active session", "session_reference_blocked", "This answer is referenced by an active session and cannot be permanently deleted.", lambda: self._answer_reference_counts(record_id)),
            ("referenced by application history", "history_reference_blocked", "This answer is referenced by protected application history and cannot be permanently deleted.", lambda: self._answer_reference_counts(record_id)),
            ("still referenced by a job", "job_reference_blocked", "This resume is referenced by one or more jobs. Reassign or delete those jobs first.", lambda: self._resume_reference_counts(record_id)),
            ("active job URL already exists", "duplicate_active_blocked", "An active job with the same canonical identity already exists.", lambda: {"duplicateActiveRecords": 1}),
            ("active resume file already exists", "duplicate_active_blocked", "An active resume with the same canonical file identity already exists.", lambda: {"duplicateActiveRecords": 1}),
            ("assigned resume does not exist", "assigned_resume_blocked", "This job's assigned resume is unavailable. Restore or reassign that resume first.", lambda: {"unavailableAssignedResumes": 1}),
            ("answer is the target of an immutable redirect", "redirect_target_blocked", "This answer is a canonical redirect target and cannot be moved or deleted.", lambda: {}),
            ("resume is assigned to an active job", "job_reference_blocked", "This resume is assigned to an active job. Reassign that job first.", lambda: self._resume_reference_counts(record_id, active_only=True)),
            ("default resume is used by an active job", "default_reference_blocked", "This default resume is in use by active jobs. Assign another default first.", lambda: self._resume_reference_counts(record_id, active_only=True)),
        )
        for fragment, code, safe_message, counts_factory in mappings:
            if fragment in message:
                return code, safe_message, counts_factory()
        return "store_rejected", "The canonical store rejected this lifecycle operation.", {}

    def _answer_reference_counts(self, key: str) -> dict[str, int]:
        answer = self.server.store.get_answer(key, include_trashed=True)
        references = answer.get("referenceCounts", {}) if answer else {}
        return {
            "sessions": int(references.get("sessions", 0)),
            "history": int(references.get("history", 0)),
        }

    def _resume_reference_counts(
        self, resume_id: str, active_only: bool = False
    ) -> dict[str, int]:
        jobs = self.server.store.list_jobs(include_trashed=True)
        references = sum(
            job.get("resumeId") == resume_id
            and (not active_only or job.get("deletedAt") is None)
            for job in jobs
        )
        if active_only:
            resume = self.server.store.get_resume(resume_id, include_trashed=True)
            if resume and resume.get("default"):
                references += sum(
                    job.get("resumeId") is None and job.get("deletedAt") is None
                    for job in jobs
                )
        return {"jobReferences": references}

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
        if path == "/api/boot":
            self._json(HTTPStatus.OK, self.server.boot_status)
            return
        if self.server.boot_status["status"] != "ready":
            self._error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "canonical store is unavailable",
                "store_unavailable",
            )
            return
        if path == "/api/overview":
            self._store_call(self.server.store.owner_beta_overview)
            return
        if path == "/api/profile":
            self._store_call(self.server.store.inspect_profile)
            return
        if path == "/api/automation":
            self._store_call(lambda: {
                "settings": self.server.store.get_automation_settings(companion=True),
                "capability": self.server.store.automation_capability(),
                "accounts": self.server.store.list_employer_accounts(companion=True),
                "profileRevision": self.server.store.inspect_profile()["revision"],
            })
            return
        if path == "/api/account-operation":
            self._store_call(self.server.store.account_operation_status)
            return
        if path == "/api/fact-groups":
            self._store_call(lambda: {"groups": self.server.store.list_fact_groups()})
            return
        if path == "/api/state":
            self._store_call(lambda: {
                "jobs": self.server.store.list_jobs(),
                "resumes": public_resumes(self.server.store.list_resumes()),
            })
            return
        if path == "/api/attention":
            self._store_call(self.server.store.list_needs_attention)
            return
        if path == "/api/jobs":
            self._store_call(lambda: {"jobs": self.server.store.list_jobs()})
            return
        if path == "/api/trash":
            self._store_call(lambda: unified_trash_projection(self.server.store))
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
        if path == "/api/answers/cleanup-preview":
            self._store_call(self.server.store.preview_answer_cleanup)
            return
        parts = path.split("/")
        if len(parts) == 4 and parts[1:3] == ["api", "trusted-fill"]:
            self._store_call(lambda: self.server.store.trusted_fill_status(parts[3], public=True))
            return
        if len(parts) == 4 and parts[1:3] == ["api", "employer-accounts"]:
            def employer_account_detail() -> dict[str, Any]:
                account = self.server.store.get_employer_account(parts[3], public=True)
                if account is None:
                    raise STORE_MODULE.StoreError("employer account does not exist")
                return account
            self._store_call(employer_account_detail)
            return
        if len(parts) == 4 and parts[1:3] == ["api", "fact-groups"]:
            def fact_group_detail() -> dict[str, Any]:
                group = self.server.store.get_fact_group(parts[3])
                if group is None:
                    raise STORE_MODULE.StoreError("fact group does not exist")
                return group
            self._store_call(fact_group_detail)
            return
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
        if (
            len(parts) == 6
            and parts[1:3] == ["api", "jobs"]
            and parts[4] == "pending-answers"
        ):
            self._store_call(
                lambda: self.server.store.pending_answer_detail(parts[3], parts[5])
            )
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
        if len(parts) == 5 and parts[1:3] == ["api", "jobs"] and parts[4] == "activity":
            self._store_call(lambda: self.server.store.get_job_activity(parts[3]))
            return
        if len(parts) == 5 and parts[1:3] == ["api", "jobs"] and parts[4] == "preflight":
            self._store_call(lambda: self.server.store.preflight_job(parts[3]))
            return
        self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")

    def _require_job(
        self, job_id: str, include_trashed: bool = False
    ) -> dict[str, Any]:
        job = self.server.store.get_job(job_id, include_trashed=include_trashed)
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
        if self.server.boot_status["status"] != "ready":
            self._error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "canonical store is unavailable",
                "store_unavailable",
            )
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
        if method == "POST" and path == "/api/automation/realm-resolve":
            if set(payload) != {"url"} or not isinstance(payload.get("url"), str):
                self._error(HTTPStatus.BAD_REQUEST, "body must contain only a portal URL")
                return
            self._store_call(lambda: self.server.store.resolve_account_realm(payload["url"]))
            return
        if method == "POST" and path == "/api/trusted-fill/approve":
            self._store_call(lambda: self.server.store.approve_trusted_fill(payload, public=True))
            return
        if method == "POST" and path == "/api/account-operation/execute-synthetic":
            self._store_call(lambda: self.server.store.execute_synthetic_account(payload, public=True))
            return
        if method == "POST" and path == "/api/account-operation/recover":
            if payload != {}:
                self._error(HTTPStatus.BAD_REQUEST, "account recovery body must be empty")
                return
            self._store_call(self.server.store.recover_account_operation)
            return
        if method == "POST" and path == "/api/trusted-fill/evaluate":
            self._store_call(lambda: self.server.store.evaluate_trusted_fill(payload, public=True))
            return
        if (
            method == "POST" and len(route_parts) == 5
            and route_parts[1:3] == ["api", "trusted-fill"]
            and route_parts[4] == "revoke"
        ):
            if set(payload) != {"expectedApprovalRevision"}:
                self._error(HTTPStatus.BAD_REQUEST, "body must contain only expectedApprovalRevision")
                return
            expected_revision = payload.get("expectedApprovalRevision")
            if not isinstance(expected_revision, int) or isinstance(expected_revision, bool) or expected_revision < 1:
                self._error(HTTPStatus.BAD_REQUEST, "expectedApprovalRevision must be a positive integer")
                return
            self._store_call(lambda: self.server.store.revoke_trusted_fill(
                route_parts[3], expected_revision, public=True
            ))
            return
        if method == "PATCH" and path == "/api/automation/settings":
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(payload.get("patch"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body must contain a settings patch and expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(lambda: self.server.store.update_automation_settings(
                payload["patch"], expected_revision, public=True
            ))
            return
        if method == "POST" and path == "/api/automation/settings/copy-profile-email":
            if set(payload) != {"expectedProfileRevision", "expectedSettingsRevision"}:
                self._error(HTTPStatus.BAD_REQUEST, "body must contain exact profile and settings revisions")
                return
            profile_revision = payload.get("expectedProfileRevision")
            settings_revision = payload.get("expectedSettingsRevision")
            if any(
                not isinstance(value, int) or isinstance(value, bool) or value < 1
                for value in (profile_revision, settings_revision)
            ):
                self._error(HTTPStatus.BAD_REQUEST, "profile and settings revisions must be positive integers")
                return
            self._store_call(lambda: self.server.store.copy_profile_email_to_automation_settings(
                profile_revision, settings_revision, public=True,
            ))
            return
        if method == "POST" and path == "/api/employer-accounts":
            if set(payload) - {"url", "signupEmailOverride"} or "url" not in payload or not isinstance(payload["url"], str):
                self._error(HTTPStatus.BAD_REQUEST, "body must contain a portal URL and optional signup email override")
                return
            self._store_call(lambda: self.server.store.create_employer_account(
                payload["url"], payload.get("signupEmailOverride"), public=True
            ))
            return
        if method == "PATCH" and len(route_parts) == 4 and route_parts[1:3] == ["api", "employer-accounts"]:
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(payload.get("patch"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body must contain an account patch and expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(lambda: self.server.store.update_employer_account(
                route_parts[3], payload["patch"], expected_revision, public=True
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
        if method == "POST" and path == "/api/fact-groups":
            if set(payload) != {"group"} or not isinstance(payload.get("group"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body must contain only a fact group object")
                return
            self._store_call(lambda: self.server.store.create_fact_group(payload["group"]))
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
        if method == "POST" and path == "/api/answers/semantic":
            self._store_call(lambda: self.server.store.semantic_answer_lookup(payload))
            return
        if method == "POST" and path == "/api/answers/cleanup-approve":
            if set(payload) != {"approval", "ownerConfirmed"} or payload.get("ownerConfirmed") is not True or not isinstance(payload.get("approval"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "cleanup requires an explicit owner-approved preview")
                return
            self._store_call(lambda: self.server.store.approve_answer_cleanup(
                payload["approval"], owner_confirmed=True
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
        if (
            method == "POST" and len(parts) == 5
            and parts[1:3] == ["api", "jobs"]
            and parts[4] == "resolve-pending-answer"
        ):
            required = {
                "reference", "expectedJobRevision", "expectedSessionRevision",
                "expectedAnswerRevision", "ownerConfirmed",
            }
            if set(payload) != required or payload.get("ownerConfirmed") is not True:
                self._error(HTTPStatus.BAD_REQUEST, "body requires an explicit owner-confirmed exact-revision recheck")
                return
            revisions = [payload.get(name) for name in ("expectedJobRevision", "expectedSessionRevision", "expectedAnswerRevision")]
            if any(not isinstance(value, int) or isinstance(value, bool) or value < 1 for value in revisions):
                self._error(HTTPStatus.BAD_REQUEST, "all expected revisions must be positive integers")
                return
            self._store_call(lambda: self.server.store.resolve_pending_answer(
                parts[3], payload["reference"], payload["expectedJobRevision"],
                payload["expectedSessionRevision"], payload["expectedAnswerRevision"],
                owner_confirmed=True,
            ))
            return
        if (
            method == "POST" and len(parts) == 5
            and parts[1:3] == ["api", "jobs"]
            and parts[4] in {"approval-preview", "approval-approve"}
        ):
            required = {
                "expectedJobRevision", "expectedSessionRevision", "decisions"
            }
            if parts[4] == "approval-approve":
                required |= {"previewToken", "ownerConfirmed"}
            if set(payload) != required or not isinstance(payload.get("decisions"), list):
                self._error(HTTPStatus.BAD_REQUEST, "grouped approval body is invalid")
                return
            if parts[4] == "approval-preview":
                self._store_call(lambda: self.server.store.preview_grouped_approval(
                    parts[3], payload["expectedJobRevision"],
                    payload["expectedSessionRevision"], payload["decisions"],
                ))
            elif payload.get("ownerConfirmed") is not True:
                self._error(HTTPStatus.BAD_REQUEST, "grouped approval requires explicit owner confirmation")
            else:
                self._store_call(lambda: self.server.store.approve_grouped_approval(
                    parts[3], payload["expectedJobRevision"],
                    payload["expectedSessionRevision"], payload["decisions"],
                    payload["previewToken"], owner_confirmed=True,
                ))
            return
        if len(parts) == 4 and parts[1:3] == ["api", "fact-groups"] and method == "PATCH":
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(payload.get("patch"), dict):
                self._error(HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(lambda: self.server.store.update_fact_group(
                parts[3], payload["patch"], expected_revision
            ))
            return
        if (
            len(parts) == 5
            and parts[1:3] == ["api", "fact-groups"]
            and parts[4] == "delete"
            and method == "POST"
        ):
            if set(payload) != {"expectedRevision"}:
                self._error(HTTPStatus.BAD_REQUEST, "delete body requires expectedRevision")
                return
            expected_revision = self._expected_revision(payload)
            if expected_revision is None:
                return
            self._store_call(lambda: self.server.store.delete_fact_group(
                parts[3], expected_revision
            ))
            return
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
                self._lifecycle_call(
                    "answer", action, answer_id,
                    lambda: operation(answer_id, expected_revision),
                )
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
                self._lifecycle_call(
                    "resume", action, resume_id,
                    lambda: operations[action](resume_id, expected_revision),
                    public_resume,
                )
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
            if action in {"trash", "restore", "delete"} and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(HTTPStatus.BAD_REQUEST, f"{action} body requires expectedRevision")
                    return
                expected_revision = self._expected_revision(payload)
                if expected_revision is None:
                    return
                operations = {
                    "trash": self.server.store.trash_job,
                    "restore": self.server.store.restore_job,
                    "delete": self.server.store.delete_job,
                }
                self._lifecycle_call(
                    "job", action, job_id,
                    lambda: operations[action](job_id, expected_revision),
                )
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
