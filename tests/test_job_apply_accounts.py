import importlib.util
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "job_apply_accounts_test", ROOT / "scripts" / "job_apply_accounts.py"
)
ACCOUNTS = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(ACCOUNTS)
MAC_SPEC = importlib.util.spec_from_file_location(
    "job_apply_credentials_macos_accounts_test", ROOT / "scripts" / "job_apply_credentials_macos.py"
)
MAC = importlib.util.module_from_spec(MAC_SPEC)
assert MAC_SPEC.loader is not None
MAC_SPEC.loader.exec_module(MAC)


class AccountContractTests(unittest.TestCase):
    def test_flow_registry_classifies_reviewed_greenhouse_as_accountless(self):
        expected = {
            "status": "classified",
            "adapterId": "greenhouse",
            "flowKind": "account_not_required",
            "credentialRequired": False,
            "accountRequired": False,
        }
        for url in (
            "https://boards.greenhouse.io/acme/jobs/12345",
            "https://job-boards.greenhouse.io/acme_engineering/jobs/98765/",
        ):
            self.assertEqual(ACCOUNTS.classify_account_flow(url), expected)

    def test_flow_registry_rejects_unreviewed_greenhouse_surfaces(self):
        for url in (
            "https://boards.greenhouse.io/acme",
            "https://boards.greenhouse.io/acme/login",
            "https://boards.greenhouse.io/acme/candidate-home",
            "https://boards.greenhouse.io/acme/jobs/not-numeric",
            "https://boards.greenhouse.io/acme/jobs/12345?token=secret",
            "https://person@boards.greenhouse.io/acme/jobs/12345",
            "http://boards.greenhouse.io/acme/jobs/12345",
            "https://greenhouse.io/acme/jobs/12345",
        ):
            actual = ACCOUNTS.classify_account_flow(url)
            self.assertEqual(actual["status"], "unresolved", url)

    def test_flow_registry_preserves_credential_bearing_realm_identity(self):
        workday = ACCOUNTS.classify_account_flow(
            "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_R1"
        )
        oracle = ACCOUNTS.classify_account_flow(
            "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/331081/apply/email"
        )
        self.assertEqual(
            (workday["status"], workday["adapterId"], workday["flowKind"], workday["accountRequired"]),
            ("classified", "workday", "password_candidate_account", True),
        )
        self.assertRegex(workday["realmRef"], r"^[0-9a-f]{64}$")
        self.assertEqual(
            (oracle["status"], oracle["adapterId"], oracle["flowKind"], oracle["accountRequired"]),
            ("classified", "oracle-recruiting", "email_only_candidate_profile", True),
        )

    def test_oracle_recruiting_realm_is_tenant_site_stable_and_strict(self):
        first = ACCOUNTS.normalize_realm("https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/331081/apply/email")
        second = ACCOUNTS.normalize_realm("https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/999999")
        other_site = ACCOUNTS.normalize_realm("https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/engineering/job/331081")
        self.assertEqual(first["status"], "resolved")
        self.assertEqual(first["adapterId"], "oracle-recruiting")
        self.assertEqual(first["authorityKind"], "tenant-site")
        self.assertEqual(first["flowKind"], "email_only_candidate_profile")
        self.assertFalse(first["credentialRequired"])
        self.assertEqual(first["realmRef"], second["realmRef"])
        self.assertNotEqual(first["realmRef"], other_site["realmRef"])
        for rejected in (
            "https://oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1",
            "https://acme.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1",
            "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/JobSearch/job/1",
            "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/job%73earch/job/1",
            "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/1?x=1",
            "https://acme.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/jobs/1",
        ):
            self.assertEqual(ACCOUNTS.normalize_realm(rejected)["status"], "unresolved", rejected)

    def test_account_flow_capability_is_portable_and_side_effect_free(self):
        adapter = type("Adapter", (), {
            "platform_prefixes": ("darwin",),
            "discover": lambda self: {"providerId": "macos-accessibility", "state": "available", "emailOnlyCandidateProfileReady": True},
        })()
        self.assertEqual(ACCOUNTS.discover_account_flow_capability("darwin", (adapter,))["providerId"], "macos-accessibility")
        self.assertEqual(ACCOUNTS.discover_account_flow_capability("win32", (adapter,))["state"], "unsupported")
        self.assertEqual(ACCOUNTS.discover_account_flow_capability("linux", (adapter,))["state"], "unsupported")
    def test_workday_tenant_host_normalizes_job_and_locale_paths_to_one_realm(self):
        first = ACCOUNTS.normalize_realm(
            "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_R1"
        )
        second = ACCOUNTS.normalize_realm(
            "https://acme.wd5.myworkdayjobs.com/fr-FR/Careers/job/Paris/Engineer_R2?source=x"
        )
        self.assertEqual(first["status"], "resolved")
        self.assertEqual(first["realmRef"], second["realmRef"])
        self.assertEqual(first["descriptor"], "workday:v1:wd5:acme")

    def test_workday_tenants_and_cells_do_not_collapse(self):
        refs = {
            ACCOUNTS.normalize_realm(url)["realmRef"]
            for url in (
                "https://acme.wd5.myworkdayjobs.com/jobs/one",
                "https://other.wd5.myworkdayjobs.com/jobs/one",
                "https://acme.wd3.myworkdayjobs.com/jobs/one",
            )
        }
        self.assertEqual(len(refs), 3)

    def test_workday_shared_auth_gateway_paths_fail_closed_without_tenant_collapse(self):
        gateways = [
            ACCOUNTS.normalize_realm("https://wd5.myworkday.com/wday/authgwy/acme/login.htmld"),
            ACCOUNTS.normalize_realm("https://wd5.myworkday.com/wday/authgwy/other/login.htmld"),
            ACCOUNTS.normalize_realm("https://wd5.myworkday.com/acme/login"),
        ]
        self.assertTrue(all(item == {"status": "unresolved", "reasonCode": "ambiguous_auth_gateway"} for item in gateways))
        for url in (
            "https://jobs.example.com/acme/job/1",
            "https://myworkdayjobs.com/acme/job/1",
            "http://acme.wd5.myworkdayjobs.com/job/1",
            "https://wd5.myworkday.com/",
        ):
            self.assertEqual(ACCOUNTS.normalize_realm(url)["status"], "unresolved", url)

    def test_userinfo_fragments_and_credential_shaped_query_parameters_are_rejected(self):
        cases = {
            "https://person@acme.wd5.myworkdayjobs.com/jobs/one": "portal_url_userinfo_rejected",
            "https://acme.wd5.myworkdayjobs.com/jobs/one#signin": "portal_url_fragment_rejected",
            "https://acme.wd5.myworkdayjobs.com/jobs/one?access_token=": "portal_url_credential_parameter_rejected",
            "https://acme.wd5.myworkdayjobs.com/jobs/one?session-id=": "portal_url_credential_parameter_rejected",
        }
        for url, reason in cases.items():
            self.assertEqual(ACCOUNTS.normalize_realm(url), {"status": "unresolved", "reasonCode": reason})

    def test_capability_discovery_is_side_effect_free_and_never_ready(self):
        with mock.patch("subprocess.run", side_effect=AssertionError("must not probe")):
            mac = ACCOUNTS.discover_capability("darwin", MAC.ADAPTER_REGISTRY)
            linux = ACCOUNTS.discover_capability("linux", MAC.ADAPTER_REGISTRY)
            windows = ACCOUNTS.discover_capability("win32", MAC.ADAPTER_REGISTRY)
        self.assertEqual(mac["state"], "available")
        self.assertEqual({linux["state"], windows["state"]}, {"unsupported"})
        self.assertEqual(mac["providerId"], "macos-keychain")
        self.assertTrue(mac["syntheticOperationsReady"])
        self.assertIsNone(linux["providerId"])
        self.assertIsNone(windows["providerId"])
        self.assertFalse(any(item["credentialOperationsReady"] for item in (mac, linux, windows)))
        self.assertTrue(all(item["discoveryMode"] == "side_effect_free" for item in (mac, linux, windows)))

    def test_public_projections_hide_identity_and_provider_handle_fields(self):
        settings = {
            "enabled": True, "automaticAccountCreation": True,
            "passwordStrategy": "unique_per_realm", "signupEmail": "owner@example.com",
            "revision": 2, "createdAt": "a", "updatedAt": "b",
        }
        projected = ACCOUNTS.public_settings(settings)
        self.assertNotIn("signupEmail", projected)
        self.assertTrue(projected["signupEmailConfigured"])
        account = {
            "realmRef": "a" * 64, "adapterId": "workday", "descriptorVersion": 1,
            "descriptor": "workday:v1:wd5:acme", "signupEmailOverride": "owner@example.com",
            "providerId": None, "credentialRef": None,
            "credentialVersion": None, "lifecycleState": "discovered", "revision": 1,
            "createdAt": "a", "updatedAt": "b",
        }
        public = ACCOUNTS.public_account(account)
        self.assertNotIn("descriptor", public)
        self.assertNotIn("credentialRef", public)
        self.assertNotIn("signupEmailOverride", public)
        self.assertFalse(public["providerAssigned"])
        self.assertNotIn("signupEmail", ACCOUNTS.companion_settings(settings))
        self.assertTrue(ACCOUNTS.companion_settings(settings)["signupEmailConfigured"])
        companion = ACCOUNTS.companion_account(account)
        self.assertNotIn("signupEmailOverride", companion)
        self.assertTrue(companion["signupEmailOverrideConfigured"])


if __name__ == "__main__":
    unittest.main()
