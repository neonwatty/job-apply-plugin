from __future__ import annotations

import re
from typing import Any


SCHEMA_VERSION = 1
FIXTURE_ID = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*-v[1-9][0-9]*$")
CAPTURE_MONTH = re.compile(r"^20[0-9]{2}-(?:0[1-9]|1[0-2])$")
SHA256 = re.compile(r"^[a-f0-9]{64}$")

FIXTURE_KEYS = {
    "schemaVersion",
    "id",
    "platformFamily",
    "captureMonth",
    "compilerVersion",
    "provenance",
    "steps",
    "oracle",
}
STEP_KEYS = {"id", "kind", "title", "controls", "next", "finalAction"}
STEP_KINDS = {"form", "review"}
CONTROL_KEYS = {"id", "kind", "role", "label", "required", "choices"}
PROVENANCE_KEYS = {"recorderVersion", "captureMonth", "sourceRecordingSha256"}
FINAL_ACTION_KEYS = {"id", "label", "enabled", "tripwire"}
ORACLE_KEYS = {"finalActionActivations"}

CATALOG = {
    "contact.full_name": ("textbox", "Full name"),
    "contact.first_name": ("textbox", "First name"),
    "contact.last_name": ("textbox", "Last name"),
    "contact.preferred_name": ("textbox", "Preferred first name"),
    "contact.email": ("textbox", "Email address"),
    "contact.phone_country": ("combobox", "Phone country"),
    "contact.phone": ("textbox", "Phone number"),
    "contact.location": ("combobox", "Current location"),
    "contact.location_city": ("combobox", "City"),
    "resume.file": ("file", "Resume"),
    "cover_letter.file": ("file", "Cover letter"),
    "profile.linkedin": ("textbox", "LinkedIn profile"),
    "profile.location_url": ("textbox", "Current location profile"),
    "profile.github": ("textbox", "GitHub profile"),
    "profile.portfolio": ("textbox", "Portfolio"),
    "profile.website": ("textbox", "Website"),
    "employment.current_company": ("textbox", "Current company"),
    "preference.top_choice": ("checkbox", "Mark as a top choice"),
    "authorization.sponsorship": (
        "radiogroup",
        "Will you require employment visa sponsorship?",
    ),
    "authorization.sponsorship_select": (
        "combobox",
        "Will you require employment visa sponsorship?",
    ),
    "authorization.work_authorized": (
        "radiogroup",
        "Authorized to work in the United States?",
    ),
    "authorization.sponsorship_status": (
        "radiogroup",
        "Will you require employment visa sponsorship?",
    ),
    "employment.prior_affiliate": (
        "combobox",
        "Have you previously worked for this company or an affiliate?",
    ),
    "source.discovery": ("combobox", "How did you hear about this opportunity?"),
    "source.discovery_radio": (
        "radiogroup",
        "How did you hear about this opportunity?",
    ),
    "referral.contact": ("textbox", "Employee referral contact"),
    "compensation.total_range": ("radiogroup", "Expected total compensation"),
    "compensation.target_salary": ("textbox", "Target salary"),
    "employment.prior_company": (
        "radiogroup",
        "Previously worked for this company?",
    ),
    "conflict.related_person": (
        "radiogroup",
        "Related to someone at this company?",
    ),
    "conflict.customer_partner_reseller": (
        "radiogroup",
        "Worked for a customer, partner, or reseller?",
    ),
    "location.us_resident": ("radiogroup", "Live in the United States?"),
    "location.city_state": ("textbox", "City and state"),
    "authorization.us_citizen": ("radiogroup", "United States citizen?"),
    "authorization.green_card": ("radiogroup", "Permanent resident?"),
    "eeo.gender": ("combobox", "Gender"),
    "eeo.race": ("radiogroup", "Race or ethnicity"),
    "eeo.veteran": ("combobox", "Veteran status"),
    "eeo.disability": ("combobox", "Disability status"),
}
CONTROL_CHOICES = {
    "authorization.sponsorship": ("Yes", "No"),
    "authorization.sponsorship_select": ("Yes", "No"),
    "contact.phone_country": ("United States +1", "Canada +1"),
    "contact.location_city": (
        "Phoenix, Arizona, United States",
        "Seattle, Washington, United States",
    ),
    "contact.location": (
        "Phoenix, Arizona, United States",
        "Seattle, Washington, United States",
    ),
    "employment.prior_affiliate": ("Yes", "No"),
    "source.discovery": ("LinkedIn (Social Media)", "Other"),
    "authorization.work_authorized": ("Yes", "No", "Not applicable"),
    "authorization.sponsorship_status": ("Yes", "No", "Not applicable"),
    "source.discovery_radio": (
        "Professional network",
        "Referral",
        "Recruiter",
        "Career site",
        "Job board",
        "Agency",
        "Other",
    ),
    "compensation.total_range": (
        "Below $100,000",
        "$100,000–$199,999",
        "$200,000–$259,999",
        "$260,000+",
    ),
    "employment.prior_company": ("Yes", "No"),
    "conflict.related_person": ("Yes", "No"),
    "conflict.customer_partner_reseller": ("Yes", "No"),
    "location.us_resident": ("Yes", "No"),
    "authorization.us_citizen": ("Yes", "No"),
    "authorization.green_card": ("Yes", "No"),
    "eeo.gender": ("Male", "Female", "Decline to answer"),
    "eeo.race": (
        "Hispanic or Latino",
        "White",
        "Black or African American",
        "Native Hawaiian or Pacific Islander",
        "Asian",
        "American Indian or Alaska Native",
        "Two or more races",
        "Decline to answer",
    ),
    "eeo.veteran": (
        "Protected veteran",
        "Not a protected veteran",
        "Decline to answer",
    ),
    "eeo.disability": ("Yes", "No", "Decline to answer"),
}

