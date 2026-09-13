"""Revision-bound grouped answer approval preview and commit behavior."""

from __future__ import annotations

import copy
import hashlib
import hmac
from typing import Any

from ... import io, normalization
from ...constants import PENDING_REFERENCE
from ...errors import StoreError
from ...validation.sessions import _validate_session_document


ANSWER_MATCH_MODULE = None
_CANONICAL_RUNTIME = {
    "ANSWER_MATCH_MODULE": ANSWER_MATCH_MODULE,
    "PENDING_REFERENCE": PENDING_REFERENCE,
    "_canonical_json": normalization._canonical_json,
    "_require_object": io.require_object,
    "_safe_session_id": normalization._safe_session_id,
    "_scope_fingerprint": normalization._scope_fingerprint,
    "_validate_session_document": _validate_session_document,
    "atomic_write_json": io.atomic_write_json,
    "copy": copy,
    "exclusive_file_lock": io.exclusive_file_lock,
    "hashlib": hashlib,
    "hmac": hmac,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class CoordinatorApprovalsMixin:
    """Grouped approvals operating on Store state supplied by composition."""

    def preview_grouped_approval(
        self,
        job_id: str,
        expected_job_revision: int,
        expected_session_revision: int,
        decisions: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Preview field-specific current-use, remember, and policy decisions."""

        self.initialize()
        job_id = _late("_safe_session_id")(job_id)
        if not isinstance(decisions, list) or not decisions:
            raise StoreError("grouped approval requires at least one field decision")
        with _late("exclusive_file_lock")(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("grouped approval job does not exist")
            if job["revision"] != expected_job_revision:
                raise StoreError("job revision conflict")
            path = self._session_path(job_id)
            if not path.exists():
                raise StoreError("grouped approval session does not exist")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            if self._session_revision(session) != expected_session_revision:
                raise StoreError("session revision conflict")
            pending = {
                field["reference"]: field
                for field in session.get("pendingFields", [])
            }
            answers = self._load_answers_document()
            projected: list[dict[str, Any]] = []
            seen_references: set[str] = set()
            for raw in decisions:
                decision = _late("_require_object")(
                    raw, "grouped approval decision"
                )
                required = {
                    "reference", "answerKey", "currentUse", "remember",
                    "policyMode", "useAuthority", "allowedSensitiveFieldClasses",
                }
                if set(decision) != required:
                    raise StoreError(
                        "grouped approval decision contains unsupported fields"
                    )
                if (
                    not isinstance(decision.get("answerKey"), str)
                    or not decision["answerKey"]
                ):
                    raise StoreError("grouped approval answer key is invalid")
                reference = decision.get("reference")
                if (
                    not isinstance(reference, str)
                    or _late("PENDING_REFERENCE").fullmatch(reference) is None
                    or reference in seen_references
                    or reference not in pending
                ):
                    raise StoreError("grouped approval reference is invalid")
                seen_references.add(reference)
                if (
                    not isinstance(decision["currentUse"], bool)
                    or not isinstance(decision["remember"], bool)
                ):
                    raise StoreError("grouped approval decisions must be booleans")
                if (
                    not decision["currentUse"]
                    and decision["useAuthority"] != "none"
                ):
                    raise StoreError("denied current use cannot carry reuse authority")
                answer = self._get_answer_record(
                    decision["answerKey"], document=answers
                )
                if answer is None:
                    raise StoreError("grouped approval answer is unavailable")
                field = pending[reference]
                bound_key = field.get("answerKey")
                if (
                    not isinstance(bound_key, str)
                    or self._resolve_answer_key_in_document(answers, bound_key)
                    != answer["key"]
                ):
                    raise StoreError(
                        "grouped approval answer does not match pending field"
                    )
                field_class = field.get("fieldClass", "general")
                answer_sensitivity = answer.get("sensitivity", "none")
                sensitivity = (
                    answer_sensitivity
                    if answer_sensitivity != "none"
                    else "high"
                    if field.get("sensitive") is True
                    or field.get("state") == "sensitive"
                    else "none"
                )
                if field.get("matchAnswerRevision") != answer.get("revision", 1):
                    raise StoreError("pending field semantic match is stale")
                candidate = self._semantic_candidate(answer)
                confidence = field.get("matchConfidence", "none")
                match_reasons = field.get("matchReasonCodes") or [
                    "no_semantic_match"
                ]
                match = {
                    "answerKey": answer["key"],
                    "confidenceBand": confidence,
                    "reasonCodes": match_reasons,
                }
                try:
                    policy = _late("ANSWER_MATCH_MODULE").evaluate_reuse(
                        match=match,
                        candidate=candidate,
                        scope=answer.get("scope", {}),
                        field_class=field_class,
                        sensitivity=sensitivity,
                        mode=decision["policyMode"],
                        use_authority=decision["useAuthority"],
                        allowed_sensitive_field_classes=decision[
                            "allowedSensitiveFieldClasses"
                        ],
                    )
                except Exception:
                    raise StoreError("grouped approval policy is invalid") from None
                candidate_scope_fingerprint = _late("_scope_fingerprint")(
                    answer.get("scope", {})
                )
                field_scope_fingerprint = field.get(
                    "scopeFingerprint", _late("_scope_fingerprint")({})
                )
                if not _late("hmac").compare_digest(
                    candidate_scope_fingerprint, field_scope_fingerprint
                ):
                    policy["reasonCodes"] = [
                        code
                        for code in policy["reasonCodes"]
                        if code not in {"reuse_eligible", "scope_match"}
                    ]
                    if "scope_mismatch" not in policy["reasonCodes"]:
                        policy["reasonCodes"].append("scope_mismatch")
                eligible = (
                    decision["currentUse"]
                    and "reuse_eligible" in policy["reasonCodes"]
                )
                projected.append({
                    "reference": reference,
                    "answerKey": answer["key"],
                    "currentUse": decision["currentUse"],
                    "remember": decision["remember"],
                    "policyMode": decision["policyMode"],
                    "useAuthority": decision["useAuthority"],
                    "eligible": eligible,
                    "confidenceBand": policy["confidenceBand"],
                    "reasonCodes": policy["reasonCodes"],
                    "answerRevision": answer.get("revision", 1),
                })
            projected.sort(key=lambda item: item["reference"])
            token_input = {
                "jobRevision": expected_job_revision,
                "sessionRevision": expected_session_revision,
                "approvals": projected,
            }
            token = "grouped-approval-v1." + _late("hashlib").sha256(
                _late("_canonical_json")(token_input).encode("utf-8")
            ).hexdigest()
            return {
                **token_input, "previewToken": token, "mutated": False,
            }

    def approve_grouped_approval(
        self,
        job_id: str,
        expected_job_revision: int,
        expected_session_revision: int,
        decisions: list[dict[str, Any]],
        preview_token: str,
        owner_confirmed: bool = False,
    ) -> dict[str, Any]:
        if owner_confirmed is not True:
            raise StoreError("grouped approval requires explicit owner confirmation")
        preview = self.preview_grouped_approval(
            job_id, expected_job_revision, expected_session_revision, decisions
        )
        if not isinstance(preview_token, str) or not _late("hmac").compare_digest(
            preview_token, preview["previewToken"]
        ):
            raise StoreError("grouped approval preview is stale")
        with _late("exclusive_file_lock")(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            path = self._session_path(job_id)
            if (
                job is None
                or job.get("revision") != expected_job_revision
                or not path.exists()
            ):
                raise StoreError("grouped approval state changed")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            if self._session_revision(session) != expected_session_revision:
                raise StoreError("session revision conflict")
            pending = {
                field["reference"]: field
                for field in session.get("pendingFields", [])
            }
            answers = self._load_answers_document()
            approvals_by_reference = {
                approval["reference"]: approval
                for approval in preview["approvals"]
            }
            for decision in decisions:
                reference = decision["reference"]
                field = pending.get(reference)
                answer = self._get_answer_record(
                    decision["answerKey"], document=answers
                )
                if field is None or answer is None:
                    raise StoreError("grouped approval state changed")
                bound_key = field.get("answerKey")
                if (
                    not isinstance(bound_key, str)
                    or self._resolve_answer_key_in_document(answers, bound_key)
                    != answer["key"]
                    or answer.get("revision", 1)
                    != approvals_by_reference[reference]["answerRevision"]
                ):
                    raise StoreError("grouped approval state changed")
            updated = _late("copy").deepcopy(session)
            approvals = {
                approval["reference"]: _late("copy").deepcopy(approval)
                for approval in self._current_session_approvals(session, answers)
            }
            approvals.update({
                approval["reference"]: _late("copy").deepcopy(approval)
                for approval in preview["approvals"]
            })
            updated["approvals"] = [
                approvals[reference] for reference in sorted(approvals)
            ]
            updated["updatedAt"] = self._now()
            _late("_validate_session_document")(updated)
            _late("atomic_write_json")(path, updated)
        return {
            "approved": True,
            "sessionRevision": self._session_revision(updated),
            "approvals": _late("copy").deepcopy(updated["approvals"]),
        }
