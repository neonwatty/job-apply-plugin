from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_live_oracle_multi_expiry_concurrency_and_safety_matrix(self):
        store, stable_request, original_claim = self._live_oracle_adversarial_fixture("62")
        authority_module = STORE_MODULE.CANARY_EXECUTOR_MODULE.CANARY
        ledger_path = self.home / "live-oracle-adversarial-ledger.json"
        ledger = authority_module.DurableT007ApprovalLedger(ledger_path)
        authority = authority_module.OneAttemptCanaryAuthority(ledger)

        self._expire_live_claim(store)
        first = store.acquire_or_recover_live_email_only_claim(
            stable_request, owner_label="oracle-adversarial"
        )["claimId"]
        self._expire_live_claim(store)
        newest = store.acquire_or_recover_live_email_only_claim(
            stable_request, owner_label="oracle-adversarial"
        )["claimId"]
        self.assertEqual(len({original_claim, first, newest}), 3)

        provider_calls = []

        class Provider:
            provider_id = "macos-accessibility"

            def execute_email_only(inner, packet, private_email):
                provider_calls.append(packet["expectedClaimId"])
                self.assertEqual(packet["expectedClaimId"], newest)
                self.assertEqual(private_email(), "synthetic-owner@example.invalid")
                return {
                    "providerId": inner.provider_id, "outcome": "active",
                    "retryAllowed": False, "finalActionAuthorized": False,
                    "emailRemoved": True, "termsAccepted": True,
                    "nextActivations": 1, "credentialProviderInvocations": 0,
                }

        # Both superseded claims fail before authority consumption or effects.
        for index, stale_claim in enumerate((original_claim, first), start=1):
            approval = "approval_" + str(index) * 64
            ledger.record_exact_approval(approval, stable_request["binding"])
            stale_binding = authority_module.execution_binding(
                stable_request["binding"], stale_claim
            )
            capability = authority.issue(
                stale_binding, approval,
                now=datetime(2026, 8, 31, tzinfo=timezone.utc),
            )["capabilityRef"]
            with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"), self.assertRaisesRegex(
                STORE_MODULE.StoreError, "exact live claimed job"
            ):
                store.execute_live_email_only_account(
                    {**stable_request, "binding": stale_binding, "capabilityRef": capability},
                    authority=authority, provider=Provider(),
                    now=datetime(2026, 8, 31, tzinfo=timezone.utc),
                )
        self.assertEqual(provider_calls, [])

        approval = "approval_" + "a" * 64
        ledger.record_exact_approval(approval, stable_request["binding"])
        executor = STORE_MODULE.CANARY_EXECUTOR_MODULE.LiveAccountCanaryExecutor(
            authority, store, Provider()
        )

        def race():
            try:
                return executor.execute_approved(
                    stable_request, approval, owner_label="oracle-adversarial",
                    now=datetime(2026, 8, 31, tzinfo=timezone.utc),
                )
            except Exception as error:
                return type(error).__name__

        with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"):
            with ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(lambda _index: race(), range(2)))
        successes = [item for item in outcomes if isinstance(item, dict)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(provider_calls, [newest])
        self.assertFalse(successes[0]["finalActionAuthorized"])
        self.assertFalse(successes[0]["retryAllowed"])
        persisted_ledger = ledger_path.read_text(encoding="utf-8")
        self.assertNotIn(approval, persisted_ledger)
        self.assertNotIn("synthetic-owner", persisted_ledger)

        # The closed request vocabulary rejects portal, terms, credential, realm,
        # and final-action drift without consulting Store state or a provider.
        validator = STORE_MODULE.CANARY_EXECUTOR_MODULE.validate_stable_live_request
        for label, mutation in (
            ("query", {"portalUrl": stable_request["portalUrl"] + "?token=forbidden"}),
            ("provider-shape", {"passwordControlFingerprint": "sha256:" + "f" * 64}),
            ("terms", {"termsDocumentFingerprint": "sha256:" + "e" * 64}),
            ("final", {"action": "submit_application"}),
            ("realm", {"binding": {**stable_request["binding"], "realmRef": "f" * 64}}),
        ):
            with self.subTest(label=label), self.assertRaises(
                STORE_MODULE.CANARY_EXECUTOR_MODULE.LiveCanaryExecutorError
            ):
                validator({**stable_request, **mutation})

    def test_live_oracle_crash_restart_pre_effect_boundaries_are_fail_closed(self):
        authority_module = STORE_MODULE.CANARY_EXECUTOR_MODULE.CANARY

        for boundary in ("journal", "authority", "account-stage", "native-entry"):
            with self.subTest(boundary=boundary):
                store, stable_request, claim_id = self._live_oracle_adversarial_fixture(
                    f"62-{boundary}"
                )
                ledger = authority_module.DurableT007ApprovalLedger(
                    self.home / f"live-oracle-crash-{boundary}.json"
                )
                authority = authority_module.OneAttemptCanaryAuthority(ledger)
                approval = "approval_" + {
                    "journal": "b", "authority": "c",
                    "account-stage": "d", "native-entry": "e",
                }[boundary] * 64
                ledger.record_exact_approval(approval, stable_request["binding"])
                binding = authority_module.execution_binding(stable_request["binding"], claim_id)
                capability = authority.issue(
                    binding, approval, now=datetime(2026, 8, 31, tzinfo=timezone.utc)
                )["capabilityRef"]
                request = {**stable_request, "binding": binding, "capabilityRef": capability}
                provider_calls = []

                class Provider:
                    provider_id = "macos-accessibility"

                    def execute_email_only(inner, _packet, _private_email):
                        provider_calls.append("entered")
                        raise KeyboardInterrupt("synthetic pre-effect crash")

                original_atomic = STORE_MODULE.atomic_write_json

                def crash_atomic(path, payload):
                    operation = payload.get("operation") if isinstance(payload, dict) else None
                    if boundary == "journal" and path == store.account_operation_journal_path and operation is not None:
                        raise OSError("synthetic journal crash")
                    return original_atomic(path, payload)

                if boundary == "authority":
                    authority.attempt = mock.Mock(side_effect=KeyboardInterrupt("synthetic authority crash"))
                stage_patch = mock.patch.object(store, "_write_account_stage_locked", wraps=store._write_account_stage_locked)
                if boundary == "account-stage":
                    stage_patch = mock.patch.object(
                        store, "_write_account_stage_locked",
                        side_effect=KeyboardInterrupt("synthetic account-stage crash"),
                    )
                flow_patch = mock.patch.object(
                    STORE_MODULE.ACCOUNT_FLOWS_MODULE, "execute_email_only",
                    side_effect=KeyboardInterrupt("synthetic native-entry crash"),
                ) if boundary == "native-entry" else mock.patch.object(
                    STORE_MODULE.ACCOUNT_FLOWS_MODULE, "execute_email_only",
                    wraps=STORE_MODULE.ACCOUNT_FLOWS_MODULE.execute_email_only,
                )

                with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"), mock.patch.object(
                    STORE_MODULE, "atomic_write_json", side_effect=crash_atomic
                ), stage_patch, flow_patch:
                    expected = OSError if boundary == "journal" else KeyboardInterrupt
                    with self.assertRaises(expected):
                        store.execute_live_email_only_account(
                            request, authority=authority, provider=Provider(),
                            now=datetime(2026, 8, 31, tzinfo=timezone.utc),
                        )

                operation = store._load_account_operation_journal()["operation"]
                if boundary == "journal":
                    self.assertIsNone(operation)
                    self.assertEqual(provider_calls, [])
                    continue
                self.assertIsNotNone(operation)
                self.assertEqual(provider_calls, [])
                restarted = STORE_MODULE.Store(store.root, store.legacy_profile)
                recovered = restarted.recover_account_operation()
                self.assertEqual((recovered["status"], recovered["retryAllowed"]), ("ambiguous", False))
                self.assertEqual(restarted.get_job(stable_request["binding"]["jobId"])["status"], "needs_info")
                self.assertIsNone(restarted._load_account_operation_journal()["operation"])

    def test_live_oracle_execute_approved_integrated_crash_restart_oracle(self):
        authority_module = STORE_MODULE.CANARY_EXECUTOR_MODULE.CANARY
        now = datetime(2026, 8, 31, tzinfo=timezone.utc)

        for boundary in (
            "journal-before-consumption", "issuance-before-commit",
            "issuance-after-commit", "provider-entry",
        ):
            with self.subTest(boundary=boundary):
                store, stable_request, original_claim = self._live_oracle_adversarial_fixture(
                    f"64-{boundary}"
                )
                self._expire_live_claim(store)
                ledger_path = self.home / f"live-oracle-integrated-{boundary}.json"
                ledger = authority_module.DurableT007ApprovalLedger(ledger_path)
                authority = authority_module.OneAttemptCanaryAuthority(ledger)
                approval = "approval_" + {
                    "journal-before-consumption": "1",
                    "issuance-before-commit": "2",
                    "issuance-after-commit": "3",
                    "provider-entry": "4",
                }[boundary] * 64
                ledger.record_exact_approval(approval, stable_request["binding"])
                provider_claims = []

                class Provider:
                    provider_id = "macos-accessibility"

                    def execute_email_only(inner, packet, private_email):
                        provider_claims.append(packet["expectedClaimId"])
                        self.assertNotEqual(packet["expectedClaimId"], original_claim)
                        self.assertEqual(private_email(), "synthetic-owner@example.invalid")
                        if boundary == "provider-entry":
                            raise KeyboardInterrupt("synthetic crash after provider entry")
                        return {
                            "providerId": inner.provider_id, "outcome": "active",
                            "retryAllowed": False, "finalActionAuthorized": False,
                            "emailRemoved": True, "termsAccepted": True,
                            "nextActivations": 1, "credentialProviderInvocations": 0,
                        }

                executor = STORE_MODULE.CANARY_EXECUTOR_MODULE.LiveAccountCanaryExecutor(
                    authority, store, Provider()
                )
                original_atomic = STORE_MODULE.atomic_write_json

                def journal_crash(path, payload):
                    operation = payload.get("operation") if isinstance(payload, dict) else None
                    if (
                        boundary == "journal-before-consumption"
                        and path == store.account_operation_journal_path
                        and operation is not None
                    ):
                        raise OSError("synthetic crash before durable journal")
                    return original_atomic(path, payload)

                original_ledger_write = ledger._write_locked

                def issuance_write(value):
                    if boundary == "issuance-before-commit" and any(
                        item.get("consumed") is True
                        for item in value["finalApprovals"].values()
                    ):
                        raise OSError("synthetic crash before atomic issuance commit")
                    return original_ledger_write(value)

                original_issue = authority.issue

                def issuance_return_lost(*args, **kwargs):
                    original_issue(*args, **kwargs)
                    raise KeyboardInterrupt("synthetic crash after atomic issuance commit")

                issue_patch = mock.patch.object(authority, "issue", wraps=authority.issue)
                if boundary == "issuance-after-commit":
                    issue_patch = mock.patch.object(
                        authority, "issue", side_effect=issuance_return_lost
                    )

                with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"), mock.patch.object(
                    STORE_MODULE, "atomic_write_json", side_effect=journal_crash
                ), mock.patch.object(
                    ledger, "_write_locked", side_effect=issuance_write
                ), issue_patch:
                    expected = (
                        OSError if boundary in (
                            "journal-before-consumption", "issuance-before-commit"
                        ) else KeyboardInterrupt
                    )
                    with self.assertRaises(expected):
                        executor.execute_approved(
                            stable_request, approval, owner_label="oracle-adversarial", now=now
                        )

                restarted = STORE_MODULE.Store(store.root, store.legacy_profile)
                restarted_ledger = authority_module.DurableT007ApprovalLedger(ledger_path)
                restarted_authority = authority_module.OneAttemptCanaryAuthority(
                    restarted_ledger
                )
                restarted_executor = (
                    STORE_MODULE.CANARY_EXECUTOR_MODULE.LiveAccountCanaryExecutor(
                        restarted_authority, restarted, Provider()
                    )
                )

                if boundary in (
                    "journal-before-consumption", "issuance-before-commit"
                ):
                    with mock.patch.object(STORE_MODULE.sys, "platform", "darwin"):
                        result = restarted_executor.execute_approved(
                            stable_request, approval,
                            owner_label="oracle-adversarial", now=now,
                        )
                    self.assertTrue(result["authorized"])
                    self.assertFalse(result["retryAllowed"])
                    self.assertEqual(len(provider_claims), 1)
                    self.assertIsNone(
                        restarted._load_account_operation_journal()["operation"]
                    )
                else:
                    self.assertIsNotNone(
                        restarted._load_account_operation_journal()["operation"]
                    )
                    recovered = restarted.recover_account_operation()
                    self.assertEqual(
                        (recovered["status"], recovered["retryAllowed"]),
                        ("ambiguous", False),
                    )
                    self.assertEqual(
                        restarted.get_job(stable_request["binding"]["jobId"])["status"],
                        "needs_info",
                    )
                    with self.assertRaises((
                        authority_module.CanaryAuthorityError, STORE_MODULE.StoreError,
                    )):
                        restarted_executor.execute_approved(
                            stable_request, approval,
                            owner_label="oracle-adversarial", now=now,
                        )
                    self.assertEqual(
                        len(provider_claims), 1 if boundary == "provider-entry" else 0
                    )

                durable = ledger_path.read_text(encoding="utf-8")
                self.assertNotIn(approval, durable)
                self.assertNotIn("synthetic-owner", durable)
                self.assertNotIn("canary_", durable)
