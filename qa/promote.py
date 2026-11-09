"""Fail-closed compilation, approval, and promotion for replay fixtures."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import stat
import sys
import tempfile
from typing import Any

from qa.compiler import COMPILER_VERSION, compile_capture
from qa.contracts import ContractError, validate_fixture
from qa.privacy import (
    MAX_DENIED_TERM_CHARS,
    MAX_DENIED_TERMS,
    PrivacyError,
    scan_tree,
)
from qa.recorder_fs import BrokerError, exclusive_rename, exclusive_rename_available
from qa.promotion import approval as _approval
from qa.promotion import bindings as _bindings
from qa.promotion import candidate as _candidate
from qa.promotion import cli as _cli
from qa.promotion import deletion as _deletion
from qa.promotion import destination as _destination
from qa.promotion import rollback as _rollback
from qa.promotion import transaction as _transaction


SCANNER_VERSION = _approval.SCANNER_VERSION
PROMOTION_SCHEMA_VERSION = _approval.PROMOTION_SCHEMA_VERSION
MAX_JSON_BYTES = _bindings.MAX_JSON_BYTES
MAX_DELETE_DEPTH = _deletion.MAX_DELETE_DEPTH
MAX_DELETE_ENTRIES = _deletion.MAX_DELETE_ENTRIES
MAX_DELETE_ENTRIES_PER_DIRECTORY = _deletion.MAX_DELETE_ENTRIES_PER_DIRECTORY
REVIEWER = _approval.REVIEWER

APPROVAL_KEYS = _approval.APPROVAL_KEYS
MANIFEST_KEYS = _candidate.MANIFEST_KEYS
PROVENANCE_KEYS = _transaction.PROVENANCE_KEYS
MANIFEST_PATHS = _candidate.MANIFEST_PATHS
MANIFEST_STRING_CATEGORIES = _candidate.MANIFEST_STRING_CATEGORIES
_POSIX_DESCRIPTOR_SUPPORT = _bindings._POSIX_DESCRIPTOR_SUPPORT

PromotionError = _bindings.PromotionError
_SessionBinding = _bindings._SessionBinding
_PrivateBinding = _bindings._PrivateBinding
_DestinationBinding = _destination._DestinationBinding
_DeleteNode = _deletion._DeleteNode


def _runtime() -> Any:
    return sys.modules[__name__]


def _deletion_entry_identity(entry: os.DirEntry[str]) -> os.stat_result:
    return _deletion._deletion_entry_identity(entry)


def _json_bytes(value: Any) -> bytes:
    return _bindings._json_bytes(value)


def _same_identity(left: os.stat_result, right: os.stat_result) -> bool:
    return _bindings._same_identity(left, right)


def _require_posix_capabilities(*, exclusive_install: bool = False) -> None:
    _bindings._require_posix_capabilities(
        exclusive_install=exclusive_install, _runtime=_runtime()
    )


def _descriptor_mount_identity(descriptor: int) -> tuple[int, int]:
    return _bindings._descriptor_mount_identity(descriptor)


def _require_private_permissions(identity: os.stat_result) -> None:
    _bindings._require_private_permissions(identity)


def _darwin_mountpoint_bound(
    path: Path, identity: os.stat_result, descriptor: int
) -> bool:
    return _bindings._darwin_mountpoint_bound(
        path, identity, descriptor, _runtime=_runtime()
    )


def _read_regular_at(
    directory_descriptor: int, name: str, diagnostic: str
) -> bytes:
    return _bindings._read_regular_at(
        directory_descriptor, name, diagnostic, _runtime=_runtime()
    )


def _read_json_at(directory_descriptor: int, name: str, diagnostic: str) -> Any:
    return _bindings._read_json_at(
        directory_descriptor, name, diagnostic, _runtime=_runtime()
    )


def _parse_json_bytes(data: bytes, diagnostic: str) -> Any:
    return _bindings._parse_json_bytes(data, diagnostic)


def _candidate_snapshot(binding: _PrivateBinding) -> dict[str, bytes]:
    return _candidate._candidate_snapshot(binding, _runtime=_runtime())


def _scan_snapshot(snapshot: dict[str, bytes], denied_terms: list[str]) -> None:
    _candidate._scan_snapshot(snapshot, denied_terms, _runtime=_runtime())


def _open_session_binding(session_argument: Path) -> _SessionBinding:
    return _bindings._open_session_binding(session_argument, _runtime=_runtime())


def _open_private_binding(candidate_argument: Path) -> _PrivateBinding:
    return _bindings._open_private_binding(candidate_argument, _runtime=_runtime())


def _assert_session_binding(binding: _SessionBinding) -> None:
    _bindings._assert_session_binding(binding, _runtime=_runtime())


def _assert_private_binding(binding: _PrivateBinding) -> None:
    _bindings._assert_private_binding(binding, _runtime=_runtime())


def _atomic_write_at(
    directory_descriptor: int, name: str, content: bytes
) -> None:
    _bindings._atomic_write_at(
        directory_descriptor, name, content, _runtime=_runtime()
    )


def _denied_terms(semantic: Any) -> list[str]:
    return _candidate._denied_terms(semantic, _runtime=_runtime())


def _timestamp(value: str | None) -> str:
    return _approval._timestamp(value, _runtime=_runtime())


def compile_candidate(
    capture: Path, fixture_id: str, candidate: Path
) -> dict[str, Any]:
    """Compile the two permitted private inputs into a review candidate."""

    return _candidate.compile_candidate(
        capture, fixture_id, candidate, _runtime=_runtime()
    )


def approve_candidate(
    candidate: Path, reviewer: str, now: str | None = None
) -> dict[str, Any]:
    """Bind a human approval to the exact candidate fixture bytes and versions."""

    return _approval.approve_candidate(
        candidate, reviewer, now, _runtime=_runtime()
    )


def _validate_approval(value: Any, digest: str) -> dict[str, Any]:
    return _approval._validate_approval(value, digest, _runtime=_runtime())


def _validate_manifest(value: Any, fixture_id: str) -> None:
    _candidate._validate_manifest(value, fixture_id, _runtime=_runtime())


def _open_destination_binding(destination_argument: Path) -> _DestinationBinding:
    return _destination._open_destination_binding(
        destination_argument, _runtime=_runtime()
    )


def _assert_destination_binding(binding: _DestinationBinding) -> None:
    _destination._assert_destination_binding(binding, _runtime=_runtime())


def _reject_overlap(
    private: _PrivateBinding, destination: _DestinationBinding
) -> None:
    _destination._reject_overlap(private, destination, _runtime=_runtime())


def _write_staging_file(
    directory_descriptor: int, name: str, content: bytes
) -> None:
    _destination._write_staging_file(
        directory_descriptor, name, content, _runtime=_runtime()
    )


def _remove_tree_contents(
    directory_descriptor: int,
    *,
    depth: int = 0,
    state: list[int] | None = None,
    device: int | None = None,
    mount_identity: tuple[int, int] | None = None,
) -> None:
    _deletion._remove_tree_contents(
        directory_descriptor,
        depth=depth,
        state=state,
        device=device,
        mount_identity=mount_identity,
        _runtime=_runtime(),
    )


def _remove_child_tree(parent_descriptor: int, name: str) -> None:
    _deletion._remove_child_tree(parent_descriptor, name, _runtime=_runtime())


def _preflight_deletion(binding: _PrivateBinding) -> list[_DeleteNode]:
    return _deletion._preflight_deletion(binding, _runtime=_runtime())


def _delete_preflighted(
    directory_descriptor: int,
    nodes: list[_DeleteNode],
    session_device: int,
    mount_identity: tuple[int, int],
) -> None:
    _deletion._delete_preflighted(
        directory_descriptor,
        nodes,
        session_device,
        mount_identity,
        _runtime=_runtime(),
    )


def _destroy_bound_session(
    binding: _PrivateBinding, deletion_plan: list[_DeleteNode]
) -> None:
    _deletion._destroy_bound_session(
        binding, deletion_plan, _runtime=_runtime()
    )


def _rollback_installed_fixture(
    destination: _DestinationBinding,
    fixture_id: str,
    installed_identity: os.stat_result,
) -> None:
    _rollback._rollback_installed_fixture(
        destination, fixture_id, installed_identity, _runtime=_runtime()
    )


def promote_candidate(
    candidate: Path, destination: Path, now: str | None = None
) -> Path:
    """Revalidate, atomically install, then securely destroy the raw session."""

    return _transaction.promote_candidate(
        candidate, destination, now, _runtime=_runtime()
    )


def _promote_bound_candidate(
    binding: _PrivateBinding, destination: _DestinationBinding, now: str | None
) -> Path:
    return _transaction._promote_bound_candidate(
        binding, destination, now, _runtime=_runtime()
    )


def _parser() -> argparse.ArgumentParser:
    return _cli._parser(_runtime=_runtime())


def main() -> int:
    return _cli.main(_runtime())


__all__ = [
    "APPROVAL_KEYS",
    "Any",
    "BrokerError",
    "COMPILER_VERSION",
    "ContractError",
    "MANIFEST_KEYS",
    "MANIFEST_PATHS",
    "MANIFEST_STRING_CATEGORIES",
    "MAX_DELETE_DEPTH",
    "MAX_DELETE_ENTRIES",
    "MAX_DELETE_ENTRIES_PER_DIRECTORY",
    "MAX_DENIED_TERMS",
    "MAX_DENIED_TERM_CHARS",
    "MAX_JSON_BYTES",
    "PROMOTION_SCHEMA_VERSION",
    "PROVENANCE_KEYS",
    "Path",
    "PrivacyError",
    "PromotionError",
    "REVIEWER",
    "SCANNER_VERSION",
    "annotations",
    "approve_candidate",
    "argparse",
    "compile_candidate",
    "compile_capture",
    "dataclass",
    "datetime",
    "exclusive_rename",
    "exclusive_rename_available",
    "hashlib",
    "json",
    "main",
    "os",
    "promote_candidate",
    "re",
    "scan_tree",
    "secrets",
    "stat",
    "sys",
    "tempfile",
    "timezone",
    "validate_fixture",
]


if __name__ == "__main__":
    raise SystemExit(main())
