"""Session document operations composed ahead of the Store facade."""

from __future__ import annotations

import copy
import hmac
import json
import re
import uuid
from pathlib import Path
from typing import Any

from ... import constants, io, normalization, sessions_runtime
from ...constants import _ATS_UNSET
from ...errors import StoreError
from ...validation import sessions


_RUNTIME_PROVIDER = lambda: {}


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its facade's late-bound collaborators."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    if name in runtime:
        return runtime[name]
    if name in {"ANSWER_MATCH_MODULE", "FORM_READINESS_MODULE"}:
        return sessions_runtime.companion({
            "ANSWER_MATCH_MODULE": "job_apply_answer_match",
            "FORM_READINESS_MODULE": "job_apply_form_readiness",
        }[name])
    return _CANONICAL[name]


_CANONICAL = {
    'AGENT_BLOCKER_TYPE_BY_CODE': constants.AGENT_BLOCKER_TYPE_BY_CODE,
    'BROWSER_HANDOFF_REASON_CODES': constants.BROWSER_HANDOFF_REASON_CODES,
    'SCHEMA_VERSION': constants.SCHEMA_VERSION,
    'SESSION_STATUSES': constants.SESSION_STATUSES,
    '_canonical_json': normalization._canonical_json,
    '_pending_reference_identity': sessions_runtime._pending_reference_identity,
    '_project_legacy_session': sessions_runtime._project_legacy_session,
    '_question_fingerprint': normalization._question_fingerprint,
    '_require_object': io.require_object,
    '_safe_session_id': normalization._safe_session_id,
    '_scope_fingerprint': normalization._scope_fingerprint,
    '_validate_session_document': sessions_runtime._validate_session_document,
    'copy': copy,
    'read_json_object': io.read_json_object,
    'utc_now': sessions_runtime.utc_now,
    'uuid': uuid,
    'validate_version': io.validate_version,
}


