from tests.support.policy_case import *


class PolicyTests(PolicyCase):
    def test_tampered_attempt_state_cannot_manufacture_a_retry(self):
        campaign = self.activate()
        self.store.authorize(self.authorization(), now=NOW)
        application_path = self.store._application_path(
            self.application_ref, campaign["campaignId"]
        )
        document = json.loads(application_path.read_text(encoding="utf-8"))
        document["status"] = "retry_available"
        application_path.write_text(json.dumps(document), encoding="utf-8")
        denied = self.store.authorize(
            self.authorization(), now=NOW + timedelta(seconds=1)
        )
        self.assertEqual(denied["mode"], "review_only")
        self.assertEqual(denied["reason"], "policy_unavailable")

    def test_one_retry_then_terminal_uncertain_exhausted(self):
        self.activate()
        first = self.store.authorize(self.authorization(), now=NOW)
        first_claim = self.claim(first)
        result = self.store.record_outcome(
            first_claim["campaignId"],
            self.application_ref,
            first["leaseId"],
            first_claim["claimId"],
            "uncertain",
            now=NOW,
        )
        self.assertEqual(result["status"], "retry_available")
        second = self.store.authorize(self.authorization(), now=NOW + timedelta(seconds=1))
        self.assertNotEqual(second["leaseId"], first["leaseId"])
        self.assertEqual(second["attempt"], 2)
        second_claim = self.claim(second, now=NOW + timedelta(seconds=1))
        exhausted = self.store.record_outcome(
            second_claim["campaignId"],
            self.application_ref,
            second["leaseId"],
            second_claim["claimId"],
            "uncertain",
            now=NOW + timedelta(seconds=2),
        )
        self.assertEqual(exhausted["status"], "uncertain_exhausted")
        restarted = POLICY.PolicyStore(self.root)
        denied = restarted.authorize(self.authorization(), now=NOW + timedelta(seconds=3))
        self.assertEqual(denied["mode"], "review_only")
        self.assertEqual(denied["reason"], "uncertain_exhausted")

    def test_click_is_not_success_confirmation_requires_opaque_evidence(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        claim = self.claim(lease)
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                claim["campaignId"],
                self.application_ref,
                lease["leaseId"],
                claim["claimId"],
                "clicked",
                now=NOW,
            )
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                claim["campaignId"],
                self.application_ref,
                lease["leaseId"],
                claim["claimId"],
                "confirmed_submitted",
                now=NOW,
            )
        confirmed = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "confirmed_submitted",
            confirmation_event=self.confirmation(claim),
            confirmation_capability=CONFIRMATION_CAPABILITY,
            now=NOW,
        )
        self.assertEqual(confirmed["status"], "confirmed_submitted")

    def test_receipts_are_closed_value_free_and_reject_stale_or_wrong_leases(self):
        secret = "synthetic-private-answer"
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        claim = self.claim(lease)
        receipt = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "blocked",
            now=NOW,
        )
        repeated = self.store.record_outcome(
            claim["campaignId"],
            self.application_ref,
            lease["leaseId"],
            claim["claimId"],
            "blocked",
            now=NOW,
        )
        self.assertEqual(repeated, receipt)
        self.assertEqual(len(self.store.receipts_path.read_text(encoding="utf-8").splitlines()), 1)
        self.assertEqual(set(receipt), POLICY.RECEIPT_FIELDS)
        self.assertNotIn(secret, json.dumps(receipt))
        self.assertNotIn(secret, self.store.receipts_path.read_text(encoding="utf-8"))
        with self.assertRaises(POLICY.PolicyError):
            self.store.record_outcome(
                claim["campaignId"],
                self.application_ref,
                reference("lease", "wrong"),
                claim["claimId"],
                "blocked",
                now=NOW,
            )

    def test_atomic_action_claim_has_one_winner_and_rechecks_every_boundary(self):
        campaign = self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        barrier = threading.Barrier(2)

        def claim_once():
            barrier.wait()
            try:
                return POLICY.PolicyStore(self.root).claim_final_action(
                    self.application_ref,
                    lease["leaseId"],
                    lease["attempt"],
                    self.authorization(),
                    CONFIRMATION_CAPABILITY,
                    now=NOW,
                )
            except POLICY.PolicyError:
                return None

        with ThreadPoolExecutor(max_workers=2) as executor:
            claims = list(executor.map(lambda _: claim_once(), range(2)))
        self.assertEqual(sum(claim is not None for claim in claims), 1)

        other_root = Path(self.temporary.name) / "other"
        other = POLICY.PolicyStore(other_root)
        other.activate(self.campaign_input(), now=NOW)
        other_lease = other.authorize(self.authorization(), now=NOW)
        with self.assertRaises(POLICY.PolicyError):
            other.claim_final_action(
                self.application_ref,
                other_lease["leaseId"],
                1,
                self.authorization(finalControlRevision=fingerprint("changed")),
                CONFIRMATION_CAPABILITY,
                now=NOW,
            )
        with self.assertRaises(POLICY.PolicyError):
            other.claim_final_action(
                self.application_ref,
                other_lease["leaseId"],
                1,
                self.authorization(),
                CONFIRMATION_CAPABILITY,
                now=POLICY.parse_time(other_lease["leaseExpiresAt"]),
            )
        self.assertEqual(campaign["mode"], "auto_submit")

    def test_action_claim_rejects_mismatched_persisted_application_identity(self):
        self.activate()
        lease = self.store.authorize(self.authorization(), now=NOW)
        application_path = self.store._application_path(
            self.application_ref, lease["campaignId"]
        )
        application = json.loads(application_path.read_text(encoding="utf-8"))
        application["applicationRef"] = reference("application", "substituted")
        application_path.write_text(json.dumps(application), encoding="utf-8")
        activated = []

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

        application["authorization"]["applicationRef"] = application["applicationRef"]
        application["authorizationFingerprint"] = POLICY._digest(
            POLICY._authorization(application["authorization"])
        )
        application_path.write_text(json.dumps(application), encoding="utf-8")
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

        self.assertEqual(activated, [])
