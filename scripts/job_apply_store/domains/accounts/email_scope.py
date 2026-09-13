"""Root-local email scope operations for Store composition."""

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
    'exclusive_file_lock': io.exclusive_file_lock,
    'urlsplit': urlsplit,
}


class EmailScopeMixin:
    """Plain mixin; persistent state belongs to StoreBase."""

    def _validate_live_email_only_stable_locked(
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
        ):
            raise StoreError("live email-only stable job binding drifted")
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
        if account["signupEmailOverride"] is None and settings["signupEmail"] is None:
            raise StoreError("effective signup email is required")
        return {"job": job, "realm": realm, "settings": settings, "account": account}


    def revalidate_live_email_only_stable_scope(
        self, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        """Recheck a claim-independent final scope without revealing values."""
        try:
            request = _late('CANARY_EXECUTOR_MODULE').validate_stable_live_request(incoming)
        except _late('CANARY_EXECUTOR_MODULE').LiveCanaryExecutorError as error:
            raise StoreError(str(error)) from None
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with _late('exclusive_file_lock')(self.store_lock_path):
            current = self._validate_live_email_only_stable_locked(request)
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


    def revalidate_live_email_only_preparation_scope(
        self, scope: dict[str, Any], portal_url: str, portal_name: str,
        realm_descriptor: str,
    ) -> dict[str, Any]:
        """Recheck stable canonical scope before any read-only page access."""
        try:
            exact = _late('CANARY_EXECUTOR_MODULE').CANARY.validate_preparation_scope(scope)
        except _late('CANARY_EXECUTOR_MODULE').CANARY.CanaryAuthorityError as error:
            raise StoreError(str(error)) from None
        try:
            portal = _late('urlsplit')(portal_url)
            port = portal.port
        except (TypeError, ValueError):
            raise StoreError("live email-only preparation portal binding drifted") from None
        if (
            not isinstance(portal_url, str) or not isinstance(portal_name, str)
            or portal.scheme != "https" or not portal.hostname
            or portal.username is not None or portal.password is not None
            or portal.query or portal.fragment or not portal.path.startswith("/")
            or (port is not None and port != 443)
            or self._trusted_fill_fingerprint(portal_url) != exact["portalFingerprint"]
            or self._trusted_fill_fingerprint(portal_name) != exact["portalNameFingerprint"]
        ):
            raise StoreError("live email-only preparation portal binding drifted")
        self.initialize()
        self._ensure_account_control_documents()
        self._ensure_coordinator_files()
        with _late('exclusive_file_lock')(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(exact["jobId"])
            if (
                job is None or job.get("deletedAt") is not None
                or job["url"] != portal_url
                or not (
                    (job["status"] == "in_progress" and job["revision"] == exact["jobRevision"])
                    or (job["status"] == "ready" and job["revision"] + 1 == exact["jobRevision"])
                )
            ):
                raise StoreError("live email-only preparation job binding drifted")
            realm = _late('ACCOUNTS_MODULE').normalize_realm(job["url"])
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(exact["realmRef"])
            if (
                realm.get("status") != "resolved" or realm.get("adapterId") != "oracle-recruiting"
                or realm.get("realmRef") != exact["realmRef"] or account is None
                or realm.get("descriptor") != realm_descriptor
                or account.get("descriptor") != realm.get("descriptor")
                or account.get("revision") != exact["accountRevision"]
                or settings.get("revision") != exact["settingsRevision"]
                or account.get("lifecycleState") != "discovered"
                or account.get("flowKind") != _late('ACCOUNTS_MODULE').FLOW_EMAIL_ONLY
                or account.get("credentialRequired") is not False
                or not settings.get("enabled") or not settings.get("automaticAccountCreation")
                or (account.get("signupEmailOverride") is None and settings.get("signupEmail") is None)
            ):
                raise StoreError("live email-only preparation canonical binding drifted")
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            return {
                "valid": True, "jobId": job["id"],
                "jobRevision": exact["jobRevision"], "finalActionAuthorized": False,
            }
