from __future__ import annotations

import inspect
import json
import unittest
from pathlib import Path

from tests.support.store_case import STORE_MODULE, StoreTestCase
from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    composed_store_class,
    source_inventory,
)


METHODS = ("execute_synthetic_account", "execute_synthetic_email_only_account")


class SyntheticAccountExtractionTests(StoreTestCase):
    @classmethod
    def setUpClass(cls):
        cls.leaves = [
            STORE_MODULE._accounts_settings_domain,
            STORE_MODULE._accounts_registry_domain,
            STORE_MODULE._accounts_operations_domain,
            STORE_MODULE._accounts_synthetic_domain,
        ]
        for leaf in cls.leaves:
            leaf._bind_runtime(lambda: vars(STORE_MODULE))
        cls.mixin = cls.leaves[-1].SyntheticAccountMixin
        cls.composed = composed_store_class(
            STORE_MODULE.Store,
            cls.leaves[0].AccountSettingsMixin,
            cls.leaves[1].AccountRegistryMixin,
            cls.leaves[2].AccountOperationMixin,
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
            source_inventory(domain_root)["accounts.synthetic"],
            {"SyntheticAccountMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, STORE_MODULE.Store, self.mixin, self.leaf_composed, METHODS
        )

    def test_password_synthetic_success_is_redacted_and_exactly_once(self):
        _job, _acquired, account, packet = self._synthetic_account_fixture()
        credentials = self.leaves[-1]._CANONICAL_RUNTIME["CREDENTIALS_MODULE"]
        authority = credentials.synthetic_test_authority()
        provider = credentials.synthetic_provider_for_tests(authority)
        self.leaves[-1]._bind_runtime(lambda: {})
        try:
            result = self.store.execute_synthetic_account(
                packet, provider=provider, observer=self._synthetic_account_observer,
                test_authority=authority,
            )
        finally:
            self.leaves[-1]._bind_runtime(lambda: vars(STORE_MODULE))
        self.assertEqual(
            (result["authorized"], result["reasonCode"], result["retryAllowed"]),
            (True, "active", False),
        )
        self.assertFalse(result["finalActionAuthorized"])
        self.assertNotIn("credentialRef", json.dumps(result))
        self.assertIsNone(self.store._load_account_operation_journal()["operation"])
        facade_authority = STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority()
        facade_provider = STORE_MODULE.CREDENTIALS_MODULE.synthetic_provider_for_tests(
            facade_authority
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict|permanently"):
            self.store.execute_synthetic_account(
                packet, provider=facade_provider, observer=self._synthetic_account_observer,
                test_authority=facade_authority,
            )
        self.assertEqual(self.store.get_employer_account(account["realmRef"])["lifecycleState"], "active")

    def test_synthetic_authority_is_required_before_any_account_effect(self):
        _job, _acquired, account, packet = self._synthetic_account_fixture("success", "denied")
        authority = STORE_MODULE.CREDENTIALS_MODULE.synthetic_test_authority()
        provider = STORE_MODULE.CREDENTIALS_MODULE.synthetic_provider_for_tests(authority)
        before = self.store.employer_accounts_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "test-only"):
            self.store.execute_synthetic_account(
                packet, provider=provider, observer=self._synthetic_account_observer,
                test_authority=object(),
            )
        self.assertEqual(self.store.employer_accounts_path.read_bytes(), before)
        self.assertEqual(self.store.get_employer_account(account["realmRef"])["lifecycleState"], "discovered")


if __name__ == "__main__":
    unittest.main()
