"""Frozen extraction contracts and synthetic account behavior for email_scope."""

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
    "_validate_live_email_only_stable_locked": "60ee556e50802fd67a766040a7c29ed6a73e006e6624076d5e8f90864540db6a",
    "revalidate_live_email_only_stable_scope": "7eed69f8d5d800321d6a2f7c03d49562fe4caeeef9176890455202a7cc98db7b",
    "revalidate_live_email_only_preparation_scope": "160b6f27160867ac030dad8b331216ae3774675800c2ad48766547bf7ebebbb5"
}


class AccountExtractionTests(unittest.TestCase):
    def setUp(self):
        self.facade = load_module(name="email_scope_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.accounts.email_scope"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.EmailScopeMixin
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
                       for root, name in zip(roots, ("email_scope_a", "email_scope_b"))]
            leaves = [importlib.import_module(f"{f._PACKAGE_NAME}.domains.accounts.email_scope")
                      for f in facades]
            sentinel = object()
            leaves[1]._bind_runtime(lambda: {"ACCOUNTS_MODULE": sentinel})
            leaves[0]._bind_runtime(lambda: {})
            canonical = leaves[0]._late("ACCOUNTS_MODULE")
            self.assertTrue(Path(canonical.__file__).resolve().is_relative_to(roots[0].resolve()))
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "email_scope_fresh")
            fresh_leaf = importlib.import_module(f"{fresh._PACKAGE_NAME}.domains.accounts.email_scope")
            self.assertIsNot(fresh_leaf, leaves[0])
            self.assertIs(leaves[1]._late("ACCOUNTS_MODULE"), sentinel)
            self.assertIs(leaves[0]._late("ACCOUNTS_MODULE"), canonical)

    def test_stable_scope_rejects_job_drift_before_account_lookup(self):
        store = self.composed(Path("/unused"))
        request = {"binding": {"jobId": "job", "jobRevision": 3}, "portalUrl": "https://example.invalid/"}
        for job in (None, {"status": "ready", "revision": 1},
                    {"status": "ready", "revision": 2, "deletedAt": "deleted"}):
            with mock.patch.object(store, "_load_jobs_document", return_value={"jobs": {"job": job}}), \
                 mock.patch.object(store, "_load_employer_accounts_document") as accounts:
                with self.assertRaisesRegex(self.facade.StoreError, "stable job binding drifted"):
                    store._validate_live_email_only_stable_locked(request)
                accounts.assert_not_called()

    def test_canonical_preparation_rejects_invalid_scope_before_store_access(self):
        self.leaf._bind_runtime(lambda: {})
        store = self.composed(Path("/unused"))
        with mock.patch.object(store, "initialize") as initialize:
            with self.assertRaises(self.facade.StoreError):
                store.revalidate_live_email_only_preparation_scope({}, "https://example.invalid", "portal", "realm")
            initialize.assert_not_called()
