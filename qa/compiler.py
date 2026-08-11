from __future__ import annotations

import hashlib
import json
from pathlib import PureWindowsPath
import re
from typing import Any
import unicodedata

from qa.contracts import (
    CAPTURE_MONTH,
    FINAL_ACTION,
    SHA256,
    ContractError,
    generic_control,
    validate_fixture,
)


COMPILER_VERSION = "1.0.0"
MAX_SOURCE_FILES = 2_000
MAX_SOURCE_PATH_CHARS = 512

_CAPTURE_KEYS = {
    "captureId",
    "platformFamily",
    "captureMonth",
    "sourceDeniedTerms",
    "steps",
}
_STEP_KEYS = {"checkpoint", "controls", "finalActionObserved"}
_CONTROL_KEYS = {"kind", "sourceLabel", "required"}
_RECEIPT_KEYS = {
    "recorderVersion",
    "captureMonth",
    "captureId",
    "sourceFiles",
}
_CHECKPOINT_SEQUENCE = (
    "application-opened",
    "step-advanced",
    "review-reached",
)
_CONTROL_SEQUENCE = (
    (
        "contact.first_name",
        "contact.last_name",
        "contact.email",
        "contact.phone",
    ),
    ("resume.file",),
    (),
)
_SEMVER_CORE = re.compile(
    r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$"
)


class CompilerError(ContractError):
    """A value-free diagnostic for rejected private compiler input."""


def _closed(value: dict[str, Any], allowed: set[str], category: str) -> None:
    if set(value) - allowed:
        raise CompilerError(f"unknown {category} key")


