import hashlib
import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


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

    def test_native_provider_allows_bounded_accessibility_observation_under_ci_load(self):
        class SlowNativeChild:
            pid = 4242
            returncode = None

            def __init__(self, arguments):
                self.private_descriptor = os.dup(int(arguments[-1]))

            def communicate(self, timeout):
                os.read(self.private_descriptor, 255)
                os.close(self.private_descriptor)
                if timeout < 20:
                    raise __import__("subprocess").TimeoutExpired("native-helper", timeout)
                self.returncode = 0
                return b"", b""

            def poll(self):
                return self.returncode

            def kill(self):
                self.returncode = -9

            def wait(self, timeout):
                return self.returncode

        class ObservationResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps({
                    "lifecycleState": "active", "retryAllowed": False,
                    "finalActionAuthorized": False, "emailRemoved": True,
                    "termsAccepted": True, "nextActivations": 1,
                    "credentialProviderInvocations": 0,
                }).encode()

        provider = object.__new__(MAC.NativeMacOSAccessibilityProvider)
        provider.binary = "/reviewed/native-helper"
        provider.browser_process_identifier = 123
        provider.socket_path = "/tmp/native-attestation.sock"
        request = self.packet()
        request["portalUrl"] = "http://127.0.0.1:4321/synthetic-oracle?operation=" + "a" * 64
        request["operationFingerprint"] = "sha256:" + "a" * 64
        with mock.patch.object(provider, "_verified_binary", return_value=provider.binary), \
             mock.patch.object(MAC.subprocess, "Popen", side_effect=lambda arguments, **_kwargs: SlowNativeChild(arguments)), \
             mock.patch.object(MAC.urllib.request, "urlopen", return_value=ObservationResponse()):
            result = provider.execute_email_only(request, lambda: "private@example.invalid")
        self.assertEqual(result["outcome"], "active")
        self.assertEqual(result["nextActivations"], 1)
        self.assertFalse(result["finalActionAuthorized"])

    def test_native_provider_propagates_only_closed_identity_diagnostics(self):
        expected = {
            38: "browser_identity_process_executable",
            39: "browser_identity_running_application",
            40: "browser_identity_running_executable",
            41: "browser_identity_process_running_mismatch",
            42: "browser_identity_trusted_browser",
            43: "browser_identity_requirement",
            44: "browser_identity_static_code",
            45: "browser_identity_static_validity",
            46: "browser_identity_dynamic_code",
            47: "browser_identity_dynamic_validity",
            48: "browser_identity_literal_anchor_unproven",
            49: "browser_identity_second_proof_changed",
            50: "browser_identity_process_identity_unavailable",
            51: "browser_identity_running_identity_unavailable",
            52: "browser_identity_process_literal_anchor_only",
            53: "browser_identity_running_literal_anchor_only",
            54: "browser_identity_no_literal_anchor_match",
            55: "browser_identity_literal_anchor_match_ambiguous",
        }
        self.assertEqual(
            {status: MAC.NativeMacOSAccessibilityProvider._closed_failure_codes[status]
             for status in expected},
            expected,
        )
        self.assertEqual(
            MAC.NativeMacOSAccessibilityProvider._closed_failure_codes.get(255, "unclassified"),
            "unclassified",
        )

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
