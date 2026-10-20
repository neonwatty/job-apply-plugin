"""Non-mutating duplicate-answer cleanup proposals."""
from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

from .features import (
    CONFIDENCE_EXACT, CONFIDENCE_HIGH, AnswerMatchError, _answer_key,
    _candidate_texts, _field_class, _sensitivity,
)
from .reuse import _candidate_policy_reasons
from .scoring import rank_candidates

def propose_cleanup(
    *,
    candidates: Iterable[Mapping[str, Any]],
    _ranker=rank_candidates,
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
            match = _ranker(
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