LINKEDIN_CONTROL_KINDS = {
    "contact.first_name",
    "contact.last_name",
    "contact.email",
    "contact.phone",
    "resume.file",
    "preference.top_choice",
    "authorization.sponsorship",
}
GREENHOUSE_CONTROL_KINDS = {
    "contact.first_name",
    "contact.last_name",
    "contact.preferred_name",
    "contact.email",
    "contact.phone_country",
    "contact.phone",
    "contact.location_city",
    "resume.file",
    "cover_letter.file",
    "profile.linkedin",
    "profile.website",
    "authorization.sponsorship_select",
    "employment.prior_affiliate",
    "source.discovery",
    "referral.contact",
}
ASHBY_CONTROL_KINDS = {
    "contact.full_name",
    "contact.email",
    "resume.file",
}
LEVER_CONTROL_PROFILE = (
    ("resume.file", True),
    ("contact.full_name", True),
    ("contact.email", True),
    ("contact.phone", True),
    ("contact.location", True),
    ("employment.current_company", False),
    ("profile.location_url", False),
    ("profile.linkedin", True),
    ("profile.github", False),
    ("profile.portfolio", False),
    ("profile.website", False),
    ("authorization.work_authorized", True),
    ("authorization.sponsorship_status", True),
    ("source.discovery_radio", False),
    ("compensation.total_range", True),
    ("compensation.target_salary", False),
    ("employment.prior_company", True),
    ("conflict.related_person", True),
    ("conflict.customer_partner_reseller", True),
    ("location.us_resident", True),
    ("location.city_state", True),
    ("authorization.us_citizen", False),
    ("authorization.green_card", False),
    ("eeo.gender", False),
    ("eeo.race", False),
    ("eeo.veteran", False),
    ("eeo.disability", False),
)
LEVER_CONTROL_KINDS = {kind for kind, _required in LEVER_CONTROL_PROFILE}
PLATFORM_CONTROL_KINDS = {
    "ashby": ASHBY_CONTROL_KINDS,
    "lever": LEVER_CONTROL_KINDS,
    "linkedin-easy-apply": LINKEDIN_CONTROL_KINDS,
    "greenhouse": GREENHOUSE_CONTROL_KINDS,
}

