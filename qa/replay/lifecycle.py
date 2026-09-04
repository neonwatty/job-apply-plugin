"""Route resolution and replay lifecycle transitions."""

from __future__ import annotations

import fcntl
import hmac
import os
from pathlib import Path
import sys
from typing import Any

from qa.contracts import ContractError, validate_fixture
from qa.replay.prepare import PLATFORM_LABELS, _run_store_json
from qa.replay.run_state import ROUTE, _open_loaded_run
from qa.replay.secure_io import (
    CoordinatorError,
    _atomic_json_at,
    _entry_exists_at,
    _read_json_at,
)
from qa.replay.server_control import _fetch_state, _verify_identity


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _resolve_route(
    route_token: str, *, _runtime: Any | None = None
) -> dict[str, str]:
    runtime = _resolve_runtime(_runtime)
    match = runtime.ROUTE.fullmatch(route_token)
    if match is None:
        raise CoordinatorError("unknown QA route")
    run_id, supplied_token = match.groups()
    storage = None
    try:
        storage, state = runtime._open_loaded_run(run_id)
        lifecycle = runtime._read_json_at(
            storage.run_descriptor, "lifecycle.json", "invalid run state"
        )
        terminal = runtime._entry_exists_at(
            storage.run_descriptor, "completed.json"
        ) or runtime._entry_exists_at(storage.run_descriptor, "abandoned.json")
        if (
            terminal
            or lifecycle
            != {"state": "prepared", "nonce": state["lifecycleNonce"]}
            or not runtime.hmac.compare_digest(
                state["routeToken"], supplied_token
            )
        ):
            raise CoordinatorError("unknown QA route")
        return {"storeRoot": state["storeRoot"]}
    except CoordinatorError:
        raise CoordinatorError("unknown QA route")
    finally:
        if storage is not None:
            storage.close()


def _record_transition(
    run_id: str,
    transition: str,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    if transition not in {"started", "reviewed"}:
        raise CoordinatorError("invalid lifecycle transition")
    storage, state = runtime._open_loaded_run(run_id)
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
        runtime.fcntl.flock(lock_descriptor, runtime.fcntl.LOCK_EX)
        lifecycle = runtime._read_json_at(
            storage.run_descriptor, "lifecycle.json", "invalid run state"
        )
        if (
            lifecycle
            != {"state": "prepared", "nonce": state["lifecycleNonce"]}
            or runtime._entry_exists_at(
                storage.run_descriptor, "completed.json"
            )
            or runtime._entry_exists_at(
                storage.run_descriptor, "abandoned.json"
            )
        ):
            raise CoordinatorError("run is terminal")
        runtime._verify_identity(state)

        fixture = runtime._read_json_at(
            storage.run_descriptor, "fixture.json", "invalid fixture package"
        )
        try:
            runtime.validate_fixture(fixture)
        except (ContractError, TypeError):
            raise CoordinatorError("invalid fixture package") from None
        platform_family = fixture["platformFamily"]
        if platform_family not in runtime.PLATFORM_LABELS:
            raise CoordinatorError("unsupported fixture platform")

        if transition == "reviewed":
            server_state = runtime._fetch_state(state["url"])
            review_ids = {
                step["id"]
                for step in fixture["steps"]
                if step["kind"] == "review"
            }
            observed_review = any(
                isinstance(event, dict)
                and event
                in (
                    {
                        "type": "reviewed",
                        "controlId": "",
                        "stepId": review_id,
                    }
                    for review_id in review_ids
                )
                for event in server_state["events"]
            )
            if not observed_review:
                raise CoordinatorError("replay review event not observed")
            if server_state["finalActionActivations"] != 0 or any(
                isinstance(event, dict) and event.get("type") == "final-action"
                for event in server_state["events"]
            ):
                raise CoordinatorError("replay final action was activated")

        result = runtime._run_store_json(
            Path(state["storeRoot"]),
            [
                "replay-transition",
                "--id",
                run_id,
                "--transition",
                transition,
                "--ats",
                platform_family,
            ],
        )
        expected = {"applicationId": run_id, "transition": transition}
        if (
            not isinstance(result, dict)
            or set(result) != {"applicationId", "transition", "changed"}
            or any(result[key] != value for key, value in expected.items())
            or not isinstance(result["changed"], bool)
        ):
            raise CoordinatorError("isolated lifecycle transition failed")
        return {
            "runId": run_id,
            "transition": transition,
            "changed": result["changed"],
        }
    except CoordinatorError as error:
        if str(error) == "isolated store initialization failed":
            raise CoordinatorError(
                "isolated lifecycle transition failed"
            ) from None
        raise
    finally:
        if lock_descriptor is not None:
            runtime.os.close(lock_descriptor)
        storage.close()
