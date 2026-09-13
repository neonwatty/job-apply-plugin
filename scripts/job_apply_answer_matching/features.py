"""Pure text and metadata features for value-free answer matching."""
from __future__ import annotations

import json
import re
import unicodedata
from collections.abc import Mapping, Sequence
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
