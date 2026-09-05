"""Bounded, descriptor-safe primitives for replay oracle artifacts."""

from __future__ import annotations

import json
import os
import re
import stat
from typing import Any

MAX_ARTIFACT_BYTES = 1024 * 1024
MAX_JSON_DEPTH = 64
MAX_JSON_NODES = 100_000
APPLICATION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class OracleError(ValueError):
    """An invalid untrusted oracle input with a stable, value-free diagnostic."""


def _has_forbidden_value_key(key: str) -> bool:
    lowered = key.lower()
    return lowered == "value" or lowered.endswith("value")


def _json_tree_has_forbidden_value_key(value: Any, diagnostic: str) -> bool:
    stack = [(value, 0)]
    nodes = 0
    forbidden = False
    while stack:
        current, depth = stack.pop()
        nodes += 1
        if depth > MAX_JSON_DEPTH or nodes > MAX_JSON_NODES:
            raise OracleError(diagnostic)
        if isinstance(current, dict):
            for key, child in current.items():
                if not isinstance(key, str):
                    raise OracleError(diagnostic)
                forbidden = forbidden or _has_forbidden_value_key(key)
                stack.append((child, depth + 1))
        elif isinstance(current, list):
            stack.extend((child, depth + 1) for child in current)
    return forbidden


def _inspect_json_tree(value: Any, diagnostic: str) -> None:
    if _json_tree_has_forbidden_value_key(value, diagnostic):
        raise OracleError(diagnostic)


def _validate_string_fields(value: dict[str, Any], fields: set[str]) -> bool:
    return all(
        field not in value
        or value[field] is None
        or isinstance(value[field], str)
        for field in fields
    )


def _valid_application_id(value: Any) -> bool:
    return (
        isinstance(value, str)
        and APPLICATION_ID.fullmatch(value) is not None
        and ".." not in value
    )


def _read_regular_file(
    directory_descriptor: int,
    name: str,
    diagnostic: str,
    expected_identity: os.stat_result | None = None,
) -> bytes:
    descriptor = None
    try:
        descriptor = os.open(
            name,
            os.O_RDONLY | os.O_NOFOLLOW,
            dir_fd=directory_descriptor,
        )
        try:
            opened_stat = os.fstat(descriptor)
            if (
                not stat.S_ISREG(opened_stat.st_mode)
                or opened_stat.st_size > MAX_ARTIFACT_BYTES
                or (
                    expected_identity is not None
                    and (expected_identity.st_dev, expected_identity.st_ino)
                    != (opened_stat.st_dev, opened_stat.st_ino)
                )
            ):
                raise OracleError(diagnostic)
            chunks: list[bytes] = []
            remaining = MAX_ARTIFACT_BYTES + 1
            while remaining:
                chunk = os.read(descriptor, min(64 * 1024, remaining))
                if not chunk:
                    break
                chunks.append(chunk)
                remaining -= len(chunk)
            data = b"".join(chunks)
            if len(data) > MAX_ARTIFACT_BYTES:
                raise OracleError(diagnostic)
            return data
        finally:
            os.close(descriptor)
            descriptor = None
    except OracleError:
        raise
    except (OSError, ValueError):
        if descriptor is not None:
            os.close(descriptor)
        raise OracleError(diagnostic) from None


def _parse_json(data: bytes, diagnostic: str) -> Any:
    try:
        return json.loads(data.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError, RecursionError):
        raise OracleError(diagnostic) from None