class SessionDocumentMixin:
    """Plain document mixin with no independent Store state."""

    def _session_path(self, application_id: str) -> Path:
        return self.sessions_path / f"{_late('_safe_session_id')(application_id)}.json"


    def _read_session_projection(
        self,
        path: Path,
        application_id: str | None = None,
        expected_ats: Any = _ATS_UNSET,
    ) -> dict[str, Any]:
        session = _late('read_json_object')(path, "session")
        _late('validate_version')(session, "session")
        pending_fields = session.get("pendingFields", [])
        if not isinstance(pending_fields, list):
            _late('_validate_session_document')(session)
        legacy_pending = any(
            isinstance(value, dict) and "reference" not in value
            for value in pending_fields
        )
        projected = _late('_project_legacy_session')(session, expected_ats)
        if legacy_pending and self.answers_path.exists():
            answers = self._load_answers_document()
            ats = (
                expected_ats
                if expected_ats is not _ATS_UNSET
                else session.get("ats")
            )
            scope = {"ats": ats} if isinstance(ats, str) and ats else {}
            for raw, field in zip(
                session.get("pendingFields", []), projected["pendingFields"]
            ):
                question = raw.get("question")
                bound_key = raw.get("answerKey")
                answer = (
                    self._get_answer_record(bound_key, document=answers)
                    if isinstance(bound_key, str) and bound_key
                    else None
                )
                if answer is None:
                    continue
                if (
                    isinstance(question, str)
                    and question.strip()
                    and isinstance(answer.get("question"), str)
                    and answer["question"].strip()
                ):
                    try:
                        match = _late('ANSWER_MATCH_MODULE').rank_candidates(
                            question=question,
                            scope=scope,
                            field_class="general",
                            sensitivity=(
                                answer.get("sensitivity", "none")
                                if answer.get("sensitivity", "none") != "none"
                                else "high"
                                if raw.get("sensitive") is True
                                or raw.get("state") == "sensitive"
                                else "none"
                            ),
                            candidates=[self._semantic_candidate(answer)],
                            limit=1,
                        )[0]
                    except Exception:
                        raise StoreError(
                            "pending field semantic match is invalid"
                        ) from None
                    field["matchConfidence"] = match["confidenceBand"]
                    field["matchReasonCodes"] = match["reasonCodes"]
                else:
                    field["matchConfidence"] = "none"
                    field["matchReasonCodes"] = ["no_semantic_match"]
                field["matchAnswerRevision"] = answer.get("revision", 1)
            _late('_validate_session_document')(projected)
        expected_id = application_id if application_id is not None else path.stem
        if projected["applicationId"] != expected_id:
            raise StoreError("session application id does not match path")
        return projected


    def _build_session(
        self,
        application_id: str,
        incoming: dict[str, Any],
        now: str | None = None,
        *,
        expected_attempt_revision: int | None = None,
        expected_ats: Any = _ATS_UNSET,
        internal_approvals: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        allowed = {
            "applicationId", "status", "ats", "company", "role", "url", "step",
            "answerKeys", "pendingFields", "createdAt", "updatedAt",
            "attemptRevision", "readinessInput", "blockers", "browserHandoff",
        }
        if set(incoming) - allowed:
            raise StoreError("session contains unsupported fields")
        application_id = _late('_safe_session_id')(application_id)
        if incoming.get("applicationId", application_id) != application_id:
            raise StoreError("session application id does not match path")
        attempt_revision = incoming.get("attemptRevision", expected_attempt_revision)
        if expected_attempt_revision is not None and attempt_revision != expected_attempt_revision:
            raise StoreError("session is not bound to the current attempt")
        status = incoming.get("status", "active")
        if status not in _late('SESSION_STATUSES'):
            raise StoreError("session status is unsupported")
        answer_keys = incoming.get("answerKeys", [])
        if not isinstance(answer_keys, list) or not all(isinstance(item, str) for item in answer_keys):
            raise StoreError("session answerKeys must be strings")
        path = self._session_path(application_id)
        created_at = incoming.get("createdAt")
        existing = None
        if path.exists():
            existing = self._read_session_projection(
                path, application_id, expected_ats
            )
            created_at = created_at or existing.get("createdAt")
        pending_input = incoming.get("pendingFields", [])
        if not isinstance(pending_input, list):
            raise StoreError("session pendingFields must be a list")
        answers_document = self._load_answers_document()
        reusable: dict[str, list[str]] = {}
        if existing is not None:
            for field in existing.get("pendingFields", []):
                reusable.setdefault(_late('_pending_reference_identity')(field), []).append(
                    field["reference"]
                )
        pending_fields = []
        for value in pending_input:
            field = _late('_require_object')(value, "pending field")
            if set(field) - {
                "question", "state", "answerKey", "sensitive", "fieldClass",
                "scope", "matchConfidence", "matchReasonCodes",
            }:
                raise StoreError("pending field contains unsupported fields")
            copied = _late('copy').deepcopy(field)
            # Question text is ephemeral adapter input. Durable sessions use
            # only the opaque reference and closed metadata needed for review.
            question = copied.pop("question", None)
            if isinstance(question, str) and question.strip():
                copied["questionFingerprint"] = _late('_question_fingerprint')(question)
            raw_scope = copied.pop("scope", None)
            if raw_scope is None:
                ats = (
                    expected_ats
                    if expected_ats is not _ATS_UNSET
                    else incoming.get("ats")
                    if "ats" in incoming
                    else (existing or {}).get("ats")
                )
                raw_scope = {"ats": ats} if isinstance(ats, str) and ats else {}
            try:
                scope_object = _late('_require_object')(raw_scope, "pending field scope")
                if scope_object:
                    copied["scopeFingerprint"] = _late('_scope_fingerprint')(scope_object)
            except (TypeError, ValueError, OverflowError):
                raise StoreError("pending field scope is invalid") from None
            copied.pop("matchConfidence", None)
            copied.pop("matchReasonCodes", None)
            bound_key = copied.get("answerKey")
            answer = (
                self._get_answer_record(bound_key, document=answers_document)
                if isinstance(bound_key, str) and bound_key
                else None
            )
            if (
                answer is not None
                and isinstance(answer.get("question"), str)
                and answer["question"].strip()
                and isinstance(question, str)
                and question.strip()
            ):
                try:
                    match = _late('ANSWER_MATCH_MODULE').rank_candidates(
                        question=question, scope=scope_object,
                        field_class=copied.get("fieldClass", "general"),
                        sensitivity=(
                            answer.get("sensitivity", "none")
                            if answer.get("sensitivity", "none") != "none"
                            else "high"
                            if copied.get("sensitive") is True
                            or copied.get("state") == "sensitive"
                            else "none"
                        ),
                        candidates=[self._semantic_candidate(answer)], limit=1,
                    )[0]
                except Exception:
                    raise StoreError("pending field semantic match is invalid") from None
                copied["matchConfidence"] = match["confidenceBand"]
                copied["matchReasonCodes"] = match["reasonCodes"]
                copied["matchAnswerRevision"] = answer.get("revision", 1)
            elif answer is not None:
                copied["matchConfidence"] = "none"
                copied["matchReasonCodes"] = ["no_semantic_match"]
                copied["matchAnswerRevision"] = answer.get("revision", 1)
            references = reusable.get(_late('_pending_reference_identity')(copied), [])
            copied["reference"] = references.pop(0) if references else f"pending_{_late('uuid').uuid4().hex}"
            pending_fields.append(copied)
        timestamp = now or _late('utc_now')()
        readiness = None
        if "readinessInput" in incoming:
            if attempt_revision is None:
                raise StoreError("readiness requires a current attempt revision")
            readiness = self._recompute_readiness(
                incoming["readinessInput"], attempt_revision, expected_ats
            )
        elif existing is not None and existing.get("attemptRevision") == attempt_revision:
            readiness = _late('copy').deepcopy(existing.get("readiness"))

        blockers: list[dict[str, Any]] = []
        for field in pending_fields:
            blocker = {
                "type": "information",
                "code": "sensitive-answer-required"
                if field.get("sensitive") is True or field.get("state") == "sensitive"
                else "answer-required",
                "reference": field["reference"],
                "sensitivity": "high"
                if field.get("sensitive") is True or field.get("state") == "sensitive"
                else "none",
            }
            if "fieldClass" in field:
                blocker["fieldClass"] = field["fieldClass"]
            blockers.append(blocker)
        if readiness is not None:
            for code in readiness["blockerCodes"]:
                blockers.append({"type": self._readiness_blocker_type(code), "code": code})
            if readiness["fallbackCode"] is not None:
                blockers.append({
                    "type": "browser_handoff",
                    "code": readiness["fallbackCode"],
                })
        supplied_blockers = incoming.get("blockers", [])
        if not isinstance(supplied_blockers, list):
            raise StoreError("session blockers must be a list")
        for raw_blocker in supplied_blockers:
            blocker = _late('_require_object')(raw_blocker, "session blocker")
            if set(blocker) != {"type", "code"}:
                raise StoreError("agent blockers must contain only closed type and code")
            expected_type = _late('AGENT_BLOCKER_TYPE_BY_CODE').get(blocker.get("code"))
            if expected_type is None or blocker.get("type") != expected_type:
                raise StoreError("session blocker is invalid")
            blockers.append(_late('copy').deepcopy(blocker))
        blockers = list({
            _late('_canonical_json')(item): item for item in blockers
        }.values())
        browser_blockers = [
            blocker
            for blocker in blockers
            if blocker.get("type") == "browser_handoff"
            and blocker.get("code") in _late('BROWSER_HANDOFF_REASON_CODES')
        ]

        browser_handoff = incoming.get("browserHandoff")
        if browser_handoff is None:
            if readiness is not None and readiness["fallbackCode"] is not None:
                browser_handoff = {
                    "state": "required", "reasonCode": readiness["fallbackCode"],
                    "revision": 1,
                }
            elif browser_blockers:
                browser_handoff = {
                    "state": "required", "reasonCode": browser_blockers[0]["code"],
                    "revision": 1,
                }
            elif status == "review":
                browser_handoff = {
                    "state": "ready_for_owner", "reasonCode": "final-review-required",
                    "revision": 1,
                }
            else:
                browser_handoff = {
                    "state": "not_required", "reasonCode": "none", "revision": 1,
                }
        else:
            browser_handoff = _late('copy').deepcopy(
                _late('_require_object')(browser_handoff, "browser handoff")
            )
            if set(browser_handoff) != {"state", "reasonCode", "revision"}:
                raise StoreError("browser handoff contains unsupported fields")
        if browser_blockers and browser_handoff.get("state") != "required":
            raise StoreError("browser handoff contradicts browser blockers")

        durable_input = {
            key: _late('copy').deepcopy(value)
            for key, value in incoming.items()
            if key not in {
                "readinessInput", "blockers", "browserHandoff", "company", "role",
                "url", "answerKeys", "pendingFields", "applicationId", "createdAt",
                "updatedAt", "attemptRevision",
            }
        }
        if expected_ats is not _ATS_UNSET:
            durable_input["ats"] = _late('copy').deepcopy(expected_ats)
        elif "ats" not in incoming and "ats" in (existing or {}):
            durable_input["ats"] = _late('copy').deepcopy(existing["ats"])
        current_references = {field["reference"] for field in pending_fields}
        carried_approvals = (
            existing.get("approvals", [])
            if existing is not None
            and existing.get("attemptRevision") == attempt_revision
            else []
        )
        carried_approvals = self._current_session_approvals(
            {
                "pendingFields": pending_fields,
                "approvals": [
                    approval for approval in carried_approvals
                    if approval.get("reference") in current_references
                ],
            },
            answers_document,
        )
        session = {
            "schemaVersion": _late('SCHEMA_VERSION'), **durable_input,
            "applicationId": application_id, "status": status,
            "answerKeys": answer_keys,
            "pendingFields": pending_fields,
            "attemptRevision": attempt_revision,
            "readiness": readiness,
            "blockers": blockers,
            "approvals": _late('copy').deepcopy(
                internal_approvals
                if internal_approvals is not None
                else carried_approvals
            ),
            "browserHandoff": browser_handoff,
            "createdAt": created_at or timestamp, "updatedAt": timestamp,
        }
        _late('_validate_session_document')(session)
        return session
