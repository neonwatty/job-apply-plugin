#!/usr/bin/env python3
"""Prepare and evaluate supervised local Job Apply replay runs."""

from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import fcntl
import hashlib
import hmac
from importlib import import_module as _import_module
import json
import os
from pathlib import Path
import queue
import re
import secrets
import stat
import subprocess
import sys
import tempfile
import threading
from typing import Any
import urllib.error
import urllib.request
from urllib.parse import urlsplit
from concurrent.futures import ThreadPoolExecutor

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from qa.oracle import OracleError, evaluate_run
from qa.contracts import ContractError, validate_fixture
from qa.recorder_fs import BrokerError, exclusive_rename
from qa.server import ReplayHTTPServer
from scripts.job_apply_policy import (
    PolicyError,
    PolicyStore,
    confirmation_authority_revision,
)
_auto_submit = _import_module("qa.replay.auto_submit")
_cleanup_module = _import_module("qa.replay.cleanup")
_cleanup_preflight = _import_module("qa.replay.cleanup_preflight")
_cli = _import_module("qa.replay.cli")
_evaluate_module = _import_module("qa.replay.evaluate")
_lifecycle = _import_module("qa.replay.lifecycle")
_prepare_module = _import_module("qa.replay.prepare")
_report = _import_module("qa.replay.report")
_run_state = _import_module("qa.replay.run_state")
_secure_io = _import_module("qa.replay.secure_io")
_server_control = _import_module("qa.replay.server_control")


FIXTURES_ROOT = _run_state.FIXTURES_ROOT
SCENARIOS_ROOT = _run_state.SCENARIOS_ROOT
RUNS_ROOT = _run_state.RUNS_ROOT
STORE_SCRIPT = _run_state.STORE_SCRIPT

IDENTIFIER = _prepare_module.IDENTIFIER
RUN_ID = _run_state.RUN_ID
TOKEN = _run_state.TOKEN
ROUTE = _run_state.ROUTE
MARKER_TEMP = _cleanup_preflight.MARKER_TEMP
MAX_JSON_BYTES = _secure_io.MAX_JSON_BYTES
MAX_RESUME_BYTES = _secure_io.MAX_RESUME_BYTES
MAX_CLEANUP_ENTRIES = _cleanup_preflight.MAX_CLEANUP_ENTRIES
MAX_CLEANUP_BYTES = _cleanup_preflight.MAX_CLEANUP_BYTES
MAX_CLEANUP_DEPTH = _cleanup_preflight.MAX_CLEANUP_DEPTH
STARTUP_TIMEOUT_SECONDS = _server_control.STARTUP_TIMEOUT_SECONDS
REQUEST_TIMEOUT_SECONDS = _server_control.REQUEST_TIMEOUT_SECONDS
PROMPT = _prepare_module.PROMPT
PLATFORM_LABELS = _prepare_module.PLATFORM_LABELS
RUN_STATE_KEYS = _run_state.RUN_STATE_KEYS
EXPECTED_KEYS = _prepare_module.EXPECTED_KEYS
SCENARIO_IDS = _report.SCENARIO_IDS
REPORT_KEYS = _report.REPORT_KEYS
TOMBSTONE_KEYS = _report.TOMBSTONE_KEYS
ASSERTION_NAMES = _report.ASSERTION_NAMES
FAILURE_CATEGORIES = _report.FAILURE_CATEGORIES
CoordinatorError = _secure_io.CoordinatorError


_FACADE_RUNTIME = _cli.FacadeRuntime(globals())
_runtime = _FACADE_RUNTIME.resolve


def _opaque(kind: str, label: str) -> str:
    return _server_control._opaque(kind, label, _runtime=_runtime())


def _revision(label: str) -> str:
    return _server_control._revision(label, _runtime=_runtime())


def _post_claimed_action(
    base_url: str,
    token: str,
    lease: dict[str, Any],
    authorization: dict[str, Any],
    step_id: str,
    safety_checks: dict[str, bool] | None = None,
) -> tuple[int, dict[str, Any]]:
    return _server_control._post_claimed_action(
        base_url,
        token,
        lease,
        authorization,
        step_id,
        safety_checks,
        _runtime=_runtime(),
    )


def _verify_auto_submit(fixture_path: Path) -> dict[str, Any]:
    return _auto_submit._verify_auto_submit(fixture_path, _runtime=_runtime())


def _open_private_directory(path: Path, diagnostic: str) -> int:
    return _secure_io._open_private_directory(
        path, diagnostic, _runtime=_runtime()
    )


def _verify_directory_binding(
    path: Path, descriptor: int, diagnostic: str
) -> None:
    _secure_io._verify_directory_binding(
        path, descriptor, diagnostic, _runtime=_runtime()
    )


