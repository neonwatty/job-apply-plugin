"""Employer account registry and account-flow decisions."""

from __future__ import annotations

import copy
from typing import Any

from ...accounts_runtime import _optional_email, companion, validate_employer_account
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock, require_object


_CANONICAL_RUNTIME = {
    "ACCOUNTS_MODULE": companion("job_apply_accounts"),
    "StoreError": StoreError,
    "_optional_email": _optional_email,
    "_require_object": require_object,
    "_validate_employer_account_record": validate_employer_account,
    "atomic_write_json": atomic_write_json,
    "copy": copy,
    "exclusive_file_lock": exclusive_file_lock,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's live globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    return runtime[name] if name in runtime else _CANONICAL_RUNTIME[name]


class AccountRegistryMixin:
    """Employer account records operating on Store-supplied state."""

    def resolve_account_realm(self, portal_url: str) -> dict[str, Any]:
        return _late("ACCOUNTS_MODULE").normalize_realm(portal_url)

    def employer_account_flow_decision(self, job_id: str) -> dict[str, Any]:
        """Return a value-free account decision for one canonical job."""

        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise StoreError("employer account flow job is unavailable")
            classified = _late("ACCOUNTS_MODULE").classify_account_flow(job["url"])
            if classified.get("status") != "classified":
                return {
                    "jobId": job["id"],
                    "decision": "human_attention_required",
                    "adapterId": None,
                    "flowKind": None,
                    "accountRevision": None,
                    "reasonCode": "account_flow_unresolved",
                }
            base = {
                "jobId": job["id"],
                "adapterId": classified["adapterId"],
                "flowKind": classified["flowKind"],
            }
            if classified["accountRequired"] is False:
                return {
                    **base,
                    "decision": "account_not_required",
                    "accountRevision": None,
                }
            account = self._load_employer_accounts_document()["accounts"].get(
                classified["realmRef"]
            )
            if account is None:
                return {**base, "decision": "create_required", "accountRevision": None}
            lifecycle = account["lifecycleState"]
            settings = self._load_automation_settings_document()["settings"]
            if (
                classified["flowKind"] == _late("ACCOUNTS_MODULE").FLOW_PASSWORD
                and lifecycle == "discovered"
                and settings["passwordStrategy"] != "unique_per_realm"
            ):
                return {
                    **base,
                    "decision": "human_attention_required",
                    "accountRevision": account["revision"],
                    "reasonCode": "password_strategy_requires_human",
                }
            if lifecycle == "active":
                decision = "reuse_active"
            elif lifecycle == "discovered":
                decision = "create_required"
            else:
                return {
                    **base,
                    "decision": "human_attention_required",
                    "accountRevision": account["revision"],
                    "reasonCode": "account_lifecycle_requires_human",
                }
            return {
                **base,
                "decision": decision,
                "accountRevision": account["revision"],
            }

    def list_employer_accounts(self, *, public: bool = False, companion: bool = False) -> list[dict[str, Any]]:
        self.initialize()
        self._ensure_account_control_documents()
        accounts = list(self._load_employer_accounts_document()["accounts"].values())
        accounts.sort(key=lambda item: item["realmRef"])
        records = _late("copy").deepcopy(accounts)
        if companion:
            return [_late("ACCOUNTS_MODULE").public_account(item) for item in records]
        return [_late("ACCOUNTS_MODULE").public_account(item) for item in records] if public else records

    def get_employer_account(self, realm_ref: str, *, public: bool = False) -> dict[str, Any] | None:
        self.initialize()
        self._ensure_account_control_documents()
        record = self._load_employer_accounts_document()["accounts"].get(realm_ref)
        if record is None:
            return None
        result = _late("copy").deepcopy(record)
        return _late("ACCOUNTS_MODULE").public_account(result) if public else result

    def create_employer_account(
        self, portal_url: str, signup_email_override: str | None = None, *, public: bool = False
    ) -> dict[str, Any]:
        realm = self.resolve_account_realm(portal_url)
        if realm["status"] != "resolved":
            raise StoreError("employer account realm is unresolved")
        override = _late("_optional_email")(signup_email_override, "signup email override")
        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_employer_accounts_document()
            if realm["realmRef"] in document["accounts"]:
                raise StoreError("employer account already exists")
            now = self._now()
            record = {
                "realmRef": realm["realmRef"],
                "adapterId": realm["adapterId"],
                "descriptorVersion": realm["descriptorVersion"],
                "descriptor": realm["descriptor"],
                "flowKind": realm.get("flowKind", _late("ACCOUNTS_MODULE").FLOW_PASSWORD),
                "credentialRequired": realm.get("credentialRequired", True),
                "signupEmailOverride": override,
                "providerId": None,
                "credentialRef": None,
                "credentialVersion": None,
                "lifecycleState": "discovered",
                "revision": 1,
                "createdAt": now,
                "updatedAt": now,
            }
            _late("_validate_employer_account_record")(realm["realmRef"], record)
            document["accounts"][realm["realmRef"]] = record
            document["metadata"]["updatedAt"] = now
            _late("atomic_write_json")(self.employer_accounts_path, document)
        result = _late("copy").deepcopy(record)
        return _late("ACCOUNTS_MODULE").public_account(result) if public else result

    def update_employer_account(
        self, realm_ref: str, patch: dict[str, Any], expected_revision: int, *, public: bool = False
    ) -> dict[str, Any]:
        incoming = _late("_require_object")(patch, "employer account patch")
        if set(incoming) != {"signupEmailOverride"}:
            raise StoreError("employer account patch may only change signup email override")
        override = _late("_optional_email")(incoming["signupEmailOverride"], "signup email override")
        self.initialize()
        self._ensure_account_control_documents()
        with _late("exclusive_file_lock")(self.store_lock_path):
            document = self._load_employer_accounts_document()
            current = document["accounts"].get(realm_ref)
            if current is None:
                raise StoreError("employer account does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("employer account revision conflict")
            updated = dict(current)
            updated.update({
                "signupEmailOverride": override,
                "revision": current["revision"] + 1,
                "updatedAt": self._now(),
            })
            _late("_validate_employer_account_record")(realm_ref, updated)
            document["accounts"][realm_ref] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            _late("atomic_write_json")(self.employer_accounts_path, document)
        result = _late("copy").deepcopy(updated)
        return _late("ACCOUNTS_MODULE").public_account(result) if public else result
