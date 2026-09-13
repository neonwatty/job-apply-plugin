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

    def test_composed_store_rejects_overlapping_direct_methods(self):
        class FirstDomain:
            def collide(self):
                return "first"

        class SecondDomain:
            def collide(self):
                return "second"

        with self.assertRaisesRegex(
            ValueError, r"^domain mixins own overlapping methods: collide$"
        ):
            composed_store_class(self.facade.Store, FirstDomain, SecondDomain)

    def test_composed_store_reuses_an_exact_mixin_already_in_the_base(self):
        class IntegratedDomain:
            def domain_value(self):
                return "integrated"

        class IntegratedStore(IntegratedDomain):
            pass

        self.assertIs(
            composed_store_class(IntegratedStore, IntegratedDomain),
            IntegratedStore,
        )

        class DistinctOverlap:
            def domain_value(self):
                return "distinct"

        with self.assertRaisesRegex(
            ValueError, r"^domain mixins own overlapping methods: domain_value$"
        ):
            composed_store_class(
                IntegratedStore, IntegratedDomain, DistinctOverlap
            )

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

    def test_method_contract_rejects_descriptor_and_execution_kind_drift(self):
        class ExistingStore:
            def operation(self, value: "str") -> "str":
                """Stable operation."""
                return value

        class StaticDomain:
            @staticmethod
            def operation(self, value: "str") -> "str":
                """Stable operation."""
                return value

        class ClassDomain:
            @classmethod
            def operation(cls, value: "str") -> "str":
                """Stable operation."""
                return value

        class CoroutineDomain:
            async def operation(self, value: "str") -> "str":
                """Stable operation."""
                return value

        class GeneratorDomain:
            def operation(self, value: "str") -> "str":
                """Stable operation."""
                yield value

        class AsyncGeneratorDomain:
            async def operation(self, value: "str") -> "str":
                """Stable operation."""
                yield value

        for domain in (StaticDomain, ClassDomain):
            with self.subTest(domain=domain.__name__):
                with self.assertRaisesRegex(AssertionError, "descriptor kind"):
                    assert_method_contract(self, ExistingStore, domain, ["operation"])
        for domain in (CoroutineDomain, GeneratorDomain, AsyncGeneratorDomain):
            with self.subTest(domain=domain.__name__):
                with self.assertRaisesRegex(AssertionError, "execution kind"):
                    assert_method_contract(self, ExistingStore, domain, ["operation"])

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
            (root / "accounts" / "email").mkdir(parents=True)
            (root / "accounts" / "email" / "provider.py").write_text(
                "from ....errors import StoreError\n",
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
            (root / "left.py").write_text("from . import right\n", encoding="utf-8")
            (root / "right.py").write_text("from . import left\n", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "domain dependency cycle"):
                assert_domain_import_direction(self, root)

    def test_import_contract_rejects_over_root_and_from_dot_wiring(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "__init__.py").write_text('"""domains"""\n', encoding="utf-8")
            leaf = root / "profile.py"
            leaf.write_text("from ...errors import StoreError\n", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "invalid relative import"):
                assert_domain_import_direction(self, root)
            leaf.write_text("from ..errors import StoreError\n", encoding="utf-8")
            nested = root / "accounts" / "email"
            nested.mkdir(parents=True)
            provider = nested / "provider.py"
            provider.write_text("from .....errors import StoreError\n", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "invalid relative import"):
                assert_domain_import_direction(self, root)
            provider.unlink()
            leaf.write_text("from . import ExportedName\n", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, r"domain import .*ExportedName"):
                assert_domain_import_direction(self, root)

    def test_cloned_store_helpers_compare_exact_bytes_and_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            source = parent / "source"
            store = self.facade.Store(source)
            store.initialize()
            empty = source / "empty"
            empty.mkdir()
            clone = clone_store_root(source, parent / "clone")
            self.assertEqual(snapshot_tree(source), snapshot_tree(clone))
            assert_store_trees_equal(self, source, clone)
            (clone / "empty").rmdir()
            with self.assertRaises(AssertionError):
                assert_store_trees_equal(self, source, clone)
            byte_clone = clone_store_root(source, parent / "byte-clone")
            cloned_profile = byte_clone / store.profile_path.name
            cloned_profile.write_bytes(cloned_profile.read_bytes() + b" ")
            with self.assertRaises(AssertionError):
                assert_store_trees_equal(self, source, byte_clone)

    @unittest.skipIf(os.name == "nt", "POSIX permission bits are required")
    def test_snapshot_includes_root_and_directory_modes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary) / "store"
            root.mkdir(mode=0o700)
            empty = root / "empty"
            empty.mkdir(mode=0o700)
            document = root / "document.json"
            document.write_text("{}\n", encoding="utf-8")
            os.chmod(root, 0o700)
            os.chmod(empty, 0o700)
            os.chmod(document, 0o600)
            expected = snapshot_tree(root)
            self.assertEqual(expected["."][:2], ("directory", 0o700))
            self.assertEqual(expected["empty"][:2], ("directory", 0o700))
            self.assertEqual(expected["document.json"][:2], ("file", 0o600))
            os.chmod(root, 0o755)
            self.assertNotEqual(snapshot_tree(root), expected)
            os.chmod(root, 0o700)
            os.chmod(empty, 0o755)
            self.assertNotEqual(snapshot_tree(root), expected)
            os.chmod(empty, 0o700)
            os.chmod(document, 0o644)
            self.assertNotEqual(snapshot_tree(root), expected)

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
