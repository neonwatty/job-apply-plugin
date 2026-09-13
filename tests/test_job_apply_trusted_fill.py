import importlib.util
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("trusted_fill_test", ROOT / "scripts" / "job_apply_trusted_fill.py")
TRUSTED = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(TRUSTED)


def fp(char):
    return "sha256:" + char * 64


class TrustedFillAuthorityTests(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.bindings = {
            "jobId": "job-one", "jobRevision": 2,
            "claimId": "11111111-1111-4111-8111-111111111111",
            "realmRef": "a" * 64,
            "urlFingerprint": fp("1"), "resumeId": "resume-one", "resumeRevision": 3,
            "resumeContentRevision": "content_" + "c" * 43,
            "profileRevision": 4, "vitalFactRevision": 4,
            "answerBindings": [{"answerRef": "question.abc", "questionRevision": 5, "answerRevision": 5}],
            "observedQuestionFingerprint": fp("2"), "observedControlFingerprint": fp("3"),
            "formFingerprint": fp("4"), "automationSettingsRevision": 2,
            "employerAccountRevision": None, "allowedOperations": ["fill_text", "select_option"],
        }
        with mock.patch.object(TRUSTED.secrets, "token_hex", return_value="a" * 32), mock.patch.object(TRUSTED.secrets, "token_urlsafe", return_value="b" * 43):
            self.approval = TRUSTED.create_approval(self.bindings, 30, 1, self.now)

    def observed(self, **changes):
        value = {
            "observedQuestionFingerprint": fp("2"), "observedControlFingerprint": fp("3"),
            "formFingerprint": fp("4"), "fieldOperations": ["fill_text"],
            "authenticationRequired": False, "consentRequired": False,
            "credentialFieldsPresent": False, "finalControlsPresent": False,
            "unseenQuestions": False, "unseenControls": False,
        }
        value.update(changes)
        return value

    def test_exact_value_free_packet_authorizes_non_final_operations_only(self):
        current = {**self.bindings, "policyRevision": TRUSTED.POLICY_REVISION}
        decision = TRUSTED.evaluate_approval(self.approval, current, self.observed(), self.now)
        self.assertEqual(decision["reasonCode"], "authorized_non_final_fields")
        self.assertTrue(decision["authorized"])
        self.assertFalse(decision["retryAllowed"])
        for forbidden in ("click", "navigate", "authenticate", "consent", "credential", "submit", "send", "apply"):
            with self.assertRaises(TRUSTED.TrustedFillError):
                TRUSTED.validate_operations([forbidden])
        for unverifiable in (3, "3", fp("8"), "content_short"):
            with self.assertRaisesRegex(TRUSTED.TrustedFillError, "unverifiable"):
                TRUSTED.validate_content_revision(unverifiable)

    def test_every_drift_and_human_boundary_denies_without_retry(self):
        current = {**self.bindings, "policyRevision": TRUSTED.POLICY_REVISION}
        cases = [
            ({**current, "jobRevision": 3}, self.observed(), "canonical_drift"),
            (current, self.observed(formFingerprint=fp("9")), "observed_drift"),
            (current, self.observed(unseenQuestions=True), "unseen_questions"),
            (current, self.observed(unseenControls=True), "unseen_controls"),
            (current, self.observed(authenticationRequired=True), "authentication_required"),
            (current, self.observed(consentRequired=True), "consent_required"),
            (current, self.observed(credentialFieldsPresent=True), "credential_fields_present"),
            (current, self.observed(finalControlsPresent=True), "final_controls_present"),
        ]
        for live, observed, reason in cases:
            decision = TRUSTED.evaluate_approval(self.approval, live, observed, self.now)
            self.assertEqual((decision["authorized"], decision["reasonCode"], decision["retryAllowed"]), (False, reason, False))
        expired = TRUSTED.evaluate_approval(self.approval, current, self.observed(), self.now + timedelta(minutes=31))
        self.assertEqual((expired["authorized"], expired["reasonCode"]), (False, "approval_expired"))

    def test_revoke_is_exact_revisioned_and_public_status_is_value_free(self):
        revoked = TRUSTED.revoke_approval(self.approval, 1, self.now + timedelta(minutes=1))
        self.assertEqual((revoked["status"], revoked["approvalRevision"]), ("revoked", 2))
        with self.assertRaisesRegex(TRUSTED.TrustedFillError, "revision conflict"):
            TRUSTED.revoke_approval(self.approval, 2, self.now)
        public = TRUSTED.public_status(self.approval, self.now)
        self.assertEqual(set(public), {"status", "jobId", "realmRef", "expiresAt", "approvalRevision", "allowedOperations"})


if __name__ == "__main__":
    unittest.main()
