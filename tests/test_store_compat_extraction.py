"""Frozen adapter bodies and late-bound facade compatibility contracts."""

from __future__ import annotations

import ast
import importlib
import inspect
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from tests.support.store_facade_contract import load_module
from tests.support.ast_contract import canonical_ast_digest


class NormalizeRuntime(ast.NodeTransformer):
    def visit_Subscript(self, node):
        if (
            isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Name)
            and node.value.func.id == "_runtime"
            and isinstance(node.slice, ast.Constant)
        ):
            return ast.Name(id=node.slice.value, ctx=node.ctx)
        return self.generic_visit(node)

    def visit_Name(self, node):
        if node.id == "_runtime":
            return ast.Name(id="globals", ctx=node.ctx)
        return node


class StoreCompatibilityExtractionTests(unittest.TestCase):
    def setUp(self):
        self.facade = load_module(name="store_compat_extraction")
        self.modules = [importlib.import_module(f"{self.facade._PACKAGE_NAME}.{name}")
                        for name in ("compat_storage", "compat_sessions", "compat_validation")]
        self.binding = importlib.import_module(f"{self.facade._PACKAGE_NAME}.compat_runtime")
        self.runtime = dict(vars(self.facade))
        self.binding.bind_runtime(lambda: self.runtime)

    def test_all_60_adapter_bodies_match_immutable_source(self):
        functions = []
        for module in self.modules:
            tree = ast.parse(Path(module.__file__).read_text())
            functions.extend(node for node in tree.body if isinstance(node, ast.FunctionDef))
        self.assertEqual(len(functions), 60)
        tree = NormalizeRuntime().visit(ast.Module(body=functions, type_ignores=[]))
        # Captured independently from facade 614edc3 before adapter extraction.
        self.assertEqual(canonical_ast_digest(tree),
                         "82029defce445d4d3ed5fa25909eaf47608255634bd0cbe7a94c495ef2b73921")

    def test_names_signatures_and_annotations_are_preserved(self):
        for module in self.modules:
            for name in module.__all__:
                with self.subTest(name=name):
                    old, new = getattr(self.facade, name), getattr(module, name)
                    self.assertEqual(str(inspect.signature(old)), str(inspect.signature(new)))
                    self.assertEqual(old.__annotations__, new.__annotations__)
                    self.assertEqual(old.__doc__, new.__doc__)
                    self.assertEqual(old.__name__, new.__name__)

    def test_atomic_io_uses_live_facade_runtime(self):
        storage = self.modules[0]
        with tempfile.TemporaryDirectory() as temporary:
            target = Path(temporary) / "data.json"
            storage.atomic_write_json(target, {"value": "synthetic"})
            self.assertEqual(storage.read_json_object(target, "test"), {"value": "synthetic"})
            replacement = Mock()
            self.runtime["_io"] = replacement
            storage.atomic_write_json(target, {"next": 2})
            replacement.atomic_write_json.assert_called_once_with(
                target, {"next": 2}, _runtime=self.runtime
            )

    def test_adapter_to_adapter_calls_keep_live_replacement_seams(self):
        sessions = self.modules[1]
        sentinel = Mock(return_value="canonical")
        self.runtime["_normalization"] = sentinel
        sessions._canonical_json({})
        sentinel._canonical_json.assert_called_once_with({})
        first = Mock(return_value="first")
        second = Mock(return_value="second")
        self.runtime["_canonical_json"] = first
        value = sessions._legacy_pending_reference("id", {})
        self.runtime["_canonical_json"] = second
        self.assertNotEqual(sessions._legacy_pending_reference("id", {}), value)
        first.assert_called_once()
        second.assert_called_once()

    def test_root_local_binding_does_not_replace_another_facades_runtime(self):
        original = self.binding
        another = load_module(name="store_compat_second")
        binding = importlib.import_module(f"{another._PACKAGE_NAME}.compat_runtime")
        binding.bind_runtime(lambda: vars(another))
        self.assertIs(original.runtime(), self.runtime)
        self.assertIs(binding.runtime(), vars(another))
        self.assertIsNot(original, binding)

    def test_failed_adapter_import_cleans_all_root_private_modules(self):
        original_import = importlib.import_module

        def fail_adapter(name, package=None):
            if name.endswith(".compat_sessions"):
                raise RuntimeError("synthetic adapter failure")
            return original_import(name, package)

        with patch.object(importlib, "import_module", side_effect=fail_adapter):
            with self.assertRaisesRegex(RuntimeError, "synthetic adapter failure"):
                load_module(name="store_compat_failed")
        prefixes = self.facade._ROOT_PRIVATE_PACKAGE_NAMES
        remaining = [name for name in sys.modules if any(
            name == prefix or name.startswith(prefix + ".") for prefix in prefixes
        )]
        self.assertEqual(remaining, [])


if __name__ == "__main__":
    unittest.main()
