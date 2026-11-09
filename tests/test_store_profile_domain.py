from __future__ import annotations

import importlib
import inspect
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_PATH = ROOT / "scripts" / "job_apply_store" / "domains" / "profile.py"
PURE_HELPERS = {
    "_merge_object_patch",
    "_apply_profile_patch",
    "_changed_json_pointer_paths",
    "_protect_user_provenance",
    "_user_protects_path",
    "_fact_leaf_paths",
    "_stamp_fact_provenance",
}
STORE_METHODS = {
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
}
OWNED_METHODS = PURE_HELPERS | STORE_METHODS
DEFERRED_METHODS = {
    "__init__",
    "initialize",
    "profile_preparedness",
    "_meaningfully_present",
    "_validate_existing_documents",
}


class ProfileStoreDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_profile_domain_contract")
        cls.domain = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.profile"
        )
        cls.mixin = cls.domain.ProfileStoreMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def stores(self):
        source = self.home / "source"
        original = self.facade.Store(source, self.home / "legacy.json")
        original.initialize()
        clone = clone_store_root(source, self.home / "composed")
        return original, self.composed(clone, self.home / "other-legacy.json")

    def call_both(self, stores, operation):
        values = [operation(store) for store in stores]
        self.assertEqual(values[0], values[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        return values[0]

    def test_leaf_owns_exact_reviewed_boundary_with_preserved_contracts(self):
        self.assertEqual(
            {
                name
                for name, value in vars(self.mixin).items()
                if inspect.isfunction(value) or isinstance(value, staticmethod)
            },
            OWNED_METHODS,
        )
        assert_method_contract(self, self.facade.Store, self.mixin, STORE_METHODS)
        for name in PURE_HELPERS:
            extracted = inspect.getattr_static(self.mixin, name)
            self.assertIsInstance(extracted, staticmethod)
            function = extracted.__func__
            original = (
                getattr(self.facade, name)
                if hasattr(self.facade, name)
                else getattr(self.facade.Store, name)
            )
            self.assertEqual(str(inspect.signature(function)), str(inspect.signature(original)))
            self.assertEqual(function.__doc__, original.__doc__)
            self.assertEqual(function.__annotations__, original.__annotations__)
        for name in DEFERRED_METHODS:
            self.assertNotIn(name, vars(self.mixin))

    def test_composed_mro_resolves_every_owned_method_to_leaf(self):
        assert_composed_store_lifecycle(
            self,
            self.facade.Store,
            self.mixin,
            self.composed,
            OWNED_METHODS,
        )

    def test_profile_source_is_small_and_has_no_facade_or_sibling_imports(self):
        self.assertLessEqual(len(DOMAIN_PATH.read_bytes().splitlines()), 500)
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)

    def test_reads_are_equivalent_and_do_not_mutate_initialized_clones(self):
        stores = self.stores()
        before = [snapshot_tree(store.root) for store in stores]
        self.assertEqual(stores[0].get_profile(), stores[1].get_profile())
        self.assertEqual(stores[0].inspect_profile(), stores[1].inspect_profile())
        self.assertEqual(stores[0].get_preferences(), stores[1].get_preferences())
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])

    def test_replace_patch_provenance_and_preferences_are_byte_equivalent(self):
        stores = self.stores()
        now = "2026-09-04T12:00:00Z"
        with mock.patch.object(self.facade, "utc_now", return_value=now):
            replaced = self.call_both(
                stores,
                lambda store: store.replace_profile(
                    {
                        "firstName": "Ada",
                        "location": {"city": "Phoenix", "country": "US"},
                        "preferences": {"targetTitles": ["Engineer"]},
                    },
                    1,
                    "resume",
                ),
            )
            patched = self.call_both(
                stores,
                lambda store: store.patch_profile(
                    {"location": {"city": "Tempe"}, "skills": ["Python"]},
                    replaced["revision"],
                    "user",
                ),
            )
            merged = self.call_both(
                stores,
                lambda store: store.set_preferences(
                    {"remotePreference": "hybrid"}, patched["revision"], "user"
                ),
            )
            final = self.call_both(
                stores,
                lambda store: store.set_preferences(
                    {"targetTitles": ["Staff Engineer"]},
                    merged["revision"],
                    "user",
                    replace=True,
                ),
            )
        self.assertEqual(final["profile"]["location"]["country"], "US")
        self.assertEqual(final["factProvenance"]["/location/city"]["source"], "user")
        self.assertEqual(final["factProvenance"]["/location/country"]["source"], "resume")

    def test_atomic_null_delete_and_noops_preserve_exact_behavior(self):
        stores = self.stores()
        now = "2026-09-04T13:00:00Z"
        with mock.patch.object(self.facade, "utc_now", return_value=now):
            seeded = self.call_both(
                stores,
                lambda store: store.patch_profile(
                    {"futureConfig": {"enabled": True}}, 1, "resume"
                ),
            )
            stored_null = self.call_both(
                stores,
                lambda store: store.patch_profile(
                    {"futureConfig": None},
                    seeded["revision"],
                    "user",
                    atomic_paths=["/futureConfig"],
                ),
            )
            deleted = self.call_both(
                stores,
                lambda store: store.patch_profile(
                    {"futureConfig": None},
                    stored_null["revision"],
                    "user",
                    atomic_paths=["/futureConfig"],
                    deleted_paths=["/futureConfig"],
                ),
            )
            before = [snapshot_tree(store.root) for store in stores]
            values = [
                store.replace_profile(deleted["profile"], deleted["revision"], "user")
                for store in stores
            ]
        self.assertEqual(values[0], values[1])
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])

    def test_rejected_writes_are_equivalent_and_non_mutating(self):
        stores = self.stores()
        now = "2026-09-04T14:00:00Z"
        with mock.patch.object(self.facade, "utc_now", return_value=now):
            seeded = self.call_both(
                stores,
                lambda store: store.patch_profile(
                    {"location": {"city": "Phoenix"}}, 1, "user"
                ),
            )
        cases = (
            lambda store: store.patch_profile(
                {"location": {"city": "Mesa"}}, seeded["revision"], "agent"
            ),
            lambda store: store.patch_profile(
                {"firstName": "Grace"}, seeded["revision"] - 1, "user"
            ),
            lambda store: store.patch_profile(
                {"firstName": "Grace"},
                seeded["revision"],
                "user",
                deleted_paths=["/firstName"],
            ),
        )
        for index, operation in enumerate(cases):
            with self.subTest(case=index):
                before = [snapshot_tree(store.root) for store in stores]
                errors = []
                for store in stores:
                    with self.assertRaises(self.facade.StoreError) as raised:
                        operation(store)
                    errors.append(str(raised.exception))
                self.assertEqual(errors[0], errors[1])
                self.assertEqual(before, [snapshot_tree(store.root) for store in stores])

    def test_late_runtime_clock_and_write_patches_are_observed(self):
        store = self.composed(self.home / "late", self.home / "legacy.json")
        store.initialize()
        original_write = self.facade.atomic_write_json
        write_spy = mock.Mock(wraps=original_write)
        now = "2026-09-04T15:00:00Z"
        with mock.patch.object(self.facade, "utc_now", return_value=now), mock.patch.object(
            self.facade, "atomic_write_json", write_spy
        ):
            result = store.patch_profile({"firstName": "Ada"}, 1, "user")
        self.assertEqual(result["updatedAt"], now)
        self.assertEqual(result["factProvenance"]["/firstName"]["updatedAt"], now)
        self.assertEqual(write_spy.call_count, 1)

    def test_same_revision_race_has_one_winner_and_one_conflict(self):
        for index, store_type in enumerate((self.facade.Store, self.composed)):
            with self.subTest(store=store_type.__name__):
                identity = f"{store_type.__name__}-{index}"
                root = self.home / identity
                store = store_type(root, self.home / f"{identity}.json")
                store.initialize()

                def patch(value):
                    try:
                        return store.patch_profile({"firstName": value}, 1, "user")
                    except self.facade.StoreError as error:
                        return str(error)

                with ThreadPoolExecutor(max_workers=2) as executor:
                    outcomes = list(executor.map(patch, ("Ada", "Grace")))
                self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
                self.assertEqual(outcomes.count("profile revision conflict"), 1)
                self.assertEqual(store.inspect_profile()["revision"], 2)

    def test_atomic_write_failure_preserves_bytes_modes_and_temp_cleanup(self):
        stores = self.stores()
        for store in stores:
            with self.subTest(store=type(store).__name__):
                with self.facade.exclusive_file_lock(store.store_lock_path):
                    pass
                before = snapshot_tree(store.root)
                with mock.patch.object(
                    self.facade.os, "replace", side_effect=OSError("boom")
                ):
                    with self.assertRaisesRegex(OSError, "boom"):
                        store.patch_profile({"firstName": "Ada"}, 1, "user")
                self.assertEqual(snapshot_tree(store.root), before)
                self.assertEqual(list(store.root.glob(".profile.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
