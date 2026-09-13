"""Root-local trusted fill operations for Store composition."""

from __future__ import annotations

import copy
import hashlib
import sys
import uuid
from datetime import datetime
from typing import Any
from urllib.parse import urlsplit

from ... import accounts_runtime, constants, io, normalization
from ...errors import StoreError, TrustedFillCurrentError


_RUNTIME_PROVIDER = lambda: {}


def _bind_runtime(provider) -> None:
    """Bind this leaf to its owning facade's late-bound collaborators."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    if name in runtime:
        return runtime[name]
    if name.endswith("_MODULE"):
        return accounts_runtime.companion({
            "ACCOUNTS_MODULE": "job_apply_accounts",
            "CANARY_EXECUTOR_MODULE": "job_apply_account_canary_executor",
            "ACCOUNT_FLOWS_MODULE": "job_apply_account_flows",
            "PASSWORD_ACCOUNT_FLOWS_MODULE": "job_apply_password_account_flows",
            "CREDENTIALS_MODULE": "job_apply_credentials",
            "TRUSTED_FILL_MODULE": "job_apply_trusted_fill",
        }[name])
    return _CANONICAL[name]


_CANONICAL = {
    'AGENT_BLOCKER_TYPE_BY_CODE': constants.AGENT_BLOCKER_TYPE_BY_CODE,
    'SCHEMA_VERSION': constants.SCHEMA_VERSION,
    '_require_object': io.require_object,
    '_safe_session_id': normalization._safe_session_id,
    'atomic_write_json': io.atomic_write_json,
    'copy': copy,
    'exclusive_file_lock': io.exclusive_file_lock,
    'hashlib': hashlib,
    'read_json_object': io.read_json_object,
    'uuid': uuid,
    'validate_version': io.validate_version,
}


class TrustedFillMixin:
    """Plain mixin; persistent state belongs to StoreBase."""

    def _load_trusted_fill_document(self) -> dict[str, Any]:
        document = _late('read_json_object')(self.trusted_fill_path, "trusted fill approvals")
        _late('validate_version')(document, "trusted fill approvals")
        if set(document) != {"schemaVersion", "approvals", "metadata"}:
            raise StoreError("trusted fill approval document contains unsupported fields")
        approvals = _late('_require_object')(document.get("approvals"), "trusted fill approvals")
        metadata = _late('_require_object')(document.get("metadata"), "trusted fill metadata")
        if set(metadata) != {"createdAt", "updatedAt"}:
            raise StoreError("trusted fill metadata is invalid")
        for field in ("createdAt", "updatedAt"):
            if not isinstance(metadata[field], str) or not metadata[field]:
                raise StoreError("trusted fill metadata timestamp is invalid")
        for job_id, approval in approvals.items():
            _late('_safe_session_id')(job_id)
            try:
                _late('TRUSTED_FILL_MODULE').validate_approval(approval)
            except _late('TRUSTED_FILL_MODULE').TrustedFillError as error:
                raise StoreError(str(error)) from None
            if approval["jobId"] != job_id:
                raise StoreError("trusted fill approval job identity is invalid")
        return document


    def _ensure_trusted_fill_document(self) -> None:
        with _late('exclusive_file_lock')(self.store_lock_path):
            if self.trusted_fill_path.exists():
                return
            now = self._now()
            _late('atomic_write_json')(self.trusted_fill_path, {
                "schemaVersion": _late('SCHEMA_VERSION'),
                "approvals": {},
                "metadata": {"createdAt": now, "updatedAt": now},
            })


    @staticmethod
    def _trusted_fill_fingerprint(value: str) -> str:
        return "sha256:" + _late('hashlib').sha256(value.encode("utf-8")).hexdigest()


    def _trusted_fill_current_locked(
        self, job_id: str, answer_refs: list[str]
    ) -> dict[str, Any]:
        jobs = self._load_jobs_document()["jobs"]
        job = jobs.get(job_id)
        if job is None or job.get("deletedAt") is not None or job["status"] != "in_progress":
            raise StoreError("trusted fill requires an in-progress claimed job")
        realm = _late('ACCOUNTS_MODULE').normalize_realm(job["url"])
        if realm["status"] != "resolved":
            raise StoreError("trusted fill portal realm is unresolved")
        try:
            preflight = self._preflight_job_record(job)
        except Exception:
            raise TrustedFillCurrentError("resume_observation_failed") from None
        if not preflight["ready"]:
            if "resume_file_missing" in preflight["errors"] or "resume_missing" in preflight["errors"]:
                reason = "resume_content_missing"
            elif "resume_file_changed" in preflight["errors"]:
                reason = "resume_content_changed"
            else:
                reason = "resume_preflight_not_ready"
            raise TrustedFillCurrentError(reason)
        if preflight["resumeId"] is None:
            raise TrustedFillCurrentError("resume_content_missing")
        resume = self._load_resumes_document()["resumes"].get(preflight["resumeId"])
        if resume is None or resume.get("deletedAt") is not None:
            raise TrustedFillCurrentError("resume_content_missing")
        if resume.get("storageKind") != "managed":
            raise TrustedFillCurrentError("resume_content_unverifiable")
        try:
            content_revision = _late('TRUSTED_FILL_MODULE').validate_content_revision(
                resume.get("contentRevision")
            )
        except _late('TRUSTED_FILL_MODULE').TrustedFillError:
            raise TrustedFillCurrentError("resume_content_unverifiable") from None
        profile_revision = self._load_profile_document()["metadata"].get("revision", 1)
        answers = self._load_answers_document()["answers"]
        answer_bindings = []
        for answer_ref in sorted(answer_refs):
            answer = answers.get(answer_ref)
            if (
                answer is None or answer.get("deletedAt") is not None
                or answer.get("reviewStatus", "accepted") != "accepted"
            ):
                raise TrustedFillCurrentError("answer_binding_invalid")
            answer_bindings.append({
                "answerRef": answer_ref,
                "questionRevision": answer["revision"],
                "answerRevision": answer["revision"],
            })
        settings = self._load_automation_settings_document()["settings"]
        account = self._load_employer_accounts_document()["accounts"].get(realm["realmRef"])
        return {
            "jobId": job_id,
            "jobRevision": job["revision"],
            "realmRef": realm["realmRef"],
            "urlFingerprint": self._trusted_fill_fingerprint(job["normalizedUrl"]),
            "resumeId": resume["id"],
            "resumeRevision": resume["revision"],
            "resumeContentRevision": content_revision,
            "profileRevision": profile_revision,
            "vitalFactRevision": profile_revision,
            "answerBindings": answer_bindings,
            "automationSettingsRevision": settings["revision"],
            "employerAccountRevision": account["revision"] if account is not None else None,
            "policyRevision": _late('TRUSTED_FILL_MODULE').POLICY_REVISION,
        }


    def approve_trusted_fill(self, incoming: dict[str, Any], *, public: bool = False) -> dict[str, Any]:
        packet = _late('_require_object')(incoming, "trusted fill approval request")
        required = {
            "jobId", "expectedJobRevision", "realmRef", "answerRefs",
            "observedQuestionFingerprint", "observedControlFingerprint",
            "formFingerprint", "allowedOperations", "durationMinutes",
        }
        if set(packet) != required:
            raise StoreError("trusted fill approval request contains unsupported fields")
        job_id = _late('_safe_session_id')(packet.get("jobId", ""))
        if not isinstance(packet.get("answerRefs"), list) or not all(isinstance(item, str) for item in packet["answerRefs"]):
            raise StoreError("trusted fill answer references must be a list of strings")
        if len(packet["answerRefs"]) != len(set(packet["answerRefs"])):
            raise StoreError("trusted fill answer references contain duplicates")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        self._ensure_trusted_fill_document()
        with _late('exclusive_file_lock')(self.store_lock_path):
            claim = self._load_coordinator_document()["claim"]
            if (
                claim is None or claim["jobId"] != job_id
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
            ):
                raise StoreError("trusted fill approval requires the live claimed job")
            try:
                current = self._trusted_fill_current_locked(job_id, packet["answerRefs"])
            except TrustedFillCurrentError as error:
                job = self._load_jobs_document()["jobs"][job_id]
                handed_off = self._trusted_fill_attention_handoff_locked(
                    job, error.reason_code
                )
                return {
                    "authorized": False,
                    "reasonCode": error.reason_code,
                    "retryAllowed": False,
                    "attentionHandoff": True,
                    "job": {
                        "id": handed_off["id"],
                        "status": handed_off["status"],
                        "revision": handed_off["revision"],
                    },
                }
            current["claimId"] = claim["claimId"]
            if current["jobRevision"] != packet.get("expectedJobRevision"):
                raise StoreError("job revision conflict")
            if current["realmRef"] != packet.get("realmRef"):
                raise StoreError("trusted fill realm binding mismatch")
            document = self._load_trusted_fill_document()
            previous = document["approvals"].get(job_id)
            if previous is not None and previous["status"] == "active" and self._now_datetime() < _late('TRUSTED_FILL_MODULE')._time(previous["expiresAt"], "approval expiresAt"):
                raise StoreError("active trusted fill approval already exists")
            bindings = {
                **current,
                "observedQuestionFingerprint": packet["observedQuestionFingerprint"],
                "observedControlFingerprint": packet["observedControlFingerprint"],
                "formFingerprint": packet["formFingerprint"],
                "allowedOperations": packet["allowedOperations"],
            }
            approval_revision = 1 if previous is None else previous["approvalRevision"] + 1
            try:
                approval = _late('TRUSTED_FILL_MODULE').create_approval(
                    bindings, packet["durationMinutes"], approval_revision, self._now_datetime()
                )
            except _late('TRUSTED_FILL_MODULE').TrustedFillError as error:
                raise StoreError(str(error)) from None
            document["approvals"][job_id] = approval
            document["metadata"]["updatedAt"] = self._now()
            _late('atomic_write_json')(self.trusted_fill_path, document)
        return _late('TRUSTED_FILL_MODULE').public_status(approval, self._now_datetime()) if public else approval


    def trusted_fill_status(self, job_id: str, *, public: bool = False) -> dict[str, Any] | None:
        self.initialize()
        self._ensure_trusted_fill_document()
        _late('_safe_session_id')(job_id)
        record = self._load_trusted_fill_document()["approvals"].get(job_id)
        if public:
            return _late('TRUSTED_FILL_MODULE').public_status(record, self._now_datetime())
        return _late('copy').deepcopy(record) if record is not None else None


    def revoke_trusted_fill(
        self, job_id: str, expected_approval_revision: int, *, public: bool = False
    ) -> dict[str, Any]:
        self.initialize()
        self._ensure_trusted_fill_document()
        _late('_safe_session_id')(job_id)
        with _late('exclusive_file_lock')(self.store_lock_path):
            document = self._load_trusted_fill_document()
            record = document["approvals"].get(job_id)
            if record is None:
                raise StoreError("trusted fill approval does not exist")
            try:
                updated = _late('TRUSTED_FILL_MODULE').revoke_approval(
                    record, expected_approval_revision, self._now_datetime()
                )
            except _late('TRUSTED_FILL_MODULE').TrustedFillError as error:
                raise StoreError(str(error)) from None
            document["approvals"][job_id] = updated
            document["metadata"]["updatedAt"] = self._now()
            _late('atomic_write_json')(self.trusted_fill_path, document)
        return _late('TRUSTED_FILL_MODULE').public_status(updated, self._now_datetime()) if public else updated


    def _trusted_fill_attention_handoff_locked(
        self, job: dict[str, Any], reason_code: str
    ) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if (
            claim is None or claim["jobId"] != job["id"]
            or self._now_datetime() >= self._parse_time(claim["expiresAt"])
        ):
            raise StoreError("trusted fill denial requires the live claimed job")
        now = self._now()
        blocker_code = {
            "authentication_required": "login-required",
            "credential_fields_present": "login-required",
            "consent_required": "consent-required",
            "approval_missing": "owner-input-required",
            "approval_revoked": "owner-input-required",
            "approval_expired": "owner-input-required",
            "approval_revision_mismatch": "owner-input-required",
            "answer_binding_invalid": "owner-input-required",
            "resume_content_missing": "owner-input-required",
            "resume_content_unverifiable": "owner-input-required",
            "resume_observation_failed": "owner-input-required",
            "resume_preflight_not_ready": "owner-input-required",
            "unseen_questions": "owner-input-required",
        }.get(reason_code, "browser-state-uncertain")
        session = self._build_session(job["id"], {
            "status": "active",
            "step": f"trusted_fill_denied:{reason_code}",
            "answerKeys": [],
            "pendingFields": [],
            "attemptRevision": job["revision"],
            "blockers": [{
                "type": _late('AGENT_BLOCKER_TYPE_BY_CODE')[blocker_code],
                "code": blocker_code,
            }],
            "browserHandoff": {
                "state": "required", "reasonCode": blocker_code, "revision": 1,
            },
        }, now, expected_attempt_revision=job["revision"], expected_ats=job.get("ats"))
        operation_id = str(_late('uuid').uuid4())
        self._commit_coordinator_operation_locked({
            "kind": "handoff", "operationId": operation_id, "jobId": job["id"],
            "sourceStatus": "in_progress", "targetStatus": "needs_info",
            "expectedRevision": job["revision"], "at": now, "session": session,
            "historyEvent": self._history_event_for_operation(
                operation_id, job, "job-blocked", "needs_info", now
            ),
            "resultClaim": None,
        })
        return self._load_jobs_document()["jobs"][job["id"]]


    def evaluate_trusted_fill(self, incoming: dict[str, Any], *, public: bool = False) -> dict[str, Any]:
        observed = _late('_require_object')(incoming, "trusted fill evaluation")
        required = {
            "jobId", "expectedApprovalRevision", "observedQuestionFingerprint",
            "observedControlFingerprint", "formFingerprint", "fieldOperations",
            "authenticationRequired", "consentRequired", "credentialFieldsPresent",
            "finalControlsPresent", "unseenQuestions", "unseenControls",
        }
        if set(observed) != required:
            raise StoreError("trusted fill evaluation contains unsupported fields")
        for field in (
            "authenticationRequired", "consentRequired", "credentialFieldsPresent",
            "finalControlsPresent", "unseenQuestions", "unseenControls",
        ):
            if not isinstance(observed[field], bool):
                raise StoreError("trusted fill evaluation flags must be booleans")
        job_id = _late('_safe_session_id')(observed.get("jobId", ""))
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        self._ensure_trusted_fill_document()
        with _late('exclusive_file_lock')(self.store_lock_path):
            document = self._load_trusted_fill_document()
            approval = document["approvals"].get(job_id)
            job = self._load_jobs_document()["jobs"].get(job_id)
            claim = self._load_coordinator_document()["claim"]
            if job is None or job.get("deletedAt") is not None or job["status"] != "in_progress":
                raise StoreError("trusted fill evaluation requires an in-progress job")
            if (
                claim is None or claim["jobId"] != job_id
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
            ):
                return {
                    "authorized": False,
                    "reasonCode": "claim_missing_or_expired",
                    "retryAllowed": False,
                    "attentionHandoff": False,
                }
            if approval is None:
                decision = {"authorized": False, "reasonCode": "approval_missing", "retryAllowed": False}
            elif approval["approvalRevision"] != observed.get("expectedApprovalRevision"):
                decision = {"authorized": False, "reasonCode": "approval_revision_mismatch", "retryAllowed": False}
            elif approval["claimId"] != claim["claimId"]:
                return {
                    "authorized": False,
                    "reasonCode": "claim_binding_mismatch",
                    "retryAllowed": False,
                    "attentionHandoff": False,
                }
            else:
                try:
                    current = self._trusted_fill_current_locked(
                        job_id, [item["answerRef"] for item in approval["answerBindings"]]
                    )
                except TrustedFillCurrentError as error:
                    decision = {
                        "authorized": False,
                        "reasonCode": error.reason_code,
                        "retryAllowed": False,
                    }
                else:
                    current["claimId"] = claim["claimId"]
                    try:
                        decision = _late('TRUSTED_FILL_MODULE').evaluate_approval(
                            approval, current, observed, self._now_datetime()
                        )
                    except _late('TRUSTED_FILL_MODULE').TrustedFillError as error:
                        raise StoreError(str(error)) from None
            if not decision["authorized"]:
                handed_off = self._trusted_fill_attention_handoff_locked(job, decision["reasonCode"])
                decision = {
                    **decision,
                    "attentionHandoff": True,
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            else:
                decision["attentionHandoff"] = False
        return decision