def _read_regular_at(
    directory_descriptor: int, name: str, limit: int, diagnostic: str
) -> bytes:
    return _secure_io._read_regular_at(
        directory_descriptor, name, limit, diagnostic, _runtime=_runtime()
    )


def _read_json_at(directory_descriptor: int, name: str, diagnostic: str) -> Any:
    return _secure_io._read_json_at(
        directory_descriptor, name, diagnostic, _runtime=_runtime()
    )


def _entry_exists_at(directory_descriptor: int, name: str) -> bool:
    return _secure_io._entry_exists_at(
        directory_descriptor, name, _runtime=_runtime()
    )


def _validate_report(
    report: Any, state: dict[str, Any], fixture: dict[str, Any]
) -> dict[str, Any]:
    return _report._validate_report(
        report, state, fixture, _runtime=_runtime()
    )


def _report_digest(report: dict[str, Any]) -> str:
    return _report._report_digest(report, _runtime=_runtime())


def _signed_tombstone(
    run_id: str,
    state: dict[str, Any],
    cleanup_state: str,
    retain_report: bool,
    report: dict[str, Any] | None,
) -> dict[str, Any]:
    return _report._signed_tombstone(
        run_id,
        state,
        cleanup_state,
        retain_report,
        report,
        _runtime=_runtime(),
    )


_public_cleanup_result = _report._public_cleanup_result


def _signed_tombstone_matches(
    observed: Any, expected: dict[str, Any]
) -> bool:
    return _report._signed_tombstone_matches(
        observed, expected, _runtime=_runtime()
    )


def _recover_signed_tombstone(
    run_descriptor: int,
    run_id: str,
    state: dict[str, Any],
    observed: Any,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    return _report._recover_signed_tombstone(
        run_descriptor, run_id, state, observed, _runtime=_runtime()
    )


def _atomic_json_at(
    directory_descriptor: int, name: str, value: dict[str, Any]
) -> None:
    _secure_io._atomic_json_at(
        directory_descriptor, name, value, _runtime=_runtime()
    )


def _publish_marker_at(
    directory_descriptor: int, name: str, value: dict[str, Any]
) -> None:
    _secure_io._publish_marker_at(
        directory_descriptor, name, value, _runtime=_runtime()
    )


def _ensure_marker_at(
    directory_descriptor: int, name: str, value: dict[str, Any]
) -> None:
    _secure_io._ensure_marker_at(
        directory_descriptor, name, value, _runtime=_runtime()
    )


def _copy_regular_at(
    source: Path,
    directory_descriptor: int,
    name: str,
    limit: int,
    diagnostic: str,
) -> None:
    _prepare_module._copy_regular_at(
        source,
        directory_descriptor,
        name,
        limit,
        diagnostic,
        _runtime=_runtime(),
    )


def _same_entry(expected: os.stat_result, observed: os.stat_result) -> bool:
    return _secure_io._same_entry(expected, observed)


def _restore_captured_entry(
    directory_descriptor: int, captured: str, original: str
) -> None:
    _secure_io._restore_captured_entry(
        directory_descriptor, captured, original, _runtime=_runtime()
    )


def _capture_and_remove_at(
    directory_descriptor: int,
    name: str,
    budget: dict[str, int],
    depth: int,
    expected_kind: str | None = None,
) -> None:
    _cleanup_module._capture_and_remove_at(
        directory_descriptor,
        name,
        budget,
        depth,
        expected_kind,
        _runtime=_runtime(),
    )


def _remove_contents_at(
    directory_descriptor: int,
    depth: int = 0,
    *,
    budget: dict[str, int] | None = None,
) -> None:
    _cleanup_module._remove_contents_at(
        directory_descriptor, depth, budget=budget, _runtime=_runtime()
    )


def _read_regular(path: Path, limit: int, diagnostic: str) -> bytes:
    return _prepare_module._read_regular(
        path, limit, diagnostic, _runtime=_runtime()
    )


def _read_json(path: Path, diagnostic: str) -> Any:
    return _prepare_module._read_json(path, diagnostic, _runtime=_runtime())


def _validate_source_directory(path: Path, diagnostic: str) -> None:
    _prepare_module._validate_source_directory(
        path, diagnostic, _runtime=_runtime()
    )


def _run_store_json(store_root: Path, command: list[str]) -> Any:
    return _prepare_module._run_store_json(
        store_root, command, _runtime=_runtime()
    )


def _run_store(store_root: Path, command: list[str]) -> None:
    _prepare_module._run_store(store_root, command, _runtime=_runtime())


def _start_server(
    fixture_path: Path, expected_resume_filename: str, shutdown_token: str
) -> dict[str, Any]:
    return _server_control._start_server(
        fixture_path,
        expected_resume_filename,
        shutdown_token,
        _runtime=_runtime(),
    )


def _new_run_directory() -> tuple[str, Path, int, int]:
    return _run_state._new_run_directory(_runtime=_runtime())


def _prepare(fixture_id: str, scenario_id: str) -> dict[str, Any]:
    return _prepare_module._prepare(
        fixture_id, scenario_id, _runtime=_runtime()
    )


def _load_state_at(run_root: Path, run_descriptor: int) -> dict[str, Any]:
    return _run_state._load_state_at(
        run_root, run_descriptor, _runtime=_runtime()
    )


def _load_run(run_id: str) -> tuple[Path, dict[str, Any], int, int]:
    return _run_state._load_run(run_id, _runtime=_runtime())


def _fetch_state(url: str) -> dict[str, Any]:
    return _server_control._fetch_state(url, _runtime=_runtime())


def _base_url(url: str) -> str:
    return _server_control._base_url(url, _runtime=_runtime())


def _authenticated_request(
    url: str, path: str, token: str, method: str = "GET"
) -> tuple[int, bytes]:
    return _server_control._authenticated_request(
        url, path, token, method, _runtime=_runtime()
    )


def _verify_identity(state: dict[str, Any]) -> None:
    _server_control._verify_identity(state, _runtime=_runtime())


def _shutdown_server(url: str, token: str, required: bool = True) -> None:
    _server_control._shutdown_server(
        url, token, required, _runtime=_runtime()
    )


def _shutdown_authenticated_run_if_available(state: dict[str, Any]) -> None:
    _server_control._shutdown_authenticated_run_if_available(
        state, _runtime=_runtime()
    )


def _shutdown_authenticated_run(state: dict[str, Any]) -> None:
    _server_control._shutdown_authenticated_run(state, _runtime=_runtime())


def _interrupted_marker_exists(directory_descriptor: int, stem: str) -> bool:
    return _cleanup_module._interrupted_marker_exists(
        directory_descriptor, stem, _runtime=_runtime()
    )


def _resolve_route(route_token: str) -> dict[str, str]:
    return _lifecycle._resolve_route(route_token, _runtime=_runtime())


def _record_transition(run_id: str, transition: str) -> dict[str, Any]:
    return _lifecycle._record_transition(
        run_id, transition, _runtime=_runtime()
    )


def _evaluate(run_id: str) -> tuple[int, dict[str, Any]]:
    return _evaluate_module._evaluate(run_id, _runtime=_runtime())


def _open_run_for_cleanup(run_id: str) -> tuple[Path, Path, int, int]:
    return _run_state._open_run_for_cleanup(run_id, _runtime=_runtime())


def _preflight_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    budget: dict[str, int],
    depth: int,
) -> None:
    _cleanup_preflight._preflight_cleanup_tree(
        directory_descriptor,
        prefix,
        manifest,
        children,
        budget,
        depth,
        _runtime=_runtime(),
    )


