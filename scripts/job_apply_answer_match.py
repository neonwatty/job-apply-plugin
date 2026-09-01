#!/usr/bin/env python3
"""Deterministic, value-free answer matching and reuse policy primitives.

This module deliberately has no storage, browser, network, or model dependency.
It consumes ephemeral question text and metadata, but every public result contains
only opaque answer keys, confidence bands, and closed reason codes.  Callers own
all persistence, consent, and final-action boundaries.
"""

from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any


CONFIDENCE_EXACT = "exact"
CONFIDENCE_HIGH = "high"
CONFIDENCE_UNCERTAIN = "uncertain"
CONFIDENCE_NONE = "none"
CONFIDENCE_BANDS = {
    CONFIDENCE_EXACT,
    CONFIDENCE_HIGH,
    CONFIDENCE_UNCERTAIN,
    CONFIDENCE_NONE,
}

MODE_STRICT = "strict"
MODE_BOUNDED_LOOSE = "bounded_loose"
POLICY_MODES = {MODE_STRICT, MODE_BOUNDED_LOOSE}

AUTHORITY_NONE = "none"
AUTHORITY_ACCEPTED_RECORD = "accepted_record"
AUTHORITY_PER_USE = "per_use"
AUTHORITY_BOUNDED_POLICY = "bounded_policy"
USE_AUTHORITIES = {
    AUTHORITY_NONE,
    AUTHORITY_ACCEPTED_RECORD,
    AUTHORITY_PER_USE,
    AUTHORITY_BOUNDED_POLICY,
}

SENSITIVITY_LEVELS = {"none", "personal", "high"}
ACTIVE_STATES = {"confirmed", "inferred", "missing", "sensitive"}
REVIEW_STATUSES = {"accepted", "pending", "declined"}
RECORD_STATUSES = {"active", "deleted"}
VALUE_STATES = {"seen", "unseen", "missing"}

# Results may contain only members of this closed vocabulary.  The codes carry
# policy decisions without returning a boolean that could be mistaken for broad
# application or submission authority.
REASON_CODES = {
    "match_exact_question",
    "match_exact_alias",
    "match_semantic_high",
    "match_semantic_uncertain",
    "no_semantic_match",
    "scope_match",
    "scope_mismatch",
    "field_class_match",
    "field_class_mismatch",
    "sensitivity_match",
    "sensitivity_mismatch",
    "polarity_mismatch",
    "ambiguous_tie",
    "candidate_active",
    "candidate_deleted",
    "candidate_accepted",
    "candidate_not_accepted",
    "candidate_confirmed",
    "candidate_not_confirmed",
    "value_seen",
    "value_unseen",
    "value_missing",
    "mode_strict",
    "mode_bounded_loose",
    "authority_per_use",
    "authority_accepted_record",
    "authority_bounded_policy",
    "authority_missing",
    "field_class_allowlisted",
    "field_class_not_allowlisted",
    "confidence_eligible",
    "confidence_ineligible",
    "reuse_eligible",
    "owner_confirmation_required",
    "cleanup_merge_proposed",
    "cleanup_winner_accepted",
    "cleanup_duplicate_pending",
}

_FIELD_CLASS = re.compile(r"^[a-z][a-z0-9_]{0,63}$", re.ASCII)
_WORD = re.compile(r"[^\W_]+", re.UNICODE)
_NEGATIONS = {"no", "not", "never", "without", "neither", "nor"}

_STOP_WORDS = {
    "a",
    "an",
    "and",
    "applicant",
    "are",
    "as",
    "at",
    "be",
    "been",
    "being",
    "by",
    "do",
    "does",
    "for",
    "from",
    "have",
    "in",
    "is",
    "it",
    "of",
    "on",
    "or",
    "that",
    "the",
    "this",
    "to",
    "which",
    "who",
    "will",
    "with",
    "would",
    "you",
    "your",
}

