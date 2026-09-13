"""Answer creation, revision, observation, review, and deletion behavior."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from ... import io, normalization
from ...constants import ANSWER_REVIEW_STATUSES, ANSWER_STATES, SENSITIVITY_LEVELS
from ...errors import StoreError
from ...validation import profile_answers


def _canonical_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


_CANONICAL_RUNTIME = {
    "_json_values_equal": normalization._json_values_equal,
    "_require_object": io.require_object,
    "_validate_answer_record": profile_answers._validate_answer_record,
    "answer_key": normalization.answer_key,
    "atomic_write_json": io.atomic_write_json,
    "exclusive_file_lock": io.exclusive_file_lock,
    "normalize_question": normalization.normalize_question,
    "utc_now": _canonical_utc_now,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class AnswerMutationMixin:
    """Answer writes operating on Store state supplied by composition."""

    def _reject_answer_collisions(
        self,
        answers: dict[str, Any],
        candidate: dict[str, Any],
        key: str,
        redirects: dict[str, Any] | None = None,
        redirect_targets: set[str] | None = None,
    ) -> None:
        candidate_names = self._answer_candidates(candidate)
        permitted_redirect_targets = redirect_targets or {key}
        for other_key, raw in answers.items():
            if other_key == key:
                continue
            other = _late("_require_object")(raw, "answer record")
            if _late("_json_values_equal")(other.get("scope", {}), candidate.get("scope", {})) and candidate_names & self._answer_candidates(other):
                raise StoreError("answer question or alias collides within scope")
        for normalized in candidate_names:
            retired_key = _late("answer_key")(normalized, candidate.get("scope", {}))
            redirect = (redirects or {}).get(retired_key)
            if redirect is not None and redirect.get("targetKey") not in permitted_redirect_targets:
                raise StoreError("answer question or alias is a retired redirect identity")

    def put_answer(
        self,
        incoming: dict[str, Any],
        remember_sensitive: bool = False,
        expected_revision: int | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        question = incoming.get("question")
        scope = incoming.get("scope", {})
        if not isinstance(scope, dict):
            raise StoreError("answer scope must be a JSON object")
        key = incoming.get("key")
        if key is None:
            if not isinstance(question, str):
                raise StoreError("answer requires a question or explicit key")
            key = _late("answer_key")(question, scope)
        if not isinstance(key, str) or not key.strip():
            raise StoreError("answer key must be a non-empty string")
        current_review_status = incoming.get("reviewStatus", "accepted")
        if (
            not isinstance(current_review_status, str)
            or current_review_status not in ANSWER_REVIEW_STATUSES
        ):
            raise StoreError("answer review status is unsupported")

        state = incoming.get("state")
        if state not in ANSWER_STATES:
            raise StoreError("answer state is unsupported")
        sensitivity = incoming.get(
            "sensitivity", "high" if state == "sensitive" else "none"
        )
        if sensitivity not in SENSITIVITY_LEVELS:
            raise StoreError("answer sensitivity is unsupported")
        value = incoming.get("value")
        if state == "confirmed" and value is None:
            raise StoreError("confirmed answers require a value")
        if state == "missing" and value is not None:
            raise StoreError("missing answers cannot contain a value")
        requires_consent = value is not None and (
            state == "sensitive" or sensitivity != "none"
        )
        if requires_consent and not remember_sensitive:
            raise StoreError(
                "sensitive answer value requires explicit remember consent"
            )

        aliases = incoming.get("aliases", [])
        if not isinstance(aliases, list) or not all(
            isinstance(alias, str) for alias in aliases
        ):
            raise StoreError("answer aliases must be strings")
        normalized_aliases: list[str] = []
        for alias in aliases:
            normalized = _late("normalize_question")(alias)
            if normalized and normalized not in normalized_aliases:
                normalized_aliases.append(normalized)

        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_answers_document()
            if key in self._answer_redirects(document):
                raise StoreError("answer key was merged and cannot be resurrected")
            current = document["answers"].get(key)
            if current is not None and current.get("deletedAt") is not None:
                raise StoreError("answer is trashed")
            if current is not None:
                if (
                    not isinstance(expected_revision, int)
                    or isinstance(expected_revision, bool)
                    or expected_revision < 1
                ):
                    raise StoreError("existing answer put requires expected revision")
                if current.get("revision", 1) != expected_revision:
                    raise StoreError("answer revision conflict")
            elif current_review_status != "accepted":
                raise StoreError(
                    "new answers created through put must have accepted review status"
                )
            now = _late("utc_now")()
            record = dict(_late("_require_object")(current or {}, "answer record"))
            record.update(
                {
                    "key": key,
                    "question": question,
                    "aliases": normalized_aliases,
                    "value": value,
                    "state": state,
                    "source": incoming.get("source", "user"),
                    "scope": scope,
                    "fieldClass": incoming.get(
                        "fieldClass", record.get("fieldClass", "general")
                    ),
                    "sensitivity": sensitivity,
                    "reviewStatus": (
                        record.get("reviewStatus", "accepted")
                        if current is not None
                        else incoming.get("reviewStatus", "accepted")
                    ),
                    "createdAt": record.get("createdAt") or now,
                    "updatedAt": now,
                    "deletedAt": None,
                    "revision": (
                        record.get("revision", 1) + 1 if current is not None else 1
                    ),
                }
            )
            if current is None:
                record["observationCount"] = incoming.get("observationCount", 0)
                for field in ("observedAt", "lastObservedAt", "reviewedAt"):
                    if field in incoming:
                        record[field] = incoming[field]
            else:
                record["observationCount"] = current.get("observationCount", 0)
                for field in ("observedAt", "lastObservedAt", "reviewedAt"):
                    if field in current:
                        record[field] = current[field]
                    else:
                        record.pop(field, None)
            if state == "confirmed":
                record["confirmedAt"] = incoming.get("confirmedAt") or now
            else:
                record["confirmedAt"] = incoming.get("confirmedAt")
            if requires_consent:
                record["rememberedWithConsentAt"] = now
            else:
                record.pop("rememberedWithConsentAt", None)

            _late("_validate_answer_record")(key, record)
            self._reject_answer_collisions(
                document["answers"], record, key, self._answer_redirects(document)
            )
            counts = self._answer_reference_counts(document=document)
            document["answers"][key] = record
            document["metadata"]["updatedAt"] = now
            _late("atomic_write_json")(self.answers_path, document)
        return self._answer_mutation_projection(record, counts)

    def update_answer(
        self,
        key: str,
        patch: dict[str, Any],
        expected_revision: int,
        remember_sensitive: bool = False,
        _review_status_transition: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        allowed = {
            "question",
            "aliases",
            "value",
            "state",
            "source",
            "scope",
            "fieldClass",
            "sensitivity",
        }
        if (
            (not patch and _review_status_transition is None)
            or set(patch) - allowed
            or _review_status_transition not in {None, "accepted", "declined"}
        ):
            raise StoreError("answer patch contains unsupported fields")
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_answers_document()
            current = document["answers"].get(key)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("answer does not exist")
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            if (
                _review_status_transition is not None
                and current.get("reviewStatus", "accepted") != "pending"
            ):
                raise StoreError("only pending answers can be reviewed")
            updated = {**current, **patch}
            aliases = updated.get("aliases", [])
            if not isinstance(aliases, list) or not all(
                isinstance(alias, str) for alias in aliases
            ):
                raise StoreError("answer aliases must be strings")
            normalized_aliases: list[str] = []
            for alias in aliases:
                normalized = _late("normalize_question")(alias)
                if normalized and normalized not in normalized_aliases:
                    normalized_aliases.append(normalized)
            updated["aliases"] = normalized_aliases
            scope = updated.get("scope", {})
            if not isinstance(scope, dict):
                raise StoreError("answer scope must be a JSON object")
            state = updated.get("state")
            if state not in ANSWER_STATES:
                raise StoreError("answer state is unsupported")
            sensitivity = updated.get(
                "sensitivity", "high" if state == "sensitive" else "none"
            )
            if sensitivity not in SENSITIVITY_LEVELS:
                raise StoreError("answer sensitivity is unsupported")
            value = updated.get("value")
            if state == "confirmed" and value is None:
                raise StoreError("confirmed answers require a value")
            if state == "missing" and value is not None:
                raise StoreError("missing answers cannot contain a value")
            requires_consent = value is not None and (
                state == "sensitive" or sensitivity != "none"
            )
            changed_sensitive_value = (
                value != current.get("value")
                or not current.get("rememberedWithConsentAt")
            )
            if requires_consent and changed_sensitive_value and not remember_sensitive:
                raise StoreError(
                    "sensitive answer value requires explicit remember consent"
                )
            now = _late("utc_now")()
            updated["sensitivity"] = sensitivity
            updated["revision"] = revision + 1
            updated["createdAt"] = current.get("createdAt") or current.get("updatedAt") or now
            updated["updatedAt"] = now
            updated["deletedAt"] = None
            if _review_status_transition is not None:
                updated["reviewStatus"] = _review_status_transition
                updated["reviewedAt"] = now
            if state == "confirmed":
                if state != current.get("state") or value != current.get("value"):
                    updated["confirmedAt"] = now
                else:
                    updated["confirmedAt"] = current.get("confirmedAt") or now
            else:
                updated["confirmedAt"] = None
            if requires_consent:
                if changed_sensitive_value:
                    updated["rememberedWithConsentAt"] = now
            else:
                updated.pop("rememberedWithConsentAt", None)
            _late("_validate_answer_record")(key, updated)
            self._reject_answer_collisions(
                document["answers"], updated, key, self._answer_redirects(document)
            )
            counts = self._answer_reference_counts(document=document)
            document["answers"][key] = updated
            document["metadata"]["updatedAt"] = now
            _late("atomic_write_json")(self.answers_path, document)
        return self._answer_mutation_projection(updated, counts)

    def observe_answer(self, incoming: dict[str, Any]) -> dict[str, Any]:
        question = incoming.get("question")
        scope = incoming.get("scope", {})
        state = incoming.get("state", "inferred" if incoming.get("value") is not None else "missing")
        if not isinstance(question, str) or not isinstance(scope, dict):
            raise StoreError("observed answer requires question and object scope")
        if state not in {"missing", "inferred"}:
            raise StoreError("observed answer state must be missing or inferred")
        if incoming.get("value") is not None and incoming.get("sensitivity", "none") != "none":
            raise StoreError("sensitive observed values require review and fresh remember consent")
        self.initialize()
        now = _late("utc_now")()
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_answers_document()
            normalized = _late("normalize_question")(question)
            current = next(
                (
                    record for record in document["answers"].values()
                    if _late("_json_values_equal")(record.get("scope", {}), scope)
                    and normalized in self._answer_candidates(record)
                ),
                None,
            )
            if current is not None:
                key = current["key"]
            else:
                computed_key = _late("answer_key")(question, scope)
                key = self._resolve_answer_key_in_document(document, computed_key)
                current = document["answers"].get(key)
                if current is not None and not _late("_json_values_equal")(current.get("scope", {}), scope):
                    raise StoreError(
                        "observed answer derived key is occupied by a different scope"
                    )
            if current is not None:
                if current.get("deletedAt") is not None:
                    raise StoreError("observed answer is trashed")
                updated = dict(current)
                updated["reviewStatus"] = current.get("reviewStatus", "accepted")
                updated["lastObservedAt"] = now
                updated["observedAt"] = updated.get("observedAt") or now
                updated["observationCount"] = updated.get("observationCount", 0) + 1
                updated["updatedAt"] = now
                updated["revision"] = updated.get("revision", 1) + 1
                _late("_validate_answer_record")(key, updated)
                document["answers"][key] = updated
            else:
                payload = {
                    **incoming,
                    "key": key,
                    "state": state,
                    "reviewStatus": "pending",
                    "observedAt": now,
                    "lastObservedAt": now,
                    "observationCount": 1,
                    "source": incoming.get("source", "agent"),
                }
                value = payload.get("value")
                if state == "missing" and value is not None:
                    raise StoreError("missing answers cannot contain a value")
                updated = {
                    "key": key,
                    "question": question,
                    "aliases": [],
                    "value": value,
                    "state": state,
                    "source": payload["source"],
                    "scope": scope,
                    "fieldClass": payload.get("fieldClass", "general"),
                    "sensitivity": payload.get("sensitivity", "none"),
                    "reviewStatus": "pending",
                    "observedAt": now,
                    "lastObservedAt": now,
                    "observationCount": 1,
                    "confirmedAt": None,
                    "createdAt": now,
                    "updatedAt": now,
                    "deletedAt": None,
                    "revision": 1,
                }
                _late("_validate_answer_record")(key, updated)
                self._reject_answer_collisions(
                    document["answers"], updated, key, self._answer_redirects(document)
                )
                document["answers"][key] = updated
            counts = self._answer_reference_counts(document=document)
            document["metadata"]["updatedAt"] = now
            _late("atomic_write_json")(self.answers_path, document)
        return self._answer_mutation_projection(updated, counts)

    def review_answer(
        self,
        key: str,
        review_status: str,
        expected_revision: int,
        patch: dict[str, Any] | None = None,
        remember_sensitive: bool = False,
    ) -> dict[str, Any]:
        if not isinstance(review_status, str) or review_status not in {
            "accepted",
            "declined",
        }:
            raise StoreError("answer review decision must be accepted or declined")
        if patch is not None and "reviewStatus" in patch:
            raise StoreError("answer review patch cannot set review status")
        return self.update_answer(
            key,
            patch or {},
            expected_revision,
            remember_sensitive=remember_sensitive,
            _review_status_transition=review_status,
        )

    def trash_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        return self._set_answer_deleted(key, expected_revision, restore=False)

    def restore_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        return self._set_answer_deleted(key, expected_revision, restore=True)

    def _set_answer_deleted(
        self, key: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_answers_document()
            redirects = self._answer_redirects(document)
            current = document["answers"].get(key)
            if current is None:
                raise StoreError("answer does not exist")
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                updated = dict(current)
            else:
                if not restore and any(
                    redirect["targetKey"] == key for redirect in redirects.values()
                ):
                    raise StoreError("answer is the target of an immutable redirect")
                updated = dict(current)
                updated["deletedAt"] = None if restore else _late("utc_now")()
                updated["revision"] = revision + 1
                updated["updatedAt"] = _late("utc_now")()
                _late("_validate_answer_record")(key, updated)
                counts = self._answer_reference_counts(document=document)
                document["answers"][key] = updated
                document["metadata"]["updatedAt"] = updated["updatedAt"]
                _late("atomic_write_json")(self.answers_path, document)
            if restore == (not is_trashed):
                counts = self._answer_reference_counts(document=document)
        return self._answer_mutation_projection(updated, counts)

    def delete_answer(self, key: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        if not isinstance(key, str) or not key:
            raise StoreError("answer key must be a non-empty string")
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_answers_document()
            redirects = self._answer_redirects(document)
            if key in redirects:
                raise StoreError("merged answer redirects are immutable")
            current = document["answers"].get(key)
            if current is None:
                return {"deleted": False, "key": key}
            revision = current.get("revision", 1)
            if revision != expected_revision:
                raise StoreError("answer revision conflict")
            if current.get("deletedAt") is None:
                raise StoreError("answer must be trashed before permanent deletion")
            if any(
                redirect["targetKey"] == key for redirect in redirects.values()
            ):
                raise StoreError("answer is the target of an immutable redirect")
            for session in self._list_sessions_uninitialized():
                if key in session.get("answerKeys", []) or any(
                    field.get("answerKey") == key
                    for field in session.get("pendingFields", [])
                ):
                    raise StoreError("answer is referenced by an active session")
            if any(key in event.get("answerKeys", []) for event in self.read_history()):
                raise StoreError("answer is referenced by application history")
            del document["answers"][key]
            document["metadata"]["updatedAt"] = _late("utc_now")()
            _late("atomic_write_json")(self.answers_path, document)
        return {"deleted": True, "key": key}
