from __future__ import annotations

import inspect
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    source_inventory,
)
from tests.support.store_case import STORE_MODULE
from tests.support.store_facade_contract import ROOT


METHODS = (
    "resolve_account_realm", "employer_account_flow_decision",
    "list_employer_accounts", "get_employer_account",
    "create_employer_account", "update_employer_account",
)


class AccountRegistryExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = STORE_MODULE
        cls.settings = cls.facade._accounts_settings_domain
        cls.registry = cls.facade._accounts_registry_domain
        for leaf in (cls.settings, cls.registry):
            leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.registry.AccountRegistryMixin
        cls.composed = composed_store_class(
            cls.facade.Store, cls.settings.AccountSettingsMixin, cls.mixin
        )
        cls.leaf_composed = composed_store_class(cls.facade.Store, cls.mixin)

    def test_exact_plain_mixin_contract(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(ROOT / "scripts" / "job_apply_store" / "domains")["accounts.registry"],
            {"AccountRegistryMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.leaf_composed, METHODS
        )

    def test_registry_outputs_and_bytes_match_frozen_clock(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            clock = lambda: datetime(2026, 9, 4, 21, 0, tzinfo=timezone.utc)
            seed = root / "seed"
            self.facade.Store(seed, clock=clock).initialize()
            stores = (
                self.facade.Store(clone_store_root(seed, root / "original"), clock=clock),
                self.composed(clone_store_root(seed, root / "extracted"), clock=clock),
            )
            url = "https://acme.wd5.myworkdayjobs.com/en-US/Careers/job/One"
            created = [store.create_employer_account(url, "private@example.invalid") for store in stores]
            self.assertEqual(created[0], created[1])
            public = [store.get_employer_account(created[0]["realmRef"], public=True) for store in stores]
            self.assertEqual(public[0], public[1])
            self.assertNotIn("signupEmailOverride", public[1])
            self.assertNotIn("descriptor", public[1])
            updated = [store.update_employer_account(created[0]["realmRef"], {"signupEmailOverride": None}, 1) for store in stores]
            self.assertEqual(updated[0], updated[1])
            self.assertEqual([store.list_employer_accounts() for store in stores], [[updated[0]], [updated[1]]])
            assert_store_trees_equal(self, stores[0].root, stores[1].root)

    def test_unbound_registry_uses_canonical_validation_and_realm_contracts(self):
        self.registry._bind_runtime(lambda: {})
        try:
            realm = self.mixin.resolve_account_realm(object(), "https://acme.wd5.myworkdayjobs.com/jobs/one")
        finally:
            self.registry._bind_runtime(lambda: vars(self.facade))
        self.assertEqual(realm["status"], "resolved")
        self.assertEqual(realm["adapterId"], "workday")


if __name__ == "__main__":
    unittest.main()
