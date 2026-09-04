from tests.support.policy_case import *


class PolicyTests(PolicyCase):
    def test_unclaimed_or_killed_attempt_cannot_record_outcome(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                lease["campaignId"],
                self.application_ref,
                lease["leaseId"],
                reference("claim", "fabricated"),
                "uncertain",
                now=NOW,
            )

    def test_outcome_is_recorded_against_claiming_archived_campaign(self):
        original = self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        claim = self.claim(lease)
        self.store.revoke(now=NOW)
        replacement = self.store.activate(
            self.campaign_input(), now=NOW + timedelta(seconds=1)
        )

        receipt = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "uncertain",
            now=NOW + timedelta(seconds=1),
        )

        self.assertEqual(receipt["campaignId"], original["campaignId"])
        self.assertEqual(receipt["status"], "retry_available")
        archived_application = self.store._load_application(
            self.application_ref, original["campaignId"]
        )
        self.assertEqual(archived_application["status"], "retry_available")
        self.assertEqual(self.store.load_campaign(), replacement)

    def test_activation_callback_is_inside_policy_lock_and_exactly_once(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        activated = []

        claim = self.store.claim_final_action(
            self.application_ref,
            lease["leaseId"],
            lease["attempt"],
            self.authorization(),
            CONFIRMATION_CAPABILITY,
            now=NOW,
            activation=lambda current: activated.append(current["claimId"]),
        )
        self.assertEqual(activated, [claim["claimId"]])
        with self.assertRaises(POLICY.PolicyError):
            self.store.claim_final_action(
                self.application_ref,
                lease["leaseId"],
                lease["attempt"],
                self.authorization(),
                CONFIRMATION_CAPABILITY,
                now=NOW,
                activation=lambda current: activated.append(current["claimId"]),
            )
        self.assertEqual(activated, [claim["claimId"]])

    def test_cli_is_inert_and_never_imports_browser_control(self):
        source = SCRIPT.read_text(encoding="utf-8").lower()
        for forbidden in ("playwright", "selenium", "browser.", "click(", "mcp__"):
            self.assertNotIn(forbidden, source)
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "status"],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(completed.stdout)["mode"], "review_only")
