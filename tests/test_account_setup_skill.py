import unittest
from pathlib import Path

from scripts.skill_documents import skill_text


ROOT = Path(__file__).resolve().parents[1]
ENTRY = ROOT / "skills/account-setup/SKILL.md"


class AccountSetupSkillTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.text = skill_text(ENTRY)

    def test_routes_through_shared_redacted_contract(self):
        self.assertIn("allowed-tools: Read, Bash", self.text)
        self.assertNotIn("allowed-tools: Read, Write, Bash", self.text)
        self.assertIn('apps/companion/command.mjs" store account-flow-classify', self.text)
        self.assertIn('apps/companion/command.mjs" store employer-account-list', self.text)
        self.assertIn('apps/companion/command.mjs" store employer-account-create', self.text)
        self.assertIn("Route on the returned", self.text)
        self.assertIn("do not recreate hostname or path matching", self.text)
        self.assertIn("public redacted Store results only", self.text)
        self.assertNotIn("employer-account-update --", self.text)

    def test_preserves_each_adapter_contract(self):
        expectations = {
            "workday": "password_candidate_account",
            "mygreenhouse": "passwordless_email_code",
            "oracle-recruiting": "email_only_candidate_profile",
            "greenhouse": "account_not_required",
        }
        for adapter, flow in expectations.items():
            with self.subTest(adapter=adapter):
                self.assertIn(adapter, self.text)
                self.assertIn(flow, self.text)
        self.assertIn("macOS Keychain-only", self.text)
        self.assertIn("single global record is optional", self.text)
        self.assertIn("provider-free and credential-free", self.text)
        self.assertIn("Do not create or persist one", self.text)

    def test_forbids_secret_and_live_account_handling(self):
        for boundary in (
            "Never request, read, copy, print, transmit, or persist passwords",
            "email values",
            "one-time codes",
            "raw credential references",
            "does not sign in, create an account on an ATS",
            "Do not reproduce those mutations with hand-built HTTP calls",
        ):
            with self.subTest(boundary=boundary):
                self.assertIn(boundary, self.text)
        self.assertNotIn("configure contact identity", self.text)

    def test_separates_persistence_from_execution_readiness(self):
        self.assertIn("Persisted configuration, portable classification, and native execution readiness are separate facts", self.text)
        self.assertIn("saved account record is not evidence of an active browser session", self.text)
        self.assertIn("classification: recognized adapter and flow", self.text)
        self.assertIn("revision-safe clearing and removal controls", self.text)
        self.assertIn("does not establish or infer a live session", self.text)
        self.assertIn("does not collect or set a contact email", self.text)
        self.assertIn("browser session: observed or not observed", self.text)


if __name__ == "__main__":
    unittest.main()
