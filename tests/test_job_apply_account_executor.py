import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

EXECUTOR = load("job_apply_account_executor")
CREDENTIALS = load("job_apply_credentials")


class AccountExecutorTests(unittest.TestCase):
    def packet(self, outcome="success"):
        base = "http://127.0.0.1:43123/synthetic-account"
        control = EXECUTOR.synthetic_proofs(base, outcome)["secureControlFingerprint"]
        operation = EXECUTOR.operation_fingerprint(base, "a" * 64, control)
        target = base + "?operation=" + operation.removeprefix("sha256:")
        proofs = EXECUTOR.synthetic_proofs(target, outcome)
        return {
            "jobId": "job-one", "expectedJobRevision": 3, "expectedClaimId": "claim-one",
            "realmRef": "a" * 64, "realmDescriptor": "workday:v1:wd5:acme",
            "expectedSettingsRevision": 2, "expectedAccountRevision": 1,
            "syntheticTargetUrl": target, **proofs,
        }

    def test_all_synthetic_outcomes_are_non_final_no_retry_and_cleared(self):
        for outcome, lifecycle in EXECUTOR.OUTCOMES.items():
            with self.subTest(outcome=outcome):
                result = EXECUTOR.execute_non_final(
                    self.packet(outcome), CREDENTIALS.synthetic_provider_for_tests(CREDENTIALS.synthetic_test_authority()),
                    "unique_per_realm", None,
                    lambda url, _token, outcome=outcome, lifecycle=lifecycle: {
                        "portalState": outcome, "lifecycleState": lifecycle,
                        "formFingerprint": EXECUTOR.synthetic_proofs(url, outcome)["observedFormFingerprint"],
                        "controlFingerprint": EXECUTOR.synthetic_proofs(url, outcome)["observedControlFingerprint"],
                    },
                )
                self.assertEqual(result["lifecycleState"], lifecycle)
                self.assertEqual((result["retryAllowed"], result["finalActionAuthorized"], result["secureControlCleared"]), (False, False, True))

    def test_non_loopback_live_and_credential_shaped_inputs_are_rejected(self):
        for target in ("https://acme.example/signup", "http://localhost:80/synthetic-account", "http://127.0.0.1:80/live"):
            with self.assertRaises(EXECUTOR.AccountExecutorError):
                EXECUTOR.validate_request({**self.packet(), "syntheticTargetUrl": target})
        with self.assertRaises(EXECUTOR.AccountExecutorError):
            EXECUTOR.validate_request({**self.packet(), "password": "forbidden"})

    def test_lifecycle_is_observed_not_supplied_by_caller(self):
        self.assertNotIn("outcome", self.packet())
        self.assertEqual(
            {key: self.packet("success")[key] for key in ("observedFormFingerprint", "observedControlFingerprint")},
            {key: self.packet("ambiguity")[key] for key in ("observedFormFingerprint", "observedControlFingerprint")},
        )
        with self.assertRaises((EXECUTOR.AccountExecutorError, KeyError)):
            EXECUTOR.execute_non_final(
                self.packet(), CREDENTIALS.synthetic_provider_for_tests(CREDENTIALS.synthetic_test_authority()), "unique_per_realm", None,
                lambda _url, _token: {"portalState": "success", "lifecycleState": "ambiguous"},
            )
