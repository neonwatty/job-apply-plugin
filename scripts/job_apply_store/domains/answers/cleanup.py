"""Value-free answer duplicate cleanup preview and approval behavior."""

from __future__ import annotations

import hashlib
from typing import Any

from ... import io, normalization
from ...errors import StoreError


ANSWER_MATCH_MODULE = None
_CANONICAL_RUNTIME = {
    "ANSWER_MATCH_MODULE": ANSWER_MATCH_MODULE,
    "_canonical_json": normalization._canonical_json,
    "_require_object": io.require_object,
    "exclusive_file_lock": io.exclusive_file_lock,
    "hashlib": hashlib,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class AnswerCleanupMixin:
    """Answer cleanup operations composed ahead of the compatibility Store."""

    def _preview_answer_cleanup_document(
        self, document: dict[str, Any]
    ) -> dict[str, Any]:
        candidates = []
        for record in document["answers"].values():
            if (
                not isinstance(record.get("key"), str)
                or not record["key"].strip()
                or not isinstance(record.get("question"), str)
                or not record["question"].strip()
            ):
                continue
            candidates.append(self._semantic_candidate(record))
        try:
            proposed = _late("ANSWER_MATCH_MODULE").propose_cleanup(
                candidates=candidates
            )
        except Exception:
            raise StoreError("answer cleanup preview is invalid") from None
        revisions = {
            key: record.get("revision", 1)
            for key, record in document["answers"].items()
        }
        questions = {
            key: record["question"]
            for key, record in document["answers"].items()
            if isinstance(record.get("question"), str) and record["question"].strip()
        }
        proposals = [
            proposal | {
                "winnerRevision": revisions[proposal["winnerKey"]],
                "duplicateRevision": revisions[proposal["duplicateKey"]],
                "winnerQuestion": questions[proposal["winnerKey"]],
                "duplicateQuestion": questions[proposal["duplicateKey"]],
            }
            for proposal in proposed
        ]
        token = "answer-cleanup-v1." + _late("hashlib").sha256(
            _late("_canonical_json")({
                "proposals": proposals, "revisions": revisions
            }).encode("utf-8")
        ).hexdigest()
        return {"proposals": proposals, "previewToken": token, "mutated": False}

    def preview_answer_cleanup(self) -> dict[str, Any]:
        """Return a revision-bound, value-free duplicate cleanup preview."""

        self.initialize()
        with _late("exclusive_file_lock")(self.store_lock_path):
            return self._preview_answer_cleanup_document(
                self._load_answers_document()
            )

    def approve_answer_cleanup(
        self, incoming: dict[str, Any], owner_confirmed: bool = False
    ) -> dict[str, Any]:
        packet = _late("_require_object")(incoming, "answer cleanup approval")
        required = {
            "previewToken", "winnerKey", "duplicateKey", "winnerRevision",
            "duplicateRevision",
        }
        if (
            set(packet) != required
            or owner_confirmed is not True
            or not isinstance(packet.get("previewToken"), str)
        ):
            raise StoreError("answer cleanup requires explicit owner approval")
        merged = self.merge_answers(
            packet["winnerKey"], packet["duplicateKey"],
            packet["winnerRevision"], packet["duplicateRevision"],
            cleanup_approval=packet,
        )
        return {"approved": True, "result": merged}
