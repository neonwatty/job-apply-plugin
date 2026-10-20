"""Read-only answer storage, projection, and matching behavior."""

from __future__ import annotations

from typing import Any

from ...constants import ANSWER_REVIEW_STATUSES, ANSWER_STATES
from ...errors import StoreError
from ...io import read_json_object, require_object as _require_object, validate_version
from ...normalization import _json_values_equal, answer_key, normalize_question
from ...validation.profile_answers import (
    _validate_answer_record,
    _validate_answer_redirects,
)


ANSWER_MATCH_MODULE = None
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


class AnswerReadMixin:
    """Answer reads operating on Store state supplied by composition."""

    def _load_answers_document(self) -> dict[str, Any]:
        runtime = _runtime()
        document = runtime["read_json_object"](self.answers_path, "answers")
        runtime["validate_version"](document, "answers")
        answers = runtime["_require_object"](
            document.get("answers"), "answers.answers"
        )
        runtime["_require_object"](document.get("metadata"), "answers.metadata")
        for key, record in answers.items():
            if not isinstance(key, str) or not key:
                raise StoreError("answer index keys must be non-empty strings")
            runtime["_validate_answer_record"](key, record)
        runtime["_validate_answer_redirects"](
            document.get("redirects", {}), answers
        )
        return document

    @staticmethod
    def _answer_view(record: dict[str, Any]) -> dict[str, Any]:
        view = dict(record)
        view.setdefault("revision", 1)
        view.setdefault("createdAt", record.get("updatedAt"))
        view.setdefault("deletedAt", None)
        view.setdefault("reviewStatus", "accepted")
        view.setdefault("observationCount", 0)
        return view

    @staticmethod
    def _answer_is_sensitive(record: dict[str, Any]) -> bool:
        return record.get("state") == "sensitive" or record.get(
            "sensitivity", "none"
        ) != "none"

    @staticmethod
    def _answer_redirects(document: dict[str, Any]) -> dict[str, Any]:
        return _runtime()["_validate_answer_redirects"](
            document.get("redirects", {}), document["answers"]
        )

    @classmethod
    def _resolve_answer_key_in_document(
        cls, document: dict[str, Any], key: str
    ) -> str:
        redirect = cls._answer_redirects(document).get(key)
        return redirect["targetKey"] if redirect is not None else key

    def _answer_reference_counts(
        self,
        document: dict[str, Any] | None = None,
        sessions: list[dict[str, Any]] | None = None,
        history: list[dict[str, Any]] | None = None,
    ) -> dict[str, dict[str, int]]:
        document = document or self._load_answers_document()
        counts: dict[str, dict[str, int]] = {}
        for session in (
            sessions
            if sessions is not None
            else self._list_sessions_uninitialized()
        ):
            keys = set(session.get("answerKeys", []))
            keys.update(
                field.get("answerKey")
                for field in session.get("pendingFields", [])
                if isinstance(field.get("answerKey"), str)
            )
            for key in keys:
                resolved = self._resolve_answer_key_in_document(document, key)
                counts.setdefault(
                    resolved, {"sessions": 0, "history": 0}
                )["sessions"] += 1
        for event in history if history is not None else self.read_history():
            for key in set(event.get("answerKeys", [])):
                resolved = self._resolve_answer_key_in_document(document, key)
                counts.setdefault(
                    resolved, {"sessions": 0, "history": 0}
                )["history"] += 1
        return counts

    def _answer_projection(
        self,
        record: dict[str, Any],
        counts: dict[str, dict[str, int]] | None = None,
    ) -> dict[str, Any]:
        view = self._answer_view(record)
        projected = {key: value for key, value in view.items() if key != "value"}
        projected["hasValue"] = view.get("value") is not None
        projected["valueRedacted"] = (
            self._answer_is_sensitive(view) and projected["hasValue"]
        )
        references = (counts or {}).get(
            view["key"], {"sessions": 0, "history": 0}
        )
        projected["referenceCounts"] = {
            "sessions": references["sessions"],
            "history": references["history"],
            "total": references["sessions"] + references["history"],
        }
        return projected

    def answer_detail_projection(
        self,
        record: dict[str, Any],
        document: dict[str, Any],
        reveal_value: bool = False,
    ) -> dict[str, Any]:
        projected = self._answer_projection(
            record, self._answer_reference_counts(document=document)
        )
        if reveal_value or not self._answer_is_sensitive(record):
            projected["value"] = record.get("value")
        return projected

    def _answer_mutation_projection(
        self, record: dict[str, Any], counts: dict[str, dict[str, int]]
    ) -> dict[str, Any]:
        projected = self._answer_projection(record, counts)
        if not self._answer_is_sensitive(record):
            projected["value"] = record.get("value")
        return projected

    def _get_answer_record(
        self,
        key: str,
        include_trashed: bool = False,
        document: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        document = document or self._load_answers_document()
        resolved = self._resolve_answer_key_in_document(document, key)
        answer = document["answers"].get(resolved)
        if answer is None or (
            answer.get("deletedAt") is not None and not include_trashed
        ):
            return None
        return self._answer_view(
            _runtime()["_require_object"](answer, "answer record")
        )

    @staticmethod
    def _answer_candidates(record: dict[str, Any]) -> set[str]:
        values: list[str] = []
        if isinstance(record.get("question"), str) and record["question"].strip():
            values.append(record["question"])
        values.extend(
            alias
            for alias in record.get("aliases", [])
            if isinstance(alias, str) and alias.strip()
        )
        normalize = _runtime()["normalize_question"]
        return {normalize(value) for value in values}

    def get_answer(
        self, key: str, include_trashed: bool = False
    ) -> dict[str, Any] | None:
        self.initialize()
        document = self._load_answers_document()
        resolved = self._resolve_answer_key_in_document(document, key)
        answer = self._get_answer_record(key, include_trashed, document=document)
        if answer is None:
            return None
        projection = self.answer_detail_projection(answer, document=document)
        if resolved != key:
            projection["redirectedFrom"] = key
        return projection

    def _list_answer_records(
        self,
        state: str | None = None,
        include_trashed: bool = False,
        review_status: str | None = "accepted",
        document: dict[str, Any] | None = None,
    ) -> list[dict[str, Any]]:
        self.initialize()
        if state is not None and (
            not isinstance(state, str) or state not in ANSWER_STATES
        ):
            raise StoreError("answer state is unsupported")
        if review_status is not None and (
            not isinstance(review_status, str)
            or review_status not in ANSWER_REVIEW_STATUSES
        ):
            raise StoreError("answer review status is unsupported")
        document = document or self._load_answers_document()
        records = []
        for record in document["answers"].values():
            if record.get("deletedAt") is not None and not include_trashed:
                continue
            if state is not None and record.get("state") != state:
                continue
            if (
                review_status is not None
                and record.get("reviewStatus", "accepted") != review_status
            ):
                continue
            records.append(self._answer_view(record))
        return sorted(
            records,
            key=lambda item: (
                item.get("question") or "",
                item["key"],
            ),
        )

    def list_answers(
        self,
        state: str | None = None,
        include_trashed: bool = False,
        review_status: str | None = "accepted",
    ) -> list[dict[str, Any]]:
        self.initialize()
        document = self._load_answers_document()
        records = self._list_answer_records(
            state, include_trashed, review_status, document=document
        )
        counts = self._answer_reference_counts(document=document)
        return [self._answer_projection(record, counts) for record in records]

    def query_answers(
        self,
        query: str = "",
        state: str | None = None,
        review_status: str | None = "accepted",
        include_trashed: bool = False,
        trashed_only: bool = False,
        offset: int = 0,
        limit: int = 50,
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(query, str):
            raise StoreError("answer query must be a string")
        if not isinstance(include_trashed, bool) or not isinstance(
            trashed_only, bool
        ):
            raise StoreError("answer trash filters must be booleans")
        if not isinstance(offset, int) or isinstance(offset, bool) or offset < 0:
            raise StoreError("answer offset must be a non-negative integer")
        if (
            not isinstance(limit, int)
            or isinstance(limit, bool)
            or not 1 <= limit <= 200
        ):
            raise StoreError("answer limit must be between 1 and 200")
        normalize = _runtime()["normalize_question"]
        needle = normalize(query) if query.strip() else ""
        if trashed_only and not include_trashed:
            raise StoreError("trashed-only query requires include trashed")
        document = self._load_answers_document()
        records = self._list_answer_records(
            state, include_trashed, review_status, document=document
        )
        if trashed_only:
            records = [
                item for item in records if item.get("deletedAt") is not None
            ]
        if needle:
            records = [
                item
                for item in records
                if any(
                    needle in candidate
                    for candidate in self._answer_candidates(item)
                )
            ]
        counts = self._answer_reference_counts(document=document)
        page = records[offset : offset + limit]
        return {
            "items": [self._answer_projection(item, counts) for item in page],
            "total": len(records),
            "offset": offset,
            "limit": limit,
            "hasMore": offset + len(page) < len(records),
        }

    def reveal_answer(self, key: str) -> dict[str, Any]:
        self.initialize()
        document = self._load_answers_document()
        resolved = self._resolve_answer_key_in_document(document, key)
        answer = self._get_answer_record(key, document=document)
        if answer is None:
            raise StoreError("answer does not exist")
        revealed = self.answer_detail_projection(
            answer, document=document, reveal_value=True
        )
        if resolved != key:
            revealed["redirectedFrom"] = key
        return revealed

    def find_answer(
        self, question: str, scope: dict[str, Any] | None = None
    ) -> dict[str, Any] | None:
        self.initialize()
        runtime = _runtime()
        normalized = runtime["normalize_question"](question)
        document = self._load_answers_document()
        for record in document["answers"].values():
            item = runtime["_require_object"](record, "answer record")
            if (
                item.get("deletedAt") is not None
                or item.get("reviewStatus", "accepted") != "accepted"
            ):
                continue
            candidates = self._answer_candidates(item)
            if normalized in candidates and runtime["_json_values_equal"](
                item.get("scope", {}), scope or {}
            ):
                return self.answer_detail_projection(item, document=document)
        computed_key = runtime["answer_key"](question, scope)
        resolved_key = self._resolve_answer_key_in_document(document, computed_key)
        direct = document["answers"].get(resolved_key)
        if (
            direct is None
            or not runtime["_json_values_equal"](
                direct.get("scope", {}), scope or {}
            )
            or direct.get("deletedAt") is not None
            or direct.get("reviewStatus", "accepted") != "accepted"
        ):
            return None
        projected = self.answer_detail_projection(direct, document=document)
        if resolved_key != computed_key:
            projected["redirectedFrom"] = computed_key
        return projected

    @staticmethod
    def _semantic_candidate(record: dict[str, Any]) -> dict[str, Any]:
        field_class = record.get("fieldClass", "general")
        return {
            "answerKey": record["key"],
            "question": record.get("question"),
            "aliases": [
                alias
                for alias in record.get("aliases", [])
                if isinstance(alias, str) and alias.strip()
            ],
            "scope": record.get("scope", {}),
            "fieldClass": field_class,
            "sensitivity": record.get("sensitivity", "none"),
            "recordStatus": (
                "deleted" if record.get("deletedAt") is not None else "active"
            ),
            "reviewStatus": record.get("reviewStatus", "accepted"),
            "state": record.get("state"),
            "valueState": "seen" if record.get("value") is not None else "missing",
        }

    def semantic_answer_lookup(self, incoming: dict[str, Any]) -> dict[str, Any]:
        """Recompute deterministic semantic reuse against current canonical answers."""

        self.initialize()
        runtime = _runtime()
        packet = runtime["_require_object"](incoming, "semantic lookup")
        allowed = {
            "question", "scope", "fieldClass", "sensitivity", "mode",
            "useAuthority", "allowedSensitiveFieldClasses", "limit",
        }
        if set(packet) - allowed or not {
            "question", "scope", "fieldClass", "sensitivity", "mode", "useAuthority"
        } <= set(packet):
            raise StoreError("semantic lookup contains unsupported fields")
        document = self._load_answers_document()
        field_class = packet["fieldClass"]
        candidates = [
            self._semantic_candidate(record)
            for record in document["answers"].values()
            if isinstance(record.get("key"), str)
            and bool(record["key"].strip())
            and isinstance(record.get("question"), str)
            and record["question"].strip()
        ]
        matcher = runtime["ANSWER_MATCH_MODULE"]
        try:
            matches = matcher.rank_candidates(
                question=packet["question"], scope=packet["scope"],
                field_class=field_class, sensitivity=packet["sensitivity"],
                candidates=candidates, limit=packet.get("limit", 5),
            )
            indexed = {item["answerKey"]: item for item in candidates}
            decisions = [
                matcher.evaluate_reuse(
                    match=match, candidate=indexed[match["answerKey"]],
                    scope=packet["scope"], field_class=field_class,
                    sensitivity=packet["sensitivity"], mode=packet["mode"],
                    use_authority=packet["useAuthority"],
                    allowed_sensitive_field_classes=packet.get(
                        "allowedSensitiveFieldClasses", []
                    ),
                )
                for match in matches
            ]
        except Exception:
            raise StoreError("semantic lookup is invalid") from None
        return {"candidates": decisions, "mutated": False}
