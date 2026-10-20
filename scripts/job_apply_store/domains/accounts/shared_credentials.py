"""Journaled shared-credential binding and per-account upgrades."""

from __future__ import annotations

import copy
import uuid
from typing import Any

from ...accounts_runtime import companion, validate_employer_account
from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock


UPGRADE_OUTCOMES = {
    "updated": "active",
    "email_verification_required": "verification_required",
    "captcha_required": "verification_required",
    "mfa_required": "verification_required",
    "password_reset_required": "reset_required",
    "failed_definitive": "failed_definitive",
    "ambiguous": "ambiguous",
}

_CANONICAL_RUNTIME = {
    "ACCOUNTS_MODULE": companion("job_apply_accounts"),
    "CREDENTIALS_MODULE": companion("job_apply_credentials"),
    "SCHEMA_VERSION": SCHEMA_VERSION,
    "StoreError": StoreError,
    "_validate_employer_account_record": validate_employer_account,
    "atomic_write_json": atomic_write_json,
    "copy": copy,
    "exclusive_file_lock": exclusive_file_lock,
    "uuid": uuid,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    return runtime[name] if name in runtime else _CANONICAL_RUNTIME[name]


def _positive_version(value: Any, label: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 1:
        raise StoreError(f"{label} must be a positive integer")
    return value


class SharedCredentialMixin:
    """Store-only state machine; it never creates, reads, or resets a secret."""

    def _shared_reference(self, realm_ref: str, version: int) -> str:
        return _late("CREDENTIALS_MODULE").credential_reference(
            "shared", realm_ref, version
        )

    def _write_shared_account_locked(
        self, account: dict[str, Any], *, version: int | None = None,
        lifecycle: str,
    ) -> dict[str, Any]:
        document = self._load_employer_accounts_document()
        current = document["accounts"].get(account["realmRef"])
        if current is None or current["revision"] != account["revision"]:
            raise StoreError("employer account revision conflict")
        updated = dict(current)
        updated.update({
            "lifecycleState": lifecycle,
            "revision": current["revision"] + 1,
            "updatedAt": self._now(),
        })
        if version is not None:
            updated.update({
                "providerId": "macos-keychain",
                "credentialRef": self._shared_reference(account["realmRef"], version),
                "credentialVersion": version,
            })
        _late("_validate_employer_account_record")(updated["realmRef"], updated)
        document["accounts"][updated["realmRef"]] = updated
        document["metadata"]["updatedAt"] = updated["updatedAt"]
        _late("atomic_write_json")(self.employer_accounts_path, document)
        return updated

    def bind_shared_credential_version(
        self, realm_ref: str, credential_version: int, expected_revision: int,
        *, owner_confirmed: bool = False, public: bool = False,
    ) -> dict[str, Any]:
        """Pin one discovered account to an owner-created shared slot."""

        target = _positive_version(credential_version, "shared credential version")
        if owner_confirmed is not True:
            raise StoreError("shared credential binding requires owner confirmation")
        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            settings = self._load_automation_settings_document()["settings"]
            account = self._load_employer_accounts_document()["accounts"].get(realm_ref)
            if account is None:
                raise StoreError("employer account does not exist")
            if account["revision"] != expected_revision:
                raise StoreError("employer account revision conflict")
            if settings["passwordStrategy"] != "shared":
                raise StoreError("shared credential binding requires shared strategy")
            if (
                account.get("flowKind") != _late("ACCOUNTS_MODULE").FLOW_PASSWORD
                or account["lifecycleState"] != "discovered"
                or account["providerId"] is not None
                or account["credentialRef"] is not None
                or account["credentialVersion"] is not None
            ):
                raise StoreError("employer account cannot accept a shared credential binding")
            operation = {
                "kind": "shared_credential_binding",
                "operationId": str(_late("uuid").uuid4()),
                "realmRef": realm_ref, "accountRevision": account["revision"],
                "targetCredentialVersion": target, "stage": "binding_in_progress",
                "outcomeCode": "observed_pending", "startedAt": self._now(),
            }
            _late("atomic_write_json")(
                self.account_operation_journal_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation},
            )
            updated = self._write_shared_account_locked(
                account, version=target, lifecycle="credential_provisioned"
            )
            self._clear_account_operation_locked(operation)
        projected = _late("ACCOUNTS_MODULE").public_account(updated) if public else _late("copy").deepcopy(updated)
        return {
            "status": "bound", "credentialVersion": target,
            "finalActionAuthorized": False, "account": projected,
        }

    def begin_shared_credential_upgrade(
        self, realm_ref: str, target_version: int, expected_revision: int,
        *, owner_confirmed: bool = False,
    ) -> dict[str, Any]:
        """Burn a journal entry before an owner performs an external reset."""

        target = _positive_version(target_version, "target credential version")
        if owner_confirmed is not True:
            raise StoreError("shared credential upgrade requires owner confirmation")
        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            if self._load_account_operation_journal()["operation"] is not None:
                raise StoreError("account operation requires explicit recovery")
            account = self._load_employer_accounts_document()["accounts"].get(realm_ref)
            if account is None:
                raise StoreError("employer account does not exist")
            if account["revision"] != expected_revision:
                raise StoreError("employer account revision conflict")
            source = account.get("credentialVersion")
            if (
                account.get("flowKind") != _late("ACCOUNTS_MODULE").FLOW_PASSWORD
                or account["lifecycleState"] != "active"
                or account["providerId"] != "macos-keychain"
                or not isinstance(source, int) or isinstance(source, bool)
                or account["credentialRef"] != self._shared_reference(realm_ref, source)
                or target <= source
            ):
                raise StoreError("employer account cannot upgrade its shared credential")
            operation = {
                "kind": "shared_credential_upgrade",
                "operationId": str(_late("uuid").uuid4()),
                "realmRef": realm_ref, "accountRevision": account["revision"],
                "sourceCredentialVersion": source,
                "targetCredentialVersion": target, "stage": "reset_in_progress",
                "outcomeCode": "observed_pending", "startedAt": self._now(),
            }
            _late("atomic_write_json")(
                self.account_operation_journal_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation},
            )
            return self._public_shared_operation(operation)

    def complete_shared_credential_upgrade(
        self, operation_id: str, outcome: str, *, owner_confirmed: bool = False,
        public: bool = False,
    ) -> dict[str, Any]:
        """Record one owner-observed reset outcome and update only on success."""

        if owner_confirmed is not True:
            raise StoreError("shared credential upgrade completion requires owner confirmation")
        if outcome not in UPGRADE_OUTCOMES:
            raise StoreError("shared credential upgrade outcome is invalid")
        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            operation = self._load_account_operation_journal()["operation"]
            if (
                operation is None
                or operation.get("kind") != "shared_credential_upgrade"
                or operation["operationId"] != operation_id
            ):
                raise StoreError("shared credential upgrade operation is unavailable")
            account = self._load_employer_accounts_document()["accounts"].get(
                operation["realmRef"]
            )
            source = operation["sourceCredentialVersion"]
            if (
                account is None or account["revision"] != operation["accountRevision"]
                or account["providerId"] != "macos-keychain"
                or account["credentialVersion"] != source
                or account["credentialRef"] != self._shared_reference(account["realmRef"], source)
                or account["lifecycleState"] != "active"
            ):
                raise StoreError("shared credential upgrade binding drifted")
            operation = {
                **operation, "stage": "outcome_recorded", "outcomeCode": outcome,
            }
            _late("atomic_write_json")(
                self.account_operation_journal_path,
                {"schemaVersion": _late("SCHEMA_VERSION"), "operation": operation},
            )
            version = operation["targetCredentialVersion"] if outcome == "updated" else None
            updated = self._write_shared_account_locked(
                account, version=version, lifecycle=UPGRADE_OUTCOMES[outcome]
            )
            self._clear_account_operation_locked(operation)
        projected = _late("ACCOUNTS_MODULE").public_account(updated) if public else _late("copy").deepcopy(updated)
        return {
            "status": outcome, "bindingUpdated": outcome == "updated",
            "credentialVersion": updated["credentialVersion"],
            "retryAllowed": False, "finalActionAuthorized": False,
            "account": projected,
        }

    @staticmethod
    def _public_shared_operation(operation: dict[str, Any]) -> dict[str, Any]:
        return {
            "kind": operation["kind"], "operationId": operation["operationId"],
            "realmRef": operation["realmRef"], "stage": operation["stage"],
            "outcomeCode": operation["outcomeCode"],
            "sourceCredentialVersion": operation.get("sourceCredentialVersion"),
            "targetCredentialVersion": operation["targetCredentialVersion"],
        }

    def _recover_shared_credential_operation_locked(
        self, operation: dict[str, Any]
    ) -> dict[str, Any]:
        account = self._load_employer_accounts_document()["accounts"].get(
            operation["realmRef"]
        )
        if account is None:
            raise StoreError("account operation realm is unavailable")
        if operation["kind"] == "shared_credential_binding":
            target = operation["targetCredentialVersion"]
            applied = (
                account["revision"] == operation["accountRevision"] + 1
                and account["credentialVersion"] == target
                and account["credentialRef"] == self._shared_reference(account["realmRef"], target)
                and account["lifecycleState"] == "credential_provisioned"
            )
            if not applied and account["revision"] != operation["accountRevision"]:
                raise StoreError("shared credential binding recovery drifted")
            self._clear_account_operation_locked(operation)
            return {"status": "bound" if applied else "cancelled", "recovered": True}
        outcome = operation["outcomeCode"]
        if outcome == "observed_pending":
            if account["revision"] != operation["accountRevision"]:
                raise StoreError("shared credential upgrade recovery drifted")
            outcome = "ambiguous"
        version = operation["targetCredentialVersion"] if outcome == "updated" else None
        expected_version = version or operation["sourceCredentialVersion"]
        expected_ref = self._shared_reference(account["realmRef"], expected_version)
        expected_lifecycle = UPGRADE_OUTCOMES[outcome]
        if account["revision"] == operation["accountRevision"]:
            if (
                account["credentialVersion"] != operation["sourceCredentialVersion"]
                or account["credentialRef"] != self._shared_reference(
                    account["realmRef"], operation["sourceCredentialVersion"]
                )
                or account["lifecycleState"] != "active"
            ):
                raise StoreError("shared credential upgrade recovery drifted")
            updated = self._write_shared_account_locked(
                account, version=version, lifecycle=expected_lifecycle
            )
        elif (
            account["revision"] == operation["accountRevision"] + 1
            and account["credentialVersion"] == expected_version
            and account["credentialRef"] == expected_ref
            and account["lifecycleState"] == expected_lifecycle
        ):
            updated = account
        else:
            raise StoreError("shared credential upgrade recovery drifted")
        self._clear_account_operation_locked(operation)
        return {
            "status": outcome, "recovered": True, "retryAllowed": False,
            "bindingUpdated": outcome == "updated",
            "credentialVersion": updated["credentialVersion"],
            "account": _late("ACCOUNTS_MODULE").public_account(updated),
        }