def _sanitize_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    retained: set[tuple[str, ...]],
    deferred: set[tuple[str, ...]],
) -> None:
    _cleanup_preflight._sanitize_cleanup_tree(
        directory_descriptor,
        prefix,
        manifest,
        children,
        retained,
        deferred,
        _runtime=_runtime(),
    )


def _sanitize_deferred_regular(
    directory_descriptor: int, name: str, expected: os.stat_result
) -> None:
    _cleanup_preflight._sanitize_deferred_regular(
        directory_descriptor, name, expected, _runtime=_runtime()
    )


def _verify_cleanup_tree(
    directory_descriptor: int,
    prefix: tuple[str, ...],
    manifest: dict[tuple[str, ...], os.stat_result],
    children: dict[tuple[str, ...], tuple[str, ...]],
    retained: set[tuple[str, ...]],
) -> None:
    _cleanup_preflight._verify_cleanup_tree(
        directory_descriptor,
        prefix,
        manifest,
        children,
        retained,
        _runtime=_runtime(),
    )


def _sanitize_run_artifacts(
    run_descriptor: int, *, retain_report: bool
) -> None:
    _cleanup_preflight._sanitize_run_artifacts(
        run_descriptor, retain_report=retain_report, _runtime=_runtime()
    )


def _validate_self_contained_tombstone(
    run_descriptor: int, run_id: str, tombstone: Any
) -> dict[str, Any]:
    return _cleanup_preflight._validate_self_contained_tombstone(
        run_descriptor, run_id, tombstone, _runtime=_runtime()
    )


def _cleanup(run_id: str) -> dict[str, Any]:
    return _cleanup_module._cleanup(run_id, _runtime=_runtime())


def build_parser() -> argparse.ArgumentParser:
    return _cli.build_parser(_runtime=_runtime())


def main(argv: list[str] | None = None) -> int:
    return _cli.main(argv, _runtime=_runtime())


__all__ = list(_cli.LEGACY_STAR_EXPORTS)


if __name__ == "__main__":
    raise SystemExit(main())
