"""Frozen extraction contract plus independent session behavior assertions."""

import ast
import importlib
import inspect
import json
import sys
import tempfile
import textwrap
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_method_contract, assert_composed_store_lifecycle, composed_store_class,
)
from tests.support.ast_contract import canonical_ast_digest
from tests.support.store_facade_contract import load_module
from tests.support import store_fixtures
from tests.test_store_loader_isolation import copy_plugin


METHOD_HASHES = {
    '_session_path': 'aaab1b430f3d1d4acbb41f236e58e5345617aa8b9dc3277bdf5d1ae4d660aea0',
    '_read_session_projection': '69708a27d29b441980f94464277730bfc0786137c41af0946f672daa7df4158e',
    '_build_session': 'e845f580953126d9fa57a85bff9d2ac3a5f6f00cefdbaf98c44a1313da75233c',
}


class SessionExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.facade = load_module(name="session_document_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.sessions.document"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.SessionDocumentMixin
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
            self.assertEqual(canonical_ast_digest(normalized), digest)

    def test_canonical_document_strips_ephemeral_values_and_reuses_reference(self):
        self.leaf._bind_runtime(lambda: {})
        incoming = {"company": "PRIVATE", "url": "https://private.invalid", "pendingFields": [{"question": "PRIVATE QUESTION", "state": "missing"}]}
        first = self.store.save_session("app", incoming)
        second = self.store.save_session("app", incoming)
        self.assertEqual(first["pendingFields"][0]["reference"], second["pendingFields"][0]["reference"])
        self.assertNotIn("PRIVATE", json.dumps(second))
        self.assertNotIn("private.invalid", json.dumps(second))
        self.assertEqual(second["blockers"][0]["code"], "answer-required")
        with self.assertRaises(self.facade.StoreError):
            self.store._session_path("../escape")

    def test_canonical_legacy_projection_preserves_bytes_and_rejects_mixed_shapes(self):
        self.store.initialize()
        legacy = store_fixtures.legacy_1_2_session("app", None)
        path = self.store.sessions_path / "app.json"
        path.write_text(json.dumps(legacy), encoding="utf-8")
        before = path.read_bytes()
        self.leaf._bind_runtime(lambda: {})
        projected = self.store._read_session_projection(path)
        self.assertEqual(path.read_bytes(), before)
        self.assertTrue(all("question" not in field for field in projected["pendingFields"]))
        self.assertTrue(all(field["reference"].startswith("pending_") for field in projected["pendingFields"]))
        self.assertEqual(projected, self.facade._project_legacy_session(legacy))
        legacy["pendingFields"].append({"reference": "pending_" + "a" * 32, "state": "missing"})
        path.write_text(json.dumps(legacy), encoding="utf-8")
        invalid = path.read_bytes()
        with self.assertRaisesRegex(self.facade.StoreError, "cannot be mixed"):
            self.store._read_session_projection(path)
        self.assertEqual(path.read_bytes(), invalid)

    def test_canonical_companions_and_bindings_survive_other_root_reload(self):
        roots = [copy_plugin(self.root / name) for name in ("a", "b")]
        facades = [load_module(root / "scripts/job-apply-store.py", name)
                   for root, name in zip(roots, ("session_a", "session_b"))]
        runtimes = []
        for facade in facades:
            leaf = importlib.import_module(f"{facade._PACKAGE_NAME}.domains.sessions.document")
            leaf._bind_runtime(lambda: {})
            runtime = leaf.sessions_runtime
            runtimes.append(runtime)
        saved_path = list(sys.path)
        ambient_qa = {key: value for key, value in sys.modules.items()
                      if key == "qa" or key.startswith("qa.")}
        def load(pair):
            runtime, name = pair
            companion = runtime.companion(name)
            self.assertTrue(Path(companion.__file__).resolve().is_relative_to(runtime.SCRIPT_PATH.parent))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(load, [(runtime, name) for runtime in runtimes
                                 for name in ("job_apply_answer_match", "job_apply_form_readiness")]))
        self.assertEqual(sys.path, saved_path)
        self.assertEqual({key: value for key, value in sys.modules.items()
                          if key == "qa" or key.startswith("qa.")}, ambient_qa)
        other_companion = runtimes[1].companion("job_apply_answer_match")
        fresh = load_module(roots[0] / "scripts/job-apply-store.py", "session_reload")
        fresh_leaf = importlib.import_module(f"{fresh._PACKAGE_NAME}.domains.sessions.document")
        self.assertIsNot(fresh_leaf.sessions_runtime, runtimes[0])
        fresh_store = composed_store_class(fresh.Store, fresh_leaf.SessionDocumentMixin)(self.root / "fresh")
        result = fresh_store.save_session("fresh", {"pendingFields": [{"question": "PRIVATE", "state": "missing"}]})
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertIs(runtimes[1].companion("job_apply_answer_match"), other_companion)
        self.assertIs(sys.modules[runtimes[1].__name__], runtimes[1])
        validated = runtimes[1]._project_legacy_session(store_fixtures.legacy_1_2_session("other", None))
        self.assertTrue(validated["pendingFields"][0]["reference"].startswith("pending_"))


if __name__ == "__main__":
    unittest.main()
