"""Answer query, review, merge, and lifecycle mutation routes."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from .. import runtime


class AnswerMutationMixin:
    def _mutate_answers(
        self, method: str, path: str, parts: list[str], payload: dict[str, Any]
    ) -> bool:
        store = self.server.store
        if method == "POST" and path == "/api/answers/query":
            allowed = {
                "query", "state", "reviewStatus", "includeTrashed",
                "trashedOnly", "offset", "limit",
            }
            if set(payload) - allowed:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "answer query contains unsupported fields",
                )
            else:
                self._store_call(lambda: store.query_answers(
                    query=payload.get("query", ""),
                    state=payload.get("state"),
                    review_status=payload.get("reviewStatus", "accepted"),
                    include_trashed=payload.get("includeTrashed", False),
                    trashed_only=payload.get("trashedOnly", False),
                    offset=payload.get("offset", 0),
                    limit=payload.get("limit", 50),
                ))
            return True
        if method == "POST" and path == "/api/answers/semantic":
            self._store_call(lambda: store.semantic_answer_lookup(payload))
            return True
        if method == "POST" and path == "/api/answers/cleanup-approve":
            if (
                set(payload) != {"approval", "ownerConfirmed"}
                or payload.get("ownerConfirmed") is not True
                or not isinstance(payload.get("approval"), dict)
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "cleanup requires an explicit owner-approved preview",
                )
            else:
                self._store_call(lambda: store.approve_answer_cleanup(
                    payload["approval"], owner_confirmed=True
                ))
            return True
        if method == "POST" and path == "/api/answers":
            if set(payload) - {
                "answer", "expectedRevision", "rememberSensitive"
            } or not isinstance(payload.get("answer"), dict):
                self._error(
                    HTTPStatus.BAD_REQUEST, "body requires an answer object"
                )
                return True
            if "rememberSensitive" in payload and not isinstance(
                payload["rememberSensitive"], bool
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST, "rememberSensitive must be a boolean"
                )
            else:
                self._store_call(lambda: store.put_answer(
                    payload["answer"],
                    payload.get("rememberSensitive", False),
                    payload.get("expectedRevision"),
                ))
            return True
        if method == "POST" and path == "/api/answers/observe":
            if set(payload) != {"answer"} or not isinstance(
                payload.get("answer"), dict
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain only an answer object",
                )
            else:
                self._store_call(lambda: store.observe_answer(payload["answer"]))
            return True
        encoded = len(parts) in {5, 6} and parts[1:4] == [
            "api", "answers", "by-key"
        ]
        legacy = len(parts) in {4, 5} and parts[1:3] == ["api", "answers"]
        if method == "PATCH" and (
            (encoded and len(parts) == 5) or (legacy and len(parts) == 4)
        ):
            return self._patch_answer(parts, payload, encoded)
        if method == "POST" and (
            (encoded and len(parts) == 6) or (legacy and len(parts) == 5)
        ):
            return self._act_on_answer(parts, payload, encoded)
        return False

    def _patch_answer(
        self, parts: list[str], payload: dict[str, Any], encoded: bool
    ) -> bool:
        if set(payload) - {
            "patch", "expectedRevision", "rememberSensitive"
        } or not isinstance(payload.get("patch"), dict):
            self._error(
                HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision"
            )
            return True
        revision = self._expected_revision(payload)
        if revision is None:
            return True
        if "rememberSensitive" in payload and not isinstance(
            payload["rememberSensitive"], bool
        ):
            self._error(
                HTTPStatus.BAD_REQUEST, "rememberSensitive must be a boolean"
            )
            return True
        key = (
            self._encoded_answer_key(parts[4])
            if encoded
            else self._answer_key(parts[3])
        )
        self._store_call(lambda: self.server.store.update_answer(
            key,
            payload["patch"],
            revision,
            payload.get("rememberSensitive", False),
        ))
        return True

    def _act_on_answer(
        self, parts: list[str], payload: dict[str, Any], encoded: bool
    ) -> bool:
        store_module = runtime()["STORE_MODULE"]
        try:
            answer_id, action = (
                (self._encoded_answer_key(parts[4]), parts[5])
                if encoded
                else (self._answer_key(parts[3]), parts[4])
            )
        except store_module.StoreError as error:
            self._error(HTTPStatus.BAD_REQUEST, str(error))
            return True
        if action == "reveal":
            if payload:
                self._error(HTTPStatus.BAD_REQUEST, "reveal body must be empty")
            else:
                self._store_call(
                    lambda: self.server.store.reveal_answer(answer_id)
                )
            return True
        if action == "merge":
            return self._merge_answer(answer_id, payload)
        revision = self._expected_revision(payload)
        if revision is None:
            return True
        if action in {"accept", "decline"}:
            allowed = {"expectedRevision", "patch", "rememberSensitive"}
            if set(payload) - allowed or not isinstance(payload.get("patch", {}), dict):
                self._error(
                    HTTPStatus.BAD_REQUEST, "answer review body is invalid"
                )
                return True
            if "rememberSensitive" in payload and not isinstance(
                payload["rememberSensitive"], bool
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "rememberSensitive must be a boolean",
                )
                return True
            self._store_call(lambda: self.server.store.review_answer(
                answer_id,
                "accepted" if action == "accept" else "declined",
                revision,
                payload.get("patch"),
                payload.get("rememberSensitive", False),
            ))
            return True
        if set(payload) != {"expectedRevision"}:
            self._error(
                HTTPStatus.BAD_REQUEST,
                f"{action} body requires expectedRevision",
            )
            return True
        operations = {
            "trash": self.server.store.trash_answer,
            "restore": self.server.store.restore_answer,
            "delete": self.server.store.delete_answer,
        }
        if action not in operations:
            return False
        operation = operations[action]
        self._lifecycle_call(
            "answer",
            action,
            answer_id,
            lambda: operation(answer_id, revision),
        )
        return True

    def _merge_answer(self, answer_id: str, payload: dict[str, Any]) -> bool:
        allowed = {
            "winnerKey", "expectedWinnerRevision", "expectedSourceRevision"
        }
        if set(payload) != allowed:
            self._error(HTTPStatus.BAD_REQUEST, "answer merge body is invalid")
            return True
        winner = payload.get("winnerKey")
        winner_revision = payload.get("expectedWinnerRevision")
        source_revision = payload.get("expectedSourceRevision")
        if (
            not isinstance(winner, str)
            or not winner
            or not isinstance(winner_revision, int)
            or isinstance(winner_revision, bool)
            or winner_revision < 1
            or not isinstance(source_revision, int)
            or isinstance(source_revision, bool)
            or source_revision < 1
        ):
            self._error(HTTPStatus.BAD_REQUEST, "answer merge body is invalid")
        else:
            self._store_call(lambda: self.server.store.merge_answers(
                winner, answer_id, winner_revision, source_revision
            ))
        return True
