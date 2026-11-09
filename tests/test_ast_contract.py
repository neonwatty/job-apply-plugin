from __future__ import annotations

import ast
import unittest

from tests.support.ast_contract import canonical_ast_digest, canonical_ast_dump


class VersionedFunction(ast.AST):
    _fields = ("name", "body", "type_params")

    def __init__(self, name=None, body=None, type_params=None):
        self.name = name
        self.body = [] if body is None else body
        self.type_params = [] if type_params is None else type_params


class AstContractTests(unittest.TestCase):
    def test_only_empty_version_metadata_is_removed_without_mutating_input(self):
        node = VersionedFunction("work", [ast.Pass()], [])

        serialized = canonical_ast_dump(node)

        self.assertEqual(serialized, "VersionedFunction(name='work', body=[Pass()])")
        self.assertEqual(node.type_params, [])

    def test_meaningful_generic_parameters_remain_hash_significant(self):
        generic_t = VersionedFunction("identity", [], [ast.Name(id="T")])
        generic_u = VersionedFunction("identity", [], [ast.Name(id="U")])
        plain = VersionedFunction("identity", [], [])

        self.assertIn("type_params", canonical_ast_dump(generic_t))
        self.assertNotEqual(canonical_ast_digest(generic_t), canonical_ast_digest(generic_u))
        self.assertNotEqual(canonical_ast_digest(generic_t), canonical_ast_digest(plain))
        if "type_params" in ast.FunctionDef._fields:
            parsed_generic = ast.parse(
                "def identity[T](value: T) -> T:\n    return value\n"
            )
            parsed_plain = ast.parse(
                "def identity(value):\n    return value\n"
            )
            self.assertIn("type_params", canonical_ast_dump(parsed_generic))
            self.assertNotEqual(
                canonical_ast_digest(parsed_generic),
                canonical_ast_digest(parsed_plain),
            )

    def test_control_flow_remains_hash_significant(self):
        conditional = ast.parse("if ready:\n    execute()\n")
        loop = ast.parse("while ready:\n    execute()\n")

        self.assertNotEqual(
            canonical_ast_digest(conditional), canonical_ast_digest(loop)
        )

    def test_pre_type_parameter_dump_stays_frozen(self):
        tree = ast.parse("def work(value):\n    return value + 1\n")

        self.assertEqual(
            canonical_ast_digest(tree),
            "57c49469e67c31c65ae7eb86ab413a255ec610945f66e0b8eb2602e56c8d2091",
        )


if __name__ == "__main__":
    unittest.main()
