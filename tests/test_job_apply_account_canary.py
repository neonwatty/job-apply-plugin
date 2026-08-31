import importlib.util
import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("account_canary_test", ROOT / "scripts" / "job_apply_account_canary.py")
CANARY = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(CANARY)


class AccountCanaryAuthorityTests(unittest.TestCase):
    def binding(self):
        return {"jobId": "job-one", "jobRevision": 4,
                "claimId": "11111111-1111-4111-8111-111111111111",
                "realmRef": "a" * 64,
                "accountRevision": 3, "settingsRevision": 2,
                "portalFingerprint": "sha256:" + "b" * 64,
                "portalNameFingerprint": "sha256:" + "c" * 64,
                "accountCreationControlsFingerprint": "sha256:" + "d" * 64,
                "approvalRevision": 1}

    def test_email_only_binding_includes_flow_and_exact_terms_identity(self):
        component_values = {
            "accountFormFingerprint": "sha256:" + "1" * 64,
            "emailControlFingerprint": "sha256:" + "2" * 64,
            "termsControlFingerprint": "sha256:" + "3" * 64,
            "termsDocumentFingerprint": "sha256:" + "9" * 64,
            "nextControlFingerprint": "sha256:" + "4" * 64,
        }
        aggregate = "sha256:" + hashlib.sha256(":".join(component_values.values()).encode()).hexdigest()
        binding = {
            **self.binding(), **component_values,
            "accountCreationControlsFingerprint": aggregate,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
            "flowKind": "email_only_candidate_profile",
        }
        self.assertEqual(CANARY.validate_binding(binding)["flowKind"], "email_only_candidate_profile")
        with self.assertRaises(CANARY.CanaryAuthorityError):
            CANARY.validate_binding({**binding, "termsDocumentFingerprint": "changed"})

    def test_unavailable_before_exact_t007_approval_and_never_final(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ledger.json"
            ledger = CANARY.DurableT007ApprovalLedger(path); authority = CANARY.OneAttemptCanaryAuthority(ledger)
            approval = "approval_" + "c" * 64
            now = datetime(2026, 8, 29, tzinfo=timezone.utc)
            with self.assertRaises(CANARY.CanaryAuthorityError): authority.issue(self.binding(), approval, now=now)
            ledger.record_exact_approval(approval, self.binding())
            capability = authority.issue(self.binding(), approval, now=now)
            self.assertFalse(capability["finalActionAuthorized"])
            persisted = path.read_text(encoding="utf-8")
            self.assertNotIn(approval, persisted); self.assertNotIn(capability["capabilityRef"], persisted)
            restarted = CANARY.OneAttemptCanaryAuthority(CANARY.DurableT007ApprovalLedger(path))
            result = restarted.attempt(capability["capabilityRef"], self.binding(), now=now)
            self.assertEqual(result, {"accountCreationAuthorized": True, "attemptsRemaining": 0, "finalActionAuthorized": False})
            with self.assertRaises(CANARY.CanaryAuthorityError): authority.attempt(capability["capabilityRef"], self.binding(), now=now)
            with self.assertRaises(CANARY.CanaryAuthorityError): authority.issue(self.binding(), approval, now=now)

    def test_drift_expiry_and_first_failed_attempt_burn_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ledger.json"
            ledger = CANARY.DurableT007ApprovalLedger(path); authority = CANARY.OneAttemptCanaryAuthority(ledger)
            now = datetime.now(timezone.utc)
            first = "approval_" + "d" * 64
            ledger.record_exact_approval(first, self.binding())
            drifted = authority.issue(self.binding(), first, now=now)
            with self.assertRaises(CANARY.CanaryAuthorityError):
                authority.attempt(drifted["capabilityRef"], {**self.binding(), "jobRevision": 5}, now=now)
            with self.assertRaises(CANARY.CanaryAuthorityError): authority.attempt(drifted["capabilityRef"], self.binding(), now=now)
            second = "approval_" + "e" * 64
            ledger.record_exact_approval(second, self.binding())
            expired = authority.issue(self.binding(), second, now=now, ttl_seconds=1)
            with self.assertRaises(CANARY.CanaryAuthorityError):
                authority.attempt(expired["capabilityRef"], self.binding(), now=now + timedelta(seconds=1))
            with self.assertRaises(CANARY.CanaryAuthorityError):
                authority.attempt(expired["capabilityRef"], self.binding(), now=now)

    def test_concurrent_issue_consumes_one_approval_atomically(self):
        from concurrent.futures import ThreadPoolExecutor
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ledger.json"
            ledger = CANARY.DurableT007ApprovalLedger(path)
            approval = "approval_" + "f" * 64; ledger.record_exact_approval(approval, self.binding())
            now = datetime.now(timezone.utc)
            def issue():
                try:
                    return CANARY.OneAttemptCanaryAuthority(CANARY.DurableT007ApprovalLedger(path)).issue(self.binding(), approval, now=now)
                except CANARY.CanaryAuthorityError:
                    return None
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(lambda _: issue(), range(16)))
            self.assertEqual(sum(item is not None for item in results), 1)
            state = json.loads(path.read_text())
            self.assertEqual(len(state["attempts"]), 1)

    def test_short_ledger_writes_are_completed_before_atomic_replace(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ledger.json"
            ledger = CANARY.DurableT007ApprovalLedger(path)
            real_write = CANARY.os.write

            def short_write(descriptor, payload):
                size = max(1, len(payload) // 2)
                return real_write(descriptor, payload[:size])

            with mock.patch.object(CANARY.os, "write", side_effect=short_write):
                ledger.record_exact_approval("approval_" + "a" * 64, self.binding())
            persisted = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(len(persisted["approvals"]), 1)

    def test_claim_rotation_changes_the_exact_canary_binding(self):
        rotated = {
            **self.binding(),
            "claimId": "22222222-2222-4222-8222-222222222222",
        }
        self.assertNotEqual(
            CANARY.binding_digest(self.binding()),
            CANARY.binding_digest(rotated),
        )
