import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module


FLOWS = load("job_apply_account_flows")
MAC = load("job_apply_account_flows_macos")


class AccountFlowTests(unittest.TestCase):
    def packet(self):
        descriptor = "oracle-recruiting:v1:acme.fa.us2.oraclecloud.com:jobsearch"
        packet = {
            "jobId": "job-one", "jobRevision": 3, "expectedClaimId": "claim-one",
            "realmRef": hashlib.sha256(descriptor.encode()).hexdigest(),
            "realmDescriptor": descriptor, "flowKind": "email_only_candidate_profile",
            "accountRevision": 1, "settingsRevision": 2,
            "portalUrl": "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1/apply/email",
            "accountFormFingerprint": FLOWS.fingerprint("form"),
            "emailControlFingerprint": FLOWS.fingerprint("email"),
            "termsControlFingerprint": FLOWS.fingerprint("terms-control"),
            "termsDocumentFingerprint": FLOWS.fingerprint("terms-document"),
            "nextControlFingerprint": FLOWS.fingerprint("next"),
            "passwordControlFingerprint": None,
            "createAccountControlFingerprint": None,
        }
        packet["accountCreationControlsFingerprint"] = FLOWS.aggregate_controls(packet)
        return packet

    def test_email_only_flow_consumes_private_identity_and_returns_value_free_attestation(self):
        provider = MAC.SyntheticMacOSAccessibilityProvider()
        result = FLOWS.execute_email_only(self.packet(), provider, lambda: "private@example.invalid")
        encoded = json.dumps(result, sort_keys=True)
        self.assertEqual(result["lifecycleState"], "active")
        self.assertEqual(result["credentialProviderInvocations"], 0)
        self.assertEqual(result["nextActivations"], 1)
        self.assertNotIn("private", encoded)
        self.assertFalse(result["finalActionAuthorized"])

    def test_password_controls_drift_and_ambiguous_retry_are_denied(self):
        for patch in (
            {"passwordControlFingerprint": FLOWS.fingerprint("password")},
            {"termsDocumentFingerprint": FLOWS.fingerprint("changed")},
            {"accountCreationControlsFingerprint": FLOWS.fingerprint("forged")},
        ):
            packet = {**self.packet(), **patch}
            with self.assertRaises(FLOWS.AccountFlowError):
                FLOWS.validate_email_only_request(packet)
        result = FLOWS.execute_email_only(
            self.packet(), MAC.SyntheticMacOSAccessibilityProvider("ambiguous"),
            lambda: "private@example.invalid",
        )
        self.assertEqual(result["lifecycleState"], "ambiguous")
        self.assertFalse(result["retryAllowed"])

    @unittest.skipUnless(sys.platform.startswith("darwin"), "macOS native helper required")
    def test_native_provider_cannot_be_constructed_from_an_arbitrary_signed_helper(self):
        with self.assertRaisesRegex(ValueError, "reviewed source constructor"):
            MAC.NativeMacOSAccessibilityProvider("/tmp/substituted-helper", 42)
        with tempfile.TemporaryDirectory() as directory:
            provider = MAC.NativeMacOSAccessibilityProvider.from_reviewed_sources(
                42, build_directory=directory,
            )
            self.assertEqual(provider._verified_binary(), os.path.realpath(provider.binary))
            replacement = os.path.join(directory, "replacement")
            shutil.copy2(sys.executable, replacement)
            os.replace(replacement, provider.binary)
            with self.assertRaisesRegex(ValueError, "identity is invalid"):
                provider._verified_binary()


if __name__ == "__main__": unittest.main()
