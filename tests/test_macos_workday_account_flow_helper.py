import importlib.util
import hashlib
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "job_apply_password_account_flows_macos_test",
    ROOT / "scripts" / "job_apply_password_account_flows_macos.py",
)
MACOS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MACOS)


@unittest.skipUnless(__import__("sys").platform.startswith("darwin"), "macOS Swift toolchain required")
class MacOSWorkdayAccountFlowTests(unittest.TestCase):
    def test_reviewed_provider_compiles_and_adversarial_fixtures_are_silent(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = MACOS.NativeMacOSWorkdayAccountProvider.from_reviewed_sources(
                4242, build_directory=directory
            )
            completed = provider.run_adversarial_fixtures()
            self.assertEqual(completed, {"passed": True, "effectCount": 0})

    def test_reviewed_provider_denies_direct_construction_and_binary_substitution(self):
        with self.assertRaises(ValueError):
            MACOS.NativeMacOSWorkdayAccountProvider("/tmp/not-reviewed", 4242)
        with tempfile.TemporaryDirectory() as directory:
            provider = MACOS.NativeMacOSWorkdayAccountProvider.from_reviewed_sources(
                4242, build_directory=directory
            )
            Path(provider.binary).write_bytes(b"substituted")
            with self.assertRaisesRegex(ValueError, "identity"):
                provider.run_adversarial_fixtures()

    def test_preparation_invocation_has_no_private_identity_or_effect_authority(self):
        with tempfile.TemporaryDirectory() as directory:
            provider = MACOS.NativeMacOSWorkdayAccountProvider.from_reviewed_sources(
                4242, build_directory=directory
            )
            request = {
                "jobId": "job", "jobRevision": 2,
                "realmRef": hashlib.sha256(b"workday:v1:wd5:acme").hexdigest(),
                "realmDescriptor": "workday:v1:wd5:acme",
                "accountRevision": 1, "settingsRevision": 3,
                "portalUrl": "https://acme.wd5.myworkdayjobs.com/jobs/1",
            }
            observed = {}

            def run(arguments, **kwargs):
                observed["arguments"] = arguments
                return subprocess.CompletedProcess(
                    arguments, 0,
                    stdout=(b'{"accountFormFingerprint":"sha256:' + b'1' * 64
                            + b'","emailControlFingerprint":"sha256:' + b'2' * 64
                            + b'","passwordControlFingerprint":"sha256:' + b'3' * 64
                            + b'","createAccountControlFingerprint":"sha256:' + b'4' * 64
                            + b'","accountCreationControlsFingerprint":"sha256:' + b'5' * 64
                            + b'","readOnly":true,"effectCount":0,"providerId":"macos-workday-account"}\n'),
                    stderr=b"",
                )

            with mock.patch.object(MACOS.subprocess, "run", side_effect=run):
                # Aggregate mismatch is rejected after the inert native call.
                with self.assertRaises(ValueError):
                    provider.prepare(request)
            arguments = " ".join(observed["arguments"])
            self.assertNotIn("owner@", arguments)
            self.assertNotIn("password", arguments.lower())
            self.assertIn("workday-prepare", arguments)

    def test_execution_keeps_private_identity_out_of_process_arguments(self):
        descriptor = "workday:v1:wd5:acme"
        controls = {
            "accountFormFingerprint": "sha256:" + "1" * 64,
            "emailControlFingerprint": "sha256:" + "2" * 64,
            "passwordControlFingerprint": "sha256:" + "3" * 64,
            "createAccountControlFingerprint": "sha256:" + "4" * 64,
        }
        aggregate = "sha256:" + hashlib.sha256(":".join(controls.values()).encode()).hexdigest()
        request = {
            "jobId": "job", "jobRevision": 2,
            "realmRef": hashlib.sha256(descriptor.encode()).hexdigest(),
            "realmDescriptor": descriptor, "accountRevision": 1, "settingsRevision": 3,
            "portalUrl": "https://acme.wd5.myworkdayjobs.com/jobs/1",
            "expectedClaimId": "claim", "strategy": "unique_per_realm",
            **controls, "accountCreationControlsFingerprint": aggregate,
        }
        observed = {}

        class Listener:
            def bind(self, _path): pass
            def listen(self, _count): pass
            def close(self): pass

        class Child:
            pid = 73
            returncode = 0
            def poll(self): return 0
            def communicate(self, timeout): return (b"", b"")

        def popen(arguments, **_kwargs):
            observed["arguments"] = arguments
            return Child()

        provider = object.__new__(MACOS.NativeMacOSWorkdayAccountProvider)
        provider.binary = "/reviewed/helper"; provider.browser_process_identifier = 4242
        provider.socket_path = "/tmp/reviewed.sock"
        receipt = {
            "providerId": provider.provider_id, "credentialProviderId": "macos-keychain",
            "credentialRef": "credential_" + "a" * 64, "credentialVersion": 1,
            "reused": False, "outcome": "active", "retryAllowed": False,
            "finalActionAuthorized": False, "createAccountActivations": 1,
            "emailControlRemoved": True, "passwordControlRemoved": True,
        }
        with mock.patch.object(provider, "_verified_binary", return_value=provider.binary), \
             mock.patch.object(MACOS.socket, "socket", return_value=Listener()), \
             mock.patch.object(MACOS.subprocess, "Popen", side_effect=popen), \
             mock.patch.object(provider, "_read_receipt", return_value=receipt), \
             mock.patch.object(MACOS.os, "pipe", return_value=(90, 91)), \
             mock.patch.object(MACOS.os, "write", return_value=17), \
             mock.patch.object(MACOS.os, "close"), \
             mock.patch.object(MACOS.os, "chmod"):
            self.assertEqual(provider.execute(request, lambda: "owner@example.com")["outcome"], "active")
        arguments = " ".join(observed["arguments"])
        self.assertNotIn("owner@example.com", arguments)
        self.assertNotIn("credential_", arguments)
        self.assertEqual(observed["arguments"][-1], "90")


if __name__ == "__main__":
    unittest.main()
