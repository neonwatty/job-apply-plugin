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
    'save_session': '4be939d4df608abd2b1c1c30ce2bc967d8ec52aa23588f49bf93d57a67fcc023',
    'load_session': '86433089f3846fbae4c8e9d4a0c811ec670ad6c1fbf0090e8c5ee0a5f6366c1b',
    'list_sessions': '7c0f89a052d4c43c3d4a9e0be4309d04bc688de18103f1b2fffdb217a20ebaff',
    '_list_sessions_uninitialized': 'd2b6cd77c9b655c09a9b80485fa913876bfb7f737e44ee13bab1a19e085b7adb',
    'delete_session': '5b56cb17c95cb9a15351052c42f87969bc8a2f88c419b6332998c0ad994bfbfd',
    '_require_generic_session_mutation_allowed_locked': '815038a97fc9a3b23a9543c19d74fbe0679683d28e8956768ff5ae03d64bcedd',
}


class SessionExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.facade = load_module(name="session_lifecycle_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.sessions.lifecycle"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.SessionLifecycleMixin
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

    def test_canonical_roundtrip_sorted_listing_delete_and_job_guard(self):
        self.leaf._bind_runtime(lambda: {})
        self.store.save_session("z", {"status": "review"})
        self.store.save_session("a", {"status": "active"})
        self.assertEqual([item["applicationId"] for item in self.store.list_sessions()], ["a", "z"])
        self.assertEqual(self.store.load_session("z")["status"], "review")
        self.assertEqual(self.store.delete_session("z"), {"deleted": True, "applicationId": "z"})
        self.assertEqual(self.store.delete_session("z"), {"deleted": False, "applicationId": "z"})
        self.store.create_job({"id": "job", "url": "https://example.invalid/job", "company": "Company", "role": "Role"})
        for operation in (lambda: self.store.save_session("job", {}), lambda: self.store.delete_session("job")):
            with self.assertRaisesRegex(self.facade.StoreError, "coordinator operation"):
                operation()

    def test_failed_write_preserves_previous_document_and_fsync_seam(self):
        self.store.save_session("app", {"status": "active"})
        path = self.store.sessions_path / "app.json"
        before = path.read_bytes()
        with mock.patch.object(self.facade, "atomic_write_json", side_effect=OSError("interrupted")):
            with self.assertRaisesRegex(OSError, "interrupted"):
                self.store.save_session("app", {"status": "review"})
        self.assertEqual(path.read_bytes(), before)
        with mock.patch.object(self.facade, "_fsync_directory", wraps=self.facade._fsync_directory) as sync:
            self.store.delete_session("app")
        sync.assert_called_with(self.store.sessions_path)


if __name__ == "__main__":
    unittest.main()
