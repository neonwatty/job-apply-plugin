"""Durable account-operation journal and recovery transitions."""

from __future__ import annotations

import uuid
from typing import Any

from ...accounts_runtime import companion, validate_employer_account
from ...constants import AGENT_BLOCKER_TYPE_BY_CODE, SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock


_CANONICAL_RUNTIME = {
    "ACCOUNTS_MODULE": companion("job_apply_accounts"),
    "AGENT_BLOCKER_TYPE_BY_CODE": AGENT_BLOCKER_TYPE_BY_CODE,
    "SCHEMA_VERSION": SCHEMA_VERSION,
    "StoreError": StoreError,
    "_validate_employer_account_record": validate_employer_account,
    "atomic_write_json": atomic_write_json,
    "exclusive_file_lock": exclusive_file_lock,
    "uuid": uuid,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's live globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    return runtime[name] if name in runtime else _CANONICAL_RUNTIME[name]


class AccountOperationMixin:
    """Account operation recovery operating on Store-supplied state."""

    def account_operation_status(self) -> dict[str, Any]:
        self.initialize()
        self._ensure_account_control_documents()
        operation = self._load_account_operation_journal()["operation"]
        if operation is None:
            return {"status": "idle", "operation": None}
        return {
            "status": "recovery_required",
            "operation": {
                "operationId": operation["operationId"],
                "jobId": operation["jobId"],
                "realmRef": operation["realmRef"],
                "stage": operation["stage"],
                "outcomeCode": operation["outcomeCode"],
            },
        }

    def recover_account_operation(self) -> dict[str, Any]:
        """Fail a stranded protected operation closed; never infer success."""

        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            journal = self._load_account_operation_journal()
            operation = journal["operation"]
            if operation is None:
                return {"status": "idle", "recovered": False}
            accounts = self._load_employer_accounts_document()
            account = accounts["accounts"].get(operation["realmRef"])
            if account is None:
                raise StoreError("account operation realm is unavailable")
            if account["lifecycleState"] != "ambiguous":
                account = dict(account)
                account["lifecycleState"] = "ambiguous"
                account["revision"] += 1
                account["updatedAt"] = self._now()
                _late("_validate_employer_account_record")(account["realmRef"], account)
                accounts["accounts"][account["realmRef"]] = account
                accounts["metadata"]["updatedAt"] = account["updatedAt"]
                _late("atomic_write_json")(self.employer_accounts_path, accounts)
            jobs = self._load_jobs_document()["jobs"]
            job = jobs.get(operation["jobId"])
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("account operation job is unavailable")
            recovered_job = None
            if job["status"] == "in_progress":
                claim = self._load_coordinator_document()["claim"]
                if (
                    claim is None or claim["jobId"] != job["id"]
                    or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                ):
                    raise StoreError("account operation recovery requires a live same-job claim")
                recovered_job = self._account_attention_handoff_locked(job, "ambiguous_recovery")
            elif job["status"] != "needs_info":
                raise StoreError("account operation job cannot be reconciled")
            self._clear_account_operation_locked(operation)
            result = {
                "status": "ambiguous", "recovered": True,
                "account": _late("ACCOUNTS_MODULE").public_account(account),
                "retryAllowed": False,
            }
            if recovered_job is not None:
                result["job"] = {
                    "id": recovered_job["id"], "status": recovered_job["status"],
                    "revision": recovered_job["revision"],
                }
            return result

    def _clear_account_operation_locked(self, operation: dict[str, Any]) -> None:
        current = self._load_account_operation_journal()["operation"]
        if current is None or current["operationId"] != operation["operationId"]:
            raise StoreError("account operation journal changed before completion")
        _late("atomic_write_json")(
            self.account_operation_journal_path,
            {"schemaVersion": _late("SCHEMA_VERSION"), "operation": None},
        )

    def _write_account_stage_locked(
        self, account: dict[str, Any], lifecycle: str, operation: dict[str, Any], stage: str,
        *, provider_id: str | None = None, credential_ref: str | None = None,
        credential_version: int | None = None,
    ) -> dict[str, Any]:
        accounts = self._load_employer_accounts_document()
        current = accounts["accounts"].get(account["realmRef"])
        if current is None or current["revision"] != account["revision"]:
            raise StoreError("employer account revision conflict")
        updated = dict(current)
        updated.update({
            "lifecycleState": lifecycle,
            "revision": current["revision"] + 1,
            "updatedAt": self._now(),
        })
        if provider_id is not None:
            updated.update({
                "providerId": provider_id,
                "credentialRef": credential_ref,
                "credentialVersion": credential_version,
            })
        _late("_validate_employer_account_record")(updated["realmRef"], updated)
        accounts["accounts"][updated["realmRef"]] = updated
        accounts["metadata"]["updatedAt"] = updated["updatedAt"]
        _late("atomic_write_json")(self.employer_accounts_path, accounts)
        operation = {**operation, "stage": stage, "accountRevision": updated["revision"]}
        journal = {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation}
        _late("atomic_write_json")(self.account_operation_journal_path, journal)
        return updated

    def _account_attention_handoff_locked(self, job: dict[str, Any], reason: str) -> dict[str, Any]:
        claim = self._load_coordinator_document()["claim"]
        if claim is None or claim["jobId"] != job["id"] or self._now_datetime() >= self._parse_time(claim["expiresAt"]):
            raise StoreError("account denial requires the live claimed job")
        now = self._now()
        blocker_code = {
            "password_strategy": "owner-input-required",
            "reset_required": "owner-input-required",
            "verification_required": "mfa-required",
            "email_verification_required": "email-verification-required",
            "captcha_required": "captcha-required",
            "mfa_required": "mfa-required",
            "password_reset_required": "owner-input-required",
        }.get(reason, "browser-state-uncertain")
        session = self._build_session(job["id"], {
            "status": "active", "step": f"account_automation_denied:{reason}",
            "answerKeys": [], "pendingFields": [],
            "attemptRevision": job["revision"],
            "blockers": [{
                "type": _late("AGENT_BLOCKER_TYPE_BY_CODE")[blocker_code],
                "code": blocker_code,
            }],
            "browserHandoff": {
                "state": "required", "reasonCode": blocker_code, "revision": 1,
            },
        }, now, expected_attempt_revision=job["revision"], expected_ats=job.get("ats"))
        operation_id = str(_late("uuid").uuid4())
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