def _nonempty_string(value: Any, category: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise CompilerError(f"invalid {category}")
    return value


def _validate_capture(capture: Any) -> tuple[str, str, list[dict[str, Any]]]:
    if not isinstance(capture, dict):
        raise CompilerError("invalid capture object")
    _closed(capture, _CAPTURE_KEYS, "capture")

    capture_id = _nonempty_string(capture.get("captureId"), "capture identifier")
    if capture.get("platformFamily") != "linkedin-easy-apply":
        raise CompilerError("unsupported platform family")

    capture_month = capture.get("captureMonth")
    if not isinstance(capture_month, str) or not CAPTURE_MONTH.fullmatch(capture_month):
        raise CompilerError("invalid capture month")

    denied_terms = capture.get("sourceDeniedTerms")
    if not isinstance(denied_terms, list) or any(
        not isinstance(term, str) for term in denied_terms
    ):
        raise CompilerError("invalid denied terms")

    steps = capture.get("steps")
    if not isinstance(steps, list):
        raise CompilerError("invalid steps")
    for step in steps:
        _validate_step_shape(step)

    checkpoints = tuple(step.get("checkpoint") for step in steps)
    if len(checkpoints) != len(set(checkpoints)):
        raise CompilerError("duplicate checkpoint")
    if checkpoints != _CHECKPOINT_SEQUENCE:
        raise CompilerError("unsupported checkpoint sequence")

    for index, step in enumerate(steps):
        expected_keys = {"checkpoint", "controls"}
        if index == 2:
            expected_keys.add("finalActionObserved")
        if set(step) != expected_keys:
            raise CompilerError("invalid step fields")
        _validate_controls(step["controls"], _CONTROL_SEQUENCE[index])

    review = steps[2]
    if review["finalActionObserved"] is not True:
        raise CompilerError("final action observation required")

    return capture_id, capture_month, steps


def _validate_step_shape(step: Any) -> None:
    if not isinstance(step, dict):
        raise CompilerError("invalid step object")
    _closed(step, _STEP_KEYS, "step")
    if not isinstance(step.get("checkpoint"), str):
        raise CompilerError("invalid checkpoint")
    if not isinstance(step.get("controls"), list):
        raise CompilerError("invalid step controls")
    for control in step["controls"]:
        _validate_control_shape(control)


def _validate_control_shape(control: Any) -> None:
    if not isinstance(control, dict):
        raise CompilerError("invalid control object")
    _closed(control, _CONTROL_KEYS, "control")
    if not isinstance(control.get("kind"), str):
        raise CompilerError("invalid control kind")
    _nonempty_string(control.get("sourceLabel"), "control source label")
    if not isinstance(control.get("required"), bool):
        raise CompilerError("invalid control required flag")


def _validate_controls(
    controls: list[dict[str, Any]], expected_kinds: tuple[str, ...]
) -> None:
    kinds = tuple(control["kind"] for control in controls)
    if len(kinds) != len(set(kinds)):
        raise CompilerError("duplicate control kind")
    if kinds != expected_kinds:
        raise CompilerError("unsupported control sequence")


def _validate_source_files(value: Any) -> str:
    if not isinstance(value, dict) or not value:
        raise CompilerError("invalid source files")
    if len(value) > MAX_SOURCE_FILES:
        raise CompilerError("source file count limit exceeded")
    for path, digest in value.items():
        if not isinstance(path, str) or not path:
            raise CompilerError("invalid source file path")
        if len(path) > MAX_SOURCE_PATH_CHARS:
            raise CompilerError("source file path limit exceeded")
        if (
            PureWindowsPath(path).drive
            or path.startswith("/")
            or "\\" in path
            or any(unicodedata.category(character) == "Cc" for character in path)
            or any(part in {"", ".", ".."} for part in path.split("/"))
        ):
            raise CompilerError("invalid source file path")
        if not isinstance(digest, str) or not SHA256.fullmatch(digest):
            raise CompilerError("invalid source file digest")
    canonical = json.dumps(
        value, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def _validate_receipt(receipt: Any) -> tuple[str, str, str, str]:
    if not isinstance(receipt, dict):
        raise CompilerError("invalid receipt object")
    _closed(receipt, _RECEIPT_KEYS, "receipt")

    recorder_version = receipt.get("recorderVersion")
    if (
        not isinstance(recorder_version, str)
        or not _SEMVER_CORE.fullmatch(recorder_version)
    ):
        raise CompilerError("invalid recorder version")
    capture_id = _nonempty_string(receipt.get("captureId"), "receipt identifier")
    capture_month = receipt.get("captureMonth")
    if not isinstance(capture_month, str) or not CAPTURE_MONTH.fullmatch(capture_month):
        raise CompilerError("invalid receipt month")
    digest = _validate_source_files(receipt.get("sourceFiles"))
    return recorder_version, capture_id, capture_month, digest


def compile_capture(capture: dict, receipt: dict, fixture_id: str) -> dict:
    """Compile validated private semantic observations into a generic fixture."""

    capture_id, capture_month, steps = _validate_capture(capture)
    recorder_version, receipt_id, receipt_month, digest = _validate_receipt(receipt)
    if capture_id != receipt_id:
        raise CompilerError("capture identifier mismatch")
    if capture_month != receipt_month:
        raise CompilerError("capture month mismatch")

    try:
        first_controls = [
            generic_control(control["kind"], control["required"])
            for control in steps[0]["controls"]
        ]
        second_controls = [
            generic_control(control["kind"], control["required"])
            for control in steps[1]["controls"]
        ]
        fixture = {
            "schemaVersion": 1,
            "id": fixture_id,
            "platformFamily": "linkedin-easy-apply",
            "captureMonth": capture_month,
            "compilerVersion": COMPILER_VERSION,
            "provenance": {
                "recorderVersion": recorder_version,
                "captureMonth": receipt_month,
                "sourceRecordingSha256": digest,
            },
            "steps": [
                {
                    "id": "step-1",
                    "kind": "form",
                    "title": "Application details",
                    "controls": first_controls,
                    "next": "step-2",
                },
                {
                    "id": "step-2",
                    "kind": "form",
                    "title": "Resume",
                    "controls": second_controls,
                    "next": "review",
                },
                {
                    "id": "review",
                    "kind": "review",
                    "title": "Review application",
                    "controls": [],
                    "finalAction": dict(FINAL_ACTION),
                },
            ],
            "oracle": {"finalActionActivations": 0},
        }
        validate_fixture(fixture)
    except ContractError:
        raise CompilerError("compiled fixture validation failed") from None
    return fixture
