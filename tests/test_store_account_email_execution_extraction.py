"""Frozen extraction contracts and synthetic account behavior for email_execution."""

import ast
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
from tests.support.ast_contract import canonical_ast_digest
from tests.support.store_facade_contract import load_module
from tests.test_store_loader_isolation import copy_plugin


METHOD_HASHES = {
    "acquire_or_recover_live_email_only_claim": "6781e8f2d358c246d360e78cf46eeb666e7cce7389e1d5c15699aa7791fb4801",
    "prepare_live_email_only_account_execution": "296c2482fcae3c8de054199529f321c3f05478f75c764159d904db10c1980dd8",
    "execute_live_email_only_account": "d18362051f0956712ec5d64c8656acd53e7a98cbcee848630b21ca35171eb3c1"
}


class AccountExtractionTests(unittest.TestCase):
    def setUp(self):
        self.facade = load_module(name="email_execution_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.accounts.email_execution"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.EmailExecutionMixin
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
            self.assertEqual(canonical_ast_digest(normalized), digest)

    def test_root_reload_and_canonical_companions_preserve_other_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = [copy_plugin(Path(directory) / name) for name in ("a", "b")]
            facades = [load_module(root / "scripts/job-apply-store.py", name)
                       for root, name in zip(roots, ("email_execution_a", "email_execution_b"))]
            leaves = [importlib.import_module(f"{f._PACKAGE_NAME}.domains.accounts.email_execution")
                      for f in facades]
            sentinel = object()
            leaves[1]._bind_runtime(lambda: {"ACCOUNTS_MODULE": sentinel})
            leaves[0]._bind_runtime(lambda: {})
            canonical = leaves[0]._late("ACCOUNTS_MODULE")
            self.assertTrue(Path(canonical.__file__).resolve().is_relative_to(roots[0].resolve()))
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "email_execution_fresh")
            fresh_leaf = importlib.import_module(f"{fresh._PACKAGE_NAME}.domains.accounts.email_execution")
            self.assertIsNot(fresh_leaf, leaves[0])
            self.assertIs(leaves[1]._late("ACCOUNTS_MODULE"), sentinel)
            self.assertIs(leaves[0]._late("ACCOUNTS_MODULE"), canonical)

    def test_claim_acquisition_rechecks_stable_scope_after_acquiring(self):
        store = self.composed(Path("/unused"))
        with mock.patch.object(store, "revalidate_live_email_only_stable_scope",
                               side_effect=[{"jobId": "job"}, self.facade.StoreError("drift")]) as stable, \
             mock.patch.object(store, "claim_status", return_value={"claim": None}), \
             mock.patch.object(store, "get_job", return_value={"id": "job", "status": "ready", "revision": 2}), \
             mock.patch.object(store, "acquire_ready_job", return_value={"claim": {"claimId": "claim", "expiresAt": "future"}}) as acquire:
            with self.assertRaisesRegex(self.facade.StoreError, "drift"):
                store.acquire_or_recover_live_email_only_claim({}, owner_label="owner")
            self.assertEqual(stable.call_count, 2)
            acquire.assert_called_once_with("job", "owner", 2)

    def test_other_owner_cannot_reuse_claim(self):
        store = self.composed(Path("/unused"))
        with mock.patch.object(store, "revalidate_live_email_only_stable_scope", return_value={"jobId": "job"}), \
             mock.patch.object(store, "claim_status", return_value={"claim": {"jobId": "job", "expired": False, "ownerLabel": "other"}}), \
             mock.patch.object(store, "recover_claim") as recover:
            with self.assertRaisesRegex(self.facade.StoreError, "another owner"):
                store.acquire_or_recover_live_email_only_claim({}, owner_label="owner")
            recover.assert_not_called()
