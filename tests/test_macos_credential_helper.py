import unittest
import importlib.util
import subprocess
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ORACLE_SWIFT_SOURCES = (
    "job_apply_credential_helper.swift",
    "job_apply_browser_bridge.swift",
    "OracleExecutableIdentity.swift",
    "NativeEmailOnlyBinding.swift",
    "AccessibilityTree.swift",
    "ReviewedAccountForm.swift",
    "OracleBrowserIdentity.swift",
    "MacOSAccessibilityAccountFlowHelper.swift",
    "OracleAccountFlowFixtures.swift",
    "job_apply_credential_helper_tests.swift",
    "job_apply_credential_helper_main.swift",
)


class MacOSCredentialHelperTests(unittest.TestCase):
    def test_helper_uses_security_framework_and_native_boundary_only(self):
        source = (ROOT / "native/macos/job_apply_credential_helper.swift").read_text(encoding="utf-8")
        self.assertIn("import Security", source)
        self.assertIn("SecItemAdd", source)
        self.assertIn("SecItemCopyMatching", source)
        self.assertIn("SecRandomCopyBytes", source)
        self.assertIn("fillAndClear", source)
        self.assertIn("SecItemDelete", source)
        self.assertLess(
            source.index("defer { secret.resetBytes"),
            source.index("SecItemAdd(add as CFDictionary"),
        )
        for forbidden in ("Process(", "security ", "AppleScript", "NSPasteboard", "UIPasteboard", "print(", "CommandLine", "ProcessInfo.processInfo.environment"):
            self.assertNotIn(forbidden, source)

    def test_helper_namespace_is_isolated_and_has_no_public_retrieval(self):
        source = (ROOT / "native/macos/job_apply_credential_helper.swift").read_text(encoding="utf-8")
        self.assertIn("com.openai.job-apply.accounts.v1.", source)
        self.assertNotRegex(source, r"func\s+(get|reveal|copy|export)")

    @unittest.skipUnless(__import__("sys").platform.startswith("darwin"), "macOS Keychain required")
    def test_compiled_isolated_keychain_integration_is_silent_and_cleans_up(self):
        spec = importlib.util.spec_from_file_location("credentials_native_test", ROOT / "scripts" / "job_apply_credentials_macos.py")
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        realm = "a" * 64
        expected = module.MacOSSecurityFrameworkProvider.credential_reference("unique_per_realm", realm)
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "credential-integration"
            compile_result = subprocess.run([
                "xcrun", "swiftc", "-O", "-o", str(binary),
                *(str(ROOT / "native/macos" / source) for source in ORACLE_SWIFT_SOURCES),
            ], capture_output=True, check=False)
            self.assertEqual(compile_result.returncode, 0, compile_result.stderr.decode(errors="replace"))
            namespace = "test_durable_separate_invocations"
            commands = [
                [str(binary), "count", namespace, "0"],
                [str(binary), "isolated-compound-fail", "unique_per_realm", realm, expected, namespace],
                [str(binary), "count", namespace, "0"],
                [str(binary), "isolated-compound", "unique_per_realm", realm, expected, namespace, "new"],
                [str(binary), "isolated-compound", "unique_per_realm", realm, expected, namespace, "reused"],
                [str(binary), "count", namespace, "1"],
                [str(binary), "cleanup", "unique_per_realm", realm, namespace],
                [str(binary), "count", namespace, "0"],
            ]
            for command in commands:
                result = subprocess.run(command, capture_output=True, check=False)
                self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
                self.assertEqual((result.stdout, result.stderr), (b"", b""))

    def test_native_browser_bridge_independently_observes_os_control_and_publishes_after_clear(self):
        source = (ROOT / "native/macos/job_apply_browser_bridge.swift").read_text(encoding="utf-8")
        for required in ("AXUIElementCreateApplication", "kAXFocusedUIElementAttribute", "kAXSecureTextFieldSubrole", "proc_pidpath", "observedPageURL", "AXUIElementSetAttributeValue", "publishVerifiedObservation", "SecStaticCodeCheckValidity", "SecCodeCopyGuestWithAttributes", "certificate leaf[subject.OU]", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"):
            self.assertIn(required, source)
        self.assertIn("running.executableURL", source)
        self.assertNotIn(".contains(\"chrom", source)
        self.assertNotIn("portalState", source)
        self.assertNotIn("URLSession", source)
        self.assertIn("secureValueIsEmpty(after.element)", source)
        self.assertLess(source.rindex("secureValueIsEmpty(after.element)"), source.rindex("publishVerifiedObservation()"))
        main = (ROOT / "native/macos/job_apply_credential_helper_main.swift").read_text(encoding="utf-8")
        for status in range(40, 49):
            self.assertIn(str(status), main)

    def test_native_attestation_uses_authenticated_local_peer_not_inherited_descriptor(self):
        bridge = (ROOT / "native/macos/job_apply_browser_bridge.swift").read_text(encoding="utf-8")
        server = (ROOT / "qa/account_server.py").read_text(encoding="utf-8")
        self.assertIn("nativeAttestationSocketPath", bridge)
        self.assertNotIn("nativeChannelFileDescriptor", bridge)
        for required in (
            "LOCAL_PEERPID", "_process_path", "_signed_identity",
            "_dynamic_signed_identity", "_peer_is_exact_native_helper",
            "SecCodeCopyGuestWithAttributes", "SecCodeCheckValidity",
            "kSecCodeInfoIdentifier", "kSecCodeInfoUnique",
        ):
            self.assertIn(required, server)
        self.assertNotIn("socketpair", server)
        self.assertIn("dynamic_identity_unavailable", server)
        self.assertIn("attestation_validated", server)

    def test_live_native_vocabulary_is_closed_account_creation_only_and_disabled(self):
        source = (ROOT / "native/macos/job_apply_browser_bridge.swift").read_text(encoding="utf-8")
        self.assertIn("enum ReviewedNativeAccountCreationEffect", source)
        self.assertIn("struct DisabledMacOSAccountCreationBoundary", source)
        self.assertIn("static let enabled = false", source)
        legacy_vocabulary = source.split("enum ReviewedNativeAccountCreationEffect", 1)[1].split("enum ReviewedNativeEmailOnlyEffect", 1)[0]
        for effect in (
            "focus_email_control", "fill_email_from_settings",
            "focus_password_control", "fill_password_from_keychain",
            "activate_create_account_control", "observe_account_creation_outcome",
        ):
            self.assertEqual(legacy_vocabulary.count(f' = "{effect}"'), 1)
        for forbidden_case in ("submitApplication", "finalAction", "arbitraryAction", "runScript"):
            self.assertNotIn("case " + forbidden_case, source)
