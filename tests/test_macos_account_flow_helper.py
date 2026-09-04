from __future__ import annotations

import ast
import re
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]

ACCOUNT_FLOW_SWIFT_SOURCES = (
    "OracleExecutableIdentity.swift",
    "NativeEmailOnlyBinding.swift",
    "AccessibilityTree.swift",
    "ReviewedAccountForm.swift",
    "OracleBrowserIdentity.swift",
    "MacOSAccessibilityAccountFlowHelper.swift",
    "OracleAccountFlowFixtures.swift",
)
ORACLE_SWIFT_SOURCES = (
    "job_apply_credential_helper.swift",
    "job_apply_browser_bridge.swift",
    *ACCOUNT_FLOW_SWIFT_SOURCES,
    "job_apply_credential_helper_tests.swift",
    "job_apply_credential_helper_main.swift",
)
WORKDAY_SWIFT_SOURCES = (
    "job_apply_credential_helper.swift",
    "job_apply_browser_bridge.swift",
    *ACCOUNT_FLOW_SWIFT_SOURCES,
    "job_apply_workday_account_flow_helper.swift",
    "job_apply_workday_account_flow_main.swift",
)


def account_flow_source() -> str:
    return "\n".join(
        (ROOT / "native/macos" / name).read_text(encoding="utf-8")
        for name in ACCOUNT_FLOW_SWIFT_SOURCES
    )


def native_paths(names: tuple[str, ...]) -> list[str]:
    return [str(ROOT / "native/macos" / name) for name in names]


def assigned_swift_tuple(path: Path, name: str, class_name: str | None = None) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    body = tree.body
    if class_name is not None:
        body = next(node.body for node in tree.body if isinstance(node, ast.ClassDef) and node.name == class_name)
    for node in body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == name for target in node.targets):
            return tuple(ast.literal_eval(node.value))
    raise AssertionError(f"{path}: missing {name}")


def function_swift_literals(path: Path, function_name: str) -> tuple[str, ...]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    function = next(
        node for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function_name
    )
    strings = sorted(
        (node for node in ast.walk(function) if isinstance(node, ast.Constant)
         and isinstance(node.value, str) and node.value.endswith(".swift")),
        key=lambda node: (node.lineno, node.col_offset),
    )
    return tuple(Path(node.value).name for node in strings)


def workflow_typecheck_sources() -> list[tuple[str, ...]]:
    workflow = (ROOT / ".github/workflows/validate.yml").read_text(encoding="utf-8")
    return [
        tuple(Path(token).name for token in command.split() if token.endswith(".swift"))
        for command in re.findall(r"xcrun swiftc -typecheck ([^\n]+)", workflow)
    ]


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
        helper = account_flow_source()
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
        helper = account_flow_source()
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
        oracle_sources = assigned_swift_tuple(
            ROOT / "scripts/job_apply_account_flows_macos.py",
            "_reviewed_sources", "NativeMacOSAccessibilityProvider",
        )
        workday_sources = assigned_swift_tuple(
            ROOT / "scripts/job_apply_password_account_flows_macos.py",
            "_reviewed_sources", "NativeMacOSWorkdayAccountProvider",
        )
        visible_qa_sources = function_swift_literals(ROOT / "qa/account_environment.py", "_compile_native")
        credential_test_sources = assigned_swift_tuple(
            ROOT / "tests/test_macos_credential_helper.py", "ORACLE_SWIFT_SOURCES"
        )
        workflow_sources = workflow_typecheck_sources()
        self.assertEqual(oracle_sources, ORACLE_SWIFT_SOURCES)
        self.assertEqual(workday_sources, WORKDAY_SWIFT_SOURCES)
        self.assertEqual(visible_qa_sources, ORACLE_SWIFT_SOURCES)
        self.assertEqual(credential_test_sources, ORACLE_SWIFT_SOURCES)
        self.assertIn(ORACLE_SWIFT_SOURCES, workflow_sources)
        self.assertIn(WORKDAY_SWIFT_SOURCES, workflow_sources)
        self.assertIn("job_apply_credential_helper_tests.swift", ORACLE_SWIFT_SOURCES)
        self.assertNotIn("job_apply_credential_helper_tests.swift", WORKDAY_SWIFT_SOURCES)
        obsolete_source = "job_apply_" + "account_flow_helper.swift"
        self.assertNotIn(obsolete_source, oracle_sources + workday_sources)

        if not __import__("sys").platform.startswith("darwin"):
            return
        for sources in (WORKDAY_SWIFT_SOURCES, ORACLE_SWIFT_SOURCES):
            completed = subprocess.run([
                "xcrun", "swiftc", "-typecheck",
                *native_paths(sources),
            ], capture_output=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))

    # These contract tests are intentionally quiet. Visible/native integration
    # lives behind the separately owner-approved qa-account gate.
    def test_native_email_only_contract_is_value_free_and_closed(self):
        source = account_flow_source()
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
            *native_paths(ORACLE_SWIFT_SOURCES),
        ], capture_output=True, check=False)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))

    @unittest.skipUnless(__import__("sys").platform.startswith("darwin"), "Swift macOS toolchain required")
    def test_native_adversarial_fixtures_execute_silently(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            binary = Path(directory) / "oracle-fixtures"
            completed = subprocess.run([
                "xcrun", "swiftc", "-O", "-o", str(binary),
                *native_paths(ORACLE_SWIFT_SOURCES),
            ], capture_output=True, check=False)
            self.assertEqual(completed.returncode, 0, completed.stderr.decode(errors="replace"))
            executed = subprocess.run(
                [str(binary), "oracle-email-only-adversarial-fixtures"],
                capture_output=True, check=False,
            )
            self.assertEqual(executed.returncode, 0, executed.stderr.decode(errors="replace"))
            self.assertEqual((executed.stdout, executed.stderr), (b"", b""))


if __name__ == "__main__": unittest.main()
