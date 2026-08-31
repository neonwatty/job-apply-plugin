#!/usr/bin/env python3
"""Private, durable, single-attempt authority for one T007 account canary.

Raw approval and capability values never enter the durable ledger. Only their
one-way digests are stored, and issuance plus approval consumption is one
locked atomic rewrite. Attempt consumption is likewise durably burned before
expiry or binding checks return, so drift, failure, or restart cannot retry.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import secrets
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Protocol

try:
    import fcntl
except ImportError:  # pragma: no cover - exercised by the Windows CI job
    fcntl = None
    import msvcrt


FINGERPRINT = re.compile(r"^sha256:[0-9a-f]{64}$")
REALM_REF = re.compile(r"^[0-9a-f]{64}$")
_LOCK_REGISTRY: dict[str, threading.Lock] = {}
_LOCK_REGISTRY_GUARD = threading.Lock()
_HELD_THREAD_LOCKS: dict[int, threading.Lock] = {}


class CanaryAuthorityError(ValueError):
    pass


class ExactT007ApprovalLedger(Protocol):
    def consume_preparation_approval(
        self, approval_ref: str, preparation_digest: str,
    ) -> bool: ...

    def consume_approval_and_issue(
        self, approval_ref: str, approval_scope_digest: str,
        execution_binding_digest: str, capability_digest: str, expires_at: datetime,
    ) -> bool: ...

    def consume_attempt(
        self, capability_ref: str, binding_digest: str, now: datetime,
    ) -> str: ...


def _positive(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def validate_binding(value: Any) -> dict[str, Any]:
    legacy_fields = {
        "jobId", "jobRevision", "claimId", "realmRef", "accountRevision",
        "settingsRevision", "portalFingerprint", "portalNameFingerprint",
        "accountCreationControlsFingerprint", "approvalRevision",
    }
    oracle_component_fields = {
        "accountFormFingerprint", "emailControlFingerprint",
        "termsControlFingerprint", "nextControlFingerprint",
        "passwordControlFingerprint", "createAccountControlFingerprint",
    }
    oracle_fields = legacy_fields | {
        "flowKind", "termsDocumentFingerprint", *oracle_component_fields,
    }
    if not isinstance(value, dict) or set(value) not in (legacy_fields, oracle_fields):
        raise CanaryAuthorityError("canary binding is invalid")
    if set(value) == oracle_fields:
        if value["flowKind"] != "email_only_candidate_profile":
            raise CanaryAuthorityError("canary flow binding is invalid")
        if not isinstance(value["termsDocumentFingerprint"], str) or FINGERPRINT.fullmatch(value["termsDocumentFingerprint"]) is None:
            raise CanaryAuthorityError("canary consent binding is invalid")
        for field in (
            "accountFormFingerprint", "emailControlFingerprint",
            "termsControlFingerprint", "nextControlFingerprint",
        ):
            if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
                raise CanaryAuthorityError("canary component binding is invalid")
        if value["passwordControlFingerprint"] is not None or value["createAccountControlFingerprint"] is not None:
            raise CanaryAuthorityError("canary credential controls are invalid")
        components = ":".join(value[field] for field in (
            "accountFormFingerprint", "emailControlFingerprint",
            "termsControlFingerprint", "termsDocumentFingerprint",
            "nextControlFingerprint",
        ))
        aggregate = "sha256:" + hashlib.sha256(components.encode("utf-8")).hexdigest()
        if aggregate != value["accountCreationControlsFingerprint"]:
            raise CanaryAuthorityError("canary aggregate control binding is invalid")
    if not isinstance(value["jobId"], str) or not value["jobId"]:
        raise CanaryAuthorityError("canary job binding is invalid")
    if not isinstance(value["claimId"], str) or re.fullmatch(
        r"[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}",
        value["claimId"],
    ) is None:
        raise CanaryAuthorityError("canary claim binding is invalid")
    if not isinstance(value["realmRef"], str) or REALM_REF.fullmatch(value["realmRef"]) is None:
        raise CanaryAuthorityError("canary realm binding is invalid")
    for field in ("portalFingerprint", "portalNameFingerprint", "accountCreationControlsFingerprint"):
        if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
            raise CanaryAuthorityError("canary portal binding is invalid")
    if not all(_positive(value[field]) for field in ("jobRevision", "accountRevision", "settingsRevision", "approvalRevision")):
        raise CanaryAuthorityError("canary revision binding is invalid")
    return dict(value)


def _without_claim(binding: dict[str, Any]) -> dict[str, Any]:
    exact = validate_binding(binding)
    return {key: item for key, item in exact.items() if key != "claimId"}


def validate_final_scope(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or "claimId" in value:
        raise CanaryAuthorityError("claim-independent final scope is invalid")
    # Reuse the closed execution validator with a syntactically valid sentinel,
    # then remove it. The sentinel is never persisted or accepted as execution.
    return _without_claim({**value, "claimId": "00000000-0000-4000-8000-000000000000"})


def validate_preparation_scope(value: Any) -> dict[str, Any]:
    fields = {
        "jobId", "jobRevision", "realmRef", "accountRevision",
        "settingsRevision", "portalFingerprint", "portalNameFingerprint",
        "approvalRevision",
    }
    if not isinstance(value, dict) or set(value) != fields:
        raise CanaryAuthorityError("claim-independent preparation scope is invalid")
    if not isinstance(value["jobId"], str) or not value["jobId"]:
        raise CanaryAuthorityError("canary job binding is invalid")
    if not isinstance(value["realmRef"], str) or REALM_REF.fullmatch(value["realmRef"]) is None:
        raise CanaryAuthorityError("canary realm binding is invalid")
    for field in ("portalFingerprint", "portalNameFingerprint"):
        if not isinstance(value[field], str) or FINGERPRINT.fullmatch(value[field]) is None:
            raise CanaryAuthorityError("canary portal binding is invalid")
    if not all(_positive(value[field]) for field in (
        "jobRevision", "accountRevision", "settingsRevision", "approvalRevision"
    )):
        raise CanaryAuthorityError("canary revision binding is invalid")
    return dict(value)


def preparation_scope(binding: dict[str, Any]) -> dict[str, Any]:
    source = validate_final_scope(binding) if "claimId" not in binding else _without_claim(binding)
    return validate_preparation_scope({
        key: source[key] for key in (
            "jobId", "jobRevision", "realmRef", "accountRevision",
            "settingsRevision", "portalFingerprint", "portalNameFingerprint",
            "approvalRevision",
        )
    })


def execution_binding(final_scope: dict[str, Any], claim_id: str) -> dict[str, Any]:
    return validate_binding({**validate_final_scope(final_scope), "claimId": claim_id})


def _domain_digest(domain: str, value: dict[str, Any]) -> str:
    canonical = json.dumps(value, sort_keys=True, separators=(",", ":"))
    payload = f"job-apply-account-canary:{domain}:v1\0{canonical}".encode("utf-8")
    return "sha256:" + hashlib.sha256(payload).hexdigest()


def preparation_digest(binding: dict[str, Any]) -> str:
    return _domain_digest("read-only-preparation", validate_preparation_scope(binding))


def final_scope_digest(binding: dict[str, Any]) -> str:
    return _domain_digest("final-owner-approval", validate_final_scope(binding))


def binding_digest(binding: dict[str, Any]) -> str:
    return _domain_digest("claim-bound-execution", validate_binding(binding))


def _private_digest(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.encode("ascii")).hexdigest()


class DurableT007ApprovalLedger:
    """Private hash-only authority ledger; deliberately separate from Store."""

    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.lock_path = self.path.with_suffix(self.path.suffix + ".lock")

    @staticmethod
    def _empty() -> dict[str, Any]:
        return {
            "schemaVersion": 2, "preparationApprovals": {},
            "finalApprovals": {}, "attempts": {},
        }

    def _read_locked(self) -> dict[str, Any]:
        if not self.path.exists():
            return self._empty()
        if self.path.is_symlink():
            raise CanaryAuthorityError("private approval ledger is invalid")
        try:
            value = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            raise CanaryAuthorityError("private approval ledger is invalid") from error
        if (
            isinstance(value, dict) and value.get("schemaVersion") == 1
            and set(value) == {"schemaVersion", "approvals", "attempts"}
            and isinstance(value.get("approvals"), dict)
            and isinstance(value.get("attempts"), dict)
        ):
            # Legacy approvals included a rotating claim. Fail closed by
            # importing every one as consumed; attempts remain burned.
            return {
                "schemaVersion": 2,
                "preparationApprovals": {},
                "finalApprovals": {
                    key: {"scopeDigest": item.get("bindingDigest"), "consumed": True}
                    for key, item in value["approvals"].items()
                    if isinstance(item, dict)
                },
                "attempts": value["attempts"],
            }
        expected = {"schemaVersion", "preparationApprovals", "finalApprovals", "attempts"}
        if not isinstance(value, dict) or set(value) != expected or value["schemaVersion"] != 2:
            raise CanaryAuthorityError("private approval ledger is invalid")
        if not all(isinstance(value[field], dict) for field in (
            "preparationApprovals", "finalApprovals", "attempts"
        )):
            raise CanaryAuthorityError("private approval ledger is invalid")
        return value

    def _write_locked(self, value: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_name(f".{self.path.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp")
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            payload = (json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n").encode()
            offset = 0
            while offset < len(payload):
                written = os.write(descriptor, payload[offset:])
                if written <= 0:
                    raise OSError("private approval ledger write made no progress")
                offset += written
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
        os.replace(temporary, self.path)
        try:
            directory = os.open(self.path.parent, os.O_RDONLY)
        except OSError:
            directory = None
        if directory is not None:
            try:
                os.fsync(directory)
            finally:
                os.close(directory)

    def _locked(self):
        self.lock_path.parent.mkdir(parents=True, exist_ok=True)
        lock_key = str(self.lock_path.resolve())
        with _LOCK_REGISTRY_GUARD:
            thread_lock = _LOCK_REGISTRY.setdefault(lock_key, threading.Lock())
        thread_lock.acquire()
        try:
            descriptor = os.open(self.lock_path, os.O_RDWR | os.O_CREAT, 0o600)
            _HELD_THREAD_LOCKS[descriptor] = thread_lock
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_EX)
            else:  # pragma: no cover - exercised by the Windows CI job
                if os.fstat(descriptor).st_size == 0:
                    os.write(descriptor, b"0")
                    os.fsync(descriptor)
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_LOCK, 1)
        except Exception:
            if "descriptor" in locals():
                _HELD_THREAD_LOCKS.pop(descriptor, None)
                os.close(descriptor)
            thread_lock.release()
            raise
        return descriptor

    @staticmethod
    def _unlock_close(descriptor: int) -> None:
        thread_lock = _HELD_THREAD_LOCKS.pop(descriptor)
        try:
            if fcntl is not None:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            else:  # pragma: no cover - exercised by the Windows CI job
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        finally:
            os.close(descriptor)
            thread_lock.release()

    def _record_approval(
        self, collection: str, approval_ref: str, digest: str, prefix: str,
    ) -> None:
        if not isinstance(approval_ref, str) or re.fullmatch(prefix + r"[0-9a-f]{64}", approval_ref) is None:
            raise CanaryAuthorityError("exact private canary approval is required")
        key = _private_digest(approval_ref)
        descriptor = self._locked()
        try:
            value = self._read_locked()
            if key in value[collection]:
                raise CanaryAuthorityError("exact private canary approval already exists")
            value[collection][key] = {"scopeDigest": digest, "consumed": False}
            self._write_locked(value)
        finally:
            self._unlock_close(descriptor)

    def record_preparation_approval(self, approval_ref: str, binding: dict[str, Any]) -> None:
        self._record_approval(
            "preparationApprovals", approval_ref,
            preparation_digest(validate_preparation_scope(binding)), r"preparation_",
        )

    def consume_preparation_approval(self, approval_ref: str, exact_digest: str) -> bool:
        key = _private_digest(approval_ref)
        descriptor = self._locked()
        try:
            value = self._read_locked()
            approval = value["preparationApprovals"].get(key)
            if not isinstance(approval, dict) or approval != {
                "scopeDigest": exact_digest, "consumed": False,
            }:
                return False
            approval["consumed"] = True
            self._write_locked(value)
            return True
        finally:
            self._unlock_close(descriptor)

    def record_exact_approval(self, approval_ref: str, binding: dict[str, Any]) -> None:
        if not isinstance(approval_ref, str) or re.fullmatch(r"approval_[0-9a-f]{64}", approval_ref) is None:
            raise CanaryAuthorityError("exact private T007 approval is required")
        scope = validate_final_scope(binding) if "claimId" not in binding else _without_claim(binding)
        self._record_approval(
            "finalApprovals", approval_ref, final_scope_digest(scope), r"approval_",
        )

    def consume_approval_and_issue(
        self, approval_ref: str, approval_scope_digest: str,
        execution_binding_digest: str, capability_digest: str, expires_at: datetime,
    ) -> bool:
        approval_key = _private_digest(approval_ref)
        descriptor = self._locked()
        try:
            value = self._read_locked()
            approval = value["finalApprovals"].get(approval_key)
            if not isinstance(approval, dict) or approval != {
                "scopeDigest": approval_scope_digest, "consumed": False,
            } or capability_digest in value["attempts"]:
                return False
            approval["consumed"] = True
            value["attempts"][capability_digest] = {
                "bindingDigest": execution_binding_digest,
                "expiresAt": expires_at.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "attempted": False,
            }
            self._write_locked(value)
            return True
        finally:
            self._unlock_close(descriptor)

    def consume_attempt(self, capability_ref: str, exact_binding_digest: str, now: datetime) -> str:
        capability_key = _private_digest(capability_ref)
        descriptor = self._locked()
        try:
            value = self._read_locked()
            attempt = value["attempts"].get(capability_key)
            if not isinstance(attempt, dict) or attempt.get("attempted") is not False:
                return "unavailable"
            attempt["attempted"] = True
            self._write_locked(value)
            if attempt.get("bindingDigest") != exact_binding_digest:
                return "binding_drift"
            try:
                expires = datetime.fromisoformat(attempt["expiresAt"].replace("Z", "+00:00"))
            except (KeyError, TypeError, ValueError):
                return "unavailable"
            return "authorized" if now.astimezone(timezone.utc) < expires else "expired"
        finally:
            self._unlock_close(descriptor)


class OneAttemptCanaryAuthority:
    def __init__(self, approval_ledger: ExactT007ApprovalLedger):
        self._ledger = approval_ledger

    def authorize_preparation(self, binding: dict[str, Any], approval_ref: str) -> dict[str, Any]:
        exact = validate_preparation_scope(binding)
        if not self._ledger.consume_preparation_approval(
            approval_ref, preparation_digest(exact)
        ):
            raise CanaryAuthorityError("exact private read-only preparation approval is required")
        return {
            "readOnlyPreparationAuthorized": True,
            "accountCreationAuthorized": False,
            "finalActionAuthorized": False,
        }

    def issue(self, binding: dict[str, Any], approval_ref: str, *, now: datetime, ttl_seconds: int = 300) -> dict[str, Any]:
        exact = validate_binding(binding)
        stable_digest = final_scope_digest(_without_claim(exact))
        digest = binding_digest(exact)
        if not isinstance(approval_ref, str) or not re.fullmatch(r"approval_[0-9a-f]{64}", approval_ref):
            raise CanaryAuthorityError("exact private T007 approval is required")
        if not isinstance(now, datetime) or now.tzinfo is None or not 1 <= ttl_seconds <= 300:
            raise CanaryAuthorityError("canary expiry is invalid")
        nonce = secrets.token_hex(32)
        capability_ref = "canary_" + nonce
        expires = now.astimezone(timezone.utc) + timedelta(seconds=ttl_seconds)
        if not self._ledger.consume_approval_and_issue(
            approval_ref, stable_digest, digest, _private_digest(capability_ref), expires,
        ):
            raise CanaryAuthorityError("exact private T007 approval is required")
        return {
            "capabilityRef": capability_ref,
            "bindingDigest": digest,
            "expiresAt": expires.isoformat().replace("+00:00", "Z"),
            "attemptsRemaining": 1,
            "accountCreationOnly": True,
            "flowKind": exact.get("flowKind", "password_candidate_account"),
            "finalActionAuthorized": False,
        }

    def attempt(self, capability_ref: str, current_binding: dict[str, Any], *, now: datetime) -> dict[str, Any]:
        if not isinstance(capability_ref, str) or not re.fullmatch(r"canary_[0-9a-f]{64}", capability_ref):
            raise CanaryAuthorityError("canary capability is invalid")
        if not isinstance(now, datetime) or now.tzinfo is None:
            raise CanaryAuthorityError("canary time is invalid")
        result = self._ledger.consume_attempt(capability_ref, binding_digest(current_binding), now)
        if result != "authorized":
            messages = {"expired": "canary capability expired", "binding_drift": "canary binding drifted"}
            raise CanaryAuthorityError(messages.get(result, "canary capability is unavailable"))
        return {
            "accountCreationAuthorized": True,
            "attemptsRemaining": 0,
            "finalActionAuthorized": False,
        }
