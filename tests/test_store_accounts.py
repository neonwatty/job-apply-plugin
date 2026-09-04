from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_automation_settings_are_closed_revisioned_and_cli_addressable(self):
        initial = self.store.get_automation_settings()
        self.assertEqual((initial["enabled"], initial["revision"]), (False, 1))
        updated = self.store.update_automation_settings(
            {
                "enabled": True,
                "automaticAccountCreation": True,
                "signupEmail": "owner@example.com",
                "passwordStrategy": "unique_per_realm",
            },
            1,
        )
        self.assertEqual(updated["revision"], 2)
        public = self.store.get_automation_settings(public=True)
        self.assertNotIn("signupEmail", public)
        self.assertTrue(public["signupEmailConfigured"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_automation_settings({"enabled": False}, 1)
        for patch in ({"credential": None}, {"token": None}, {"signupEmail": "invalid"}):
            with self.assertRaises(STORE_MODULE.StoreError):
                self.store.update_automation_settings(patch, 2)

        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "automation-capability", "--platform", "linux"],
            check=True, capture_output=True, text=True,
        )
        capability = json.loads(completed.stdout)
        self.assertEqual(capability["state"], "unsupported")
        self.assertIsNone(capability["providerId"])
        self.assertFalse(capability["credentialOperationsReady"])

        for command in ("automation-settings-get",):
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(self.root), command],
                check=True, capture_output=True, text=True,
            )
            projection = json.loads(completed.stdout)
            self.assertNotIn("signupEmail", projection)
            self.assertTrue(projection["signupEmailConfigured"])
            self.assertNotIn("owner@example.com", completed.stdout + completed.stderr)

    def test_employer_accounts_require_proven_realms_and_expose_redacted_projection(self):
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unresolved"):
            self.store.create_employer_account("https://jobs.example.com/acme/1")
        created = self.store.create_employer_account(
            "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/One",
            "realm-owner@example.com",
        )
        self.assertEqual(created["lifecycleState"], "discovered")
        self.assertIsNone(created["providerId"])
        self.assertIsNone(created["credentialRef"])
        self.assertIsNone(created["credentialVersion"])
        public = self.store.get_employer_account(created["realmRef"], public=True)
        self.assertNotIn("descriptor", public)
        self.assertNotIn("signupEmailOverride", public)
        self.assertNotIn("credentialRef", public)
        self.assertTrue(public["signupEmailOverrideConfigured"])
        self.assertFalse(public["providerAssigned"])
        oracle = self.store.create_employer_account(
            "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/331081/apply/email"
        )
        self.assertEqual(oracle["adapterId"], "oracle-recruiting")
        self.assertEqual(oracle["flowKind"], "email_only_candidate_profile")
        self.assertFalse(oracle["credentialRequired"])
        self.assertEqual(
            (oracle["providerId"], oracle["credentialRef"], oracle["credentialVersion"]),
            (None, None, None),
        )
        oracle_public = self.store.get_employer_account(oracle["realmRef"], public=True)
        self.assertFalse(oracle_public["credentialRequired"])
        self.assertNotIn("descriptor", oracle_public)
        for rejected_url in (
            "https://person@acme.wd5.myworkdayjobs.com/jobs/one",
            "https://acme.wd5.myworkdayjobs.com/jobs/one?session-id=",
            "https://wd5.myworkday.com/wday/authgwy/acme/login.htmld",
        ):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "unresolved"):
                self.store.create_employer_account(rejected_url)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already exists"):
            self.store.create_employer_account(
                "https://acme.wd5.myworkdayjobs.com/fr-FR/Careers/job/Two"
            )
        updated = self.store.update_employer_account(
            created["realmRef"], {"signupEmailOverride": None}, 1
        )
        self.assertEqual(updated["revision"], 2)

        cli_commands = (
            ["employer-account-list"],
            ["employer-account-get", "--realm-ref", created["realmRef"]],
        )
        for arguments in cli_commands:
            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--root", str(self.root), *arguments],
                check=True, capture_output=True, text=True,
            )
            self.assertNotIn("realm-owner@example.com", completed.stdout + completed.stderr)
            self.assertNotIn('"signupEmailOverride"', completed.stdout)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "only change"):
            self.store.update_employer_account(
                created["realmRef"], {"lifecycleState": "active"}, 2
            )

    def test_employer_account_flow_decisions_are_value_free_and_fail_closed(self):
        workday = self.store.create_job({
            "id": "flow-workday", "role": "Engineer", "company": "Acme",
            "url": "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_R1",
        })
        greenhouse = self.store.create_job({
            "id": "flow-greenhouse", "role": "Engineer", "company": "Acme",
            "url": "https://boards.greenhouse.io/acme/jobs/12345",
        })
        unresolved = self.store.create_job({
            "id": "flow-unknown", "role": "Engineer", "company": "Acme",
            "url": "https://jobs.example.com/acme/12345",
        })

        create = self.store.employer_account_flow_decision(workday["id"])
        accountless = self.store.employer_account_flow_decision(greenhouse["id"])
        attention = self.store.employer_account_flow_decision(unresolved["id"])
        self.assertEqual(create["decision"], "create_required")
        self.assertEqual(accountless, {
            "jobId": greenhouse["id"], "decision": "account_not_required",
            "adapterId": "greenhouse", "flowKind": "account_not_required",
            "accountRevision": None,
        })
        self.assertEqual(attention["decision"], "human_attention_required")
        self.assertEqual(attention["reasonCode"], "account_flow_unresolved")
        self.assertEqual(self.store.list_employer_accounts(), [])

        account = self.store.create_employer_account(workday["url"])
        discovered = self.store.employer_account_flow_decision(workday["id"])
        self.assertEqual((discovered["decision"], discovered["accountRevision"]), ("create_required", 1))

        document = self.store._load_employer_accounts_document()
        active = document["accounts"][account["realmRef"]]
        active["lifecycleState"] = "active"
        active["providerId"] = "macos-keychain"
        active["credentialRef"] = STORE_MODULE.CREDENTIALS_MODULE.credential_reference(
            "unique_per_realm", account["realmRef"]
        )
        active["credentialVersion"] = 1
        active["revision"] = 2
        STORE_MODULE.atomic_write_json(self.store.employer_accounts_path, document)
        reuse = self.store.employer_account_flow_decision(workday["id"])
        self.assertEqual((reuse["decision"], reuse["accountRevision"]), ("reuse_active", 2))

        serialized = json.dumps([create, accountless, attention, discovered, reuse])
        for forbidden in (
            "https://", "owner@", "signupEmail", "descriptor", "credentialRef", "providerId",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_profile_email_copy_is_internal_revisioned_and_redacted(self):
        self.store.initialize()
        profile = self.store.replace_profile(
            {"email": "private@example.invalid"},
            self.store.inspect_profile()["revision"], "user",
        )
        settings = self.store.get_automation_settings()
        copied = self.store.copy_profile_email_to_automation_settings(
            profile["revision"], settings["revision"], public=True,
        )
        self.assertTrue(copied["signupEmailConfigured"])
        self.assertNotIn("signupEmail", copied)
        self.assertNotIn("private", json.dumps(copied))
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.copy_profile_email_to_automation_settings(
                profile["revision"], settings["revision"], public=True,
            )
        current = self.store.get_automation_settings()
        completed = subprocess.run([
            sys.executable, str(SCRIPT), "--root", str(self.root),
            "automation-settings-copy-profile-email",
            "--expected-profile-revision", str(profile["revision"]),
            "--expected-settings-revision", str(current["revision"]),
        ], check=True, capture_output=True, text=True)
        self.assertNotIn("private", completed.stdout + completed.stderr)
        self.assertNotIn("signupEmail\"", completed.stdout)

    def test_oracle_email_only_execution_is_provider_free_burned_and_non_retryable(self):
        class Provider:
            provider_id = "macos-accessibility"
            def __init__(self, outcome="active", fail=False):
                self.outcome = outcome; self.fail = fail; self.invocations = 0
            def execute_email_only(self, _request, private_email):
                self.invocations += 1
                identity = private_email()
                if self.fail or "@" not in identity:
                    raise ValueError("synthetic failure")
                identity = None
                return {
                    "providerId": self.provider_id, "outcome": self.outcome,
                    "retryAllowed": False, "finalActionAuthorized": False,
                    "emailRemoved": True, "termsAccepted": True,
                    "nextActivations": 1, "credentialProviderInvocations": 0,
                }

        def prepared(store, suffix):
            store.replace_profile({"firstName": "Synthetic"}, store.inspect_profile()["revision"], "user")
            resume_path = self.home / f"oracle-{suffix}.txt"; resume_path.write_text("Synthetic", encoding="utf-8")
            resume = store.create_resume({"id": f"oracle-{suffix}", "label": "Synthetic", "path": str(resume_path)})
            url = f"https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/{1 if suffix == 'success' else 2}/apply/email"
            job = store.create_job({"id": f"oracle-job-{suffix}", "url": url, "role": "Synthetic", "company": "Synthetic", "resumeId": resume["id"]})
            ready = store.transition_job(job["id"], "ready", job["revision"])
            acquired = store.acquire_ready_job(job["id"], "oracle-test", ready["revision"])
            settings = store.get_automation_settings()
            settings = store.update_automation_settings({"enabled": True, "automaticAccountCreation": True, "signupEmail": "private@example.invalid"}, settings["revision"])
            realm = store.resolve_account_realm(url); account = store.create_employer_account(url)
            controls = {
                "accountFormFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("oracle-form:v1"),
                "emailControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("oracle-email:v1"),
                "termsControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("oracle-terms-control:v1"),
                "termsDocumentFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("oracle-terms-document:v1"),
                "nextControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("oracle-next-non-final:v1"),
                "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
            }
            packet = {
                "jobId": job["id"], "jobRevision": acquired["job"]["revision"],
                "expectedClaimId": acquired["claim"]["claimId"],
                "realmRef": realm["realmRef"], "realmDescriptor": realm["descriptor"],
                "flowKind": "email_only_candidate_profile", "accountRevision": account["revision"],
                "settingsRevision": settings["revision"],
                "portalUrl": "http://127.0.0.1:49152/synthetic-oracle?operation=" + ("a" * 64),
                **controls,
            }
            packet["accountCreationControlsFingerprint"] = STORE_MODULE.ACCOUNT_FLOWS_MODULE.aggregate_controls(packet)
            return packet, realm

        self.store.initialize()
        packet, _realm = prepared(self.store, "success")
        provider = Provider()
        result = self.store.execute_synthetic_email_only_account(
            packet, provider=provider,
            test_authority=STORE_MODULE.ACCOUNT_FLOWS_MODULE.synthetic_test_authority(),
        )
        self.assertTrue(result["authorized"])
        self.assertEqual(result["account"]["lifecycleState"], "active")
        self.assertEqual(result["credentialProviderInvocations"], 0)
        self.assertEqual(provider.invocations, 1)
        self.assertFalse(result["finalActionAuthorized"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict|cannot be attempted again"):
            self.store.execute_synthetic_email_only_account(
                packet, provider=provider,
                test_authority=STORE_MODULE.ACCOUNT_FLOWS_MODULE.synthetic_test_authority(),
            )

        second = STORE_MODULE.Store(self.home / ".job-apply-ambiguous", self.home / ".legacy-ambiguous.json")
        second.initialize(); failed_packet, _ = prepared(second, "failure")
        failed = second.execute_synthetic_email_only_account(
            failed_packet, provider=Provider(fail=True),
            test_authority=STORE_MODULE.ACCOUNT_FLOWS_MODULE.synthetic_test_authority(),
        )
        self.assertEqual(failed["reasonCode"], "ambiguous")
        self.assertFalse(failed["retryAllowed"])
        self.assertTrue(failed["attentionHandoff"])
        self.assertIsNone(second._load_account_operation_journal()["operation"])

    def test_synthetic_account_success_is_journaled_redacted_and_same_realm_reuses(self):
        job, acquired, account, packet = self._synthetic_account_fixture()
        provider = STORE_MODULE.CREDENTIALS_MODULE.synthetic_provider_for_tests(STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority())
        result = self.store.execute_synthetic_account(packet, provider=provider, observer=self._synthetic_account_observer, test_authority=STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority())
        self.assertEqual((result["authorized"], result["reasonCode"], result["retryAllowed"]), (True, "active", False))
        self.assertTrue(result["secureControlCleared"])
        self.assertFalse(result["finalActionAuthorized"])
        self.assertEqual(self.store.account_operation_status(), {"status": "idle", "operation": None})
        public = self.store.get_employer_account(account["realmRef"], public=True)
        self.assertEqual(public["lifecycleState"], "active")
        self.assertNotIn("credentialRef", public)

        handed = self.store.handoff_claimed_job(
            job["id"], acquired["token"], "awaiting_review",
            self.review_session(acquired["job"]["revision"], "non-final-review"), acquired["job"]["revision"],
        )
        self.assertEqual(handed["job"]["status"], "awaiting_review")
        _job2, _acquired2, _account2, packet2 = self._synthetic_account_fixture("reuse", "two")
        reused = self.store.execute_synthetic_account(packet2, provider=provider, observer=self._synthetic_account_observer, test_authority=STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority())
        self.assertTrue(reused["authorized"]); self.assertTrue(reused["reused"])
        self.assertEqual(reused["account"]["realmRef"], public["realmRef"])

    def test_synthetic_account_ambiguity_is_permanent_and_restart_recovery_never_infers_success(self):
        job, acquired, account, packet = self._synthetic_account_fixture("ambiguity", "ambiguous")
        provider = STORE_MODULE.CREDENTIALS_MODULE.synthetic_provider_for_tests(STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority())
        denied = self.store.execute_synthetic_account(packet, provider=provider, observer=self._synthetic_account_observer, test_authority=STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority())
        self.assertEqual((denied["reasonCode"], denied["retryAllowed"], denied["attentionHandoff"]), ("ambiguous", False, True))
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")
        self.assertEqual(self.store.get_employer_account(account["realmRef"])["lifecycleState"], "ambiguous")
        session = self.store.load_session(job["id"])
        self.assertEqual(session["attemptRevision"], acquired["job"]["revision"])
        self.assertEqual(
            session["blockers"],
            [{"type": "browser_handoff", "code": "browser-state-uncertain"}],
        )
        self.assertEqual(
            session["browserHandoff"],
            {
                "state": "required",
                "reasonCode": "browser-state-uncertain",
                "revision": 1,
            },
        )

        self.store = STORE_MODULE.Store(self.root / "restart", self.legacy)
        restart_job, _restart_acquired, restart_account, restart_packet = self._synthetic_account_fixture("restart", "restart")
        operation = {
            "operationId": "synthetic-restart", "jobId": restart_job["id"],
            "jobRevision": restart_packet["expectedJobRevision"],
            # The stranded operation may belong to the expired pre-recovery claim.
            "claimId": "expired-claim", "realmRef": restart_account["realmRef"],
            "accountRevision": restart_account["revision"],
            "settingsRevision": restart_packet["expectedSettingsRevision"], "stage": "prepared",
            "outcomeCode": "ambiguity", "startedAt": "2026-08-29T00:00:00Z",
        }
        STORE_MODULE.atomic_write_json(
            self.store.account_operation_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        recovered = self.store.recover_account_operation()
        self.assertEqual((recovered["status"], recovered["retryAllowed"]), ("ambiguous", False))
        self.assertEqual(self.store.get_employer_account(restart_account["realmRef"])["lifecycleState"], "ambiguous")
        self.assertEqual(self.store.get_job(restart_job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_stranded_account_operation_converges_after_explicit_expired_claim_recovery(self):
        job, acquired, account, packet = self._synthetic_account_fixture(
            "restart", "expired-claim"
        )
        operation = {
            "operationId": "synthetic-expired-claim-restart",
            "jobId": job["id"], "jobRevision": packet["expectedJobRevision"],
            "claimId": acquired["claim"]["claimId"],
            "realmRef": account["realmRef"], "accountRevision": account["revision"],
            "settingsRevision": packet["expectedSettingsRevision"], "stage": "prepared",
            "outcomeCode": "observed_pending", "startedAt": "2026-08-29T00:00:00Z",
        }
        STORE_MODULE.atomic_write_json(
            self.store.account_operation_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        coordinator = self.store._load_coordinator_document()
        coordinator["claim"]["expiresAt"] = "2000-01-01T00:00:00Z"
        STORE_MODULE.atomic_write_json(self.store.coordinator_path, coordinator)

        with self.assertRaisesRegex(
            STORE_MODULE.StoreError,
            "account operation recovery requires a live same-job claim",
        ):
            self.store.recover_account_operation()
        self.assertIsNotNone(self.store._load_account_operation_journal()["operation"])
        self.assertEqual(self.store.get_job(job["id"])["status"], "in_progress")
        self.assertEqual(
            self.store.get_employer_account(account["realmRef"])["lifecycleState"],
            "ambiguous",
        )

        recovered_claim = self.store.recover_claim(job["id"], "recovery-agent")
        self.assertNotEqual(recovered_claim["claim"]["claimId"], operation["claimId"])
        recovered = self.store.recover_account_operation()
        self.assertEqual((recovered["status"], recovered["retryAllowed"]), ("ambiguous", False))
        self.assertEqual(recovered["job"]["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        self.assertIsNone(self.store._load_account_operation_journal()["operation"])

    def test_account_attention_failure_keeps_recovery_journal(self):
        _job, _acquired, account, packet = self._synthetic_account_fixture(
            "ambiguity", "handoff-failure"
        )
        provider = STORE_MODULE.CREDENTIALS_MODULE.synthetic_provider_for_tests(
            STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority()
        )
        with mock.patch.object(
            self.store, "_account_attention_handoff_locked",
            side_effect=STORE_MODULE.StoreError("synthetic handoff failure"),
        ), self.assertRaisesRegex(STORE_MODULE.StoreError, "synthetic handoff failure"):
            self.store.execute_synthetic_account(
                packet, provider=provider, observer=self._synthetic_account_observer,
                test_authority=STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority(),
            )
        self.assertIsNotNone(self.store._load_account_operation_journal()["operation"])
        self.assertEqual(
            self.store.get_employer_account(account["realmRef"])["lifecycleState"],
            "ambiguous",
        )
