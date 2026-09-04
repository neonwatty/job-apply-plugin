from __future__ import annotations

import importlib
import inspect
import json
import unittest
from pathlib import Path

from tests.support.store_case import STORE_MODULE, StoreTestCase
from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    composed_store_class,
    snapshot_tree,
    source_inventory,
)


METHODS = (
    "account_operation_status", "recover_account_operation",
    "_clear_account_operation_locked", "_write_account_stage_locked",
    "_account_attention_handoff_locked",
)


class AccountOperationsExtractionTests(StoreTestCase):
    @classmethod
    def setUpClass(cls):
        package = STORE_MODULE._PACKAGE_NAME
        cls.settings = importlib.import_module(f"{package}.domains.accounts.settings")
        cls.registry = importlib.import_module(f"{package}.domains.accounts.registry")
        cls.operations = importlib.import_module(f"{package}.domains.accounts.operations")
        for leaf in (cls.settings, cls.registry, cls.operations):
            leaf._bind_runtime(lambda: vars(STORE_MODULE))
        cls.mixin = cls.operations.AccountOperationMixin
        cls.composed = composed_store_class(
            STORE_MODULE.Store,
            cls.settings.AccountSettingsMixin,
            cls.registry.AccountRegistryMixin,
            cls.mixin,
        )
        cls.leaf_composed = composed_store_class(STORE_MODULE.Store, cls.mixin)

    def setUp(self):
        super().setUp()
        self.store = self.composed(self.root, self.legacy)

    def test_exact_plain_mixin_contract(self):
        assert_method_contract(self, STORE_MODULE.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        domain_root = Path(__file__).resolve().parents[1] / "scripts" / "job_apply_store" / "domains"
        self.assertEqual(
            source_inventory(domain_root)["accounts.operations"],
            {"AccountOperationMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, STORE_MODULE.Store, self.mixin, self.leaf_composed, METHODS
        )

    def test_status_is_redacted_and_journal_identity_change_preserves_bytes(self):
        _job, acquired, account, packet = self._synthetic_account_fixture("restart", "status")
        operation = {
            "operationId": "operation-status", "jobId": packet["jobId"],
            "jobRevision": packet["expectedJobRevision"],
            "claimId": acquired["claim"]["claimId"], "realmRef": account["realmRef"],
            "accountRevision": account["revision"],
            "settingsRevision": packet["expectedSettingsRevision"], "stage": "prepared",
            "outcomeCode": "observed_pending", "startedAt": "2026-09-04T00:00:00Z",
        }
        STORE_MODULE.atomic_write_json(
            self.store.account_operation_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        status = self.store.account_operation_status()
        self.assertEqual(status["status"], "recovery_required")
        self.assertNotIn(operation["claimId"], json.dumps(status))
        before = snapshot_tree(self.store.root)
        with self.assertRaisesRegex(Exception, "changed before completion"):
            self.store._clear_account_operation_locked({**operation, "operationId": "other"})
        self.assertEqual(snapshot_tree(self.store.root), before)

    def test_recovery_is_fail_closed_and_closes_same_journal(self):
        job, acquired, account, packet = self._synthetic_account_fixture("restart", "recovery")
        operation = {
            "operationId": "operation-recovery", "jobId": job["id"],
            "jobRevision": packet["expectedJobRevision"],
            "claimId": acquired["claim"]["claimId"], "realmRef": account["realmRef"],
            "accountRevision": account["revision"],
            "settingsRevision": packet["expectedSettingsRevision"], "stage": "prepared",
            "outcomeCode": "observed_pending", "startedAt": "2026-09-04T00:00:00Z",
        }
        STORE_MODULE.atomic_write_json(
            self.store.account_operation_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        self.operations._bind_runtime(lambda: {})
        try:
            recovered = self.store.recover_account_operation()
        finally:
            self.operations._bind_runtime(lambda: vars(STORE_MODULE))
        self.assertEqual((recovered["status"], recovered["retryAllowed"]), ("ambiguous", False))
        self.assertEqual(recovered["job"]["status"], "needs_info")
        self.assertIsNone(self.store._load_account_operation_journal()["operation"])
        self.assertEqual(self.store.get_employer_account(account["realmRef"])["lifecycleState"], "ambiguous")


if __name__ == "__main__":
    unittest.main()
