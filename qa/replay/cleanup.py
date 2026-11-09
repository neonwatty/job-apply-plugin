"""Authenticated, identity-bound sanitization of replay runs."""

from __future__ import annotations

import fcntl
import os
import secrets
import stat
import sys
from typing import Any

from qa.contracts import ContractError, validate_fixture
from qa.recorder_fs import BrokerError, exclusive_rename
from qa.replay.cleanup_preflight import (
    MARKER_TEMP,
    MAX_CLEANUP_BYTES,
    MAX_CLEANUP_DEPTH,
    MAX_CLEANUP_ENTRIES,
    _sanitize_run_artifacts,
    _validate_self_contained_tombstone,
)
from qa.replay.report import (
    _public_cleanup_result,
    _recover_signed_tombstone,
    _signed_tombstone,
    _signed_tombstone_matches,
    _validate_report,
)
from qa.replay.run_state import _load_state_at, _open_run_for_cleanup
from qa.replay.secure_io import (
    CoordinatorError,
    _RunStorage,
    _ensure_marker_at,
    _entry_exists_at,
    _read_json_at,
    _restore_captured_entry,
    _same_entry,
)
from qa.replay.server_control import (
    _shutdown_authenticated_run,
    _shutdown_authenticated_run_if_available,
)


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _capture_and_remove_at(
    directory_descriptor: int,
    name: str,
    budget: dict[str, int],
    depth: int,
    expected_kind: str | None = None,
    *,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    if depth > runtime.MAX_CLEANUP_DEPTH:
        raise CoordinatorError("run cleanup failed") from None
    captured = f".cleanup-{runtime.secrets.token_hex(16)}"
    try:
        expected = runtime.os.stat(
            name, dir_fd=directory_descriptor, follow_symlinks=False
        )
        parent = runtime.os.fstat(directory_descriptor)
        if (
            expected.st_uid != runtime.os.getuid()
            or expected.st_dev != parent.st_dev
            or not (
                runtime.stat.S_ISDIR(expected.st_mode)
                or runtime.stat.S_ISREG(expected.st_mode)
            )
            or (
                expected_kind == "dir"
                and not runtime.stat.S_ISDIR(expected.st_mode)
            )
            or (
                expected_kind == "file"
                and not runtime.stat.S_ISREG(expected.st_mode)
            )
        ):
            raise CoordinatorError("run cleanup failed")
        expected_mode = (
            0o700 if runtime.stat.S_ISDIR(expected.st_mode) else 0o600
        )
        if runtime.stat.S_IMODE(expected.st_mode) != expected_mode:
            raise CoordinatorError("run cleanup failed")
        budget["entries"] += 1
        if runtime.stat.S_ISREG(expected.st_mode):
            budget["bytes"] += expected.st_size
        if (
            budget["entries"] > runtime.MAX_CLEANUP_ENTRIES
            or budget["bytes"] > runtime.MAX_CLEANUP_BYTES
        ):
            raise CoordinatorError("run cleanup failed")
        runtime.exclusive_rename(
            directory_descriptor, name, directory_descriptor, captured
        )
        renamed = runtime.os.stat(
            captured,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_entry(expected, renamed):
            runtime._restore_captured_entry(
                directory_descriptor, captured, name
            )
            raise CoordinatorError("run cleanup failed")
        flags = runtime.os.O_RDONLY | getattr(runtime.os, "O_NOFOLLOW", 0)
        if runtime.stat.S_ISDIR(expected.st_mode):
            flags |= runtime.os.O_DIRECTORY
        opened = runtime.os.open(
            captured, flags, dir_fd=directory_descriptor
        )
        try:
            if not runtime._same_entry(expected, runtime.os.fstat(opened)):
                raise CoordinatorError("run cleanup failed")
            if runtime.stat.S_ISDIR(expected.st_mode):
                runtime._remove_contents_at(
                    opened, budget=budget, depth=depth + 1
                )
        finally:
            runtime.os.close(opened)
        final = runtime.os.stat(
            captured,
            dir_fd=directory_descriptor,
            follow_symlinks=False,
        )
        if not runtime._same_entry(expected, final):
            runtime._restore_captured_entry(
                directory_descriptor, captured, name
            )
            raise CoordinatorError("run cleanup failed")
        if runtime.stat.S_ISDIR(expected.st_mode):
            runtime.os.rmdir(captured, dir_fd=directory_descriptor)
        else:
            runtime.os.unlink(captured, dir_fd=directory_descriptor)
    except CoordinatorError:
        runtime._restore_captured_entry(directory_descriptor, captured, name)
        raise
    except (OSError, BrokerError):
        runtime._restore_captured_entry(directory_descriptor, captured, name)
        raise CoordinatorError("run cleanup failed") from None


def _remove_contents_at(
    directory_descriptor: int,
    depth: int = 0,
    *,
    budget: dict[str, int] | None = None,
    _runtime: Any | None = None,
) -> None:
    runtime = _resolve_runtime(_runtime)
    if budget is None:
        budget = {"entries": 0, "bytes": 0}
    if depth > runtime.MAX_CLEANUP_DEPTH:
        raise CoordinatorError("run cleanup failed")
    while True:
        try:
            names = runtime.os.listdir(directory_descriptor)
        except OSError:
            raise CoordinatorError("run cleanup failed") from None
        if len(names) > runtime.MAX_CLEANUP_ENTRIES - budget["entries"]:
            raise CoordinatorError("run cleanup failed")
        if not names:
            return
        for name in names:
            runtime._capture_and_remove_at(
                directory_descriptor, name, budget, depth
            )


def _interrupted_marker_exists(
    directory_descriptor: int,
    stem: str,
    *,
    _runtime: Any | None = None,
) -> bool:
    runtime = _resolve_runtime(_runtime)
    prefix = f".marker-{stem}-"
    try:
        names = runtime.os.listdir(directory_descriptor)
    except OSError:
        raise CoordinatorError("invalid cleanup state") from None
    if len(names) > runtime.MAX_CLEANUP_ENTRIES:
        raise CoordinatorError("invalid cleanup state")
    return any(
        name.startswith(prefix) and runtime.MARKER_TEMP.fullmatch(name) is not None
        for name in names
    )


def _cleanup(
    run_id: str, *, _runtime: Any | None = None
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    run_root, canonical_run_root, root_descriptor, run_descriptor = (
        runtime._open_run_for_cleanup(run_id)
    )
    storage = _RunStorage.adopt_legacy(
        run_id,
        run_root,
        root_descriptor,
        run_descriptor,
        canonical_run_root=canonical_run_root,
    )
    lock_descriptor = None
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

        try:
            run_metadata = runtime.os.stat(
                "run.json",
                dir_fd=storage.run_descriptor,
                follow_symlinks=False,
            )
            if not runtime.stat.S_ISREG(run_metadata.st_mode):
                raise CoordinatorError("invalid run state")
            meaningful_run_state = run_metadata.st_size > 0
        except FileNotFoundError:
            meaningful_run_state = False
        except OSError:
            raise CoordinatorError("invalid run state") from None

        if (
            runtime._entry_exists_at(storage.run_descriptor, "tombstone.json")
            and not meaningful_run_state
        ):
            try:
                tombstone = runtime._read_json_at(
                    storage.run_descriptor,
                    "tombstone.json",
                    "invalid cleanup state",
                )
            except CoordinatorError:
                tombstone = None
            tombstone = runtime._validate_self_contained_tombstone(
                storage.run_descriptor, run_id, tombstone
            )
            runtime._sanitize_run_artifacts(
                storage.run_descriptor,
                retain_report=tombstone["reportRetained"],
            )
            return runtime._public_cleanup_result(tombstone)

        state = runtime._load_state_at(
            storage.canonical_run_root, storage.run_descriptor
        )
        if runtime._entry_exists_at(storage.run_descriptor, "tombstone.json"):
            try:
                observed_tombstone = runtime._read_json_at(
                    storage.run_descriptor,
                    "tombstone.json",
                    "invalid cleanup state",
                )
            except CoordinatorError:
                observed_tombstone = None
            recovered = runtime._recover_signed_tombstone(
                storage.run_descriptor, run_id, state, observed_tombstone
            )
            if recovered is not None:
                tombstone, result = recovered
                runtime._shutdown_authenticated_run_if_available(state)
                runtime._sanitize_run_artifacts(
                    storage.run_descriptor,
                    retain_report=tombstone["reportRetained"],
                )
                return result
        lifecycle = runtime._read_json_at(
            storage.run_descriptor, "lifecycle.json", "invalid run state"
        )
        expected_prepared = {
            "state": "prepared",
            "nonce": state["lifecycleNonce"],
        }
        if lifecycle != expected_prepared:
            raise CoordinatorError("invalid run state")
        completed = runtime._entry_exists_at(
            storage.run_descriptor, "completed.json"
        )
        expected_abandoned = {
            "state": "abandoned",
            "nonce": state["lifecycleNonce"],
        }
        abandoned_exists = runtime._entry_exists_at(
            storage.run_descriptor, "abandoned.json"
        )
        abandoned_valid = False
        if abandoned_exists:
            try:
                abandoned_valid = (
                    runtime._read_json_at(
                        storage.run_descriptor,
                        "abandoned.json",
                        "invalid run state",
                    )
                    == expected_abandoned
                )
            except CoordinatorError:
                abandoned_valid = False
        if completed and abandoned_exists:
            raise CoordinatorError("invalid run state")
        cleanup_report = None
        if completed:
            runtime._shutdown_authenticated_run_if_available(state)
            if runtime._read_json_at(
                storage.run_descriptor, "completed.json", "invalid run state"
            ) != {"state": "completed", "nonce": state["lifecycleNonce"]}:
                raise CoordinatorError("invalid run state")
            fixture = runtime._read_json_at(
                storage.run_descriptor,
                "fixture.json",
                "invalid fixture package",
            )
            try:
                runtime.validate_fixture(fixture)
            except (ContractError, TypeError):
                raise CoordinatorError("invalid fixture package") from None
            report = runtime._read_json_at(
                storage.run_descriptor, "report.json", "invalid run report"
            )
            runtime._validate_report(report, state, fixture)
            cleanup_report = report
            cleanup_state = "completed"
            retain_report = True
        elif not abandoned_valid:
            # A prepared run has no durable evidence that its detached server was
            # already stopped. Preserve the shutdown capability on any transient
            # failure so cleanup can be retried instead of orphaning the server.
            if runtime._interrupted_marker_exists(
                storage.run_descriptor, "abandoned"
            ):
                runtime._shutdown_authenticated_run_if_available(state)
            else:
                runtime._shutdown_authenticated_run(state)
            runtime._ensure_marker_at(
                storage.run_descriptor, "abandoned.json", expected_abandoned
            )
            cleanup_state = "abandoned"
            retain_report = False
        elif abandoned_valid:
            runtime._shutdown_authenticated_run_if_available(state)
            cleanup_state = "abandoned"
            retain_report = False
        else:
            raise CoordinatorError("invalid run state")

        tombstone = runtime._signed_tombstone(
            run_id,
            state,
            cleanup_state,
            retain_report,
            cleanup_report,
        )
        try:
            observed_tombstone = runtime._read_json_at(
                storage.run_descriptor,
                "tombstone.json",
                "invalid cleanup state",
            )
        except CoordinatorError:
            observed_tombstone = None
        if not runtime._signed_tombstone_matches(
            observed_tombstone, tombstone
        ):
            runtime._ensure_marker_at(
                storage.run_descriptor, "tombstone.json", tombstone
            )
        runtime._sanitize_run_artifacts(
            storage.run_descriptor, retain_report=retain_report
        )
        return runtime._public_cleanup_result(tombstone)
    finally:
        if lock_descriptor is not None:
            runtime.os.close(lock_descriptor)
        storage.close()
