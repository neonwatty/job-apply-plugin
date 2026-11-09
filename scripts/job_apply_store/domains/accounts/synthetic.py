"""Synthetic protected and email-only account execution."""

from __future__ import annotations

import sys
import uuid
from typing import Any

from ...accounts_runtime import companion
from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock


_CANONICAL_RUNTIME = {
    "ACCOUNTS_MODULE": companion("job_apply_accounts"),
    "ACCOUNT_EXECUTOR_MODULE": companion("job_apply_account_executor"),
    "ACCOUNT_FLOWS_MODULE": companion("job_apply_account_flows"),
    "CREDENTIALS_MODULE": companion("job_apply_credentials"),
    "SCHEMA_VERSION": SCHEMA_VERSION,
    "StoreError": StoreError,
    "atomic_write_json": atomic_write_json,
    "exclusive_file_lock": exclusive_file_lock,
    "sys": sys,
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


class SyntheticAccountMixin:
    """Synthetic account execution operating on Store-supplied state."""

    def execute_synthetic_account(
        self, incoming: dict[str, Any], *, provider: Any | None = None,
        observer: Any | None = None, public: bool = False,
        test_authority: object | None = None,
    ) -> dict[str, Any]:
        try:
            packet = _late("ACCOUNT_EXECUTOR_MODULE").validate_request(incoming)
        except _late("ACCOUNT_EXECUTOR_MODULE").AccountExecutorError as error:
            raise StoreError(str(error)) from None
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        if provider is None:
            raise StoreError("native protected provider injection is required")
        provider_id = getattr(provider, "provider_id", None)
        synthetic_authorized = (
            provider_id == "synthetic-protected"
            and test_authority is _late("CREDENTIALS_MODULE").synthetic_test_authority()
            and not public
        )
        if provider_id == "synthetic-protected" and not synthetic_authorized:
            raise StoreError("synthetic provider is test-only")
        if not synthetic_authorized and (
            not _late("sys").platform.startswith("darwin") or provider_id != "macos-keychain"
        ):
            raise StoreError("native account execution is unsupported on this platform")
        protected_provider = provider
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(packet["jobId"])
            if (
                claim is None or claim["jobId"] != packet["jobId"]
                or claim["claimId"] != packet["expectedClaimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress"
                or job["revision"] != packet["expectedJobRevision"]
            ):
                raise StoreError("account execution requires the exact live claimed job")
            realm = _late("ACCOUNTS_MODULE").normalize_realm(job["url"])
            if (
                realm["status"] != "resolved" or realm["realmRef"] != packet["realmRef"]
                or realm["descriptor"] != packet["realmDescriptor"]
            ):
                raise StoreError("account execution realm binding mismatch")
            expected_target = self._trusted_fill_fingerprint(packet["syntheticTargetUrl"])
            if expected_target != packet["syntheticTargetFingerprint"]:
                raise StoreError("synthetic target fingerprint mismatch")
            settings = self._load_automation_settings_document()["settings"]
            accounts = self._load_employer_accounts_document()
            account = accounts["accounts"].get(packet["realmRef"])
            if account is None:
                raise StoreError("employer account does not exist")
            if settings["revision"] != packet["expectedSettingsRevision"] or account["revision"] != packet["expectedAccountRevision"]:
                raise StoreError("account execution revision conflict")
            if not settings["enabled"] or not settings["automaticAccountCreation"]:
                raise StoreError("account automation is disabled")
            if account["signupEmailOverride"] is None and settings["signupEmail"] is None:
                raise StoreError("effective signup email is required")
            if account["lifecycleState"] in _late("ACCOUNT_EXECUTOR_MODULE").TERMINAL_NO_RETRY:
                raise StoreError("account lifecycle permanently requires human attention")
            strategy = settings["passwordStrategy"]
            if strategy in {"custom", "ask_each_time"}:
                handed_off = self._account_attention_handoff_locked(job, "password_strategy")
                return {
                    "authorized": False, "reasonCode": "password_strategy_requires_human",
                    "retryAllowed": False, "attentionHandoff": True,
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            operation = {
                "operationId": str(_late("uuid").uuid4()), "jobId": job["id"],
                "jobRevision": job["revision"], "claimId": claim["claimId"],
                "realmRef": account["realmRef"], "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending", "startedAt": self._now(),
            }
            _late("atomic_write_json")(
                self.account_operation_journal_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation},
            )
            try:
                result = _late("ACCOUNT_EXECUTOR_MODULE").execute_non_final(
                    packet, protected_provider, strategy, account["credentialRef"],
                    observer or _late("ACCOUNT_EXECUTOR_MODULE").observe_synthetic_portal,
                )
            except Exception:
                ambiguous = self._write_account_stage_locked(
                    account, "ambiguous", operation, "signup_in_progress"
                )
                handed_off = self._account_attention_handoff_locked(job, "ambiguous")
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous",
                    "retryAllowed": False, "attentionHandoff": True,
                    "account": _late("ACCOUNTS_MODULE").public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(
                account, "credential_provisioned", operation, "credential_provisioned",
                provider_id=result["providerId"], credential_ref=result["credentialRef"],
                credential_version=result["credentialVersion"],
            )
            account = self._write_account_stage_locked(
                account, "signup_in_progress", operation, "signup_in_progress"
            )
            account = self._write_account_stage_locked(
                account, result["lifecycleState"], operation, "signup_in_progress"
            )
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": result["lifecycleState"] == "active",
                "reasonCode": result["lifecycleState"], "retryAllowed": False,
                "attentionHandoff": attention, "reused": result["reused"],
                "secureControlCleared": result["secureControlCleared"],
                "finalActionAuthorized": False,
                "account": _late("ACCOUNTS_MODULE").public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(job, result["lifecycleState"])
                response["job"] = {
                    "id": handed_off["id"], "status": handed_off["status"],
                    "revision": handed_off["revision"],
                }
            self._clear_account_operation_locked(operation)
            return response

    def execute_synthetic_email_only_account(
        self, incoming: dict[str, Any], *, provider: Any,
        test_authority: object | None = None,
    ) -> dict[str, Any]:
        """Execute one loopback Oracle email-only flow without credentials."""

        try:
            packet = _late("ACCOUNT_FLOWS_MODULE").validate_email_only_request(incoming, allow_loopback=True)
        except _late("ACCOUNT_FLOWS_MODULE").AccountFlowError as error:
            raise StoreError(str(error)) from None
        if (
            test_authority is not _late("ACCOUNT_FLOWS_MODULE").synthetic_test_authority()
            or getattr(provider, "provider_id", None) != "macos-accessibility"
        ):
            raise StoreError("synthetic account-flow provider is test-only")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            claim = self._load_coordinator_document()["claim"]
            job = self._load_jobs_document()["jobs"].get(packet["jobId"])
            if (
                claim is None or claim["jobId"] != packet["jobId"]
                or claim["claimId"] != packet["expectedClaimId"]
                or self._now_datetime() >= self._parse_time(claim["expiresAt"])
                or job is None or job.get("deletedAt") is not None
                or job["status"] != "in_progress" or job["revision"] != packet["jobRevision"]
            ):
                raise StoreError("email-only execution requires the exact live claimed job")
            realm = _late("ACCOUNTS_MODULE").normalize_realm(job["url"])
            if (
                realm.get("status") != "resolved"
                or realm.get("adapterId") != "oracle-recruiting"
                or realm.get("flowKind") != _late("ACCOUNTS_MODULE").FLOW_EMAIL_ONLY
                or realm.get("realmRef") != packet["realmRef"]
                or realm.get("descriptor") != packet["realmDescriptor"]
            ):
                raise StoreError("email-only execution realm binding mismatch")
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(packet["realmRef"])
            if (
                account is None or account["revision"] != packet["accountRevision"]
                or settings["revision"] != packet["settingsRevision"]
            ):
                raise StoreError("email-only execution revision conflict")
            if not settings["enabled"] or not settings["automaticAccountCreation"]:
                raise StoreError("account automation is disabled")
            if account.get("flowKind") != _late("ACCOUNTS_MODULE").FLOW_EMAIL_ONLY or account.get("credentialRequired") is not False:
                raise StoreError("email-only account metadata is invalid")
            if account["providerId"] is not None or account["credentialRef"] is not None or account["credentialVersion"] is not None:
                raise StoreError("email-only execution forbids credential metadata")
            if account["lifecycleState"] != "discovered":
                raise StoreError("email-only account cannot be attempted again")
            effective_email = account["signupEmailOverride"] or settings["signupEmail"]
            if effective_email is None:
                raise StoreError("effective signup email is required")
            operation = {
                "operationId": str(_late("uuid").uuid4()), "jobId": job["id"],
                "jobRevision": job["revision"], "claimId": claim["claimId"],
                "realmRef": account["realmRef"], "accountRevision": account["revision"],
                "settingsRevision": settings["revision"], "stage": "prepared",
                "outcomeCode": "observed_pending", "startedAt": self._now(),
            }
            # Durable burn precedes every portal effect.
            _late("atomic_write_json")(self.account_operation_journal_path, {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation})
            account = self._write_account_stage_locked(account, "signup_in_progress", operation, "signup_in_progress")
            try:
                result = _late("ACCOUNT_FLOWS_MODULE").execute_email_only(
                    {**packet, "accountRevision": packet["accountRevision"]}, provider,
                    lambda: effective_email, allow_loopback=True,
                )
            except Exception:
                ambiguous = self._write_account_stage_locked(account, "ambiguous", operation, "signup_in_progress")
                handed_off = self._account_attention_handoff_locked(job, "ambiguous")
                self._clear_account_operation_locked(operation)
                return {
                    "authorized": False, "reasonCode": "ambiguous", "retryAllowed": False,
                    "attentionHandoff": True, "finalActionAuthorized": False,
                    "credentialProviderInvocations": 0,
                    "account": _late("ACCOUNTS_MODULE").public_account(ambiguous),
                    "job": {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]},
                }
            account = self._write_account_stage_locked(
                account, result["lifecycleState"], operation, "signup_in_progress"
            )
            attention = result["lifecycleState"] != "active"
            response = {
                "authorized": not attention, "reasonCode": result["lifecycleState"],
                "retryAllowed": False, "attentionHandoff": attention,
                "finalActionAuthorized": False, "emailRemoved": result["emailRemoved"],
                "termsAccepted": result["termsAccepted"], "nextActivations": result["nextActivations"],
                "credentialProviderInvocations": 0,
                "account": _late("ACCOUNTS_MODULE").public_account(account),
            }
            if attention:
                handed_off = self._account_attention_handoff_locked(job, result["lifecycleState"])
                response["job"] = {"id": handed_off["id"], "status": handed_off["status"], "revision": handed_off["revision"]}
            self._clear_account_operation_locked(operation)
            return response
