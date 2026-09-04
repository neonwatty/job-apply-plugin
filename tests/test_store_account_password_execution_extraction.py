"""Frozen extraction contracts and synthetic account behavior for password_execution."""

import ast
import hashlib
import importlib
import inspect
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_method_contract, assert_composed_store_lifecycle, composed_store_class,
)
from tests.support.store_facade_contract import load_module
from tests.test_store_loader_isolation import copy_plugin


METHOD_HASHES = {
    "_validate_live_password_stable_locked": "070d778f2a8e231e8e47e02fe5f9b4c8a09cdf6e44ac30de66d902a6238461cc",
    "revalidate_live_password_stable_scope": "02aa47a425ab147ca21322793a59dc115e877a673801e8f13256ba7cf3d8cf31",
    "acquire_or_recover_live_password_claim": "a9d01edd8f328d86037d8fafcbd2a2b4e73492c37ceb249c6b686de2a614f67a",
    "prepare_live_password_account_execution": "e8ce6e60018e78841e6557508cff3579919958eee36b7c83822283c1bef61619",
    "execute_live_password_account": "f8c5f41831df57fb7d2aa7f71e74d199eada4fac94cbc0d8f5f7c679a80a5ff7"
}


class AccountExtractionTests(unittest.TestCase):
    def setUp(self):
        self.facade = load_module(name="password_execution_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.accounts.password_execution"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.PasswordExecutionMixin
        self.composed = composed_store_class(self.facade.Store, self.mixin)

    def test_frozen_ast_and_exact_contract(self):
        class Normalize(ast.NodeTransformer):
            def visit_Call(self, node):
                node = self.generic_visit(node)
                if isinstance(node.func, ast.Name) and node.func.id == "_late":
                    return ast.copy_location(ast.Name(id=node.args[0].value, ctx=ast.Load()), node)
                return node
        owned = {name for name, value in vars(self.mixin).items()
                 if inspect.isfunction(value) or isinstance(value, staticmethod)}
        self.assertEqual(owned, set(METHOD_HASHES))
        assert_method_contract(self, self.facade.Store, self.mixin, owned)
        assert_composed_store_lifecycle(self, self.facade.Store, self.mixin, self.composed, owned)
        for name, digest in METHOD_HASHES.items():
            node = ast.parse(textwrap.dedent(inspect.getsource(getattr(self.mixin, name)))).body[0]
            normalized = Normalize().visit(node)
            self.assertEqual(hashlib.sha256(ast.dump(normalized, include_attributes=False).encode()).hexdigest(), digest)

    def test_root_reload_and_canonical_companions_preserve_other_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = [copy_plugin(Path(directory) / name) for name in ("a", "b")]
            facades = [load_module(root / "scripts/job-apply-store.py", name)
                       for root, name in zip(roots, ("password_execution_a", "password_execution_b"))]
            leaves = [importlib.import_module(f"{f._PACKAGE_NAME}.domains.accounts.password_execution")
                      for f in facades]
            sentinel = object()
            leaves[1]._bind_runtime(lambda: {"ACCOUNTS_MODULE": sentinel})
            leaves[0]._bind_runtime(lambda: {})
            canonical = leaves[0]._late("ACCOUNTS_MODULE")
            self.assertTrue(Path(canonical.__file__).resolve().is_relative_to(roots[0].resolve()))
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "password_execution_fresh")
            fresh_leaf = importlib.import_module(f"{fresh._PACKAGE_NAME}.domains.accounts.password_execution")
            self.assertIsNot(fresh_leaf, leaves[0])
            self.assertIs(leaves[1]._late("ACCOUNTS_MODULE"), sentinel)
            self.assertIs(leaves[0]._late("ACCOUNTS_MODULE"), canonical)

    def test_password_claim_revalidates_after_recovery(self):
        store = self.composed(Path("/unused"))
        with mock.patch.object(store, "revalidate_live_password_stable_scope",
                               side_effect=[{"jobId": "job"}, self.facade.StoreError("drift")]) as stable, \
             mock.patch.object(store, "claim_status", return_value={"claim": {"jobId": "job", "expired": True}}), \
             mock.patch.object(store, "recover_claim", return_value={"claim": {"claimId": "claim", "expiresAt": "future"}}) as recover:
            with self.assertRaisesRegex(self.facade.StoreError, "drift"):
                store.acquire_or_recover_live_password_claim({}, owner_label="owner")
            self.assertEqual(stable.call_count, 2)
            recover.assert_called_once_with("job", "owner")

    def test_canonical_password_request_rejects_before_initialization(self):
        self.leaf._bind_runtime(lambda: {})
        store = self.composed(Path("/unused"))
        with mock.patch.object(store, "initialize") as initialize:
            with self.assertRaises(self.facade.StoreError):
                store.revalidate_live_password_stable_scope({})
            initialize.assert_not_called()
