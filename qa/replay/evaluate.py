"""Fail-closed replay evaluation and terminal report publication."""

from __future__ import annotations

import fcntl
import os
import stat
import sys
from typing import Any

from qa.contracts import ContractError, validate_fixture
from qa.oracle import OracleError, evaluate_run
from qa.replay.report import _validate_report
from qa.replay.run_state import _open_loaded_run
from qa.replay.secure_io import (
    CoordinatorError,
    _atomic_json_at,
    _entry_exists_at,
    _read_json_at,
)
from qa.replay.server_control import (
    _fetch_state,
    _shutdown_server,
    _verify_identity,
)


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _evaluate(
    run_id: str, *, _runtime: Any | None = None
) -> tuple[int, dict[str, Any]]:
    runtime = _resolve_runtime(_runtime)
    storage, state = runtime._open_loaded_run(run_id)
    lock_descriptor = None
    authenticated = False
    lifecycle_active = False
    store_descriptor = None
    try:
        lock_descriptor = runtime.os.open(
            "evaluate.lock",
            runtime.os.O_RDWR
            | runtime.os.O_CREAT
            | getattr(runtime.os, "O_NOFOLLOW", 0),
            0o600,
            dir_fd=storage.run_descriptor,
        )
        runtime.os.fchmod(lock_descriptor, 0o600)
        try:
            runtime.fcntl.flock(
                lock_descriptor, runtime.fcntl.LOCK_EX | runtime.fcntl.LOCK_NB
            )
        except BlockingIOError:
            raise CoordinatorError("evaluation already in progress") from None
        fixture = runtime._read_json_at(
            storage.run_descriptor, "fixture.json", "invalid fixture package"
        )
        try:
            runtime.validate_fixture(fixture)
        except (ContractError, TypeError):
            raise CoordinatorError("invalid fixture package") from None
        try:
            completed = runtime._read_json_at(
                storage.run_descriptor, "report.json", "invalid run report"
            )
        except CoordinatorError:
            try:
                runtime.os.stat(
                    "report.json",
                    dir_fd=storage.run_descriptor,
                    follow_symlinks=False,
                )
            except FileNotFoundError:
                completed = None
            else:
                raise
        if completed is not None:
            completed_marker = runtime._read_json_at(
                storage.run_descriptor,
                "completed.json",
                "invalid run report",
            )
            if completed_marker != {
                "state": "completed",
                "nonce": state["lifecycleNonce"],
            }:
                raise CoordinatorError("invalid run report")
            completed = runtime._validate_report(completed, state, fixture)
            return (0 if completed["status"] == "passed" else 1), completed
        lifecycle = runtime._read_json_at(
            storage.run_descriptor, "lifecycle.json", "invalid run state"
        )
        if runtime._entry_exists_at(storage.run_descriptor, "abandoned.json"):
            raise CoordinatorError("run is abandoned")
        if lifecycle != {
            "state": "prepared",
            "nonce": state["lifecycleNonce"],
        }:
            raise CoordinatorError("run is abandoned")
        lifecycle_active = True
        try:
            store_descriptor = runtime.os.open(
                "store",
                runtime.os.O_RDONLY
                | runtime.os.O_DIRECTORY
                | getattr(runtime.os, "O_NOFOLLOW", 0),
                dir_fd=storage.run_descriptor,
            )
            store_metadata = runtime.os.fstat(store_descriptor)
            if (
                not runtime.stat.S_ISDIR(store_metadata.st_mode)
                or store_metadata.st_uid != runtime.os.getuid()
                or runtime.stat.S_IMODE(store_metadata.st_mode) != 0o700
            ):
                raise CoordinatorError("invalid store root")
        except CoordinatorError:
            raise
        except OSError:
            raise CoordinatorError("invalid store root") from None
        runtime._verify_identity(state)
        authenticated = True
        server_state = runtime._fetch_state(state["url"])
        report = runtime.evaluate_run(
            fixture,
            {"id": state["scenarioId"]},
            server_state["events"],
            store_descriptor,
        )
        if not isinstance(report, dict):
            raise CoordinatorError("replay evaluation failed")
        report = runtime._validate_report(report, state, fixture)
        runtime._shutdown_server(
            state["url"], state["shutdownToken"], required=True
        )
        authenticated = False
        runtime._atomic_json_at(storage.run_descriptor, "report.json", report)
        runtime._atomic_json_at(
            storage.run_descriptor,
            "completed.json",
            {"state": "completed", "nonce": state["lifecycleNonce"]},
        )
        return (0 if report.get("status") == "passed" else 1), report
    except OracleError as error:
        if lifecycle_active:
            try:
                runtime._atomic_json_at(
                    storage.run_descriptor,
                    "abandoned.json",
                    {"state": "abandoned", "nonce": state["lifecycleNonce"]},
                )
            except CoordinatorError:
                pass
        raise CoordinatorError(str(error)) from None
    except CoordinatorError:
        if lifecycle_active:
            try:
                runtime._atomic_json_at(
                    storage.run_descriptor,
                    "abandoned.json",
                    {"state": "abandoned", "nonce": state["lifecycleNonce"]},
                )
            except CoordinatorError:
                pass
        raise
    finally:
        if authenticated:
            runtime._shutdown_server(
                state["url"], state["shutdownToken"], required=False
            )
        if lock_descriptor is not None:
            runtime.os.close(lock_descriptor)
        if store_descriptor is not None:
            runtime.os.close(store_descriptor)
        storage.close()
