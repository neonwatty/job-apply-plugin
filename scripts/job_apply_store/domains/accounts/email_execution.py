"""Root-local email execution operations for Store composition."""

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
    'hashlib': hashlib,
    'sys': sys,
    'uuid': uuid,
}


class EmailExecutionMixin:
    """Plain mixin; persistent state belongs to StoreBase."""

    def acquire_or_recover_live_email_only_claim(
        self, incoming: dict[str, Any], *, owner_label: str,
    ) -> dict[str, Any]:
        """Create fresh short-lived execution authority after stable approval."""
        stable = self.revalidate_live_email_only_stable_scope(incoming)
        status = self.claim_status()["claim"]
        if status is None:
            job = self.get_job(stable["jobId"])
            if job["status"] != "ready":
                raise StoreError("live email-only claim cannot be acquired")
            acquired = self.acquire_ready_job(job["id"], owner_label, job["revision"])
            claim = acquired["claim"]
        elif status["jobId"] != stable["jobId"]:
            raise StoreError("another job claim blocks live email-only execution")
        elif status["expired"]:
            claim = self.recover_claim(stable["jobId"], owner_label)["claim"]
        elif status["ownerLabel"] != owner_label.strip():
            raise StoreError("live email-only claim belongs to another owner")
        else:
            claim = status
        # Close the acquisition/recovery race by rechecking every stable field.
        self.revalidate_live_email_only_stable_scope(incoming)
        return {"claimId": claim["claimId"], "expiresAt": claim["expiresAt"]}


    def prepare_live_email_only_account_execution(
        self, incoming: dict[str, Any], binding: dict[str, Any],
    ) -> dict[str, Any]:
        """Durably stage one exact attempt before consuming owner authority."""

        try:
            stable = _late('CANARY_EXECUTOR_MODULE').validate_stable_live_request(incoming)
            exact_binding = _late('CANARY_EXECUTOR_MODULE').CANARY.validate_binding(binding)
        except (
            _late('CANARY_EXECUTOR_MODULE').LiveCanaryExecutorError,
            _late('CANARY_EXECUTOR_MODULE').CANARY.CanaryAuthorityError,
        ) as error:
            raise StoreError(str(error)) from None
        if _late('CANARY_EXECUTOR_MODULE').CANARY._without_claim(exact_binding) != stable["binding"]:
            raise StoreError("live email-only execution binding drifted")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with _late('exclusive_file_lock')(self.store_lock_path):
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(exact_binding["jobId"])
            account = self._load_employer_accounts_document()["accounts"].get(
                exact_binding["realmRef"]
            )
            settings = self._load_automation_settings_document()["settings"]
            if (
                claim is None or claim["jobId"] != exact_binding["jobId"]
                or claim["claimId"] != exact_binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress"
                or job["revision"] != exact_binding["jobRevision"]
                or job["url"] != stable["portalUrl"]
                or account is None or account["revision"] != exact_binding["accountRevision"]
                or settings["revision"] != exact_binding["settingsRevision"]
                or account["lifecycleState"] != "discovered"
            ):
                raise StoreError("live email-only execution preparation drifted")
            operation = self._load_account_operation_journal()["operation"]
            expected = {
                "jobId": job["id"], "jobRevision": job["revision"],
                "claimId": claim["claimId"], "realmRef": account["realmRef"],
                "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending",
            }
            if operation is not None:
                if any(operation.get(field) != value for field, value in expected.items()):
                    raise StoreError("account operation requires explicit recovery")
                return {"prepared": True, "reused": True}
            operation_id = str(_late('uuid').uuid4())
            _late('atomic_write_json')(
                self.account_operation_journal_path,
                {"schemaVersion": _late('SCHEMA_VERSION'), "operation": {
                    "operationId": operation_id, **expected, "startedAt": self._now(),
                }},
            )
            return {"prepared": True, "reused": False}


    def execute_live_email_only_account(
        self, incoming: dict[str, Any], *, authority: Any, provider: Any,
        now: datetime,
    ) -> dict[str, Any]:
        """Consume one exact T007 capability and run one query-free Oracle attempt.

        This method is intentionally not exposed through the JSON CLI or HTTP.
        Capability material and the canonical signup identity remain inside the
        process. The durable journal is written before T007 is consumed, and
        both burns precede every browser effect.
        """

        try:
            request = _late('CANARY_EXECUTOR_MODULE').validate_live_request(incoming)
        except _late('CANARY_EXECUTOR_MODULE').LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        if request["binding"].get("flowKind") != _late('ACCOUNTS_MODULE').FLOW_EMAIL_ONLY:
            raise StoreError("live email-only canary binding is invalid")
        if not _late('sys').platform.startswith("darwin") or getattr(provider, "provider_id", None) != "macos-accessibility":
            raise StoreError("native account execution is unsupported on this platform")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        binding = request["binding"]
        with _late('exclusive_file_lock')(self.store_lock_path):
            prepared_operation = self._load_account_operation_journal()["operation"]
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(binding["jobId"])
            if (
                claim is None or claim["jobId"] != binding["jobId"]
                or claim["claimId"] != binding["claimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress" or job["revision"] != binding["jobRevision"]
            ):
                raise StoreError("live email-only execution requires the exact live claimed job")
            if job["url"] != request["portalUrl"]:
                raise StoreError("live email-only portal URL drifted")
            realm = _late('ACCOUNTS_MODULE').normalize_realm(job["url"])
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(binding["realmRef"])
            if (
                realm.get("status") != "resolved"
                or realm.get("adapterId") != "oracle-recruiting"
                or realm.get("realmRef") != binding["realmRef"]
                or account is None or account["descriptor"] != realm.get("descriptor")
                or account["revision"] != binding["accountRevision"]
                or settings["revision"] != binding["settingsRevision"]
            ):
                raise StoreError("live email-only canonical binding drifted")
            if not settings["enabled"] or not settings["automaticAccountCreation"]:
                raise StoreError("account automation is disabled")
            if (
                account.get("flowKind") != _late('ACCOUNTS_MODULE').FLOW_EMAIL_ONLY
                or account.get("credentialRequired") is not False
                or account["providerId"] is not None
                or account["credentialRef"] is not None
                or account["credentialVersion"] is not None
            ):
                raise StoreError("live email-only account metadata is invalid")
            if account["lifecycleState"] != "discovered":
                raise StoreError("live email-only account cannot be attempted again")
            effective_email = account["signupEmailOverride"] or settings["signupEmail"]
            if effective_email is None:
                raise StoreError("effective signup email is required")
            expected_operation = {
                "jobId": job["id"], "jobRevision": job["revision"],
                "claimId": claim["claimId"], "realmRef": account["realmRef"],
                "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending",
            }
            if prepared_operation is None:
                operation_id = str(_late('uuid').uuid4())
                operation = {
                    "operationId": operation_id, **expected_operation,
                    "startedAt": self._now(),
                }
                _late('atomic_write_json')(
                    self.account_operation_journal_path,
                    {"schemaVersion": _late('SCHEMA_VERSION'), "operation": operation},
                )
            else:
                if any(
                    prepared_operation.get(field) != value
                    for field, value in expected_operation.items()
                ):
                    raise StoreError("account operation requires explicit recovery")
                operation = prepared_operation
                operation_id = operation["operationId"]
            operation_fingerprint = "sha256:" + _late('hashlib').sha256(operation_id.encode("ascii")).hexdigest()
            # The hash-only T007 ledger is consumed after the write-ahead burn
            # and before signup_in_progress or any native browser effect.
            authority.attempt(request["capabilityRef"], binding, now=now)
            account = self._write_account_stage_locked(
                account, "signup_in_progress", operation, "signup_in_progress"
            )
            flow_packet = {
                "jobId": job["id"], "jobRevision": job["revision"],
                "expectedClaimId": claim["claimId"], "realmRef": realm["realmRef"],
                "realmDescriptor": realm["descriptor"], "flowKind": _late('ACCOUNTS_MODULE').FLOW_EMAIL_ONLY,
                "accountRevision": binding["accountRevision"],
                "settingsRevision": settings["revision"], "portalUrl": request["portalUrl"],
                "accountFormFingerprint": request["accountFormFingerprint"],
                "emailControlFingerprint": request["emailControlFingerprint"],
                "termsControlFingerprint": request["termsControlFingerprint"],
                "termsDocumentFingerprint": request["termsDocumentFingerprint"],
                "nextControlFingerprint": request["nextControlFingerprint"],
                "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
                "accountCreationControlsFingerprint": binding["accountCreationControlsFingerprint"],
            }
            try:
                result = _late('ACCOUNT_FLOWS_MODULE').execute_email_only(
                    flow_packet, provider, lambda: effective_email,
                    operation_fingerprint=operation_fingerprint,
                )
            except Exception:
                ambiguous = self._write_account_stage_locked(account, "ambiguous", operation, "signup_in_progress")
                handed_off = self._account_attention_handoff_locked(job, "ambiguous")
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous", "retryAllowed": False,
                    "attentionHandoff": True, "finalActionAuthorized": False,
                    "credentialProviderInvocations": 0,
                    "account": _late('ACCOUNTS_MODULE').public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(account, result["lifecycleState"], operation, "signup_in_progress")
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": not attention, "reasonCode": result["lifecycleState"],
                "retryAllowed": False, "attentionHandoff": attention,
                "finalActionAuthorized": False, "emailRemoved": result["emailRemoved"],
                "termsAccepted": result["termsAccepted"], "nextActivations": result["nextActivations"],
                "credentialProviderInvocations": 0,
                "account": _late('ACCOUNTS_MODULE').public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(job, result["lifecycleState"])
                response["job"] = {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]}
            self._clear_account_operation_locked(operation)
            return response
