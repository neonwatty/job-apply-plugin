"""Loading and validation for descriptor-bound replay run state."""

from __future__ import annotations

from pathlib import Path
import re
import sys
from typing import Any

from qa.replay.report import SCENARIO_IDS
from qa.replay.secure_io import (
    CoordinatorError,
    _RunStorage,
    _create_run_storage,
    _open_run_storage,
    _read_json_at,
)


REPO_ROOT = Path(__file__).resolve().parents[2]
FIXTURES_ROOT = REPO_ROOT / "qa" / "fixtures"
SCENARIOS_ROOT = REPO_ROOT / "qa" / "scenarios"
RUNS_ROOT = REPO_ROOT / "qa" / "runs"
STORE_SCRIPT = REPO_ROOT / "scripts" / "job-apply-store.py"

RUN_ID = re.compile(r"^qa-run-20[0-9]{6}-[a-f0-9]{8}$")
TOKEN = re.compile(r"^[a-f0-9]{64}$")
ROUTE = re.compile(r"^(qa-run-20[0-9]{6}-[a-f0-9]{8})\.([a-f0-9]{64})$")
RUN_STATE_KEYS = {
    "fixtureId",
    "scenarioId",
    "url",
    "storeRoot",
    "fixturePath",
    "routeToken",
    "shutdownToken",
    "lifecycleNonce",
    "createdAt",
}


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _new_run_storage(*, _runtime: Any | None = None) -> _RunStorage:
    runtime = _resolve_runtime(_runtime)
    return _create_run_storage(runtime.RUNS_ROOT, _runtime=runtime)


def _new_run_directory(
    *, _runtime: Any | None = None
) -> tuple[str, Path, int, int]:
    """Return the legacy tuple while explicitly transferring ownership."""

    storage = _new_run_storage(_runtime=_runtime)
    root_descriptor, run_descriptor = storage.detach_legacy()
    return storage.run_id, storage.run_root, root_descriptor, run_descriptor


def _load_state_at(
    run_root: Path,
    run_descriptor: int,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    state = runtime._read_json_at(
        run_descriptor, "run.json", "invalid run state"
    )
    if (
        not isinstance(state, dict)
        or set(state) != runtime.RUN_STATE_KEYS
        or not all(
            isinstance(state.get(key), str) for key in runtime.RUN_STATE_KEYS
        )
        or runtime.TOKEN.fullmatch(state["routeToken"]) is None
        or runtime.TOKEN.fullmatch(state["shutdownToken"]) is None
        or runtime.TOKEN.fullmatch(state["lifecycleNonce"]) is None
        or runtime.Path(state["storeRoot"]) != run_root / "store"
        or runtime.Path(state["fixturePath"]) != run_root / "fixture.json"
        or state["scenarioId"] not in runtime.SCENARIO_IDS
    ):
        raise CoordinatorError("invalid run state")
    return state


def _open_loaded_run(
    run_id: str, *, _runtime: Any | None = None
) -> tuple[_RunStorage, dict[str, Any]]:
    runtime = _resolve_runtime(_runtime)
    if runtime.RUN_ID.fullmatch(run_id) is None:
        raise CoordinatorError("invalid run identifier")
    storage = _open_run_storage(runtime.RUNS_ROOT, run_id, _runtime=runtime)
    try:
        state = runtime._load_state_at(
            storage.canonical_run_root, storage.run_descriptor
        )
    except BaseException:
        storage.close()
        raise
    return storage, state


def _load_run(
    run_id: str, *, _runtime: Any | None = None
) -> tuple[Path, dict[str, Any], int, int]:
    """Compatibility adapter for callers that own the returned descriptors."""

    storage, state = _open_loaded_run(run_id, _runtime=_runtime)
    root_descriptor, run_descriptor = storage.detach_legacy()
    return storage.run_root, state, root_descriptor, run_descriptor


def _open_cleanup_run(
    run_id: str, *, _runtime: Any | None = None
) -> _RunStorage:
    runtime = _resolve_runtime(_runtime)
    if runtime.RUN_ID.fullmatch(run_id) is None:
        raise CoordinatorError("invalid run identifier")
    return _open_run_storage(runtime.RUNS_ROOT, run_id, _runtime=runtime)


def _open_run_for_cleanup(
    run_id: str, *, _runtime: Any | None = None
) -> tuple[Path, Path, int, int]:
    """Compatibility adapter for the former cleanup-opening helper."""

    storage = _open_cleanup_run(run_id, _runtime=_runtime)
    root_descriptor, run_descriptor = storage.detach_legacy()
    return (
        storage.run_root,
        storage.canonical_run_root,
        root_descriptor,
        run_descriptor,
    )
