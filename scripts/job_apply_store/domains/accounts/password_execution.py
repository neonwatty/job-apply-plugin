"""Root-local password execution operations for Store composition."""

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
    'SCHEMA_VERSION': constants.SCHEMA_VERSION,
    'atomic_write_json': io.atomic_write_json,
    'datetime': datetime,
    'exclusive_file_lock': io.exclusive_file_lock,
    'sys': sys,
    'uuid': uuid,
}


class PasswordExecutionMixin:
    """Plain mixin; persistent state belongs to StoreBase."""

    def _validate_live_password_stable_locked(
        self, request: dict[str, Any]
    ) -> dict[str, Any]:
        binding = request["binding"]
        job = self._load_jobs_document()["jobs"].get(binding["jobId"])
        if (
            job is None or job.get("deletedAt") is not None
            or not (
                (job["status"] == "in_progress" and job["revision"] == binding["jobRevision"])
                or (job["status"] == "ready" and job["revision"] + 1 == binding["jobRevision"])
            )
            or job["url"] != request["portalUrl"]
        ):
            raise StoreError("live password stable job binding drifted")
        realm = _late('ACCOUNTS_MODULE').normalize_realm(job["url"])
        settings = self._load_automation_settings_document()["settings"]
        account = self._load_employer_accounts_document()["accounts"].get(
            binding["realmRef"]
        )
        if (
            realm.get("status") != "resolved"
            or realm.get("adapterId") != "workday"
            or realm.get("flowKind") != _late('ACCOUNTS_MODULE').FLOW_PASSWORD
            or realm.get("realmRef") != binding["realmRef"]
            or account is None or account.get("descriptor") != realm.get("descriptor")
            or account.get("revision") != binding["accountRevision"]
            or settings.get("revision") != binding["settingsRevision"]
        ):
            raise StoreError("live password canonical binding drifted")
        if not settings["enabled"] or not settings["automaticAccountCreation"]:
            raise StoreError("account automation is disabled")
        if settings["passwordStrategy"] != "unique_per_realm":
            raise StoreError("live password strategy requires human attention")
        if (
            account.get("flowKind") != _late('ACCOUNTS_MODULE').FLOW_PASSWORD
            or account.get("credentialRequired") is not True
            or account.get("lifecycleState") != "discovered"
            or account.get("providerId") is not None
            or account.get("credentialRef") is not None
            or account.get("credentialVersion") is not None
        ):
            raise StoreError("live password account cannot be attempted")
        if account["signupEmailOverride"] is None and settings["signupEmail"] is None:
            raise StoreError("effective signup email is required")
        return {"job": job, "realm": realm, "settings": settings, "account": account}


    def revalidate_live_password_stable_scope(
        self, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        try:
            request = _late('CANARY_EXECUTOR_MODULE').validate_stable_live_password_request(incoming)
        except _late('CANARY_EXECUTOR_MODULE').LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with _late('exclusive_file_lock')(self.store_lock_path):
            current = self._validate_live_password_stable_locked(request)
            operation = self._load_account_operation_journal()["operation"]
            if operation is not None:
                resumable = {
                    "jobId": current["job"]["id"],
                    "jobRevision": request["binding"]["jobRevision"],
                    "realmRef": current["account"]["realmRef"],
                    "accountRevision": current["account"]["revision"],
                    "settingsRevision": current["settings"]["revision"],
                    "stage": "prepared", "outcomeCode": "observed_pending",
                }
                if any(operation.get(field) != value for field, value in resumable.items()):
                    raise StoreError("account operation requires explicit recovery")
            return {
                "valid": True, "jobId": current["job"]["id"],
                "jobRevision": request["binding"]["jobRevision"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "finalActionAuthorized": False,
            }


    def acquire_or_recover_live_password_claim(
        self, incoming: dict[str, Any], *, owner_label: str,
    ) -> dict[str, Any]:
        stable = self.revalidate_live_password_stable_scope(incoming)
        status = self.claim_status()["claim"]
        if status is None:
            job = self.get_job(stable["jobId"])
            if job["status"] != "ready":
                raise StoreError("live password claim cannot be acquired")
            claim = self.acquire_ready_job(
                job["id"], owner_label, job["revision"]
            )["claim"]
        elif status["jobId"] != stable["jobId"]:
            raise StoreError("another job claim blocks live password execution")
        elif status["expired"]:
            claim = self.recover_claim(stable["jobId"], owner_label)["claim"]
        elif status["ownerLabel"] != owner_label.strip():
            raise StoreError("live password claim belongs to another owner")
        else:
            claim = status
        self.revalidate_live_password_stable_scope(incoming)
        return {"claimId": claim["claimId"], "expiresAt": claim["expiresAt"]}


    def prepare_live_password_account_execution(
        self, incoming: dict[str, Any], binding: dict[str, Any],
    ) -> dict[str, Any]:
        try:
            stable = _late('CANARY_EXECUTOR_MODULE').validate_stable_live_password_request(incoming)
            exact_binding = _late('CANARY_EXECUTOR_MODULE').CANARY.validate_binding(binding)
        except (
            _late('CANARY_EXECUTOR_MODULE').LiveCanaryExecutorError,
            _late('CANARY_EXECUTOR_MODULE').CANARY.CanaryAuthorityError,
        ) as error:
            raise StoreError(str(error)) from None
        if _late('CANARY_EXECUTOR_MODULE').CANARY._without_claim(exact_binding) != stable["binding"]:
            raise StoreError("live password execution binding drifted")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with _late('exclusive_file_lock')(self.store_lock_path):
            current = self._validate_live_password_stable_locked(stable)
            claim = self._load_coordinator_document()["claim"]
            if (
                claim is None or claim["jobId"] != exact_binding["jobId"]
                or claim["claimId"] != exact_binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or current["job"]["status"] != "in_progress"
            ):
                raise StoreError("live password execution preparation drifted")
            expected = {
                "jobId": current["job"]["id"],
                "jobRevision": current["job"]["revision"],
                "claimId": claim["claimId"],
                "realmRef": current["account"]["realmRef"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "stage": "prepared", "outcomeCode": "observed_pending",
            }
            operation = self._load_account_operation_journal()["operation"]
            if operation is not None:
                if any(operation.get(field) != value for field, value in expected.items()):
                    raise StoreError("account operation requires explicit recovery")
                return {"prepared": True, "reused": True}
            _late('atomic_write_json')(
                self.account_operation_journal_path,
                {"schemaVersion": _late('SCHEMA_VERSION'), "operation": {
                    "operationId": str(_late('uuid').uuid4()), **expected,
                    "startedAt": self._now(),
                }},
            )
            return {"prepared": True, "reused": False}


    def execute_live_password_account(
        self, incoming: dict[str, Any], *, authority: Any, provider: Any,
        now: datetime,
    ) -> dict[str, Any]:
        try:
            request = _late('CANARY_EXECUTOR_MODULE').validate_live_password_request(incoming)
        except _late('CANARY_EXECUTOR_MODULE').LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        if (
            not _late('sys').platform.startswith("darwin")
            or getattr(provider, "provider_id", None) != "macos-workday-account"
        ):
            raise StoreError("native account execution is unsupported on this platform")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        binding = request["binding"]
        with _late('exclusive_file_lock')(self.store_lock_path):
            current = self._validate_live_password_stable_locked({
                **request, "binding": _late('CANARY_EXECUTOR_MODULE').CANARY._without_claim(binding)
            })
            claim = self._load_coordinator_document()["claim"]
            if (
                claim is None or claim["jobId"] != binding["jobId"]
                or claim["claimId"] != binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or current["job"]["status"] != "in_progress"
            ):
                raise StoreError("live password execution requires the exact live claimed job")
            operation = self._load_account_operation_journal()["operation"]
            expected_operation = {
                "jobId": current["job"]["id"],
                "jobRevision": current["job"]["revision"],
                "claimId": claim["claimId"],
                "realmRef": current["account"]["realmRef"],
                "accountRevision": current["account"]["revision"],
                "settingsRevision": current["settings"]["revision"],
                "stage": "prepared", "outcomeCode": "observed_pending",
            }
            if operation is None or any(
                operation.get(field) != value
                for field, value in expected_operation.items()
            ):
                raise StoreError("live password execution requires a prepared operation")
            authority.attempt(request["capabilityRef"], binding, now=now)
            account = self._write_account_stage_locked(
                current["account"], "signup_in_progress", operation,
                "signup_in_progress",
            )
            packet = {
                "jobId": current["job"]["id"],
                "jobRevision": current["job"]["revision"],
                "expectedClaimId": claim["claimId"],
                "realmRef": current["realm"]["realmRef"],
                "realmDescriptor": current["realm"]["descriptor"],
                "accountRevision": binding["accountRevision"],
                "settingsRevision": current["settings"]["revision"],
                "portalUrl": request["portalUrl"],
                "strategy": current["settings"]["passwordStrategy"],
                "accountFormFingerprint": request["accountFormFingerprint"],
                "emailControlFingerprint": request["emailControlFingerprint"],
                "passwordControlFingerprint": request["passwordControlFingerprint"],
                "createAccountControlFingerprint": request["createAccountControlFingerprint"],
                "accountCreationControlsFingerprint": binding["accountCreationControlsFingerprint"],
            }
            effective_email = (
                current["account"]["signupEmailOverride"]
                or current["settings"]["signupEmail"]
            )
            try:
                result = _late('PASSWORD_ACCOUNT_FLOWS_MODULE').execute_password_account(
                    packet, provider, lambda: effective_email,
                )
                expected_ref = _late('CREDENTIALS_MODULE').credential_reference(
                    "unique_per_realm", current["realm"]["realmRef"]
                )
                if result["credentialRef"] != expected_ref:
                    raise StoreError("native credential realm binding mismatch")
            except Exception:
                ambiguous = self._write_account_stage_locked(
                    account, "ambiguous", operation, "signup_in_progress"
                )
                handed_off = self._account_attention_handoff_locked(
                    current["job"], "ambiguous"
                )
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous",
                    "retryAllowed": False, "attentionHandoff": True,
                    "finalActionAuthorized": False,
                    "account": _late('ACCOUNTS_MODULE').public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"],
                            "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(
                account, result["lifecycleState"], operation, "signup_in_progress",
                provider_id=result["credentialProviderId"],
                credential_ref=result["credentialRef"],
                credential_version=result["credentialVersion"],
            )
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": not attention,
                "reasonCode": result["attentionReason"],
                "retryAllowed": False, "attentionHandoff": attention,
                "finalActionAuthorized": False, "reused": result["reused"],
                "createAccountActivations": result["createAccountActivations"],
                "emailControlRemoved": result["emailControlRemoved"],
                "passwordControlRemoved": result["passwordControlRemoved"],
                "account": _late('ACCOUNTS_MODULE').public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(
                    current["job"], result["attentionReason"]
                )
                response["job"] = {
                    "id": handed_off["id"], "status": handed_off["status"],
                    "revision": handed_off["revision"],
                }
            self._clear_account_operation_locked(operation)
            return response