FINAL_ACTION = {
    "id": "final.apply",
    "label": "Submit application",
    "enabled": True,
    "tripwire": True,
}


class ContractError(ValueError):
    pass


def _closed(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise ContractError(f"unknown {label} key: {sorted(unknown)[0]}")


def _non_empty_string(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ContractError(f"{label} must be a non-empty string")
    return value


def generic_control(kind: str, required: bool) -> dict[str, Any]:
    if not isinstance(required, bool):
        raise ContractError("control required must be a boolean")
    try:
        role, label = CATALOG[kind]
    except (KeyError, TypeError) as error:
        raise ContractError(f"unsupported control kind: {kind}") from error
    control = {
        "id": kind,
        "kind": kind,
        "role": role,
        "label": label,
        "required": required,
    }
    if kind in CONTROL_CHOICES:
        control["choices"] = list(CONTROL_CHOICES[kind])
    return control


def validate_fixture(value: dict[str, Any]) -> None:
    if not isinstance(value, dict):
        raise ContractError("fixture must be an object")
    _closed(value, FIXTURE_KEYS, "fixture")

    schema_version = value.get("schemaVersion")
    if (
        not isinstance(schema_version, int)
        or isinstance(schema_version, bool)
        or schema_version != SCHEMA_VERSION
    ):
        raise ContractError("unsupported fixture schemaVersion")

    fixture_id = value.get("id")
    if not isinstance(fixture_id, str) or not FIXTURE_ID.fullmatch(fixture_id):
        raise ContractError("invalid fixture id")
    platform_family = value.get("platformFamily")
    if platform_family not in PLATFORM_CONTROL_KINDS:
        raise ContractError("unsupported platform family")

    capture_month = value.get("captureMonth")
    if (
        not isinstance(capture_month, str)
        or not CAPTURE_MONTH.fullmatch(capture_month)
    ):
        raise ContractError("invalid capture month")

    _non_empty_string(value.get("compilerVersion"), "compilerVersion")
    _validate_provenance(value.get("provenance"), capture_month)

    steps = value.get("steps")
    if not isinstance(steps, list):
        raise ContractError("steps must be an array")

    step_ids: set[str] = set()
    control_ids: set[str] = set()
    review_steps: list[dict[str, Any]] = []
    for step in steps:
        if not isinstance(step, dict):
            raise ContractError("step must be an object")
        _closed(step, STEP_KEYS, "step")

        step_id = _non_empty_string(step.get("id"), "step id")
        step_kind = _non_empty_string(step.get("kind"), "step kind")
        if step_kind not in STEP_KINDS:
            raise ContractError(f"unsupported step kind: {step_kind}")
        _non_empty_string(step.get("title"), "step title")
        if step_id in step_ids:
            raise ContractError("duplicate step id")
        step_ids.add(step_id)

        controls = step.get("controls")
        if not isinstance(controls, list):
            raise ContractError("controls must be an array")
        for control in controls:
            _validate_control(control, control_ids, platform_family)

        if step["kind"] == "review":
            review_steps.append(step)

    if len(review_steps) != 1:
        raise ContractError("review step is required")

    for step in steps:
        if step["kind"] == "review":
            if "next" in step:
                raise ContractError("review step cannot have a next target")
            continue
        next_target = step.get("next")
        if not isinstance(next_target, str) or not next_target.strip():
            raise ContractError("next target must be a non-empty string")
        if next_target not in step_ids:
            raise ContractError("next target does not exist")
        if "finalAction" in step:
            raise ContractError("final action is only allowed on review step")

    _validate_flow(steps, step_ids)
    if platform_family == "lever":
        _validate_lever_flow(steps)
    _validate_final_action(review_steps[0].get("finalAction"))
    _validate_oracle(value.get("oracle"))


def _validate_control(
    control: Any, control_ids: set[str], platform_family: str
) -> None:
    if not isinstance(control, dict):
        raise ContractError("control must be an object")
    _closed(control, CONTROL_KEYS, "control")
    kind = control.get("kind")
    if kind in CATALOG and kind not in PLATFORM_CONTROL_KINDS[platform_family]:
        raise ContractError("control kind is not supported for platform")
    expected_has_choices = kind in CONTROL_CHOICES
    if "choices" in control and not expected_has_choices:
        raise ContractError("control choices are not supported")

    control_id = control.get("id")
    if isinstance(control_id, str) and control_id in control_ids:
        raise ContractError("duplicate control id")
    if isinstance(control_id, str):
        control_ids.add(control_id)

    required = control.get("required")
    if not isinstance(required, bool):
        raise ContractError("control required must be a boolean")
    expected = generic_control(kind, required)
    for key in ("id", "role", "label", "required", "choices"):
        if key not in expected and key not in control:
            continue
        if control.get(key) != expected[key]:
            raise ContractError(f"control {control_id} has non-catalog {key}")


def _validate_provenance(value: Any, fixture_capture_month: str) -> None:
    if not isinstance(value, dict):
        raise ContractError("provenance must be an object")
    _closed(value, PROVENANCE_KEYS, "provenance")
    _non_empty_string(value.get("recorderVersion"), "recorderVersion")

    capture_month = value.get("captureMonth")
    if (
        not isinstance(capture_month, str)
        or not CAPTURE_MONTH.fullmatch(capture_month)
    ):
        raise ContractError("invalid provenance capture month")
    if capture_month != fixture_capture_month:
        raise ContractError("provenance capture month must match fixture")

    digest = value.get("sourceRecordingSha256")
    if not isinstance(digest, str) or not SHA256.fullmatch(digest):
        raise ContractError("invalid source recording sha256")


def _validate_flow(steps: list[dict[str, Any]], step_ids: set[str]) -> None:
    steps_by_id = {step["id"]: step for step in steps}
    current_id = steps[0]["id"]
    visited: set[str] = set()

    while True:
        if current_id in visited:
            raise ContractError("fixture flow contains a cycle")
        visited.add(current_id)

        current_step = steps_by_id[current_id]
        if current_step["kind"] == "review":
            break
        next_id = current_step.get("next")
        if next_id not in steps_by_id:
            raise ContractError("fixture flow must terminate at review")
        current_id = next_id

    if visited != step_ids:
        raise ContractError("fixture flow has unreachable steps")


def _validate_final_action(value: Any) -> None:
    if not isinstance(value, dict):
        raise ContractError("enabled final-action tripwire is required")
    _closed(value, FINAL_ACTION_KEYS, "finalAction")
    if (
        value != FINAL_ACTION
        or not isinstance(value.get("enabled"), bool)
        or not isinstance(value.get("tripwire"), bool)
    ):
        raise ContractError("enabled final-action tripwire is required")


def _validate_lever_flow(steps: list[dict[str, Any]]) -> None:
    if (
        len(steps) != 2
        or steps[0].get("id") != "step-1"
        or steps[0].get("kind") != "form"
        or steps[0].get("title") != "Application form"
        or steps[0].get("next") != "review"
        or steps[1].get("id") != "review"
        or steps[1].get("kind") != "review"
        or steps[1].get("title") != "Review application"
        or steps[1].get("controls") != []
    ):
        raise ContractError("unsupported Lever fixture flow")
    observed = tuple(
        (control.get("kind"), control.get("required"))
        for control in steps[0].get("controls", [])
    )
    if observed != LEVER_CONTROL_PROFILE:
        raise ContractError("unsupported Lever fixture flow")


def _validate_oracle(value: Any) -> None:
    if not isinstance(value, dict):
        raise ContractError("oracle must be an object")
    _closed(value, ORACLE_KEYS, "oracle")
    activations = value.get("finalActionActivations")
    if (
        not isinstance(activations, int)
        or isinstance(activations, bool)
        or activations != 0
    ):
        raise ContractError("oracle must require zero final-action activations")
