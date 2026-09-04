from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_live_workday_account_uses_private_email_and_reuses_active_realm(self):
        store, request, account = self._prepared_workday_canary("success")
        authority_module = STORE_MODULE.CANARY_EXECUTOR_MODULE.CANARY
        ledger = authority_module.DurableT007ApprovalLedger(
            self.home / "workday-success-ledger.json"
        )
        approval = "approval_" + "a" * 64
        ledger.record_exact_approval(approval, request["binding"])
        authority = authority_module.OneAttemptCanaryAuthority(ledger)
        calls = []

        class Provider:
            provider_id = "macos-workday-account"

            def execute(inner, packet, private_email):
                calls.append(packet["expectedClaimId"])
                self.assertEqual(private_email(), "private@example.invalid")
                self.assertEqual(packet["strategy"], "unique_per_realm")
                return {
                    "providerId": inner.provider_id,
                    "credentialProviderId": "macos-keychain",
                    "credentialRef": STORE_MODULE.CREDENTIALS_MODULE.credential_reference(
                        "unique_per_realm", account["realmRef"]
                    ),
                    "credentialVersion": 1, "reused": False,
                    "outcome": "active", "retryAllowed": False,
                    "finalActionAuthorized": False, "createAccountActivations": 1,
                    "emailControlRemoved": True, "passwordControlRemoved": True,
                }

        executor = STORE_MODULE.CANARY_EXECUTOR_MODULE.LiveAccountCanaryExecutor(
            authority, store, Provider()
        )
        with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"):
            result = executor.execute_approved_password(
                request, approval, owner_label="workday-test",
                now=datetime(2026, 9, 2, tzinfo=timezone.utc),
            )
        self.assertTrue(result["authorized"])
        self.assertFalse(result["finalActionAuthorized"])
        self.assertEqual(len(calls), 1)
        persisted = store.get_employer_account(account["realmRef"])
        self.assertEqual(persisted["lifecycleState"], "active")
        self.assertEqual(persisted["providerId"], "macos-keychain")
        self.assertEqual(store.account_operation_status()["status"], "idle")
        self.assertEqual(
            store.employer_account_flow_decision(request["binding"]["jobId"])["decision"],
            "reuse_active",
        )
        self.assertNotIn("private@example.invalid", json.dumps(result))

    def test_workday_non_unique_strategies_route_to_human_attention(self):
        for strategy in ("shared", "custom", "ask_each_time"):
            store, request, _account = self._prepared_workday_canary(
                f"strategy-{strategy}", strategy=strategy
            )
            decision = store.employer_account_flow_decision(request["binding"]["jobId"])
            self.assertEqual(decision["decision"], "human_attention_required")
            self.assertEqual(decision["reasonCode"], "password_strategy_requires_human")

    def test_live_workday_challenges_create_typed_durable_handoffs(self):
        outcomes = {
            "email_verification_required": "email-verification-required",
            "captcha_required": "captcha-required",
            "mfa_required": "mfa-required",
            "password_reset_required": "owner-input-required",
            "ambiguous": "browser-state-uncertain",
        }
        for index, (outcome, blocker) in enumerate(outcomes.items(), start=1):
            with self.subTest(outcome=outcome):
                store, request, account = self._prepared_workday_canary(f"outcome-{index}")
                authority_module = STORE_MODULE.CANARY_EXECUTOR_MODULE.CANARY
                ledger = authority_module.DurableT007ApprovalLedger(
                    self.home / f"workday-outcome-{index}.json"
                )
                approval = "approval_" + str(index) * 64
                ledger.record_exact_approval(approval, request["binding"])
                authority = authority_module.OneAttemptCanaryAuthority(ledger)

                class Provider:
                    provider_id = "macos-workday-account"

                    def execute(inner, _packet, private_email):
                        self.assertEqual(private_email(), "private@example.invalid")
                        return {
                            "providerId": inner.provider_id,
                            "credentialProviderId": "macos-keychain",
                            "credentialRef": STORE_MODULE.CREDENTIALS_MODULE.credential_reference(
                                "unique_per_realm", account["realmRef"]
                            ),
                            "credentialVersion": 1, "reused": False,
                            "outcome": outcome, "retryAllowed": False,
                            "finalActionAuthorized": False, "createAccountActivations": 1,
                            "emailControlRemoved": True, "passwordControlRemoved": True,
                        }

                executor = STORE_MODULE.CANARY_EXECUTOR_MODULE.LiveAccountCanaryExecutor(
                    authority, store, Provider()
                )
                with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"):
                    result = executor.execute_approved_password(
                        request, approval, owner_label="workday-test",
                        now=datetime(2026, 9, 2, tzinfo=timezone.utc),
                    )
                self.assertFalse(result["authorized"])
                self.assertFalse(result["retryAllowed"])
                job_id = request["binding"]["jobId"]
                self.assertEqual(store.get_job(job_id)["status"], "needs_info")
                session = store.load_session(job_id)
                self.assertEqual(session["blockers"][0]["code"], blocker)
                self.assertNotIn("private@example.invalid", json.dumps(session))

    def test_live_oracle_composes_journal_t007_private_email_and_closed_outcome(self):
        self.store.initialize()
        self.store.replace_profile({"email": "private@example.invalid"}, 1, "user")
        resume_path = self.home / "live-oracle.txt"; resume_path.write_text("Synthetic", encoding="utf-8")
        resume = self.store.create_resume({"id": "live-oracle", "label": "Synthetic", "path": str(resume_path)})
        url = "https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/7/apply/email"
        job = self.store.create_job({"id": "live-oracle-job", "url": url, "role": "Synthetic", "company": "Synthetic", "resumeId": resume["id"]})
        ready = self.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.store.acquire_ready_job(job["id"], "live-oracle-test", ready["revision"])
        settings = self.store.get_automation_settings()
        settings = self.store.update_automation_settings(
            {"enabled": True, "automaticAccountCreation": True, "signupEmail": "private@example.invalid"},
            settings["revision"],
        )
        realm = self.store.resolve_account_realm(url); account = self.store.create_employer_account(url)
        controls = {
            "accountFormFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("form"),
            "emailControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("email"),
            "termsControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("terms"),
            "termsDocumentFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("document"),
            "nextControlFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint("next"),
        }
        aggregate = STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint(":".join(controls.values()))
        portal_name = "Oracle Recruiting"
        binding = {
            "jobId": job["id"], "jobRevision": acquired["job"]["revision"],
            "claimId": acquired["claim"]["claimId"],
            "realmRef": realm["realmRef"], "accountRevision": account["revision"],
            "settingsRevision": settings["revision"],
            "portalFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint(url),
            "portalNameFingerprint": STORE_MODULE.ACCOUNT_FLOWS_MODULE.fingerprint(portal_name),
            "accountCreationControlsFingerprint": aggregate, "approvalRevision": 1,
            "flowKind": "email_only_candidate_profile", **controls,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
        }
        request = {
            "capabilityRef": "canary_" + "c" * 64, "binding": binding,
            "portalName": portal_name, "portalUrl": url, **controls,
            "passwordControlFingerprint": None, "createAccountControlFingerprint": None,
        }
        stable_request = {
            key: value for key, value in request.items() if key != "capabilityRef"
        }
        stable_request["binding"] = {
            key: value for key, value in binding.items() if key != "claimId"
        }
        validated = self.store.revalidate_live_email_only_stable_scope(stable_request)
        self.assertTrue(validated["valid"])
        coordinator = self.store._load_coordinator_document()
        coordinator["claim"]["expiresAt"] = "2000-01-01T00:00:00Z"
        STORE_MODULE.atomic_write_json(self.store.coordinator_path, coordinator)
        renewed = self.store.acquire_or_recover_live_email_only_claim(
            stable_request, owner_label="live-oracle-test"
        )
        self.assertNotEqual(renewed["claimId"], binding["claimId"])
        binding = {**binding, "claimId": renewed["claimId"]}
        request = {**request, "binding": binding}
        sequence = []
        class Authority:
            def attempt(inner, capability, exact_binding, *, now):
                inner.operation = self.store._load_account_operation_journal()["operation"]
                self.assertIsNotNone(inner.operation)
                sequence.append("authority")
                return {"accountCreationAuthorized": True}
        class Provider:
            provider_id = "macos-accessibility"
            def execute_email_only(inner, packet, private_email):
                self.assertEqual(sequence, ["authority"])
                self.assertTrue(packet["operationFingerprint"].startswith("sha256:"))
                identity = private_email(); self.assertEqual(identity, "private@example.invalid"); identity = None
                sequence.append("native")
                return {"providerId": inner.provider_id, "outcome": "verification_required",
                        "retryAllowed": False, "finalActionAuthorized": False,
                        "emailRemoved": True, "termsAccepted": True, "nextActivations": 1,
                        "credentialProviderInvocations": 0}
        with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"):
            result = self.store.execute_live_email_only_account(
                request, authority=Authority(), provider=Provider(),
                now=datetime(2026, 8, 30, tzinfo=timezone.utc),
            )
        self.assertEqual(sequence, ["authority", "native"])
        self.assertEqual(result["reasonCode"], "verification_required")
        self.assertFalse(result["retryAllowed"])
        self.assertEqual(result["credentialProviderInvocations"], 0)
        self.assertNotIn("private", json.dumps(result))
        self.assertIsNone(self.store._load_account_operation_journal()["operation"])
