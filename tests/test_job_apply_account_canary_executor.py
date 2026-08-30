import hashlib
import importlib.util
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module


CANARY = load("job_apply_account_canary")
EXECUTOR = load("job_apply_account_canary_executor")
ORACLE_SESSION = load("job_apply_oracle_canary")


class LiveCanaryExecutorTests(unittest.TestCase):
    def binding(self, url="https://careers.example.invalid/account/create", name="Example Careers"):
        fingerprint = "sha256:" + hashlib.sha256(url.encode()).hexdigest()
        name_fingerprint = "sha256:" + hashlib.sha256(name.encode()).hexdigest()
        controls = ":".join("sha256:" + digit * 64 for digit in "1234")
        controls_fingerprint = "sha256:" + hashlib.sha256(controls.encode()).hexdigest()
        return {"jobId": "job-one", "jobRevision": 4,
                "claimId": "11111111-1111-4111-8111-111111111111",
                "realmRef": "a" * 64,
                "accountRevision": 3, "settingsRevision": 2,
                "portalFingerprint": fingerprint, "portalNameFingerprint": name_fingerprint,
                "accountCreationControlsFingerprint": controls_fingerprint,
                "approvalRevision": 1}

    def request(self, capability, binding=None, url="https://careers.example.invalid/account/create"):
        return {"capabilityRef": capability, "binding": binding or self.binding(url),
                "portalName": "Example Careers", "portalUrl": url,
                "accountFormFingerprint": "sha256:" + "1" * 64,
                "emailControlFingerprint": "sha256:" + "2" * 64,
                "passwordControlFingerprint": "sha256:" + "3" * 64,
                "createAccountControlFingerprint": "sha256:" + "4" * 64}

    def authority(self, directory):
        ledger = CANARY.DurableT007ApprovalLedger(Path(directory) / "private-ledger.json")
        binding = self.binding(); approval = "approval_" + "b" * 64
        ledger.record_exact_approval(approval, binding)
        authority = CANARY.OneAttemptCanaryAuthority(ledger)
        capability = authority.issue(binding, approval, now=datetime(2026, 8, 29, tzinfo=timezone.utc))
        return authority, capability["capabilityRef"]

    def test_closed_native_boundary_delegates_only_to_store_owned_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            authority, capability = self.authority(directory)
            class Store:
                def execute_live_email_only_account(inner, request, *, authority, provider, now):
                    inner.request = request
                    authority.attempt(request["capabilityRef"], request["binding"], now=now)
                    return {"authorized": True, "finalActionAuthorized": False}
            class Provider: provider_id = "macos-accessibility"
            store = Store()
            result = EXECUTOR.LiveAccountCanaryExecutor(authority, store, Provider()).execute(
                self.request(capability), now=datetime(2026, 8, 29, tzinfo=timezone.utc)
            )
            self.assertTrue(result["authorized"])
            self.assertFalse(result["finalActionAuthorized"])
            with self.assertRaises(EXECUTOR.LiveCanaryExecutorError):
                EXECUTOR.LiveAccountCanaryExecutor(authority, store, object()).execute(
                    self.request(capability), now=datetime(2026, 8, 29, tzinfo=timezone.utc)
                )
            with self.assertRaises(EXECUTOR.LiveCanaryExecutorError):
                EXECUTOR.validate_live_request({**self.request(capability), "action": "final"})

    def test_effect_vocabulary_is_exact_account_creation_only(self):
        self.assertEqual(EXECUTOR.REVIEWED_NATIVE_ACCOUNT_CREATION_EFFECTS, {
            "focus_email_control", "fill_email_from_settings",
            "focus_password_control", "fill_password_from_keychain",
            "activate_create_account_control", "observe_account_creation_outcome",
        })
        vocabulary = " ".join(EXECUTOR.REVIEWED_NATIVE_ACCOUNT_CREATION_EFFECTS)
        for forbidden in ("final", "application", "submit_application", "arbitrary", "script", "selector"):
            self.assertNotIn(forbidden, vocabulary)

    def test_email_only_request_requires_exact_terms_and_null_credential_controls(self):
        capability = "canary_" + "c" * 64
        url = "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1/apply/email"
        name = "Oracle Recruiting"
        components = {
            "accountFormFingerprint": "sha256:" + "1" * 64,
            "emailControlFingerprint": "sha256:" + "2" * 64,
            "termsControlFingerprint": "sha256:" + "3" * 64,
            "termsDocumentFingerprint": "sha256:" + "5" * 64,
            "nextControlFingerprint": "sha256:" + "4" * 64,
        }
        aggregate = "sha256:" + hashlib.sha256(":".join(components.values()).encode()).hexdigest()
        binding = {
            **self.binding(url, name), **components,
            "realmRef": EXECUTOR.ACCOUNTS.normalize_realm(url)["realmRef"],
            "accountCreationControlsFingerprint": aggregate,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
            "flowKind": "email_only_candidate_profile",
        }
        request = {
            "capabilityRef": capability, "binding": binding,
            "portalName": name, "portalUrl": url, **components,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
        }
        self.assertIsNone(EXECUTOR.validate_live_request(request)["passwordControlFingerprint"])
        with self.assertRaises(EXECUTOR.LiveCanaryExecutorError):
            EXECUTOR.validate_live_request({**request, "passwordControlFingerprint": "sha256:" + "6" * 64})
        self.assertEqual(EXECUTOR.REVIEWED_NATIVE_EMAIL_ONLY_EFFECTS, {
            "focus_email_control", "fill_email_from_canonical_settings",
            "activate_exact_recruiting_terms_consent", "activate_exact_candidate_profile_next",
            "observe_candidate_profile_outcome",
        })
        for label, patch in (
            ("non-oracle", {"portalUrl": "https://attacker.example/not-oracle"}),
            ("portal-name", {"portalName": "Forged Recruiting"}),
            ("component", {"emailControlFingerprint": "sha256:" + "6" * 64}),
            ("consent", {"termsDocumentFingerprint": "sha256:" + "7" * 64}),
        ):
            with self.subTest(label=label), self.assertRaises(EXECUTOR.LiveCanaryExecutorError):
                EXECUTOR.validate_live_request({**request, **patch})

    def test_oracle_exact_authority_is_burned_inside_store_boundary(self):
        url = "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1/apply/email"
        name = "Oracle Recruiting"
        components = {
            "accountFormFingerprint": "sha256:" + "1" * 64,
            "emailControlFingerprint": "sha256:" + "2" * 64,
            "termsControlFingerprint": "sha256:" + "3" * 64,
            "termsDocumentFingerprint": "sha256:" + "5" * 64,
            "nextControlFingerprint": "sha256:" + "4" * 64,
        }
        aggregate = "sha256:" + hashlib.sha256(":".join(components.values()).encode()).hexdigest()
        binding = {
            **self.binding(url, name), **components,
            "realmRef": EXECUTOR.ACCOUNTS.normalize_realm(url)["realmRef"],
            "accountCreationControlsFingerprint": aggregate,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
            "flowKind": "email_only_candidate_profile",
        }
        request = {
            "binding": binding, "portalName": name, "portalUrl": url, **components,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
        }
        with tempfile.TemporaryDirectory() as directory:
            ledger = CANARY.DurableT007ApprovalLedger(Path(directory) / "private-ledger.json")
            approval = "approval_" + "d" * 64
            ledger.record_exact_approval(approval, binding)
            authority = CANARY.OneAttemptCanaryAuthority(ledger)
            capability = authority.issue(binding, approval, now=datetime(2026, 8, 29, tzinfo=timezone.utc))["capabilityRef"]
            class Provider: provider_id = "macos-accessibility"
            class Store:
                def execute_live_email_only_account(inner, exact, *, authority, provider, now):
                    authority.attempt(exact["capabilityRef"], exact["binding"], now=now)
                    return {"authorized": False, "reasonCode": "ambiguous", "retryAllowed": False}
            result = EXECUTOR.LiveAccountCanaryExecutor(authority, Store(), Provider()).execute(
                {**request, "capabilityRef": capability}, now=datetime(2026, 8, 29, tzinfo=timezone.utc)
            )
            self.assertEqual(result["reasonCode"], "ambiguous")
            with self.assertRaises(CANARY.CanaryAuthorityError):
                authority.attempt(capability, binding, now=datetime(2026, 8, 29, tzinfo=timezone.utc))

    def test_credential_shaped_and_all_other_portal_queries_are_rejected(self):
        capability = "canary_" + "c" * 64
        queries = ("password=secret", "token=value", "email=user%40example.invalid", "next=%2Faccount")
        for query in queries:
            url = "https://careers.example.invalid/account/create?" + query
            with self.subTest(query=query), self.assertRaises(EXECUTOR.LiveCanaryExecutorError):
                EXECUTOR.validate_live_request(self.request(capability, binding=self.binding(url), url=url))

    def test_private_oracle_session_has_no_helper_or_provider_override(self):
        import inspect
        signature = inspect.signature(ORACLE_SESSION.create_private_oracle_canary_session)
        self.assertEqual(
            set(signature.parameters),
            {"authority", "store", "browser_process_identifier", "build_directory"},
        )
        source = (ROOT / "scripts/job_apply_oracle_canary.py").read_text(encoding="utf-8")
        self.assertIn("NativeMacOSAccessibilityProvider.from_reviewed_sources", source)
        self.assertNotIn("binary=", source)
        self.assertNotIn("provider=", source)


if __name__ == "__main__": unittest.main()
