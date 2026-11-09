from tests.support.policy_case import *


class PolicyTests(PolicyCase):
    def test_missing_legacy_future_and_corrupt_state_fail_to_review_only(self):
        self.assertEqual(self.store.decision(now=NOW)["mode"], "review_only")
        self.store.policy_dir.mkdir(parents=True)
        for payload in (
            {"schemaVersion": 0, "mode": "auto_submit"},
            {"schemaVersion": 99, "mode": "auto_submit"},
        ):
            self.store.campaign_path.write_text(json.dumps(payload), encoding="utf-8")
            self.assertEqual(self.store.decision(now=NOW)["mode"], "review_only")
        self.store.campaign_path.write_text("not json", encoding="utf-8")
        self.assertEqual(self.store.decision(now=NOW)["mode"], "review_only")

    def test_activation_defaults_are_bounded_closed_and_scope_is_immutable(self):
        campaign = self.activate()
        self.assertEqual(campaign["mode"], "auto_submit")
        self.assertEqual(campaign["maxApplications"], 10)
        self.assertEqual(
            POLICY.parse_time(campaign["expiresAt"]) - POLICY.parse_time(campaign["createdAt"]),
            timedelta(hours=4),
        )
        self.assertEqual(set(campaign), POLICY.CAMPAIGN_FIELDS)
        with self.assertRaises(POLICY.PolicyError):
            self.store.activate(self.campaign_input(maxApplications=11), now=NOW)
        with self.assertRaises(POLICY.PolicyError):
            self.store.activate(self.campaign_input(applicationRules=[]), now=NOW)
        self.assertEqual(self.store.load_campaign(), campaign)

    def test_activation_recovers_matching_archive_after_interruption(self):
        previous = self.store.activate(
            self.campaign_input(durationSeconds=1), now=NOW
        )
        later = NOW + timedelta(seconds=2)
        original_atomic_json = POLICY._atomic_json

        def interrupt_after_archive(path, value):
            original_atomic_json(path, value)
            if path.parent == self.store.archive_dir:
                raise RuntimeError("injected interruption")

        with mock.patch.object(POLICY, "_atomic_json", interrupt_after_archive):
            with self.assertRaisesRegex(RuntimeError, "injected interruption"):
                self.store.activate(self.campaign_input(), now=later)

        restarted = POLICY.PolicyStore(self.root)
        replacement = restarted.activate(self.campaign_input(), now=later)
        archive_path = restarted.archive_dir / (
            previous["campaignId"].split(":", 1)[1] + ".json"
        )
        self.assertEqual(json.loads(archive_path.read_text()), previous)
        self.assertEqual(restarted.load_campaign(), replacement)

        mismatch = POLICY.PolicyStore(Path(self.temporary.name) / "mismatch")
        mismatch_previous = mismatch.activate(
            self.campaign_input(durationSeconds=1), now=NOW
        )

        def mismatch_interrupt(path, value):
            original_atomic_json(path, value)
            if path.parent == mismatch.archive_dir:
                raise RuntimeError("injected interruption")

        with mock.patch.object(POLICY, "_atomic_json", mismatch_interrupt):
            with self.assertRaises(RuntimeError):
                mismatch.activate(self.campaign_input(), now=later)
        mismatch_archive = mismatch.archive_dir / (
            mismatch_previous["campaignId"].split(":", 1)[1] + ".json"
        )
        mismatch_archive.write_text(
            json.dumps({**mismatch_previous, "reservedApplications": 1})
        )
        with self.assertRaisesRegex(
            POLICY.PolicyError, "campaign archive already exists"
        ):
            mismatch.activate(self.campaign_input(), now=later)

    def test_campaign_rejects_private_or_unclosed_metadata(self):
        for changes in (
            {"answerValue": "secret"},
            {"applicationRules": [{**self.rule, "url": "https://private.test/token"}]},
            {"sensitiveAllowlist": [{**self.sensitive, "answer": "secret"}]},
            {"resumeRevision": "resume text"},
        ):
            with self.subTest(changes=changes):
                with self.assertRaises(POLICY.PolicyError):
                    self.store.activate(self.campaign_input(**changes), now=NOW)

    def test_exact_scope_sensitive_and_revision_mismatch_fail_closed(self):
        self.activate()
        variants = (
            {"origin": "https://evil.example.test"},
            {"urlFingerprint": fingerprint("redirect")},
            {"jobFingerprint": fingerprint("different-job")},
            {"resumeRevision": fingerprint("resume-v2")},
            {"formRevision": "bad"},
            {"finalControlRevision": fingerprint("different-control")},
            {"answerRevisions": [{**self.sensitive, "answerRevision": fingerprint("changed")}]},
        )
        for changes in variants:
            with self.subTest(changes=changes):
                self.assertEqual(
                    self.store.authorize(self.authorization(**changes), now=NOW)["mode"],
                    "review_only",
                )
        self.assertFalse(self.store.applications_dir.exists())

    def test_atomic_reservation_limit_restart_and_idempotency(self):
        rules = []
        for number in range(3):
            rules.append(
                {
                    **self.rule,
                    "applicationRef": reference("application", f"app-{number}"),
                    "urlFingerprint": fingerprint(f"url-{number}"),
                    "jobFingerprint": fingerprint(f"job-{number}"),
                }
            )
        self.store.activate(
            self.campaign_input(maxApplications=2, applicationRules=rules), now=NOW
        )
        barrier = threading.Barrier(3)

        def reserve(rule):
            local = POLICY.PolicyStore(self.root)
            request = self.authorization(
                applicationRef=rule["applicationRef"],
                urlFingerprint=rule["urlFingerprint"],
                jobFingerprint=rule["jobFingerprint"],
            )
            barrier.wait()
            return local.authorize(request, now=NOW)

        with ThreadPoolExecutor(max_workers=3) as executor:
            results = list(executor.map(reserve, rules))
        approved = [item for item in results if item["mode"] == "auto_submit"]
        self.assertEqual(len(approved), 2)
        self.assertEqual(sorted(item["slot"] for item in approved), [1, 2])

        winner = approved[0]
        rule = next(item for item in rules if item["applicationRef"] == winner["applicationRef"])
        restarted = POLICY.PolicyStore(self.root)
        same = restarted.authorize(
            self.authorization(
                applicationRef=rule["applicationRef"],
                urlFingerprint=rule["urlFingerprint"],
                jobFingerprint=rule["jobFingerprint"],
            ),
            now=NOW,
        )
        self.assertEqual(same["leaseId"], winner["leaseId"])

    def test_expiry_and_persisted_kill_switch_deny_new_or_existing_work(self):
        campaign = self.activate()
        later = POLICY.parse_time(campaign["expiresAt"]) + timedelta(seconds=1)
        self.assertEqual(self.store.authorize(self.authorization(), now=later)["mode"], "review_only")
        self.store.kill(now=NOW)
        restarted = POLICY.PolicyStore(self.root)
        self.assertEqual(restarted.decision(now=NOW)["mode"], "review_only")
        self.assertEqual(restarted.authorize(self.authorization(), now=NOW)["mode"], "review_only")
        with self.assertRaises(POLICY.PolicyError):
            restarted.revoke(now=NOW)
