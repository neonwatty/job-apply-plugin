"""Deterministic answer-candidate scoring and ranking."""
from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from .features import (
    CONFIDENCE_BANDS, CONFIDENCE_EXACT, CONFIDENCE_HIGH, CONFIDENCE_NONE,
    CONFIDENCE_UNCERTAIN, REASON_CODES, AnswerMatchError, _answer_key,
    _candidate_texts, _features, _field_class, _has_negation, _metadata_reasons,
    _normalized_text, _require_text, _scope_fingerprint, _semantic_band,
    _sensitivity, _similarity, _BAND_ORDER,
)

@dataclass(frozen=True)
class _ScoredCandidate:
    key: str
    band: str
    reasons: tuple[str, ...]
    score: float

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
