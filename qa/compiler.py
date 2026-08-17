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
    LEVER_CONTROL_PROFILE,
    validate_fixture,
)


COMPILER_VERSION = "1.1.0"
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
_LINKEDIN_FLOW_PROFILES = (
    (
        (
            "application-opened",
            (
                ("contact.first_name", True),
                ("contact.last_name", True),
                ("contact.email", True),
                ("contact.phone", True),
            ),
        ),
        ("step-advanced", (("resume.file", True),)),
        ("review-reached", ()),
    ),
    (
        (
            "application-opened",
            (
                ("contact.email", True),
                ("contact.phone", True),
            ),
        ),
        ("step-advanced", (("resume.file", True),)),
        ("step-advanced", (("preference.top_choice", False),)),
        ("step-advanced", (("authorization.sponsorship", True),)),
        ("review-reached", ()),
    ),
)
_GREENHOUSE_CONTROL_PROFILE = (
    ("contact.first_name", True),
    ("contact.last_name", True),
    ("contact.preferred_name", False),
    ("contact.email", True),
    ("contact.phone_country", True),
    ("contact.phone", True),
    ("contact.location_city", True),
    ("resume.file", True),
    ("cover_letter.file", False),
    ("profile.linkedin", True),
    ("profile.website", False),
    ("authorization.sponsorship_select", True),
    ("employment.prior_affiliate", True),
    ("source.discovery", True),
    ("referral.contact", False),
)
_ASHBY_CONTROL_PROFILE = (
    ("contact.full_name", True),
    ("contact.email", True),
    ("resume.file", True),
)
_LEVER_CONTROL_PROFILE = LEVER_CONTROL_PROFILE
_FLOW_PROFILES = {
    "ashby": (
        (
            ("application-opened", _ASHBY_CONTROL_PROFILE),
            ("review-reached", ()),
        ),
    ),
    "linkedin-easy-apply": _LINKEDIN_FLOW_PROFILES,
    "greenhouse": (
        (
            ("application-opened", _GREENHOUSE_CONTROL_PROFILE),
            ("review-reached", ()),
        ),
    ),
    "lever": (
        (
            ("application-opened", _LEVER_CONTROL_PROFILE),
            ("review-reached", ()),
        ),
    ),
}
_STEP_TITLES = {
    (
        "contact.first_name",
        "contact.last_name",
        "contact.email",
        "contact.phone",
    ): "Application details",
    ("contact.email", "contact.phone"): "Contact information",
    ("resume.file",): "Resume",
    ("preference.top_choice",): "Job preference",
    ("authorization.sponsorship",): "Work authorization",
    tuple(kind for kind, _required in _GREENHOUSE_CONTROL_PROFILE): (
        "Application form"
    ),
    tuple(kind for kind, _required in _ASHBY_CONTROL_PROFILE): "Application form",
    tuple(kind for kind, _required in _LEVER_CONTROL_PROFILE): "Application form",
}
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


def _validate_capture(
    capture: Any,
) -> tuple[str, str, str, list[dict[str, Any]]]:
    if not isinstance(capture, dict):
        raise CompilerError("invalid capture object")
    _closed(capture, _CAPTURE_KEYS, "capture")

    capture_id = _nonempty_string(capture.get("captureId"), "capture identifier")
    platform_family = capture.get("platformFamily")
    if not isinstance(platform_family, str) or platform_family not in _FLOW_PROFILES:
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

    observed_profile = tuple(
        (
            step.get("checkpoint"),
            tuple(
                (control.get("kind"), control.get("required"))
                for control in step["controls"]
            ),
        )
        for step in steps
    )
    if observed_profile not in _FLOW_PROFILES[platform_family]:
        raise CompilerError("unsupported application flow")

    for index, step in enumerate(steps):
        expected_keys = {"checkpoint", "controls"}
        if index == len(steps) - 1:
            expected_keys.add("finalActionObserved")
        if set(step) != expected_keys:
            raise CompilerError("invalid step fields")
        _validate_controls(step["controls"])

    review = steps[-1]
    if review["finalActionObserved"] is not True:
        raise CompilerError("final action observation required")

    return capture_id, platform_family, capture_month, steps


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


def _validate_controls(controls: list[dict[str, Any]]) -> None:
    kinds = tuple(control["kind"] for control in controls)
    if len(kinds) != len(set(kinds)):
        raise CompilerError("duplicate control kind")


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

    capture_id, platform_family, capture_month, steps = _validate_capture(capture)
    recorder_version, receipt_id, receipt_month, digest = _validate_receipt(receipt)
    if capture_id != receipt_id:
        raise CompilerError("capture identifier mismatch")
    if capture_month != receipt_month:
        raise CompilerError("capture month mismatch")

    try:
        form_steps = []
        for index, source_step in enumerate(steps[:-1], start=1):
            controls = [
                generic_control(control["kind"], control["required"])
                for control in source_step["controls"]
            ]
            kinds = tuple(control["kind"] for control in source_step["controls"])
            next_id = "review" if index == len(steps) - 1 else f"step-{index + 1}"
            form_steps.append(
                {
                    "id": f"step-{index}",
                    "kind": "form",
                    "title": _STEP_TITLES[kinds],
                    "controls": controls,
                    "next": next_id,
                }
            )
        fixture = {
            "schemaVersion": 1,
            "id": fixture_id,
            "platformFamily": platform_family,
            "captureMonth": capture_month,
            "compilerVersion": COMPILER_VERSION,
            "provenance": {
                "recorderVersion": recorder_version,
                "captureMonth": receipt_month,
                "sourceRecordingSha256": digest,
            },
            "steps": form_steps + [
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
