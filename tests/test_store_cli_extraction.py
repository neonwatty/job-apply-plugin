"""Frozen parser/dispatch structure and explicit-runtime compatibility."""

from __future__ import annotations

import argparse
import ast
import hashlib
import inspect
import unittest
from unittest.mock import patch

from tests.support.store_facade_contract import load_module, parser_receipt
from tests.test_store_facade_cli_contract import EXPECTED_RECEIPT, RecordingStore


class RuntimeNames(ast.NodeTransformer):
    def visit_Subscript(self, node):
        if (
            isinstance(node.value, ast.Name)
            and node.value.id == "runtime"
            and isinstance(node.slice, ast.Constant)
            and isinstance(node.slice.value, str)
        ):
            return ast.Name(id=node.slice.value, ctx=node.ctx)
        return self.generic_visit(node)


class StoreCliExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_cli_extraction")
        import importlib.util
        from pathlib import Path

        directory = Path(cls.facade.__file__).parent / "job_apply_store"
        for name in ("cli_parser", "cli_dispatch"):
            spec = importlib.util.spec_from_file_location(name, directory / f"{name}.py")
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)
            setattr(cls, name, module)

    def test_normalized_bodies_match_pre_extraction_snapshot(self):
        # Captured from immutable facade 6214176, before extraction.
        cases = (
            (self.cli_parser.build_parser,
             "6be64140bd654bfec00651e761adea8487bc1bdda95de08b4ede97c0f37abc21"),
            (self.cli_dispatch.run,
             "f81da6000101743732227aed753760d5231d7a2a8bdb6da6cd73df5d45c09764"),
        )
        for function, expected in cases:
            with self.subTest(function=function.__name__):
                tree = RuntimeNames().visit(ast.parse(inspect.getsource(function)))
                body = ast.Module(body=tree.body[0].body, type_ignores=[])
                digest = hashlib.sha256(ast.dump(body, include_attributes=False).encode())
                self.assertEqual(digest.hexdigest(), expected)

    def test_all_98_parser_contracts_remain_exact(self):
        parser = self.cli_parser.build_parser(vars(self.facade))
        self.assertEqual(parser_receipt(parser), EXPECTED_RECEIPT)

    def test_dispatch_all_commands_matches_facade_with_synthetic_store(self):
        parser = self.cli_parser.build_parser(vars(self.facade))
        subparsers = next(
            action for action in parser._actions
            if isinstance(action, argparse._SubParsersAction)
        )
        for name, command_parser in subparsers.choices.items():
            with self.subTest(command=name):
                values = {"command": name, "root": "unused", "legacy_profile": None}
                for action in command_parser._actions:
                    if action.dest == "help":
                        continue
                    value = action.default
                    if value is None:
                        value = (
                            next(iter(action.choices)) if action.choices
                            else 3 if action.type is int else "synthetic"
                        )
                    values[action.dest] = value
                args = argparse.Namespace(**values)
                payload = {"decisions": []} if name.startswith("attention-approval-") else {}
                stores = [RecordingStore(), RecordingStore()]
                results = []
                for store, runner in zip(stores, (
                    self.facade.run,
                    lambda args: self.cli_dispatch.run(args, vars(self.facade)),
                )):
                    with patch.object(self.facade, "resolve_store", return_value=store), \
                         patch.object(self.facade, "_read_input", return_value=payload), \
                         patch.object(self.facade, "_scope", return_value={}), \
                         patch.object(self.facade, "answer_key", return_value="answer-key"):
                        results.append(runner(args))
                self.assertEqual(stores[0].calls, stores[1].calls)
                self.assertEqual(results[0], results[1])

    def test_runtime_values_are_read_at_call_time(self):
        runtime = dict(vars(self.facade))
        runtime["STORE_ENV"] = "TEST_STORE_ONE"
        self.assertIn("TEST_STORE_ONE", self.cli_parser.build_parser(runtime).format_help())
        runtime["STORE_ENV"] = "TEST_STORE_TWO"
        self.assertIn("TEST_STORE_TWO", self.cli_parser.build_parser(runtime).format_help())
        runtime["resolve_store"] = lambda args: RecordingStore()
        runtime["_scope"] = lambda value: {"scope": value}
        runtime["answer_key"] = lambda question, scope: [question, scope]
        result = self.cli_dispatch.run(
            argparse.Namespace(command="answer-key", question="Q", scope="S"), runtime
        )
        self.assertEqual(result, {"key": ["Q", {"scope": "S"}]})

    def test_unknown_command_preserves_error_type_and_message(self):
        runtime = dict(vars(self.facade))
        runtime["resolve_store"] = lambda args: RecordingStore()
        with self.assertRaisesRegex(self.facade.StoreError, "unsupported command"):
            self.cli_dispatch.run(argparse.Namespace(command="unknown"), runtime)


if __name__ == "__main__":
    unittest.main()
