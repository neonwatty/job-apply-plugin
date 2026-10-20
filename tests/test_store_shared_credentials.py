"""Store-journaled shared credential binding and upgrade regressions."""

from __future__ import annotations

import json
import subprocess
import sys

from tests.support.store_case import SCRIPT, STORE_MODULE, StoreTestCase


WORKDAY_URL = (
    "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/Phoenix/Engineer_R1"
)


class StoreSharedCredentialTests(StoreTestCase):
    def _shared_settings(self, store=None):
        store = store or self.store
        settings = store.get_automation_settings()
        return store.update_automation_settings(
            {"passwordStrategy": "shared"}, settings["revision"]
        )

    def _bound_account(self, *, active=False, store=None):
        store = store or self.store
        self._shared_settings(store)
        account = store.create_employer_account(WORKDAY_URL)
        result = store.bind_shared_credential_version(
            account["realmRef"], 1, account["revision"], owner_confirmed=True,
        )
        bound = result["account"]
        if not active:
            return bound
        document = store._load_employer_accounts_document()
        current = document["accounts"][bound["realmRef"]]
        current["lifecycleState"] = "active"
        current["revision"] += 1
        STORE_MODULE.atomic_write_json(store.employer_accounts_path, document)
        return store.get_employer_account(bound["realmRef"])

    def test_binding_is_owner_confirmed_journaled_and_value_free(self):
        self._shared_settings()
        account = self.store.create_employer_account(WORKDAY_URL)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "owner confirmation"):
            self.store.bind_shared_credential_version(
                account["realmRef"], 1, account["revision"]
            )
        public = self.store.bind_shared_credential_version(
            account["realmRef"], 1, account["revision"],
            owner_confirmed=True, public=True,
        )
        self.assertEqual(public["status"], "bound")
        self.assertEqual(public["account"]["lifecycleState"], "credential_provisioned")
        self.assertEqual(public["account"]["credentialVersion"], 1)
        self.assertNotIn("credentialRef", json.dumps(public))
        self.assertEqual(
            self.store.account_operation_status(), {"status": "idle", "operation": None}
        )
        private = self.store.get_employer_account(account["realmRef"])
        self.assertEqual(
            private["credentialRef"],
            STORE_MODULE.CREDENTIALS_MODULE.credential_reference(
                "shared", account["realmRef"], 1
            ),
        )

    def test_upgrade_stays_pinned_until_explicit_updated_outcome(self):
        account = self._bound_account(active=True)
        started = self.store.begin_shared_credential_upgrade(
            account["realmRef"], 2, account["revision"], owner_confirmed=True,
        )
        self.assertEqual(started["stage"], "reset_in_progress")
        self.assertEqual(started["sourceCredentialVersion"], 1)
        self.assertEqual(started["targetCredentialVersion"], 2)
        pinned = self.store.get_employer_account(account["realmRef"])
        self.assertEqual((pinned["credentialVersion"], pinned["revision"]), (1, account["revision"]))
        status = self.store.account_operation_status()
        self.assertEqual(status["operation"], started)
        self.assertNotIn("credentialRef", json.dumps(status))

        completed = self.store.complete_shared_credential_upgrade(
            started["operationId"], "updated", owner_confirmed=True, public=True,
        )
        self.assertTrue(completed["bindingUpdated"])
        self.assertEqual(completed["credentialVersion"], 2)
        self.assertEqual(completed["account"]["lifecycleState"], "active")
        self.assertNotIn("credentialRef", json.dumps(completed))
        private = self.store.get_employer_account(account["realmRef"])
        self.assertEqual(
            private["credentialRef"],
            STORE_MODULE.CREDENTIALS_MODULE.credential_reference(
                "shared", account["realmRef"], 2
            ),
        )

    def test_non_success_outcomes_are_typed_and_keep_source_binding(self):
        expected_lifecycles = {
            "email_verification_required": "verification_required",
            "captcha_required": "verification_required",
            "mfa_required": "verification_required",
            "password_reset_required": "reset_required",
            "failed_definitive": "failed_definitive",
            "ambiguous": "ambiguous",
        }
        for index, (outcome, lifecycle) in enumerate(expected_lifecycles.items()):
            with self.subTest(outcome=outcome):
                store = STORE_MODULE.Store(self.root / str(index), self.legacy)
                account = self._bound_account(active=True, store=store)
                source_ref = account["credentialRef"]
                started = store.begin_shared_credential_upgrade(
                    account["realmRef"], 2, account["revision"], owner_confirmed=True,
                )
                result = store.complete_shared_credential_upgrade(
                    started["operationId"], outcome, owner_confirmed=True,
                )
                self.assertEqual(result["status"], outcome)
                self.assertFalse(result["bindingUpdated"])
                self.assertFalse(result["retryAllowed"])
                current = store.get_employer_account(account["realmRef"])
                self.assertEqual(current["lifecycleState"], lifecycle)
                self.assertEqual((current["credentialVersion"], current["credentialRef"]), (1, source_ref))
                self.assertIsNone(store._load_account_operation_journal()["operation"])

    def test_upgrade_recovery_is_ambiguous_and_keeps_source_binding(self):
        account = self._bound_account(active=True)
        source_ref = account["credentialRef"]
        self.store.begin_shared_credential_upgrade(
            account["realmRef"], 3, account["revision"], owner_confirmed=True,
        )
        recovered = self.store.recover_account_operation()
        self.assertEqual((recovered["status"], recovered["retryAllowed"]), ("ambiguous", False))
        current = self.store.get_employer_account(account["realmRef"])
        self.assertEqual(current["lifecycleState"], "ambiguous")
        self.assertEqual((current["credentialVersion"], current["credentialRef"]), (1, source_ref))
        self.assertIsNone(self.store._load_account_operation_journal()["operation"])

    def test_recovery_finishes_or_verifies_a_durably_recorded_outcome(self):
        for account_already_written in (False, True):
            with self.subTest(account_already_written=account_already_written):
                store = STORE_MODULE.Store(
                    self.root / f"recorded-{account_already_written}", self.legacy
                )
                account = self._bound_account(active=True, store=store)
                started = store.begin_shared_credential_upgrade(
                    account["realmRef"], 2, account["revision"], owner_confirmed=True,
                )
                journal = store._load_account_operation_journal()
                journal["operation"].update({
                    "stage": "outcome_recorded", "outcomeCode": "updated",
                })
                STORE_MODULE.atomic_write_json(store.account_operation_journal_path, journal)
                if account_already_written:
                    document = store._load_employer_accounts_document()
                    current = document["accounts"][account["realmRef"]]
                    current.update({
                        "credentialRef": STORE_MODULE.CREDENTIALS_MODULE.credential_reference(
                            "shared", account["realmRef"], 2
                        ),
                        "credentialVersion": 2,
                        "revision": current["revision"] + 1,
                    })
                    STORE_MODULE.atomic_write_json(store.employer_accounts_path, document)
                recovered = store.recover_account_operation()
                self.assertEqual(
                    (recovered["status"], recovered["bindingUpdated"]),
                    ("updated", True),
                )
                current = store.get_employer_account(started["realmRef"])
                self.assertEqual(current["credentialVersion"], 2)
                self.assertIsNone(store._load_account_operation_journal()["operation"])

    def test_cli_requires_confirmation_and_emits_only_public_metadata(self):
        self._shared_settings()
        account = self.store.create_employer_account(WORKDAY_URL)
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        denied = subprocess.run([
            *base, "employer-account-shared-bind", "--realm-ref", account["realmRef"],
            "--credential-version", "1", "--expected-revision", "1",
        ], text=True, capture_output=True, check=False)
        self.assertNotEqual(denied.returncode, 0)
        self.assertIn("owner confirmation", denied.stderr)
        completed = subprocess.run([
            *base, "employer-account-shared-bind", "--realm-ref", account["realmRef"],
            "--credential-version", "1", "--expected-revision", "1", "--owner-confirmed",
        ], text=True, capture_output=True, check=True)
        receipt = json.loads(completed.stdout)
        self.assertEqual(receipt["status"], "bound")
        self.assertNotIn("credentialRef", completed.stdout + completed.stderr)


if __name__ == "__main__":
    import unittest
    unittest.main()
