"""Human approval creation and validation for promotion candidates."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
from pathlib import Path
import re
import sys
from typing import Any

from qa.compiler import COMPILER_VERSION
from qa.contracts import ContractError, validate_fixture
from qa.promotion.bindings import (
    PromotionError,
    _assert_private_binding,
    _atomic_write_at,
    _json_bytes,
    _open_private_binding,
    _parse_json_bytes,
    _read_regular_at,
    _require_posix_capabilities,
)


SCANNER_VERSION = "1.0.0"
PROMOTION_SCHEMA_VERSION = 1
REVIEWER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
APPROVAL_KEYS = {
    "schemaVersion",
    "reviewer",
    "fixtureSha256",
    "compilerVersion",
    "scannerVersion",
    "approvedAt",
}


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _timestamp(value: str | None, *, _runtime: Any | None = None) -> str:
    runtime = _resolve_runtime(_runtime)
    if value is None:
        value = (
            runtime.datetime.now(runtime.timezone.utc)
            .replace(microsecond=0)
            .isoformat()
            .replace("+00:00", "Z")
        )
    if not isinstance(value, str) or len(value) > 64:
        raise PromotionError("invalid timestamp")
    try:
        parsed = runtime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise PromotionError("invalid timestamp") from None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise PromotionError("invalid timestamp")
    return value


def approve_candidate(
    candidate: Path,
    reviewer: str,
    now: str | None = None,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    """Bind a human approval to the exact candidate bytes and versions."""

    runtime = _resolve_runtime(_runtime)
    runtime._require_posix_capabilities()
    binding = runtime._open_private_binding(runtime.Path(candidate))
    try:
        if not isinstance(reviewer, str) or not runtime.REVIEWER.fullmatch(reviewer):
            raise PromotionError("invalid reviewer")
        fixture_bytes = runtime._read_regular_at(
            binding.candidate_descriptor,
            "fixture.json",
            "invalid fixture artifact",
        )
        fixture = runtime._parse_json_bytes(
            fixture_bytes, "invalid fixture artifact"
        )
        try:
            runtime.validate_fixture(fixture)
        except ContractError:
            raise PromotionError("invalid fixture artifact") from None
        approval = {
            "schemaVersion": runtime.PROMOTION_SCHEMA_VERSION,
            "reviewer": reviewer,
            "fixtureSha256": runtime.hashlib.sha256(fixture_bytes).hexdigest(),
            "compilerVersion": runtime.COMPILER_VERSION,
            "scannerVersion": runtime.SCANNER_VERSION,
            "approvedAt": runtime._timestamp(now),
        }
        runtime._assert_private_binding(binding)
        runtime._atomic_write_at(
            binding.candidate_descriptor,
            "approval.json",
            runtime._json_bytes(approval),
        )
        runtime._assert_private_binding(binding)
        return approval
    finally:
        binding.close()


def _validate_approval(
    value: Any, digest: str, *, _runtime: Any | None = None
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    if not isinstance(value, dict) or set(value) != runtime.APPROVAL_KEYS:
        raise PromotionError("invalid approval")
    if (
        value.get("schemaVersion") != runtime.PROMOTION_SCHEMA_VERSION
        or isinstance(value.get("schemaVersion"), bool)
        or not isinstance(value.get("reviewer"), str)
        or not runtime.REVIEWER.fullmatch(value["reviewer"])
        or value.get("fixtureSha256") != digest
        or value.get("compilerVersion") != runtime.COMPILER_VERSION
        or value.get("scannerVersion") != runtime.SCANNER_VERSION
    ):
        if value.get("fixtureSha256") != digest:
            raise PromotionError("fixture hash mismatch")
        raise PromotionError("invalid approval")
    runtime._timestamp(value.get("approvedAt"))
    return value
