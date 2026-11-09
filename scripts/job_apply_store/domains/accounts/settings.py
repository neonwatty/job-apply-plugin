"""Automation settings persistence and capability projection."""

from __future__ import annotations

import copy
import sys
from typing import Any

from ...accounts_runtime import (
    _optional_email,
    companion,
    validate_automation_settings,
    validate_employer_account,
)
from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock, read_json_object, require_object, validate_version


_CANONICAL_RUNTIME = {
    "ACCOUNTS_MODULE": companion("job_apply_accounts"),
    "ACCOUNT_EXECUTOR_MODULE": companion("job_apply_account_executor"),
    "ACCOUNT_FLOWS_MACOS_MODULE": companion("job_apply_account_flows_macos"),
    "CREDENTIALS_MACOS_MODULE": companion("job_apply_credentials_macos"),
    "SCHEMA_VERSION": SCHEMA_VERSION,
    "StoreError": StoreError,
    "_optional_email": _optional_email,
    "_require_object": require_object,
    "_validate_automation_settings_record": validate_automation_settings,
    "_validate_employer_account_record": validate_employer_account,
    "atomic_write_json": atomic_write_json,
    "copy": copy,
    "exclusive_file_lock": exclusive_file_lock,
    "read_json_object": read_json_object,
    "sys": sys,
    "validate_version": validate_version,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's live globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    return runtime[name] if name in runtime else _CANONICAL_RUNTIME[name]


class AccountSettingsMixin:
    """Account control documents operating on Store-supplied state."""

    def _load_automation_settings_document(self) -> dict[str, Any]:
        document = _late("read_json_object")(self.automation_settings_path, "automation settings")
        _late("validate_version")(document, "automation settings")
        if set(document) != {"schemaVersion", "settings"}:
            raise StoreError("automation settings document contains unsupported fields")
        _late("_validate_automation_settings_record")(document.get("settings"))
        return document

    def _load_employer_accounts_document(self) -> dict[str, Any]:
        document = _late("read_json_object")(self.employer_accounts_path, "employer accounts")
        _late("validate_version")(document, "employer accounts")
        if set(document) != {"schemaVersion", "accounts", "metadata"}:
            raise StoreError("employer accounts document contains unsupported fields")
        accounts = _late("_require_object")(document.get("accounts"), "employer accounts")
        metadata = _late("_require_object")(document.get("metadata"), "employer account metadata")
        if set(metadata) != {"createdAt", "updatedAt"}:
            raise StoreError("employer account metadata is invalid")
        for field in ("createdAt", "updatedAt"):
            if not isinstance(metadata[field], str) or not metadata[field]:
                raise StoreError("employer account metadata timestamp is invalid")
        for key, record in accounts.items():
            _late("_validate_employer_account_record")(key, record)
        return document

    def _load_account_operation_journal(self) -> dict[str, Any]:
        document = _late("read_json_object")(self.account_operation_journal_path, "account operation journal")
        _late("validate_version")(document, "account operation journal")
        if set(document) != {"schemaVersion", "operation"}:
            raise StoreError("account operation journal contains unsupported fields")
        operation = document["operation"]
        if operation is None:
            return document
        expected = {
            "operationId", "jobId", "jobRevision", "claimId", "realmRef",
            "accountRevision", "settingsRevision", "stage", "outcomeCode", "startedAt",
        }
        if not isinstance(operation, dict) or set(operation) != expected:
            raise StoreError("account operation journal is invalid")
        for field in ("operationId", "jobId", "claimId", "realmRef", "stage", "outcomeCode", "startedAt"):
            if not isinstance(operation[field], str) or not operation[field]:
                raise StoreError("account operation journal binding is invalid")
        for field in ("jobRevision", "accountRevision", "settingsRevision"):
            if not isinstance(operation[field], int) or isinstance(operation[field], bool) or operation[field] < 1:
                raise StoreError("account operation journal revision is invalid")
        if operation["stage"] not in {"prepared", "credential_provisioned", "signup_in_progress"}:
            raise StoreError("account operation journal stage is invalid")
        if operation["outcomeCode"] not in {*_late("ACCOUNT_EXECUTOR_MODULE").OUTCOMES, "observed_pending"}:
            raise StoreError("account operation journal outcome is invalid")
        return document

    def _ensure_account_control_documents(self) -> None:
        with _late("exclusive_file_lock")(self.store_lock_path):
            if not self.automation_settings_path.exists():
                now = self._now()
                _late("atomic_write_json")(
                    self.automation_settings_path,
                    {
                        "schemaVersion": _late("SCHEMA_VERSION"),
                        "settings": {
                            "enabled": False,
                            "automaticAccountCreation": False,
                            "signupEmail": None,
                            "passwordStrategy": "unique_per_realm",
                            "revision": 1,
                            "createdAt": now,
                            "updatedAt": now,
                        },
                    },
                )
            if not self.employer_accounts_path.exists():
                now = self._now()
                _late("atomic_write_json")(
                    self.employer_accounts_path,
                    {
                        "schemaVersion": _late("SCHEMA_VERSION"),
                        "accounts": {},
                        "metadata": {"createdAt": now, "updatedAt": now},
                    },
                )
            if not self.account_operation_journal_path.exists():
                _late("atomic_write_json")(
                    self.account_operation_journal_path,
                    {"schemaVersion": _late("SCHEMA_VERSION"), "operation": None},
                )

    def get_automation_settings(self, *, public: bool = False, companion: bool = False) -> dict[str, Any]:
        self.initialize()
        self._ensure_account_control_documents()
        record = _late("copy").deepcopy(self._load_automation_settings_document()["settings"])
        if companion:
            return _late("ACCOUNTS_MODULE").companion_settings(record)
        return _late("ACCOUNTS_MODULE").public_settings(record) if public else record

    def update_automation_settings(
        self, patch: dict[str, Any], expected_revision: int, *, public: bool = False
    ) -> dict[str, Any]:
        incoming = _late("_require_object")(patch, "automation settings patch")
        allowed = {"enabled", "automaticAccountCreation", "signupEmail", "passwordStrategy"}
        if not incoming or set(incoming) - allowed:
            raise StoreError("automation settings patch contains unsupported fields")
        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_automation_settings_document()
            current = document["settings"]
            if current["revision"] != expected_revision:
                raise StoreError("automation settings revision conflict")
            updated = dict(current)
            updated.update(incoming)
            if "signupEmail" in incoming:
                updated["signupEmail"] = _late("_optional_email")(incoming["signupEmail"], "signup email")
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = self._now()
            _late("_validate_automation_settings_record")(updated)
            _late("atomic_write_json")(
                self.automation_settings_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "settings": updated},
            )
        result = _late("copy").deepcopy(updated)
        return _late("ACCOUNTS_MODULE").public_settings(result) if public else result

    def copy_profile_email_to_automation_settings(
        self, expected_profile_revision: int, expected_settings_revision: int,
        *, public: bool = True,
    ) -> dict[str, Any]:
        """Copy the canonical profile email internally without returning it."""

        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            profile_document = self._load_profile_document()
            settings_document = self._load_automation_settings_document()
            if profile_document["metadata"].get("revision", 1) != expected_profile_revision:
                raise StoreError("profile revision conflict")
            current = settings_document["settings"]
            if current["revision"] != expected_settings_revision:
                raise StoreError("automation settings revision conflict")
            email = _late("_optional_email")(profile_document["profile"].get("email"), "profile email")
            if email is None:
                raise StoreError("canonical profile email is unavailable")
            updated = {
                **current, "signupEmail": email,
                "revision": current["revision"] + 1, "updatedAt": self._now(),
            }
            _late("_validate_automation_settings_record")(updated)
            _late("atomic_write_json")(
                self.automation_settings_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "settings": updated},
            )
        # The copied identity never crosses the method boundary.
        return _late("ACCOUNTS_MODULE").public_settings(updated) if public else {"copied": True, "revision": updated["revision"]}

    def automation_capability(self, platform: str | None = None) -> dict[str, Any]:
        credential = _late("ACCOUNTS_MODULE").discover_capability(
            platform or _late("sys").platform, _late("CREDENTIALS_MACOS_MODULE").ADAPTER_REGISTRY
        )
        account_flow = _late("ACCOUNTS_MODULE").discover_account_flow_capability(
            platform or _late("sys").platform, _late("ACCOUNT_FLOWS_MACOS_MODULE").ADAPTER_REGISTRY
        )
        return {**credential, "accountFlowAutomation": account_flow}
