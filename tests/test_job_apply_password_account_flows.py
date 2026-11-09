import hashlib
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "job_apply_password_account_flows_test",
    ROOT / "scripts" / "job_apply_password_account_flows.py",
)
FLOWS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(FLOWS)


def fp(character):
    return "sha256:" + character * 64


class PasswordAccountFlowTests(unittest.TestCase):
    def setUp(self):
        self.url = "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_R1"
        self.descriptor = "workday:v1:wd5:acme"
        self.realm = hashlib.sha256(self.descriptor.encode()).hexdigest()
        self.preparation = {
            "jobId": "job-workday", "jobRevision": 4,
            "realmRef": self.realm, "realmDescriptor": self.descriptor,
            "accountRevision": 2, "settingsRevision": 3,
            "portalUrl": self.url,
        }
        self.controls = {
            "accountFormFingerprint": fp("a"),
            "emailControlFingerprint": fp("b"),
            "passwordControlFingerprint": fp("c"),
            "createAccountControlFingerprint": fp("d"),
        }
        self.aggregate = "sha256:" + hashlib.sha256(
            ":".join(self.controls.values()).encode()
        ).hexdigest()
        self.execution = {
            **self.preparation,
            "expectedClaimId": "claim-workday",
            "strategy": "unique_per_realm",
            **self.controls,
            "accountCreationControlsFingerprint": self.aggregate,
        }

    def test_prepare_accepts_only_value_free_exact_workday_attestation(self):
        class Provider:
            provider_id = "macos-workday-account"

            def prepare(inner, request):
                self.assertEqual(request, self.preparation)
                return {
                    "providerId": inner.provider_id,
                    **self.controls,
                    "accountCreationControlsFingerprint": self.aggregate,
                    "readOnly": True,
                    "effectCount": 0,
                }

        actual = FLOWS.prepare_password_account(self.preparation, Provider())
        self.assertEqual(actual["providerId"], "macos-workday-account")
        self.assertTrue(actual["readOnly"])
        self.assertEqual(actual["effectCount"], 0)
        self.assertNotIn("owner@example.com", str(actual))
        self.assertNotIn("forbidden-secret", str(actual))

    def test_requests_reject_unproven_portals_strategies_and_final_actions(self):
        invalid_preparations = (
            {**self.preparation, "portalUrl": self.url + "?token=secret"},
            {**self.preparation, "portalUrl": "http://acme.wd5.myworkdayjobs.com/jobs/1"},
            {**self.preparation, "realmRef": "f" * 64},
            {**self.preparation, "realmDescriptor": "workday:v1:wd5:other"},
            {**self.preparation, "extra": True},
        )
        for value in invalid_preparations:
            with self.subTest(value=value), self.assertRaises(FLOWS.PasswordAccountFlowError):
                FLOWS.validate_password_preparation_request(value)
        for strategy in ("shared", "custom", "ask_each_time"):
            with self.subTest(strategy=strategy), self.assertRaisesRegex(
                FLOWS.PasswordAccountFlowError, "unique-per-realm"
            ):
                FLOWS.validate_password_execution_request({**self.execution, "strategy": strategy})
        with self.assertRaises(FLOWS.PasswordAccountFlowError):
            FLOWS.validate_password_execution_request({**self.execution, "finalAction": "submit_application"})

    def test_execute_maps_closed_outcomes_and_returns_no_secret(self):
        lifecycle = {
            "active": "active",
            "email_verification_required": "verification_required",
            "captcha_required": "verification_required",
            "mfa_required": "verification_required",
            "password_reset_required": "reset_required",
            "failed_definitive": "failed_definitive",
            "ambiguous": "ambiguous",
        }
        for outcome, expected_lifecycle in lifecycle.items():
            with self.subTest(outcome=outcome):
                class Provider:
                    provider_id = "macos-workday-account"

                    def execute(inner, request, private_email):
                        self.assertEqual(request, self.execution)
                        self.assertEqual(private_email(), "owner@example.com")
                        return {
                            "providerId": inner.provider_id,
                            "credentialProviderId": "macos-keychain",
                            "credentialRef": "credential_" + "e" * 64,
                            "credentialVersion": 1,
                            "reused": False,
                            "outcome": outcome,
                            "retryAllowed": False,
                            "finalActionAuthorized": False,
                            "createAccountActivations": 1,
                            "emailControlRemoved": True,
                            "passwordControlRemoved": True,
                        }

                actual = FLOWS.execute_password_account(
                    self.execution, Provider(), lambda: "owner@example.com"
                )
                self.assertEqual(actual["lifecycleState"], expected_lifecycle)
                self.assertEqual(actual["attentionReason"], outcome)
                self.assertNotIn("owner@example.com", str(actual))

    def test_execute_rejects_malformed_or_effect_widening_receipts(self):
        valid = {
            "providerId": "macos-workday-account",
            "credentialProviderId": "macos-keychain",
            "credentialRef": "credential_" + "e" * 64,
            "credentialVersion": 1,
            "reused": True,
            "outcome": "active",
            "retryAllowed": False,
            "finalActionAuthorized": False,
            "createAccountActivations": 1,
            "emailControlRemoved": True,
            "passwordControlRemoved": True,
        }
        for mutation in (
            {"finalActionAuthorized": True},
            {"createAccountActivations": 2},
            {"retryAllowed": True},
            {"passwordControlRemoved": False},
            {"credentialRef": "secret"},
            {"outcome": "submitted"},
            {"password": "forbidden"},
        ):
            class Provider:
                provider_id = "macos-workday-account"

                def execute(inner, _request, _private_email):
                    return {**valid, **mutation}

            with self.subTest(mutation=mutation), self.assertRaises(
                FLOWS.PasswordAccountFlowError
            ):
                FLOWS.execute_password_account(self.execution, Provider(), lambda: "x@y.z")


if __name__ == "__main__":
    unittest.main()
