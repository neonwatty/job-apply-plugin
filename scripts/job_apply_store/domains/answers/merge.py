"""Crash-recoverable answer merge behavior for composed Store implementations."""

from __future__ import annotations

import copy
import hmac
import uuid
from datetime import datetime, timezone
from typing import Any

from ... import io, normalization
from ...errors import StoreError
from ...validation import profile_answers, sessions


def _canonical_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _canonical_validate_session_document(document: dict[str, Any]) -> None:
    sessions._validate_session_document(document, answer_match_module=None)


_CANONICAL_RUNTIME = {
    "_json_values_equal": normalization._json_values_equal,
    "_validate_answer_record": profile_answers._validate_answer_record,
    "_validate_answer_redirects": profile_answers._validate_answer_redirects,
    "_validate_session_document": _canonical_validate_session_document,
    "copy": copy,
    "exclusive_file_lock": io.exclusive_file_lock,
    "hmac": hmac,
    "normalize_question": normalization.normalize_question,
    "utc_now": _canonical_utc_now,
    "uuid": uuid,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class AnswerMergeMixin:
    """Answer merge operations composed ahead of the compatibility Store."""

    @staticmethod
    def _merged_observation_field(
        winner: dict[str, Any], source: dict[str, Any], field: str, earliest: bool
    ) -> str | None:
        values = [
            value for value in (winner.get(field), source.get(field))
            if isinstance(value, str) and value
        ]
        if not values:
            return None
        return min(values) if earliest else max(values)

    def _apply_answer_merge_locked(
        self, document: dict[str, Any], operation: dict[str, Any]
    ) -> dict[str, Any]:
        winner_key = operation["winnerKey"]
        source_key = operation["sourceKey"]
        expected_winner = operation["expectedWinnerRevision"]
        expected_source = operation["expectedSourceRevision"]
        redirects = document.setdefault("redirects", {})
        winner = document["answers"].get(winner_key)
        source = document["answers"].get(source_key)
        if source is None:
            redirect = redirects.get(source_key)
            if (
                redirect is None
                or redirect.get("targetKey") != winner_key
                or winner is None
                or winner.get("revision", 1) != expected_winner + 1
            ):
                raise StoreError("coordinator answer merge cannot be reconciled")
            return self._answer_view(winner)
        if winner is None:
            raise StoreError("answer merge winner does not exist")
        if (
            winner.get("revision", 1) != expected_winner
            or source.get("revision", 1) != expected_source
        ):
            raise StoreError("answer merge revision conflict")
        if winner.get("deletedAt") is not None or source.get("deletedAt") is not None:
            raise StoreError("answer merge records must be active")
        if winner.get("reviewStatus", "accepted") != "accepted":
            raise StoreError("answer merge winner must be accepted")
        if not _late("_json_values_equal")(
            winner.get("scope", {}), source.get("scope", {})
        ):
            raise StoreError("answer merge requires exact matching scope")

        aliases: list[str] = []
        winner_question_value = winner.get("question")
        winner_question = _late("normalize_question")(
            winner_question_value
            if isinstance(winner_question_value, str) and winner_question_value.strip()
            else winner_key
        )
        for value in [
            *winner.get("aliases", []),
            source.get("question"),
            *source.get("aliases", []),
        ]:
            if not isinstance(value, str) or not value.strip():
                continue
            normalized = _late("normalize_question")(value)
            if normalized != winner_question and normalized not in aliases:
                aliases.append(normalized)
        merged = dict(winner)
        merged["aliases"] = aliases
        merged["observationCount"] = (
            winner.get("observationCount", 0) + source.get("observationCount", 0)
        )
        for field, earliest in (("observedAt", True), ("lastObservedAt", False)):
            value = self._merged_observation_field(winner, source, field, earliest)
            if value is None:
                merged.pop(field, None)
            else:
                merged[field] = value
        merged["revision"] = expected_winner + 1
        merged["updatedAt"] = operation["at"]
        _late("_validate_answer_record")(winner_key, merged)
        collision_candidates = {
            key: value for key, value in document["answers"].items()
            if key != source_key
        }
        self._reject_answer_collisions(
            collision_candidates,
            merged,
            winner_key,
            redirects,
            {winner_key, source_key},
        )
        document["answers"][winner_key] = merged
        del document["answers"][source_key]
        for redirect in redirects.values():
            if redirect["targetKey"] == source_key:
                redirect["targetKey"] = winner_key
        redirects[source_key] = {
            "targetKey": winner_key,
            "mergedAt": operation["at"],
        }
        document["metadata"]["updatedAt"] = operation["at"]
        _late("_validate_answer_redirects")(redirects, document["answers"])
        return self._answer_view(merged)

    @staticmethod
    def _rewrite_session_answer_key(
        session: dict[str, Any], source_key: str, winner_key: str, at: str
    ) -> dict[str, Any]:
        rewritten = _late("copy").deepcopy(session)
        keys: list[str] = []
        for key in rewritten.get("answerKeys", []):
            key = winner_key if key == source_key else key
            if key not in keys:
                keys.append(key)
        rewritten["answerKeys"] = keys
        for field in rewritten.get("pendingFields", []):
            if field.get("answerKey") == source_key:
                field["answerKey"] = winner_key
                field.pop("matchConfidence", None)
                field.pop("matchReasonCodes", None)
                field.pop("matchAnswerRevision", None)
        rewritten["approvals"] = [
            approval
            for approval in rewritten.get("approvals", [])
            if approval.get("answerKey") != source_key
        ]
        rewritten["updatedAt"] = at
        _late("_validate_session_document")(rewritten)
        return rewritten

    def merge_answers(
        self,
        winner_key: str,
        source_key: str,
        expected_winner_revision: int,
        expected_source_revision: int,
        *,
        cleanup_approval: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_coordinator_files()
        if not all(isinstance(key, str) and key for key in (winner_key, source_key)):
            raise StoreError("answer merge keys must be non-empty strings")
        if winner_key == source_key:
            raise StoreError("answer merge requires distinct records")
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_answers_document()
            if cleanup_approval is not None:
                current_preview = self._preview_answer_cleanup_document(document)
                if not _late("hmac").compare_digest(
                    cleanup_approval["previewToken"],
                    current_preview["previewToken"],
                ):
                    raise StoreError("answer cleanup preview is stale")
                selected = {
                    key: cleanup_approval[key]
                    for key in (
                        "winnerKey", "duplicateKey", "winnerRevision",
                        "duplicateRevision",
                    )
                }
                if not any(
                    all(proposal.get(key) == value for key, value in selected.items())
                    for proposal in current_preview["proposals"]
                ):
                    raise StoreError(
                        "answer cleanup selection is not in the preview"
                    )
            redirects = self._answer_redirects(document)
            if winner_key in redirects or source_key in redirects:
                raise StoreError("answer merge records must be canonical active records")
            winner = document["answers"].get(winner_key)
            source = document["answers"].get(source_key)
            if winner is None or source is None:
                raise StoreError("answer merge record does not exist")
            # Validate every semantic and collision condition against an in-memory
            # operation before the crash-recovery journal can become durable.
            now = _late("utc_now")()
            preview = {
                "kind": "answer_merge",
                "operationId": _late("uuid").uuid4().hex,
                "at": now,
                "winnerKey": winner_key,
                "sourceKey": source_key,
                "expectedWinnerRevision": expected_winner_revision,
                "expectedSourceRevision": expected_source_revision,
                "sessions": [],
                "resultClaim": self._load_coordinator_document()["claim"],
            }
            preview_document = _late("copy").deepcopy(document)
            preview_merged = self._apply_answer_merge_locked(preview_document, preview)
            sessions_to_write = []
            all_sessions = self._list_sessions_uninitialized()
            for session in all_sessions:
                if source_key in session.get("answerKeys", []) or any(
                    field.get("answerKey") == source_key
                    for field in session.get("pendingFields", [])
                ):
                    sessions_to_write.append(
                        self._rewrite_session_answer_key(
                            session, source_key, winner_key, now
                        )
                    )
            preview["sessions"] = sessions_to_write
            rewritten_by_id = {
                session["applicationId"]: session for session in sessions_to_write
            }
            projected_sessions = [
                rewritten_by_id.get(session["applicationId"], session)
                for session in all_sessions
            ]
            counts = self._answer_reference_counts(
                document=preview_document,
                sessions=projected_sessions,
                history=self.read_history(),
            )
            self._commit_coordinator_operation_locked(preview)
            result = self._answer_projection(preview_merged, counts)
            result["mergedFrom"] = source_key
            return result
