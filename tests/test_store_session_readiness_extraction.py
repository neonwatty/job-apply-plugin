"""Frozen extraction contract plus independent session behavior assertions."""

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
    assert_method_contract, assert_composed_store_lifecycle, composed_store_class,
)
from tests.support.ast_contract import canonical_ast_digest
from tests.support.store_facade_contract import load_module
from tests.support import store_fixtures


METHOD_HASHES = {
    'profile_preparedness': 'af2d047ad657c641cb20c88919a5e131d488c95598088d2cd68db3e1ce1b6563',
    '_readiness_blocker_type': '692401032aac15c30a35fb7149052062de0f24d2644d286b13ed5848103e7f60',
    '_recompute_readiness': 'd1d475381152f79d166d6f055ce48b83e24428fca13fb678cce77eaf73c6271f',
}


class SessionExtractionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.facade = load_module(name="session_readiness_contract")
        self.leaf = importlib.import_module(
            f"{self.facade._PACKAGE_NAME}.domains.sessions.readiness"
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))
        self.mixin = self.leaf.SessionReadinessMixin
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

    def test_canonical_bundled_evidence_and_invalid_fixture_fail_closed(self):
        packet = store_fixtures.review_session(self.facade, 4, "review", "greenhouse-form-readiness-v1")["readinessInput"]
        expected = self.facade.Store(self.root / "oracle")._recompute_readiness(packet, 4, "greenhouse")
        self.leaf._bind_runtime(lambda: {})
        self.assertEqual(self.store._recompute_readiness(packet, 4, "greenhouse"), expected)
        self.assertEqual(expected["attemptRevision"], 4)
        self.assertNotIn("fixture", expected)
        with self.assertRaisesRegex(self.facade.StoreError, "current attempt"):
            self.store._recompute_readiness(packet, 5, "greenhouse")
        packet["fixture"]["id"] = "../../PRIVATE"
        with self.assertRaisesRegex(self.facade.StoreError, "evidence is invalid"):
            self.store._recompute_readiness(packet, 4, "greenhouse")

    def test_preparedness_is_value_free_with_explicit_setup_states(self):
        self.store.patch_profile({"firstName": "PRIVATE", "email": "private@example.invalid"}, 1, "user")
        self.leaf._bind_runtime(lambda: {})
        result = self.store.profile_preparedness()
        states = {item["id"]: item["state"] for item in result["essentialSetup"]}
        self.assertEqual(states, {"first_name": "present", "last_name": "blocked", "email": "present", "default_resume": "blocked"})
        self.assertNotIn("PRIVATE", json.dumps(result))
        self.assertNotIn("private@example.invalid", json.dumps(result))
        self.assertEqual(self.mixin._readiness_blocker_type("final-review"), "final_action")


if __name__ == "__main__":
    unittest.main()
