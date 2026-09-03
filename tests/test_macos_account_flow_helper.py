import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class MacOSAccountFlowHelperTests(unittest.TestCase):
    def test_native_failure_statuses_distinguish_value_free_binding_stages(self):
        source = (ROOT / "native/macos/job_apply_credential_helper_main.swift").read_text(encoding="utf-8")
        for case_name, status in (
            ("requestBinding", 28), ("browserBinding", 29), ("pageBinding", 30),
            ("controlBinding", 31), ("stateBinding", 32), ("causalBinding", 33),
            ("browserProcessBinding", 34),
            ("accessibilityBinding", 36), ("activationBinding", 37),
        ):
            self.assertIn(f"AccountFlowHelperError.{case_name}", source)
            self.assertIn(f"Darwin.exit({status})", source)

    def test_signed_browser_identity_substages_are_closed_and_value_free(self):
        helper = (ROOT / "native/macos/job_apply_account_flow_helper.swift").read_text(encoding="utf-8")
        entrypoint = (ROOT / "native/macos/job_apply_credential_helper_main.swift").read_text(encoding="utf-8")
        expected = (
            ("processExecutable", 38), ("runningApplication", 39),
            ("runningExecutable", 40), ("processRunningMismatch", 41),
            ("trustedBrowser", 42), ("requirement", 43), ("staticCode", 44),
            ("staticValidity", 45), ("dynamicCode", 46), ("dynamicValidity", 47),
            ("literalAnchorUnproven", 48), ("secondProofChanged", 49),
            ("processIdentityUnavailable", 50), ("runningIdentityUnavailable", 51),
            ("processLiteralAnchorOnly", 52), ("runningLiteralAnchorOnly", 53),
            ("noLiteralAnchorMatch", 54), ("literalAnchorMatchAmbiguous", 55),
        )
        for case_name, status in expected:
            self.assertIn(f"case {case_name} = {status}", helper)
        self.assertIn("browserIdentityBinding(let substage)", entrypoint)
        self.assertIn("Darwin.exit(Int32(substage.rawValue))", entrypoint)
        diagnostic_section = helper.split("enum OracleBrowserIdentitySubstage", 1)[1].split("}", 1)[0]
        self.assertNotIn("String", diagnostic_section)
        self.assertNotIn("URL", diagnostic_section)
        self.assertNotIn("Data", diagnostic_section)
        self.assertIn("case .processRunningMismatch:\n            return .processRunningMismatch", helper)
        self.assertIn("case .processIdentityUnavailable:\n            return .processIdentityUnavailable", helper)
        self.assertIn("case .runningIdentityUnavailable:\n            return .runningIdentityUnavailable", helper)
        self.assertIn("case .processLiteralAnchorOnly:\n            return .processLiteralAnchorOnly", helper)
        self.assertIn("case .runningLiteralAnchorOnly:\n            return .runningLiteralAnchorOnly", helper)
        self.assertIn("case .noLiteralAnchorMatch:\n            return .noLiteralAnchorMatch", helper)
        self.assertIn("case .literalAnchorMatchAmbiguous:\n            return .literalAnchorMatchAmbiguous", helper)
        self.assertIn("case .literalAnchorUnproven:\n            return .literalAnchorUnproven", helper)
        self.assertIn(") else { return .secondProofChanged }", helper)

    def test_signed_browser_identity_uses_unique_regular_file_equivalence(self):
        helper = (ROOT / "native/macos/job_apply_account_flow_helper.swift").read_text(encoding="utf-8")
        test_support = (ROOT / "native/macos/job_apply_credential_helper_tests.swift").read_text(encoding="utf-8")
        self.assertIn("metadata.st_mode & S_IFMT == S_IFREG", helper)
        self.assertIn("device: metadata.st_dev, inode: metadata.st_ino", helper)
        self.assertIn("matches.count == 1", helper)
        self.assertIn("literalAnchorIdentities: Dictionary(", helper)
        self.assertIn("SecStaticCodeCreateWithPath(path as CFURL", helper)
        self.assertIn("SecCSFlags(rawValue: (1 << 0) | (1 << 4))", helper)
        self.assertIn("kSecGuestAttributePid as String: binding.browserProcessIdentifier", helper)
        self.assertEqual(helper.count("oracleTrustedExecutableProofDecision("), 15)
        self.assertNotIn("guard path == executable", helper)
        for case in (
            'literalAnchorIdentities: ["/literal/reviewed": nil',
            'literalAnchorIdentities: ["/literal/reviewed": reviewed, "/literal/other": reviewed]',
            "processIdentity: reviewed, runningIdentity: other",
            "processIdentity: changed, runningIdentity: changed",
        ):
            self.assertIn(case, helper)
        self.assertEqual(helper.count("func oracleExecutableIdentityAdversarialFixturesPass()"), 1)
        self.assertNotIn("oracleExecutableIdentityAdversarialFixturesPass", test_support)
        self.assertNotIn(") == .processRunningMismatch", helper)
        self.assertIn(") == .processIdentityUnavailable", helper)
        self.assertIn(") == .runningIdentityUnavailable", helper)
        self.assertIn(") == .processLiteralAnchorOnly", helper)
        self.assertIn(") == .runningLiteralAnchorOnly", helper)
        self.assertIn(") == .noLiteralAnchorMatch", helper)
        self.assertIn(") == .literalAnchorMatchAmbiguous", helper)
        self.assertEqual(helper.count(") == .literalAnchorUnproven"), 2)
        self.assertIn("!oracleSecondExecutableProofMatches(", helper)

    def test_production_source_compositions_keep_workday_independent_of_test_support(self):
        oracle_sources = (
            "job_apply_credential_helper.swift", "job_apply_browser_bridge.swift",
            "job_apply_account_flow_helper.swift", "job_apply_credential_helper_tests.swift",
            "job_apply_credential_helper_main.swift",
        )
        workday_sources = (
            "job_apply_credential_helper.swift", "job_apply_browser_bridge.swift",
            "job_apply_account_flow_helper.swift", "job_apply_workday_account_flow_helper.swift",
            "job_apply_workday_account_flow_main.swift",
        )
        self.assertIn("job_apply_credential_helper_tests.swift", oracle_sources)
        self.assertNotIn("job_apply_credential_helper_tests.swift", workday_sources)

        if not __import__("sys").platform.startswith("darwin"):
            return
        for sources in (workday_sources, oracle_sources):
            completed = subprocess.run([
                "xcrun", "swiftc", "-typecheck",
                *(str(ROOT / "native/macos" / source) for source in sources),
            ], capture_output=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))

    # These contract tests are intentionally quiet. Visible/native integration
    # lives behind the separately owner-approved qa-account gate.
    def test_native_email_only_contract_is_value_free_and_closed(self):
        source = (ROOT / "native/macos/job_apply_account_flow_helper.swift").read_text(encoding="utf-8")
        bridge = (ROOT / "native/macos/job_apply_browser_bridge.swift").read_text(encoding="utf-8")
        self.assertIn("MacOSAccessibilityAccountFlowHelper", source)
        self.assertIn("passwordControlFingerprint == nil", source)
        self.assertIn("createAccountControlFingerprint == nil", source)
        self.assertIn("termsDocumentFingerprint", source)
        self.assertIn("kAXURLAttribute as String", source)
        self.assertIn("exactPage", source)
        self.assertIn("exactAccountForm", source)
        self.assertIn("func prepare()", source)
        self.assertIn("unknownRequiredControlsPresent", source)
        self.assertIn("reviewedControls", source)
        self.assertIn("unknownRequiredOrActionable", source)
        self.assertIn("AXRequired", source)
        self.assertIn("actionNames", source)
        self.assertIn("exactCausalSuccessor", source)
        self.assertIn("realmPageSnapshot", source)
        self.assertIn("classifyPostOutcome(_ successor: AXUIElement)", source)
        self.assertIn("activateReviewedBrowser", source)
        self.assertIn("for _ in 0..<100", source)
        self.assertIn("AXUIElementSetAttributeValue(\n            exactControl, kAXValueAttribute", source)
        self.assertIn("Reobserve only; never repeat the effect", source)
        self.assertIn("CFEqual(reattestedEmail, exactControl)", source)
        self.assertIn("oracleCausalSuccessorDecision", source)
        self.assertIn("oracleExactEmailControlIdentityRemoved", source)
        self.assertIn("oracleQueryBearingLivePortalRejectionsPass", source)
        self.assertIn("privateEmailDescriptor: -1", source)
        self.assertIn("exactEmailControlIdentityRemoved", source)
        self.assertIn("guard emailRemovedAttested else", source)
        self.assertNotIn('"emailRemovedAttested": true', source)
        self.assertIn("hasUnknownRequiredOrActionable", source)
        self.assertNotIn("CGEvent", source)
        self.assertNotIn("kAXFocusedAttribute", source)
        self.assertNotIn("classifyPostOutcome()", source)
        self.assertIn('value["outcome"] = outcome', source)
        self.assertIn("let formElements = elements(accountForm)", source)
        self.assertIn('string(termsControl, kAXValueAttribute as CFString) == "0"', source)
        self.assertIn('string(termsControl, kAXValueAttribute as CFString) == "1"', source)
        self.assertIn("&& components.query == nil", source)
        self.assertIn("if !effectCompleted", source)
        self.assertNotIn("Keychain", source)
        self.assertNotIn("CommandLine", source)
        self.assertNotIn("ProcessInfo.processInfo.environment", source)
        for effect in (
            "fill_email_from_canonical_settings",
            "activate_exact_recruiting_terms_consent",
            "activate_exact_candidate_profile_next",
            "observe_candidate_profile_outcome",
        ):
            self.assertEqual(bridge.count(f'= "{effect}"'), 1)
        for forbidden in ("submit_application", "run_script", "arbitrary_selector"):
            self.assertNotIn(forbidden, bridge)

    def test_reviewed_source_constructor_pins_binary_and_denies_substitution(self):
        flows = (ROOT / "scripts/job_apply_account_flows_macos.py").read_text(encoding="utf-8")
        self.assertIn("from_reviewed_sources", flows)
        self.assertIn("self._constructor_token", flows)
        self.assertIn("stat.st_ino != self._inode", flows)
        self.assertIn("hashlib.sha256(Path(binary).read_bytes()).hexdigest() != self._digest", flows)
        self.assertNotIn("NativeMacOSAccessibilityProvider(\n                    str(binary)",
                         (ROOT / "scripts/qa-account.py").read_text(encoding="utf-8"))

    @unittest.skipUnless(__import__("sys").platform.startswith("darwin"), "Swift macOS toolchain required")
    def test_native_contract_typechecks_with_existing_boundary(self):
        completed = subprocess.run([
            "xcrun", "swiftc", "-typecheck",
            str(ROOT / "native/macos/job_apply_credential_helper.swift"),
            str(ROOT / "native/macos/job_apply_browser_bridge.swift"),
            str(ROOT / "native/macos/job_apply_account_flow_helper.swift"),
            str(ROOT / "native/macos/job_apply_credential_helper_tests.swift"),
            str(ROOT / "native/macos/job_apply_credential_helper_main.swift"),
        ], capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))

    @unittest.skipUnless(__import__("sys").platform.startswith("darwin"), "Swift macOS toolchain required")
    def test_native_adversarial_fixtures_execute_silently(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            binary = Path(directory) / "oracle-fixtures"
            completed = subprocess.run([
                "xcrun", "swiftc", "-O", "-o", str(binary),
                str(ROOT / "native/macos/job_apply_credential_helper.swift"),
                str(ROOT / "native/macos/job_apply_browser_bridge.swift"),
                str(ROOT / "native/macos/job_apply_account_flow_helper.swift"),
                str(ROOT / "native/macos/job_apply_credential_helper_tests.swift"),
                str(ROOT / "native/macos/job_apply_credential_helper_main.swift"),
            ], capture_output=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
            executed = subprocess.run(
                [str(binary), "oracle-email-only-adversarial-fixtures"],
                capture_output=True, check=False,
            )
            self.assertEqual(executed.returncode, 0, executed.stderr.decode(errors="replace"))
            self.assertEqual((executed.stdout, executed.stderr), (b"", b""))


if __name__ == "__main__": unittest.main()
