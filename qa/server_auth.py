"""Loopback request authentication for the replay server."""

from __future__ import annotations

import re
import secrets


HOST = "127.0.0.1"
INVALID_BODY = object()
JSON_CONTENT_TYPE = re.compile(
    r"application/json(?:;[ \t]*charset[ \t]*=[ \t]*utf-8)?",
    re.IGNORECASE,
)
TOKEN = re.compile(r"^[a-f0-9]{64}$")


def has_local_host(handler) -> bool:
    hosts = handler.headers.get_all("Host", failobj=[])
    expected = f"{HOST}:{handler.server.server_address[1]}"
    return len(hosts) == 1 and hosts[0] == expected


def authorize_post(handler) -> bool:
    if not has_local_host(handler):
        handler._error(400, "invalid local request")
        return False
    origins = handler.headers.get_all("Origin", failobj=[])
    expected_origin = f"http://{HOST}:{handler.server.server_address[1]}"
    if len(origins) != 1 or origins[0] != expected_origin:
        handler._error(403, "invalid local request")
        return False
    content_types = handler.headers.get_all("Content-Type", failobj=[])
    if (
        len(content_types) != 1
        or JSON_CONTENT_TYPE.fullmatch(content_types[0]) is None
    ):
        handler._error(415, "invalid content type")
        return False
    return True


def has_run_token(handler) -> bool:
    configured = handler.server.shutdown_token
    supplied = handler.headers.get_all("X-QA-Run-Token", failobj=[])
    return (
        isinstance(configured, str)
        and len(supplied) == 1
        and secrets.compare_digest(supplied[0], configured)
    )
