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

    def test_workday_binding_includes_flow_and_exact_password_controls(self):
        controls = {
            "accountFormFingerprint": "sha256:" + "1" * 64,
            "emailControlFingerprint": "sha256:" + "2" * 64,
            "passwordControlFingerprint": "sha256:" + "3" * 64,
            "createAccountControlFingerprint": "sha256:" + "4" * 64,
        }
        aggregate = "sha256:" + hashlib.sha256(
            ":".join(controls.values()).encode()
        ).hexdigest()
        binding = {
            **self.binding(), **controls,
            "flowKind": "password_candidate_account",
            "accountCreationControlsFingerprint": aggregate,
        }
        self.assertEqual(
            CANARY.validate_binding(binding)["flowKind"],
            "password_candidate_account",
        )
        preparation = CANARY.preparation_scope(CANARY._without_claim(binding))
        self.assertEqual(preparation["flowKind"], "password_candidate_account")
        with self.assertRaises(CANARY.CanaryAuthorityError):
            CANARY.validate_binding({**binding, "passwordControlFingerprint": "changed"})
        with self.assertRaises(CANARY.CanaryAuthorityError):
            CANARY.validate_binding({**binding, "accountCreationControlsFingerprint": "sha256:" + "9" * 64})

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
            self.assertEqual(len(persisted["finalApprovals"]), 1)

    def test_claim_rotation_changes_the_exact_canary_binding(self):
        rotated = {
            **self.binding(),
            "claimId": "22222222-2222-4222-8222-222222222222",
        }
        self.assertNotEqual(
            CANARY.binding_digest(self.binding()),
            CANARY.binding_digest(rotated),
        )
        self.assertEqual(
            CANARY.final_scope_digest(CANARY._without_claim(self.binding())),
            CANARY.final_scope_digest(CANARY._without_claim(rotated)),
        )

    def test_preparation_and_final_approvals_are_domain_separated_one_shots(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ledger.json"
            ledger = CANARY.DurableT007ApprovalLedger(path)
            authority = CANARY.OneAttemptCanaryAuthority(ledger)
            stable = CANARY._without_claim(self.binding())
            prepare = CANARY.preparation_scope(stable)
            preparation_ref = "preparation_" + "1" * 64
            final_ref = "approval_" + "2" * 64
            ledger.record_preparation_approval(preparation_ref, prepare)
            ledger.record_exact_approval(final_ref, stable)
            self.assertNotEqual(
                CANARY.preparation_digest(prepare), CANARY.final_scope_digest(stable)
            )
            prepared = authority.authorize_preparation(prepare, preparation_ref)
            self.assertTrue(prepared["readOnlyPreparationAuthorized"])
            self.assertFalse(prepared["accountCreationAuthorized"])
            with self.assertRaises(CANARY.CanaryAuthorityError):
                authority.authorize_preparation(prepare, preparation_ref)

            rotated = CANARY.execution_binding(
                stable, "22222222-2222-4222-8222-222222222222"
            )
            capability = authority.issue(
                rotated, final_ref, now=datetime(2026, 8, 29, tzinfo=timezone.utc)
            )
            self.assertFalse(capability["finalActionAuthorized"])
            self.assertTrue(authority.attempt(
                capability["capabilityRef"], rotated,
                now=datetime(2026, 8, 29, tzinfo=timezone.utc),
            )["accountCreationAuthorized"])

    def test_legacy_claim_bound_approval_migrates_consumed_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "private-ledger.json"
            approval = "approval_" + "3" * 64
            path.write_text(json.dumps({
                "schemaVersion": 1,
                "approvals": {CANARY._private_digest(approval): {
                    "bindingDigest": "sha256:" + "4" * 64, "consumed": False,
                }},
                "attempts": {},
            }), encoding="utf-8")
            ledger = CANARY.DurableT007ApprovalLedger(path)
            with self.assertRaises(CANARY.CanaryAuthorityError):
                CANARY.OneAttemptCanaryAuthority(ledger).issue(
                    self.binding(), approval,
                    now=datetime(2026, 8, 29, tzinfo=timezone.utc),
                )