_SYNONYMS = {
    "allow": "permission",
    "allowed": "permission",
    "authorize": "permission",
    "authorized": "permission",
    "authorization": "permission",
    "eligible": "permission",
    "eligibility": "permission",
    "permit": "permission",
    "permitted": "permission",
    "permission": "permission",
    "employ": "work",
    "employed": "work",
    "employment": "work",
    "job": "work",
    "work": "work",
    "working": "work",
    "country": "jurisdiction",
    "location": "jurisdiction",
    "nation": "jurisdiction",
    "territory": "jurisdiction",
    "sponsor": "sponsorship",
    "sponsored": "sponsorship",
    "sponsoring": "sponsorship",
    "sponsorship": "sponsorship",
    "immigration": "immigration",
    "visa": "immigration",
    "require": "require",
    "required": "require",
    "requires": "require",
    "requiring": "require",
    "need": "require",
    "needed": "require",
    "needs": "require",
    "future": "future",
    "later": "future",
    "eventually": "future",
    "current": "current",
    "currently": "current",
    "now": "current",
    "present": "current",
    "assist": "assistance",
    "assistance": "assistance",
    "help": "assistance",
    "start": "start",
    "begin": "start",
    "commence": "start",
    "available": "available",
    "availability": "available",
    "relocate": "relocate",
    "relocation": "relocate",
    "move": "relocate",
    "travel": "travel",
    "traveling": "travel",
    "travelling": "travel",
}

_BAND_ORDER = {
    CONFIDENCE_EXACT: 3,
    CONFIDENCE_HIGH: 2,
    CONFIDENCE_UNCERTAIN: 1,
    CONFIDENCE_NONE: 0,
}


class AnswerMatchError(ValueError):
    """A value-free validation failure at the matcher boundary."""


@dataclass(frozen=True)
class _ScoredCandidate:
    key: str
    band: str
    reasons: tuple[str, ...]
    score: float


