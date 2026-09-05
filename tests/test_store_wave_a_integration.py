from __future__ import annotations

import ast
import importlib
import inspect
import tempfile
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    source_inventory,
)
from tests.support.store_facade_contract import (
    PRIVATE_STORE_SIGNATURES,
    PUBLIC_STORE_SIGNATURES,
    ROOT,
    SCRIPT,
    load_module,
    signatures,
)


DOMAINS_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
PROFILE_HELPERS = {
    "_merge_object_patch",
    "_apply_profile_patch",
    "_changed_json_pointer_paths",
    "_protect_user_provenance",
    "_user_protects_path",
    "_fact_leaf_paths",
    "_stamp_fact_provenance",
}
PROFILE_METHODS = {
    "_has_application_facts",
    "_load_profile_document",
    "_validate_profile_document_value",
    "get_profile",
    "inspect_profile",
    "_profile_inspection",
    "replace_profile",
    "patch_profile",
    "get_preferences",
    "set_preferences",
} | PROFILE_HELPERS
FACT_METHODS = {
    "_load_fact_groups_document",
    "_fact_group_sort_key",
    "_reject_fact_group_label_collision",
    "list_fact_groups",
    "get_fact_group",
    "create_fact_group",
    "update_fact_group",
    "delete_fact_group",
}
ANSWER_METHODS = {
    "_load_answers_document",
    "_answer_view",
    "_answer_is_sensitive",
    "_answer_redirects",
    "_resolve_answer_key_in_document",
    "_answer_reference_counts",
    "_answer_projection",
    "answer_detail_projection",
    "_answer_mutation_projection",
    "_get_answer_record",
    "_answer_candidates",
    "get_answer",
    "_list_answer_records",
    "list_answers",
    "query_answers",
    "reveal_answer",
    "find_answer",
    "_semantic_candidate",
    "semantic_answer_lookup",
}
EXTRACTED_METHODS = PROFILE_METHODS | FACT_METHODS | ANSWER_METHODS
INHERITED_CROSS_DOMAIN_HELPERS = {
    "_has_application_facts",
    "_user_protects_path",
    "_stamp_fact_provenance",
    "_validate_profile_document_value",
}
FIXED_TIME = datetime(2026, 9, 4, 18, 0, tzinfo=timezone.utc)
FIXED_NOW = "2026-09-04T18:00:00Z"
FIXED_GROUP_ID = "12345678123456781234567812345678"


class StoreWaveAIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_wave_a_integration")
        package = cls.facade._PACKAGE_NAME
        cls.profile_module = importlib.import_module(f"{package}.domains.profile")
        cls.facts_module = importlib.import_module(f"{package}.domains.profile_facts")
        cls.answer_module = importlib.import_module(f"{package}.domains.answers.read")
        cls.mixins = (
            cls.profile_module.ProfileStoreMixin,
            cls.facts_module.ProfileFactsStoreMixin,
            cls.answer_module.AnswerReadMixin,
        )

    def test_private_domain_inventory_and_exact_store_composition(self):
        self.assertEqual(len(EXTRACTED_METHODS), 44)
        self.assertIs(self.facade._profile_domain, self.profile_module)
        self.assertIs(self.facade._profile_facts_domain, self.facts_module)
        self.assertIs(self.facade._answer_read_domain, self.answer_module)
        self.assertEqual(
            self.facade.Store.__mro__[:4],
            (self.facade.Store, *self.mixins),
        )
        owned = [
            PROFILE_METHODS,
            FACT_METHODS,
            ANSWER_METHODS,
        ]
        self.assertFalse((owned[0] & owned[1]) | (owned[0] & owned[2]) | (owned[1] & owned[2]))
        for mixin, names in zip(self.mixins, owned):
            for name in names:
                with self.subTest(name=name):
                    self.assertIs(
                        inspect.getattr_static(self.facade.Store, name),
                        inspect.getattr_static(mixin, name),
                    )

    def test_store_metadata_and_supported_signatures_stay_frozen(self):
        store = self.facade.Store
        self.assertEqual((store.__name__, store.__qualname__), ("Store", "Store"))
        self.assertEqual(store.__module__, "store_wave_a_integration")
        self.assertIsNone(store.__doc__)
        self.assertEqual(
            str(inspect.signature(store.__init__)),
            "(self, root: 'Path', legacy_profile: 'Path | None' = None, clock=None)",
        )
        self.assertEqual(signatures(store, PUBLIC_STORE_SIGNATURES), PUBLIC_STORE_SIGNATURES)
        self.assertEqual(signatures(store, PRIVATE_STORE_SIGNATURES), PRIVATE_STORE_SIGNATURES)

    def test_facade_has_no_duplicate_bodies_or_unqualified_moved_helper_calls(self):
        tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
        top_functions = {
            node.name for node in tree.body if isinstance(node, ast.FunctionDef)
        }
        store_node = next(
            node for node in tree.body
            if isinstance(node, ast.ClassDef) and node.name == "Store"
        )
        direct_methods = {
            node.name for node in store_node.body if isinstance(node, ast.FunctionDef)
        }
        self.assertFalse(PROFILE_HELPERS & top_functions)
        self.assertFalse(EXTRACTED_METHODS & direct_methods)
        unqualified = {
            node.func.id
            for node in ast.walk(store_node)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        self.assertFalse(INHERITED_CROSS_DOMAIN_HELPERS & unqualified)

    def test_answer_runtime_is_bound_to_this_facade_and_observes_late_patches(self):
        self.assertIs(self.answer_module._RUNTIME_PROVIDER(), vars(self.facade))
        with tempfile.TemporaryDirectory() as temporary:
            store = self.facade.Store(Path(temporary) / "store")
            with mock.patch.object(
                self.facade, "normalize_question", return_value="late-bound"
            ) as normalizer:
                self.assertEqual(
                    store._answer_candidates({"question": "Original?"}),
                    {"late-bound"},
                )
            normalizer.assert_called_once_with("Original?")

    def test_combined_leaf_operations_match_a_cloned_preintegration_store(self):
        with tempfile.TemporaryDirectory() as temporary:
            parent = Path(temporary)
            source = parent / "source"
            baseline_type = self.facade.Store
            composed_type = composed_store_class(baseline_type, *self.mixins)
            writer = baseline_type(source, clock=lambda: FIXED_TIME)
            with mock.patch.object(self.facade, "utc_now", return_value=FIXED_NOW):
                writer.initialize()
                answer = writer.put_answer({
                    "question": "Are you authorized to work here?",
                    "aliases": ["Work authorization"],
                    "state": "confirmed",
                    "value": "Yes",
                    "fieldClass": "authorization",
                })
            left = baseline_type(
                clone_store_root(source, parent / "baseline"),
                clock=lambda: FIXED_TIME,
            )
            right = composed_type(
                clone_store_root(source, parent / "integrated"),
                clock=lambda: FIXED_TIME,
            )

            def exercise(store):
                profile = store.patch_profile(
                    {"firstName": "Ada", "location": {"city": "Phoenix"}},
                    1,
                    "resume",
                )
                with mock.patch.object(
                    self.facade.uuid,
                    "uuid4",
                    return_value=uuid.UUID(hex=FIXED_GROUP_ID),
                ):
                    group = store.create_fact_group({
                        "label": "Core facts",
                        "paths": ["/firstName", "/location/city"],
                    })
                return {
                    "profile": profile,
                    "inspect": store.inspect_profile(),
                    "facts": store.list_fact_groups(),
                    "group": store.get_fact_group(group["id"]),
                    "answer": store.get_answer(answer["key"]),
                    "answers": store.query_answers(query="authorization"),
                    "found": store.find_answer("Work authorization", {}),
                }

            with mock.patch.object(self.facade, "utc_now", return_value=FIXED_NOW):
                expected = exercise(left)
                actual = exercise(right)
            self.assertEqual(actual, expected)
            assert_store_trees_equal(self, left.root, right.root)

    def test_domain_inventory_names_the_three_integrated_leaves(self):
        inventory = source_inventory(DOMAINS_ROOT)
        self.assertEqual(
            set(inventory),
            {
                "__init__",
                "profile",
                "profile_facts",
                "answers.__init__",
                "answers.read",
                "answers.mutations",
                "answers.merge",
                "answers.cleanup",
                "jobs.__init__",
                "jobs.crud",
                "jobs.overview",
                "jobs.upsert",
                "jobs.legacy",
                "resumes.__init__", "extractions.__init__",
                "resumes.storage",
                "resumes.read",
                "resumes.mutations",
                "resumes.lifecycle",
                "extractions.journal",
                "extractions.requests",
                "extractions.proposals",
                "sessions.__init__", "sessions.history", "sessions.readiness",
                "sessions.document", "sessions.lifecycle",
                "coordinator.__init__",
                "coordinator.persistence",
                "coordinator.claims",
                "coordinator.attention",
                "coordinator.progress",
                "coordinator.approvals",
                "accounts.email_execution",
                "accounts.email_scope",
                "accounts.operations",
                "accounts.password_execution",
                "accounts.registry",
                "accounts.settings",
                "accounts.synthetic",
                "accounts.trusted_fill",
                "startup",
            },
        )


if __name__ == "__main__":
    unittest.main()
