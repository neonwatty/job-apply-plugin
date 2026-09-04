"""Bounded HTTP parsing, response, and upload primitives."""

from __future__ import annotations

import base64
import binascii
import json
import re
import sys
from http import HTTPStatus
from typing import Any
from urllib.parse import unquote, urlsplit

from . import MAX_BODY_BYTES, MAX_UPLOAD_BODY_BYTES, MAX_UPLOAD_BYTES, runtime


class HttpMixin:
    """Protocol mechanics shared by workspace route mixins."""

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
        body = (
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"
        ).encode()
        self._send_bytes(status, body, "application/json; charset=utf-8")

    def _error(
        self,
        status: int,
        message: str,
        code: str = "request_error",
        details: dict[str, Any] | None = None,
    ) -> None:
        # Never let unread attacker-controlled bytes become another HTTP request.
        self.close_connection = True
        payload = {"code": code, "message": message}
        if details:
            payload.update(details)
        self._json(status, {"error": payload})

    def _path(self) -> str | None:
        parsed = urlsplit(self.path)
        if parsed.query or parsed.fragment:
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")
            return None
        try:
            unquote(parsed.path, errors="strict")
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
        store_module = runtime()["STORE_MODULE"]
        if not re.fullmatch(r"[A-Za-z0-9_-]+", raw_segment):
            raise store_module.StoreError("encoded answer key is invalid")
        padding = "=" * (-len(raw_segment) % 4)
        try:
            decoded = base64.b64decode(
                raw_segment + padding, altchars=b"-_", validate=True
            ).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError, ValueError):
            raise store_module.StoreError("encoded answer key is invalid") from None
        if not decoded:
            raise store_module.StoreError("encoded answer key is invalid")
        return decoded

    def _read_json(self, max_bytes: int = MAX_BODY_BYTES) -> dict[str, Any] | None:
        if self.headers.get("Content-Type") != "application/json":
            self._error(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "Content-Type must be application/json",
            )
            return None
        raw_length = self.headers.get("Content-Length")
        try:
            length = int(raw_length) if raw_length is not None else -1
        except ValueError:
            length = -1
        if length < 0:
            self._error(
                HTTPStatus.LENGTH_REQUIRED, "a valid Content-Length is required"
            )
            return None
        if length > max_bytes:
            self._error(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "request body is too large"
            )
            return None
        try:
            payload = json.loads(self.rfile.read(length))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._error(HTTPStatus.BAD_REQUEST, "request body must be valid JSON")
            return None
        if not isinstance(payload, dict):
            self._error(
                HTTPStatus.BAD_REQUEST, "request body must be a JSON object"
            )
            return None
        return payload

    def _read_upload(self) -> tuple[dict[str, Any], str, bytes] | None:
        payload = self._read_json(MAX_UPLOAD_BODY_BYTES)
        if payload is None:
            return None
        if set(payload) != {"metadata", "filename", "content"}:
            self._error(
                HTTPStatus.BAD_REQUEST,
                "upload body requires metadata, filename, and content",
            )
            return None
        metadata = payload["metadata"]
        filename = payload["filename"]
        encoded = payload["content"]
        if not isinstance(metadata, dict) or not isinstance(
            filename, str
        ) or not isinstance(encoded, str):
            self._error(
                HTTPStatus.BAD_REQUEST, "upload envelope fields have invalid types"
            )
            return None
        if len(encoded) > ((MAX_UPLOAD_BYTES + 2) // 3) * 4 or any(
            char.isspace() for char in encoded
        ):
            self._error(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "encoded resume content is too large",
            )
            return None
        try:
            content = base64.b64decode(encoded.encode("ascii"), validate=True)
        except (UnicodeEncodeError, binascii.Error):
            self._error(
                HTTPStatus.BAD_REQUEST, "resume content must be strict base64"
            )
            return None
        if len(content) > MAX_UPLOAD_BYTES:
            self._error(
                HTTPStatus.REQUEST_ENTITY_TOO_LARGE,
                "decoded resume content is too large",
            )
            return None
        return metadata, filename, content
