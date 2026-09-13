"""Frozen extraction contracts and synthetic account behavior for trusted_fill."""

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
    "_load_trusted_fill_document": "2f5397dd58bea1f25ae529f07d914b6b8809ee64565a8a88efb65138a85815bf",
    "_ensure_trusted_fill_document": "c36cd93b5867deca4eff04cda9dabb9d9760bfe1b22222e05f44ceb0a0ced44b",
    "_trusted_fill_fingerprint": "78dfd3402ef9e9b750392c01c94d7ad8aa09e717e0021d42c999f45455230583",
    "_trusted_fill_current_locked": "18457570e929f6aea86f141ed926fadd5346ad2273f95817b550a1195b780429",
    "approve_trusted_fill": "a78079a436ad1c6b31698ac458ecb475ccabc15058fe4917497649769a4ad89a",
    "trusted_fill_status": "7c86fd95dbaa1d6a4cf4490bd8d9edfd831cb55730004f8c5f7cd9f343423fdc",
    "revoke_trusted_fill": "6824c92cea7cafb9447ce2140b24a2c48cab97a9c2563757339ff4b9ad087bec",
    "_trusted_fill_attention_handoff_locked": "002ef30af2932065180284c07ebbd99db9dbb7c042717e30e827458d5189750e",
    "evaluate_trusted_fill": "7459404ff24ed8e0c5d7acd615455e08dd7811063ab9697ee8c43017eb317121"
}


class AccountExtractionTests(unittest.TestCase):
    def setUp(self):
        self.facade = load_module(name="trusted_fill_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.accounts.trusted_fill"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.TrustedFillMixin
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
                       for root, name in zip(roots, ("trusted_fill_a", "trusted_fill_b"))]
            leaves = [importlib.import_module(f"{f._PACKAGE_NAME}.domains.accounts.trusted_fill")
                      for f in facades]
            sentinel = object()
            leaves[1]._bind_runtime(lambda: {"ACCOUNTS_MODULE": sentinel})
            leaves[0]._bind_runtime(lambda: {})
            canonical = leaves[0]._late("ACCOUNTS_MODULE")
            self.assertTrue(Path(canonical.__file__).resolve().is_relative_to(roots[0].resolve()))
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "trusted_fill_fresh")
            fresh_leaf = importlib.import_module(f"{fresh._PACKAGE_NAME}.domains.accounts.trusted_fill")
            self.assertIsNot(fresh_leaf, leaves[0])
            self.assertIs(leaves[1]._late("ACCOUNTS_MODULE"), sentinel)
            self.assertIs(leaves[0]._late("ACCOUNTS_MODULE"), canonical)

    def test_canonical_document_validation_is_read_only_and_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            store = self.composed(Path(directory))
            store.initialize()
            store._ensure_trusted_fill_document()
            self.leaf._bind_runtime(lambda: {})
            document = store._load_trusted_fill_document()
            self.assertEqual(document["approvals"], {})
            before = store.trusted_fill_path.read_bytes()
            self.assertEqual(store._load_trusted_fill_document(), document)
            self.assertEqual(store.trusted_fill_path.read_bytes(), before)
            store.trusted_fill_path.write_text('{"schemaVersion":1,"approvals":{},"metadata":{},"PRIVATE":"secret"}')
            invalid = store.trusted_fill_path.read_bytes()
            with self.assertRaisesRegex(self.facade.StoreError, "unsupported fields"):
                store._load_trusted_fill_document()
            self.assertEqual(store.trusted_fill_path.read_bytes(), invalid)

    def test_fingerprint_descriptor_and_late_hash_patch(self):
        self.assertIsInstance(inspect.getattr_static(self.mixin, "_trusted_fill_fingerprint"), staticmethod)
        with mock.patch.object(self.facade.hashlib, "sha256") as digest:
            digest.return_value.hexdigest.return_value = "safe"
            self.assertEqual(self.mixin._trusted_fill_fingerprint("PRIVATE"), "sha256:safe")
            digest.assert_called_once_with(b"PRIVATE")
