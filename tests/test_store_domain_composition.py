from __future__ import annotations

import ast
import os
import tempfile
import unittest
from pathlib import Path

from tests.support.store_domain_contract import (
    assert_domain_import_direction,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
    source_inventory,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
SUPPORT = ROOT / "tests" / "support" / "store_domain_contract.py"
THIS_TEST = ROOT / "tests" / "test_store_domain_composition.py"


class StoreDomainCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_domain_composition_contract")

    def test_domain_package_is_minimal_directional_and_size_bounded(self):
        inventory = source_inventory(DOMAIN_ROOT)
        self.assertIn("__init__", inventory)
        self.assertEqual(inventory["__init__"], {})
        assert_domain_import_direction(self, DOMAIN_ROOT)
        init_tree = ast.parse((DOMAIN_ROOT / "__init__.py").read_text(encoding="utf-8"))
        self.assertFalse(
            [node for node in ast.walk(init_tree) if isinstance(node, (ast.Import, ast.ImportFrom))]
        )
        for path in [*DOMAIN_ROOT.rglob("*.py"), SUPPORT, THIS_TEST]:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertLessEqual(len(path.read_bytes().splitlines()), 500)

    def test_composed_store_mro_is_ordered_and_uses_real_store_state(self):
        class FirstDomain:
            def domain_value(self, collaborator):
                return collaborator(self.profile_path)

        class SecondDomain:
            def domain_order(self):
                return "second"

        composed = composed_store_class(self.facade.Store, FirstDomain, SecondDomain)
        self.assertEqual(
            composed.__mro__[:4],
            (composed, FirstDomain, SecondDomain, self.facade.Store),
        )
        with tempfile.TemporaryDirectory() as temporary:
            store = composed(Path(temporary) / "store")
            store.initialize()
            self.assertEqual(
                store.domain_value(lambda path: path.read_bytes()),
                store.profile_path.read_bytes(),
            )
            self.assertEqual(store.domain_order(), "second")
            self.assertEqual(store.paths()["root"], str(store.root))

    def test_method_contract_accepts_new_owner_but_rejects_metadata_drift(self):
        class ExistingStore:
            def inspect(self, value: "str", enabled: "bool" = True) -> "dict[str, object]":
                """Stable method documentation."""
                return {"value": value, "enabled": enabled}

        class ExtractedDomain:
            def inspect(self, value: "str", enabled: "bool" = True) -> "dict[str, object]":
                """Stable method documentation."""
                return {"value": value, "enabled": enabled}

        class DriftedDomain:
            def inspect(self, value: "str") -> "dict[str, object]":
                """Changed documentation."""
                return {"value": value}

        assert_method_contract(self, ExistingStore, ExtractedDomain, ["inspect"])
        with self.assertRaises(AssertionError):
            assert_method_contract(self, ExistingStore, DriftedDomain, ["inspect"])

    def test_source_inventory_freezes_module_class_and_method_ownership(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "answers").mkdir()
            (root / "__init__.py").write_text('"""domains"""\n', encoding="utf-8")
            (root / "answers" / "read.py").write_text(
                "class AnswerReadDomain:\n"
                "    def get_answer(self):\n"
                "        return None\n\n"
                "    async def list_answers(self):\n"
                "        return []\n",
                encoding="utf-8",
            )
            self.assertEqual(
                source_inventory(root),
                {
                    "__init__": {},
                    "answers.read": {
                        "AnswerReadDomain": ("get_answer", "list_answers"),
                    },
                },
            )

    def test_import_contract_allows_common_primitives_and_rejects_domain_wiring(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "answers").mkdir()
            (root / "__init__.py").write_text('"""domains"""\n', encoding="utf-8")
            (root / "profile.py").write_text(
                "from ..errors import StoreError\n",
                encoding="utf-8",
            )
            (root / "answers" / "read.py").write_text(
                "from pathlib import Path\nfrom ...io import read_json_object\n",
                encoding="utf-8",
            )
            assert_domain_import_direction(self, root)
            (root / "facts.py").write_text(
                "from .profile import ProfileDomain\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(AssertionError, "domain import"):
                assert_domain_import_direction(self, root)
            (root / "facade_access.py").write_text(
                "from job_apply_store_facade import Store\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(AssertionError, "facade import"):
                assert_domain_import_direction(self, root)

    def test_import_contract_reports_cycles_as_well_as_forbidden_edges(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "__init__.py").write_text('"""domains"""\n', encoding="utf-8")
            (root / "left.py").write_text("from .right import Right\n", encoding="utf-8")
            (root / "right.py").write_text("from .left import Left\n", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "domain dependency cycle"):
                assert_domain_import_direction(self, root)

    def test_cloned_store_helpers_compare_exact_bytes_and_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            source = parent / "source"
            store = self.facade.Store(source)
            store.initialize()
            clone = clone_store_root(source, parent / "clone")
            self.assertEqual(snapshot_tree(source), snapshot_tree(clone))
            assert_store_trees_equal(self, source, clone)
            store.profile_path.write_bytes(store.profile_path.read_bytes() + b" ")
            with self.assertRaises(AssertionError):
                assert_store_trees_equal(self, source, clone)

    def test_snapshot_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            target = root / "target"
            target.write_text("private", encoding="utf-8")
            link = root / "link"
            try:
                os.symlink(target, link)
            except (OSError, NotImplementedError):
                self.skipTest("symlink creation is unavailable")
            with self.assertRaisesRegex(AssertionError, "symlink"):
                snapshot_tree(root)


if __name__ == "__main__":
    unittest.main()
