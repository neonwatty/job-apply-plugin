"""Bounded answer-reuse policy evaluation."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .features import (
    AUTHORITY_ACCEPTED_RECORD, AUTHORITY_BOUNDED_POLICY, AUTHORITY_PER_USE,
    ACTIVE_STATES, CONFIDENCE_BANDS, CONFIDENCE_EXACT, CONFIDENCE_HIGH,
    MODE_BOUNDED_LOOSE, MODE_STRICT, POLICY_MODES, REASON_CODES,
    RECORD_STATUSES, REVIEW_STATUSES, USE_AUTHORITIES, VALUE_STATES,
    AnswerMatchError, _answer_key, _field_class, _metadata_reasons,
    _scope_fingerprint, _sensitivity,
)

def _candidate_policy_reasons(record: Mapping[str, Any]) -> tuple[str, ...]:
    record_status = record.get("recordStatus", "active")
    if record_status not in RECORD_STATUSES:
        raise AnswerMatchError("candidate record status is invalid")
    review_status = record.get("reviewStatus", "accepted")
    if review_status not in REVIEW_STATUSES:
        raise AnswerMatchError("candidate review status is invalid")
    state = record.get("state")
    if state not in ACTIVE_STATES:
        raise AnswerMatchError("candidate state is invalid")
    value_state = record.get("valueState", "missing")
    if value_state not in VALUE_STATES:
        raise AnswerMatchError("candidate value state is invalid")
    return (
        "candidate_active" if record_status == "active" else "candidate_deleted",
        "candidate_accepted"
        if review_status == "accepted"
        else "candidate_not_accepted",
        "candidate_confirmed"
        if state == "confirmed"
        else "candidate_not_confirmed",
        {
            "seen": "value_seen",
            "unseen": "value_unseen",
            "missing": "value_missing",
        }[value_state],
    )


def evaluate_reuse(
    *,
    match: Mapping[str, Any],
    candidate: Mapping[str, Any],
    scope: Mapping[str, Any],
    field_class: str,
    sensitivity: str,
    mode: str,
    use_authority: str,
    allowed_sensitive_field_classes: Iterable[str] = (),
) -> dict[str, Any]:
    """Evaluate one candidate without granting remember or final-action authority.

    ``use_authority`` must be explicit.  ``strict`` requires ``per_use`` for a
    sensitive answer.  ``bounded_loose`` may additionally accept
    ``bounded_policy`` only for an explicitly allowlisted field class.
    """

    if not isinstance(match, Mapping) or not isinstance(candidate, Mapping):
        raise AnswerMatchError("reuse input is invalid")
    key = _answer_key(candidate)
    match_key = match.get("answerKey")
    band = match.get("confidenceBand")
    reasons = match.get("reasonCodes")
    if (
        match_key != key
        or band not in CONFIDENCE_BANDS
        or not isinstance(reasons, list)
        or not all(reason in REASON_CODES for reason in reasons)
    ):
        raise AnswerMatchError("match result is invalid")
    _scope_fingerprint(scope)
    field_class = _field_class(field_class)
    sensitivity = _sensitivity(sensitivity)
    if mode not in POLICY_MODES:
        raise AnswerMatchError("reuse mode is invalid")
    if use_authority not in USE_AUTHORITIES:
        raise AnswerMatchError("use authority is invalid")
    if isinstance(allowed_sensitive_field_classes, (str, bytes, Mapping)):
        raise AnswerMatchError("field class allowlist is invalid")
    try:
        allowed = frozenset(
            _field_class(item) for item in allowed_sensitive_field_classes
        )
    except TypeError as error:
        raise AnswerMatchError("field class allowlist is invalid") from error

    metadata_reasons = _metadata_reasons(
        candidate, scope=scope, field_class=field_class, sensitivity=sensitivity
    )
    policy_reasons = _candidate_policy_reasons(candidate)
    output_reasons = [
        "mode_strict" if mode == MODE_STRICT else "mode_bounded_loose",
        *metadata_reasons,
        *policy_reasons,
        "confidence_eligible"
        if band in {CONFIDENCE_EXACT, CONFIDENCE_HIGH}
        and "ambiguous_tie" not in reasons
        else "confidence_ineligible",
    ]

    compatible = (
        "scope_match" in metadata_reasons
        and "field_class_match" in metadata_reasons
        and "sensitivity_match" in metadata_reasons
    )
    candidate_safe = (
        "candidate_active" in policy_reasons
        and "candidate_accepted" in policy_reasons
        and "candidate_confirmed" in policy_reasons
        and "value_seen" in policy_reasons
    )
    confidence_safe = (
        band in {CONFIDENCE_EXACT, CONFIDENCE_HIGH}
        and "ambiguous_tie" not in reasons
    )

    authority_safe = False
    if use_authority == AUTHORITY_PER_USE:
        authority_safe = True
        output_reasons.append("authority_per_use")
    elif sensitivity == "none" and use_authority == AUTHORITY_ACCEPTED_RECORD:
        authority_safe = True
        output_reasons.append("authority_accepted_record")
    elif (
        sensitivity != "none"
        and mode == MODE_BOUNDED_LOOSE
        and use_authority == AUTHORITY_BOUNDED_POLICY
    ):
        output_reasons.append("authority_bounded_policy")
        if field_class in allowed:
            authority_safe = True
            output_reasons.append("field_class_allowlisted")
        else:
            output_reasons.append("field_class_not_allowlisted")
    else:
        output_reasons.append("authority_missing")

    eligible = compatible and candidate_safe and confidence_safe and authority_safe
    output_reasons.insert(
        0, "reuse_eligible" if eligible else "owner_confirmation_required"
    )
    return {
        "answerKey": key,
        "confidenceBand": band,
        "reasonCodes": output_reasons,
    }