def _require_text(value: Any, label: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise AnswerMatchError(f"{label} is invalid")
    return value


def _answer_key(record: Mapping[str, Any]) -> str:
    key = record.get("answerKey", record.get("key"))
    if not isinstance(key, str) or not key.strip():
        raise AnswerMatchError("answer key is invalid")
    return key


def _field_class(value: Any) -> str:
    if not isinstance(value, str) or _FIELD_CLASS.fullmatch(value) is None:
        raise AnswerMatchError("field class is invalid")
    return value


def _sensitivity(value: Any) -> str:
    if value not in SENSITIVITY_LEVELS:
        raise AnswerMatchError("sensitivity is invalid")
    return str(value)


def _scope_fingerprint(scope: Any) -> str:
    if not isinstance(scope, Mapping):
        raise AnswerMatchError("scope is invalid")
    try:
        return json.dumps(scope, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
    except (TypeError, ValueError, OverflowError) as error:
        raise AnswerMatchError("scope is invalid") from error


def _raw_tokens(text: str) -> tuple[str, ...]:
    normalized = unicodedata.normalize("NFKC", _require_text(text, "question")).casefold()
    return tuple(_WORD.findall(normalized))


def _features(text: str) -> frozenset[str]:
    features = []
    for token in _raw_tokens(text):
        if token in _STOP_WORDS or token in _NEGATIONS:
            continue
        canonical = _SYNONYMS.get(token, token)
        if len(canonical) > 2:
            features.append(canonical)
    return frozenset(features)


def _normalized_text(text: str) -> str:
    return " ".join(_raw_tokens(text))


def _has_negation(text: str) -> bool:
    return any(token in _NEGATIONS for token in _raw_tokens(text))


def _similarity(left: frozenset[str], right: frozenset[str]) -> float:
    if not left or not right:
        return 0.0
    overlap = len(left & right)
    if overlap == 0:
        return 0.0
    containment = overlap / min(len(left), len(right))
    jaccard = overlap / len(left | right)
    return (0.65 * containment) + (0.35 * jaccard)


def _semantic_band(score: float, shared_features: int) -> str:
    # Two independent meaningful features are required for automatic semantic
    # reuse.  Single-token similarities remain owner-review suggestions.
    if shared_features >= 2 and score >= 0.82:
        return CONFIDENCE_HIGH
    if shared_features >= 1 and score >= 0.35:
        return CONFIDENCE_UNCERTAIN
    return CONFIDENCE_NONE


def _candidate_texts(record: Mapping[str, Any]) -> tuple[str, tuple[str, ...]]:
    question = _require_text(record.get("question"), "candidate question")
    aliases = record.get("aliases", ())
    if not isinstance(aliases, Sequence) or isinstance(aliases, (str, bytes)):
        raise AnswerMatchError("candidate aliases are invalid")
    if not all(isinstance(alias, str) and alias.strip() for alias in aliases):
        raise AnswerMatchError("candidate aliases are invalid")
    return question, tuple(aliases)


def _metadata_reasons(
    record: Mapping[str, Any],
    *,
    scope: Mapping[str, Any],
    field_class: str,
    sensitivity: str,
) -> tuple[str, ...]:
    reasons = []
    reasons.append(
        "scope_match"
        if _scope_fingerprint(record.get("scope", {})) == _scope_fingerprint(scope)
        else "scope_mismatch"
    )
    candidate_class = record.get("fieldClass")
    reasons.append(
        "field_class_match"
        if candidate_class == field_class
        else "field_class_mismatch"
    )
    candidate_sensitivity = record.get("sensitivity", "none")
    if candidate_sensitivity not in SENSITIVITY_LEVELS:
        raise AnswerMatchError("candidate sensitivity is invalid")
    reasons.append(
        "sensitivity_match"
        if candidate_sensitivity == sensitivity
        else "sensitivity_mismatch"
    )
    return tuple(reasons)


def _score_candidate(
    question: str,
    scope: Mapping[str, Any],
    field_class: str,
    sensitivity: str,
    record: Mapping[str, Any],
) -> _ScoredCandidate:
    key = _answer_key(record)
    candidate_question, aliases = _candidate_texts(record)
    observed_normalized = _normalized_text(question)
    candidate_normalized = _normalized_text(candidate_question)
    alias_normalized = tuple(_normalized_text(alias) for alias in aliases)
    metadata = _metadata_reasons(
        record, scope=scope, field_class=field_class, sensitivity=sensitivity
    )

    if observed_normalized == candidate_normalized:
        band = CONFIDENCE_EXACT
        reasons = ("match_exact_question",) + metadata
        score = 1.0
    elif observed_normalized in alias_normalized:
        band = CONFIDENCE_EXACT
        reasons = ("match_exact_alias",) + metadata
        score = 0.995
    else:
        observed_features = _features(question)
        best_score = 0.0
        best_shared = 0
        polarity_mismatch = False
        for candidate_text in (candidate_question,) + aliases:
            candidate_features = _features(candidate_text)
            similarity = _similarity(observed_features, candidate_features)
            shared = len(observed_features & candidate_features)
            if similarity > best_score or (
                similarity == best_score and shared > best_shared
            ):
                best_score = similarity
                best_shared = shared
                polarity_mismatch = _has_negation(question) != _has_negation(candidate_text)
        if polarity_mismatch:
            band = CONFIDENCE_NONE
            reasons = ("polarity_mismatch", "no_semantic_match") + metadata
            score = 0.0
        else:
            band = _semantic_band(best_score, best_shared)
            match_reason = {
                CONFIDENCE_HIGH: "match_semantic_high",
                CONFIDENCE_UNCERTAIN: "match_semantic_uncertain",
                CONFIDENCE_NONE: "no_semantic_match",
            }[band]
            reasons = (match_reason,) + metadata
            score = best_score

    # Compatibility never upgrades a linguistic match.  It does prevent an
    # incompatible record from becoming an automatic-reuse candidate.
    if any(
        reason in reasons
        for reason in ("scope_mismatch", "field_class_mismatch", "sensitivity_mismatch")
    ):
        band = CONFIDENCE_NONE
    return _ScoredCandidate(key=key, band=band, reasons=reasons, score=score)


def _projection(candidate: _ScoredCandidate) -> dict[str, Any]:
    reasons = list(candidate.reasons)
    if not set(reasons) <= REASON_CODES:
        raise AnswerMatchError("matcher produced an invalid result")
    return {
        "answerKey": candidate.key,
        "confidenceBand": candidate.band,
        "reasonCodes": reasons,
    }


def rank_candidates(
    *,
    question: str,
    scope: Mapping[str, Any],
    field_class: str,
    sensitivity: str,
    candidates: Iterable[Mapping[str, Any]],
    limit: int = 5,
) -> list[dict[str, Any]]:
    """Return deterministic, value-free semantic candidates.

    Scope, field class, and sensitivity must match exactly for any non-``none``
    confidence.  A high-confidence tie is downgraded to ``uncertain`` so it can
    never silently select between ambiguous canonical records.
    """

    question = _require_text(question, "question")
    scope_fingerprint = _scope_fingerprint(scope)
    del scope_fingerprint  # Validation only; the original mapping is never changed.
    field_class = _field_class(field_class)
    sensitivity = _sensitivity(sensitivity)
    if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 100:
        raise AnswerMatchError("candidate limit is invalid")
    if isinstance(candidates, (str, bytes, Mapping)):
        raise AnswerMatchError("candidate collection is invalid")

    scored = []
    seen_keys = set()
    try:
        iterator = iter(candidates)
    except TypeError as error:
        raise AnswerMatchError("candidate collection is invalid") from error
    for raw in iterator:
        if not isinstance(raw, Mapping):
            raise AnswerMatchError("candidate is invalid")
        candidate = _score_candidate(question, scope, field_class, sensitivity, raw)
        if candidate.key in seen_keys:
            raise AnswerMatchError("candidate keys are not unique")
        seen_keys.add(candidate.key)
        scored.append(candidate)

    scored.sort(key=lambda item: (-_BAND_ORDER[item.band], -item.score, item.key))
    if scored:
        top = scored[0]
        tied_indexes = [
            index
            for index, item in enumerate(scored)
            if item.band in {CONFIDENCE_EXACT, CONFIDENCE_HIGH}
            and top.band in {CONFIDENCE_EXACT, CONFIDENCE_HIGH}
            and abs(item.score - top.score) <= 0.02
        ]
        if len(tied_indexes) > 1:
            # Once the best canonical target is ambiguous, no other positive
            # candidate may become automatically reusable merely because the
            # tied leaders were downgraded during presentation sorting.
            for index, item in enumerate(scored):
                if item.band not in {CONFIDENCE_EXACT, CONFIDENCE_HIGH}:
                    continue
                scored[index] = _ScoredCandidate(
                    key=item.key,
                    band=CONFIDENCE_UNCERTAIN,
                    reasons=item.reasons + ("ambiguous_tie",),
                    score=item.score,
                )
            scored.sort(key=lambda item: (-_BAND_ORDER[item.band], -item.score, item.key))
    return [_projection(candidate) for candidate in scored[:limit]]


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


def propose_cleanup(
    *,
    candidates: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Return non-mutating, value-free merge proposals for clear duplicates.

    A proposal is emitted only when an accepted, active, confirmed, seen record
    is the unambiguous winner over a pending record with identical compatibility
    metadata and an exact or high semantic match.
    """

    if isinstance(candidates, (str, bytes, Mapping)):
        raise AnswerMatchError("candidate collection is invalid")
    try:
        records = list(candidates)
    except TypeError as error:
        raise AnswerMatchError("candidate collection is invalid") from error
    if not all(isinstance(record, Mapping) for record in records):
        raise AnswerMatchError("candidate is invalid")
    keys = [_answer_key(record) for record in records]
    if len(keys) != len(set(keys)):
        raise AnswerMatchError("candidate keys are not unique")

    proposals_by_duplicate: dict[str, list[dict[str, Any]]] = {}
    for winner in records:
        winner_reasons = _candidate_policy_reasons(winner)
        if not {
            "candidate_active",
            "candidate_accepted",
            "candidate_confirmed",
            "value_seen",
        } <= set(winner_reasons):
            continue
        winner_key = _answer_key(winner)
        winner_question, _ = _candidate_texts(winner)
        winner_scope = winner.get("scope", {})
        winner_class = _field_class(winner.get("fieldClass"))
        winner_sensitivity = _sensitivity(winner.get("sensitivity", "none"))
        for duplicate in records:
            duplicate_key = _answer_key(duplicate)
            if duplicate_key == winner_key:
                continue
            duplicate_policy = _candidate_policy_reasons(duplicate)
            if "candidate_active" not in duplicate_policy:
                continue
            if duplicate.get("reviewStatus", "accepted") != "pending":
                continue
            match = rank_candidates(
                question=winner_question,
                scope=winner_scope,
                field_class=winner_class,
                sensitivity=winner_sensitivity,
                candidates=[duplicate],
                limit=1,
            )[0]
            if match["confidenceBand"] not in {CONFIDENCE_EXACT, CONFIDENCE_HIGH}:
                continue
            reason_codes = [
                "cleanup_merge_proposed",
                "cleanup_winner_accepted",
                "cleanup_duplicate_pending",
                *match["reasonCodes"],
            ]
            proposals_by_duplicate.setdefault(duplicate_key, []).append(
                {
                    "winnerKey": winner_key,
                    "duplicateKey": duplicate_key,
                    "confidenceBand": match["confidenceBand"],
                    "reasonCodes": reason_codes,
                }
            )

    proposals = [
        duplicate_proposals[0]
        for duplicate_proposals in proposals_by_duplicate.values()
        if len(duplicate_proposals) == 1
    ]
    proposals.sort(key=lambda item: (item["winnerKey"], item["duplicateKey"]))
    return proposals


__all__ = [
    "AnswerMatchError",
    "AUTHORITY_ACCEPTED_RECORD",
    "AUTHORITY_BOUNDED_POLICY",
    "AUTHORITY_NONE",
    "AUTHORITY_PER_USE",
    "CONFIDENCE_BANDS",
    "MODE_BOUNDED_LOOSE",
    "MODE_STRICT",
    "REASON_CODES",
    "evaluate_reuse",
    "propose_cleanup",
    "rank_candidates",
]
