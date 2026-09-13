"""Extraction and dependency-direction contract for shared credentials."""

from __future__ import annotations

import inspect
import unittest

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_domain_import_direction,
    assert_method_contract,
    composed_store_class,
    source_inventory,
)
from tests.support.store_facade_contract import ROOT
from tests.support.store_case import STORE_MODULE


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "_shared_reference",
    "_write_shared_account_locked",
    "bind_shared_credential_version",
    "begin_shared_credential_upgrade",
    "complete_shared_credential_upgrade",
    "_public_shared_operation",
    "_recover_shared_credential_operation_locked",
)


class SharedCredentialExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = STORE_MODULE
        cls.leaf = cls.facade._accounts_shared_credentials_domain
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.SharedCredentialMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["accounts.shared_credentials"],
            {"SharedCredentialMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)


if __name__ == "__main__":
    unittest.main()
