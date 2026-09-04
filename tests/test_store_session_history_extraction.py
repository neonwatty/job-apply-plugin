"""Frozen extraction contract plus independent session behavior assertions."""

import ast
import hashlib
import importlib
import inspect
import json
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_method_contract, assert_composed_store_lifecycle, composed_store_class,
)
from tests.support.store_facade_contract import load_module
from tests.support import store_fixtures


METHOD_HASHES = {
    'read_history': 'dcbf04e105f6902dcfc574b7bf17ed13fd83f377b187db72886fa9aa1c7fdf6b',
    'append_history': '4c748ff41cf85c2c4355d09d76cc4ed67a007582a1f6576f314a52ef66590413',
    'record_replay_transition': '8f67b0c7c56f5b84037a27e3a1b3c2b96cfc5fbd34beae53d4e0bbdbcdfecfaa',
}


class SessionExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.facade = load_module(name="session_history_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.sessions.history"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.SessionHistoryMixin
        self.composed = composed_store_class(self.facade.Store, self.mixin)
        self.store = self.composed(self.root / "store", self.root / "legacy.json")

    def test_frozen_ast_and_exact_method_contract(self):
        class Normalize(ast.NodeTransformer):
            def visit_Call(self, node):
                node = self.generic_visit(node)
                if isinstance(node.func, ast.Name) and node.func.id == "_late":
                    return ast.copy_location(ast.Name(id=node.args[0].value, ctx=ast.Load()), node)
                return node
        self.assertEqual(set(METHOD_HASHES), {
            name for name, value in vars(self.mixin).items()
            if inspect.isfunction(value) or isinstance(value, staticmethod)
        })
        assert_method_contract(self, self.facade.Store, self.mixin, set(METHOD_HASHES))
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, set(METHOD_HASHES)
        )
        for name, digest in METHOD_HASHES.items():
            node = ast.parse(textwrap.dedent(inspect.getsource(getattr(self.mixin, name)))).body[0]
            normalized = Normalize().visit(node)
            self.assertEqual(hashlib.sha256(ast.dump(normalized, include_attributes=False).encode()).hexdigest(), digest)

    def test_replay_is_idempotent_and_repairs_session_after_append(self):
        with mock.patch.object(self.store, "save_session", side_effect=OSError("interrupted")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.store.record_replay_transition("application", "started", "greenhouse")
        self.assertEqual(len(self.store.read_history()), 1)
        repaired = self.store.record_replay_transition("application", "started", "greenhouse")
        self.assertEqual(repaired, {"applicationId": "application", "transition": "started", "changed": False})
        self.assertEqual(self.store.load_session("application")["status"], "active")
        reviewed = self.store.record_replay_transition("application", "reviewed", "greenhouse")
        self.assertTrue(reviewed["changed"])
        self.assertEqual(len(self.store.read_history()), 2)

    def test_canonical_history_and_sensitive_failure_leave_bytes_unchanged(self):
        self.leaf._bind_runtime(lambda: {})
        event = self.store.append_history({"applicationId": "app", "event": "started"})
        self.assertEqual(self.store.read_history(), [event])
        before = self.store.history_path.read_bytes()
        with self.assertRaisesRegex(self.facade.StoreError, "unsupported fields"):
            self.store.append_history({"applicationId": "app", "event": "started", "value": "PRIVATE"})
        self.assertEqual(self.store.history_path.read_bytes(), before)
        self.assertNotIn(b"PRIVATE", before)


if __name__ == "__main__":
    unittest.main()
