"""Replay report and signed-tombstone validation."""

from __future__ import annotations

import hashlib
import hmac
import json
import sys
from typing import Any

from qa.replay.secure_io import (
    CoordinatorError,
    MAX_JSON_BYTES,
    _read_json_at,
    _read_regular_at,
)


SCENARIO_IDS = frozenset(
    {
        "ashby-complete-profile",
        "complete-profile",
        "greenhouse-complete-profile",
        "lever-complete-profile",
        "linkedin-screening",
    }
)
REPORT_KEYS = {
    "fixtureId",
    "scenarioId",
    "status",
    "assertions",
    "missingControlIds",
    "failureCategories",
}
TOMBSTONE_KEYS = {
    "runId",
    "state",
    "reportRetained",
    "lifecycleNonce",
    "fixtureId",
    "scenarioId",
    "reportSha256",
    "mac",
}
ASSERTION_NAMES = {
    "required-fields-filled",
    "resume-uploaded",
    "resume-filename-matched",
    "review-reached",
    "history-started-reviewed",
    "history-not-completed",
    "session-present",
    "session-value-free",
    "final-action-untouched",
}
FAILURE_CATEGORIES = {
    "required-fields-missing",
    "required-upload-missing",
    "resume-filename-mismatch",
    "review-not-reached",
    "history-missing",
    "history-lifecycle-incomplete",
    "history-completed",
    "session-not-correlated",
    "session-missing",
    "session-value-present",
    "final-action-activated",
}


def _resolve_runtime(runtime: Any | None) -> Any:
    return sys.modules[__name__] if runtime is None else runtime


def _validate_report(
    report: Any,
    state: dict[str, Any],
    fixture: dict[str, Any],
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    control_ids = {
        control["id"]
        for step in fixture["steps"]
        for control in step["controls"]
        if control["required"]
    }
    if (
        not isinstance(report, dict)
        or set(report) != runtime.REPORT_KEYS
        or report.get("fixtureId") != state["fixtureId"]
        or report.get("scenarioId") != state["scenarioId"]
        or report.get("status") not in {"passed", "failed"}
    ):
        raise CoordinatorError("invalid run report")
    assertions = report.get("assertions")
    missing = report.get("missingControlIds")
    categories = report.get("failureCategories")
    if (
        not isinstance(assertions, dict)
        or set(assertions) != runtime.ASSERTION_NAMES
        or any(value not in {"passed", "failed"} for value in assertions.values())
        or not isinstance(missing, list)
        or len(missing) > len(control_ids)
        or not all(isinstance(value, str) for value in missing)
        or len(missing) != len(set(missing))
        or missing != sorted(missing)
        or not set(missing).issubset(control_ids)
        or not isinstance(categories, list)
        or len(categories) > len(runtime.FAILURE_CATEGORIES)
        or not all(isinstance(value, str) for value in categories)
        or len(categories) != len(set(categories))
        or categories != sorted(categories)
        or not set(categories).issubset(runtime.FAILURE_CATEGORIES)
    ):
        raise CoordinatorError("invalid run report")
    semantically_passed = (
        all(value == "passed" for value in assertions.values())
        and not missing
        and not categories
    )
    if (report["status"] == "passed") != semantically_passed:
        raise CoordinatorError("invalid run report")
    return report


def _report_digest(
    report: dict[str, Any], *, _runtime: Any | None = None
) -> str:
    runtime = _resolve_runtime(_runtime)
    encoded = runtime.json.dumps(
        report, sort_keys=True, separators=(",", ":")
    ).encode()
    return runtime.hashlib.sha256(encoded).hexdigest()


def _signed_tombstone(
    run_id: str,
    state: dict[str, Any],
    cleanup_state: str,
    retain_report: bool,
    report: dict[str, Any] | None,
    *,
    _runtime: Any | None = None,
) -> dict[str, Any]:
    runtime = _resolve_runtime(_runtime)
    fields = {
        "runId": run_id,
        "state": cleanup_state,
        "reportRetained": retain_report,
        "lifecycleNonce": state["lifecycleNonce"],
        "fixtureId": state["fixtureId"],
        "scenarioId": state["scenarioId"],
        "reportSha256": runtime._report_digest(report) if report is not None else None,
    }
    key = bytes.fromhex(state["routeToken"]) + bytes.fromhex(state["shutdownToken"])
    message = runtime.json.dumps(
        fields, sort_keys=True, separators=(",", ":")
    ).encode()
    return {
        **fields,
        "mac": runtime.hmac.new(key, message, runtime.hashlib.sha256).hexdigest(),
    }


def _public_cleanup_result(tombstone: dict[str, Any]) -> dict[str, Any]:
    return {
        "runId": tombstone["runId"],
        "state": tombstone["state"],
        "reportRetained": tombstone["reportRetained"],
    }


def _signed_tombstone_matches(
    observed: Any,
    expected: dict[str, Any],
    *,
    _runtime: Any | None = None,
) -> bool:
    runtime = _resolve_runtime(_runtime)
    return (
        isinstance(observed, dict)
        and set(observed) == runtime.TOMBSTONE_KEYS
        and all(
            observed.get(key) == expected[key]
            for key in runtime.TOMBSTONE_KEYS - {"mac"}
        )
        and isinstance(observed.get("mac"), str)
        and runtime.hmac.compare_digest(observed["mac"], expected["mac"])
    )


def _recover_signed_tombstone(
    run_descriptor: int,
    run_id: str,
    state: dict[str, Any],
    observed: Any,
    *,
    _runtime: Any | None = None,
) -> tuple[dict[str, Any], dict[str, Any]] | None:
    runtime = _resolve_runtime(_runtime)
    if (
        not isinstance(observed, dict)
        or set(observed) != runtime.TOMBSTONE_KEYS
        or observed.get("runId") != run_id
        or observed.get("lifecycleNonce") != state["lifecycleNonce"]
        or observed.get("fixtureId") != state["fixtureId"]
        or observed.get("scenarioId") != state["scenarioId"]
        or observed.get("state") not in {"abandoned", "completed"}
        or observed.get("reportRetained") != (observed["state"] == "completed")
    ):
        return None
    report = None
    if observed["reportRetained"]:
        try:
            report = runtime._read_json_at(
                run_descriptor, "report.json", "invalid run report"
            )
        except CoordinatorError:
            return None
    expected = runtime._signed_tombstone(
        run_id,
        state,
        observed["state"],
        observed["reportRetained"],
        report,
    )
    if not runtime._signed_tombstone_matches(observed, expected):
        return None
    marker_name = (
        "completed.json" if observed["state"] == "completed" else "abandoned.json"
    )
    expected_marker = {
        "state": observed["state"],
        "nonce": state["lifecycleNonce"],
    }
    try:
        marker_bytes = runtime._read_regular_at(
            run_descriptor,
            marker_name,
            runtime.MAX_JSON_BYTES,
            "invalid run state",
        )
        if marker_bytes:
            marker = runtime.json.loads(marker_bytes.decode())
            if marker != expected_marker:
                return None
    except (CoordinatorError, UnicodeError, runtime.json.JSONDecodeError):
        return None
    return observed, runtime._public_cleanup_result(observed)
