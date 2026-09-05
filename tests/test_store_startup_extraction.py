"""Frozen startup extraction and non-mutating validation contracts."""

import ast
import importlib
import inspect
import json
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle, assert_method_contract,
    assert_store_trees_equal, clone_store_root, composed_store_class, snapshot_tree,
)
from tests.support.ast_contract import canonical_ast_digest
from tests.support.store_facade_contract import load_module
from tests.test_store_loader_isolation import copy_plugin


METHOD_HASHES = {
    "initialize": "dda2486c7147e516aa70731cca1668c90c9d485171415967a8ae5e850b2e07c8",
    "validate_workspace_startup": "24856eb84e34c01920556c6b8b145cad30c4473180cc5c972e1b8bf45d268c1b",
    "_validate_existing_documents": "aafa33fa538ce69c12c2f71d9b9ee55b833beb55fd51c470501537350bacd343",
    "_validate_existing_session_documents": "7023d3840a401211b20a700153d470753d7449fff671adeff3ad146bb86d7934",
}


class StartupExtractionTests(unittest.TestCase):
    def setUp(self):
        self.facade = load_module(name="startup_contract")
        self.leaf = importlib.import_module(f"{self.facade._PACKAGE_NAME}.domains.startup")
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.StartupMixin
        self.composed = composed_store_class(self.facade.Store, self.mixin)

    def test_frozen_ast_and_method_contract(self):
        class Normalize(ast.NodeTransformer):
            def visit_Call(self, node):
                node = self.generic_visit(node)
                if isinstance(node.func, ast.Name) and node.func.id == "_late":
                    return ast.copy_location(ast.Name(id=node.args[0].value, ctx=ast.Load()), node)
                return node
        owned = {name for name, value in vars(self.mixin).items() if inspect.isfunction(value)}
        self.assertEqual(owned, set(METHOD_HASHES))
        assert_method_contract(self, self.facade.Store, self.mixin, owned)
        assert_composed_store_lifecycle(self, self.facade.Store, self.mixin, self.composed, owned)
        for name, digest in METHOD_HASHES.items():
            node = ast.parse(textwrap.dedent(inspect.getsource(getattr(self.mixin, name)))).body[0]
            normalized = Normalize().visit(node)
            self.assertEqual(canonical_ast_digest(normalized), digest)

    def test_initialize_matches_cloned_bytes_modes_and_legacy_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            seed = home / "seed"
            seed.mkdir()
            left = clone_store_root(seed, home / "left")
            right = clone_store_root(seed, home / "right")
            legacy = home / "legacy.json"
            legacy.write_text(json.dumps({"firstName": "Synthetic"}))
            stores = [self.facade.Store(left, legacy), self.composed(right, legacy)]
            with mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T00:00:00Z"):
                results = [store.initialize() for store in stores]
            self.assertTrue(all(result["migratedLegacyProfile"] for result in results))
            assert_store_trees_equal(self, left, right)
            before = snapshot_tree(right)
            stores[1].initialize()
            self.assertEqual(snapshot_tree(right), before)

    def test_validation_failure_precedes_all_initialization_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "store"
            root.mkdir()
            store = self.composed(root, Path(directory) / "absent")
            store.profile_path.write_text('{"schemaVersion":999,"profile":{}}')
            before = snapshot_tree(root)
            for action in (store.initialize, store.validate_workspace_startup):
                with self.assertRaises(self.facade.StoreError):
                    action()
                self.assertEqual(snapshot_tree(root), before)

    def test_startup_validation_does_not_create_absent_store(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "missing"
            self.composed(root, Path(directory) / "absent").validate_workspace_startup()
            self.assertFalse(root.exists())

    def test_session_validation_rejects_symlinks_without_reading_target(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            store = self.composed(home / "store", home / "absent")
            store.initialize()
            outside = home / "private.json"
            outside.write_bytes(b"private invalid JSON")
            link = store.sessions_path / "session.json"
            link.symlink_to(outside)
            with self.assertRaisesRegex(self.facade.StoreError, "regular file"):
                store.validate_workspace_startup()
            self.assertTrue(link.is_symlink())
            self.assertEqual(outside.read_bytes(), b"private invalid JSON")

    def test_canonical_fallback_initializes_without_facade_runtime(self):
        self.leaf._bind_runtime(lambda: {})
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            store = self.composed(home / "store", home / "absent")
            self.assertTrue(store.initialize()["initialized"])
            before = snapshot_tree(store.root)
            store.validate_workspace_startup()
            self.assertEqual(snapshot_tree(store.root), before)

    def test_root_reload_preserves_other_root_runtime_binding(self):
        with tempfile.TemporaryDirectory() as directory:
            roots = [copy_plugin(Path(directory) / name) for name in ("a", "b")]
            facades = [load_module(root / "scripts/job-apply-store.py", name)
                       for root, name in zip(roots, ("startup_a", "startup_b"))]
            leaves = [importlib.import_module(f"{f._PACKAGE_NAME}.domains.startup") for f in facades]
            sentinel = object()
            leaves[1]._bind_runtime(lambda: {"utc_now": sentinel})
            leaves[0]._bind_runtime(lambda: {})
            canonical = leaves[0]._late("utc_now")
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "startup_fresh")
            fresh_leaf = importlib.import_module(f"{fresh._PACKAGE_NAME}.domains.startup")
            self.assertIsNot(fresh_leaf, leaves[0])
            self.assertIs(leaves[0]._late("utc_now"), canonical)
            self.assertIs(leaves[1]._late("utc_now"), sentinel)
