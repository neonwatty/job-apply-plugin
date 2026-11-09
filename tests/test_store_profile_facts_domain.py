from __future__ import annotations

import importlib
import inspect
import json
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_domain_import_direction,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
OWNED_METHODS = {
    "_load_fact_groups_document",
    "_fact_group_sort_key",
    "_reject_fact_group_label_collision",
    "list_fact_groups",
    "get_fact_group",
    "create_fact_group",
    "update_fact_group",
    "delete_fact_group",
}
FIRST_TIME = datetime(2026, 9, 4, 12, 0, tzinfo=timezone.utc)
SECOND_TIME = datetime(2026, 9, 4, 12, 5, tzinfo=timezone.utc)
FIRST_ID = "1" * 32
SECOND_ID = "2" * 32


class SequenceClock:
    def __init__(self, *values: datetime):
        self.values = iter(values)

    def __call__(self) -> datetime:
        return next(self.values)


class StoreProfileFactsDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_profile_facts_domain_contract")
        cls.domain_module = importlib.import_module(
            f"{cls.facade._implementation.__name__}.domains.profile_facts"
        )
        cls.mixin = cls.domain_module.ProfileFactsStoreMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.parent = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def make_store(self, name: str = "store", clock=None):
        return self.composed(self.parent / name, clock=clock or (lambda: FIRST_TIME))

    @staticmethod
    def patch_uuid(facade, *identities: str):
        values = iter(identities)
        return mock.patch.object(
            facade.uuid, "uuid4", side_effect=lambda: uuid.UUID(hex=next(values))
        )

    def test_plain_mixin_owns_exact_method_contract_and_directional_imports(self):
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertEqual(
            {
                name
                for name, value in vars(self.mixin).items()
                if inspect.isfunction(value) or isinstance(value, staticmethod)
            },
            OWNED_METHODS,
        )
        assert_method_contract(self, self.facade.Store, self.mixin, OWNED_METHODS)
        assert_composed_store_lifecycle(
            self,
            self.facade.Store,
            self.mixin,
            self.composed,
            OWNED_METHODS,
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)
        source = (DOMAIN_ROOT / "profile_facts.py").read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn("StoreBase", source)
        self.assertNotIn("super(", source)

    def test_empty_list_missing_get_and_invalid_id_do_not_mutate_store(self):
        store = self.make_store()
        store.initialize()
        before = {path.name: path.read_bytes() for path in store.root.iterdir() if path.is_file()}
        self.assertEqual(store.list_fact_groups(), [])
        self.assertIsNone(store.get_fact_group(FIRST_ID))
        with self.assertRaisesRegex(self.facade.StoreError, "fact group id is invalid"):
            store.get_fact_group("not-an-id")
        after = {path.name: path.read_bytes() for path in store.root.iterdir() if path.is_file()}
        self.assertEqual(after, before)

    def test_implicit_and_explicit_orders_sort_by_order_label_then_id(self):
        store = self.make_store(clock=lambda: FIRST_TIME)
        with self.patch_uuid(self.facade, SECOND_ID, FIRST_ID, "3" * 32):
            first = store.create_fact_group({"label": "Zulu", "paths": ["/z"]})
            second = store.create_fact_group({"label": "alpha", "paths": ["/a"]})
            explicit = store.create_fact_group(
                {"label": "Beta", "paths": ["/b"], "order": 0}
            )
        self.assertEqual((first["order"], second["order"]), (0, 100))
        self.assertEqual(
            [record["label"] for record in store.list_fact_groups()],
            ["Beta", "Zulu", "alpha"],
        )
        self.assertEqual(store.get_fact_group(first["id"]), first)

    def test_create_collision_and_invalid_payload_preserve_all_bytes(self):
        store = self.make_store()
        with self.patch_uuid(self.facade, FIRST_ID):
            store.create_fact_group({"label": "Core facts", "paths": ["/firstName"]})
        before = {path.name: path.read_bytes() for path in store.root.iterdir() if path.is_file()}
        probes = (
            ({"label": " core FACTS ", "paths": ["/skills"]}, "label already exists"),
            ({"label": "Bad path", "paths": ["not-a-pointer"]}, "path is invalid"),
            ({"label": "Missing paths"}, "requires label and paths"),
            ({"label": "Extra", "paths": ["/x"], "extra": True}, "requires label and paths"),
        )
        for payload, message in probes:
            with self.subTest(payload=payload):
                with self.assertRaisesRegex(self.facade.StoreError, message):
                    store.create_fact_group(payload)
                after = {
                    path.name: path.read_bytes()
                    for path in store.root.iterdir()
                    if path.is_file()
                }
                self.assertEqual(after, before)

    def test_changed_and_noop_update_have_exact_revision_timestamp_and_bytes(self):
        store = self.make_store(clock=SequenceClock(FIRST_TIME, SECOND_TIME))
        with self.patch_uuid(self.facade, FIRST_ID):
            created = store.create_fact_group(
                {"label": "Core", "paths": ["/firstName"]}
            )
        changed = store.update_fact_group(
            created["id"], {"label": "Focused", "paths": ["/skills"], "order": 25}, 1
        )
        self.assertEqual((changed["revision"], changed["updatedAt"]), (2, "2026-09-04T12:05:00Z"))
        before_bytes = store.fact_groups_path.read_bytes()
        before_mtime = store.fact_groups_path.stat().st_mtime_ns
        noop = store.update_fact_group(
            changed["id"],
            {"label": "Focused", "paths": ["/skills"], "order": 25},
            changed["revision"],
        )
        self.assertEqual(noop, changed)
        self.assertEqual(store.fact_groups_path.read_bytes(), before_bytes)
        self.assertEqual(store.fact_groups_path.stat().st_mtime_ns, before_mtime)

    def test_update_rejections_delete_and_same_revision_conflict_preserve_state(self):
        store = self.make_store()
        with self.patch_uuid(self.facade, FIRST_ID, SECOND_ID):
            first = store.create_fact_group({"label": "First", "paths": ["/a"]})
            second = store.create_fact_group({"label": "Second", "paths": ["/b"]})
        before = store.fact_groups_path.read_bytes()
        probes = (
            (first["id"], {"label": "SECOND"}, 1, "label already exists"),
            (first["id"], {"order": True}, 1, "order must be an integer"),
            (first["id"], {}, 1, "patch must contain"),
            (first["id"], {"label": "Stale"}, 2, "revision conflict"),
            ("3" * 32, {"label": "Missing"}, 1, "does not exist"),
        )
        for group_id, patch, revision, message in probes:
            with self.subTest(message=message):
                with self.assertRaisesRegex(self.facade.StoreError, message):
                    store.update_fact_group(group_id, patch, revision)
                self.assertEqual(store.fact_groups_path.read_bytes(), before)
        deleted = store.delete_fact_group(first["id"], first["revision"])
        self.assertEqual(deleted, {"deleted": True, "id": first["id"]})
        self.assertIsNone(store.get_fact_group(first["id"]))
        with self.assertRaisesRegex(self.facade.StoreError, "revision conflict"):
            store.delete_fact_group(second["id"], 2)
        self.assertEqual(store.get_fact_group(second["id"]), second)

    def test_same_revision_concurrent_updates_allow_exactly_one_writer(self):
        store = self.make_store()
        with self.patch_uuid(self.facade, FIRST_ID):
            created = store.create_fact_group({"label": "Core", "paths": ["/a"]})

        def update(label: str):
            try:
                return store.update_fact_group(
                    created["id"], {"label": label}, created["revision"]
                )
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(update, ("First writer", "Second writer")))
        winners = [outcome for outcome in outcomes if isinstance(outcome, dict)]
        conflicts = [outcome for outcome in outcomes if isinstance(outcome, str)]
        self.assertEqual(len(winners), 1)
        self.assertEqual(conflicts, ["fact group revision conflict"])
        self.assertEqual(store.get_fact_group(created["id"]), winners[0])
        self.assertEqual(winners[0]["revision"], 2)

    def test_late_facade_uuid_atomic_and_read_patches_are_live(self):
        store = self.make_store()
        original_write = self.facade.atomic_write_json
        original_read = self.facade.read_json_object
        write_spy = mock.Mock(wraps=original_write)
        read_spy = mock.Mock(wraps=original_read)
        with mock.patch.object(self.facade, "atomic_write_json", write_spy), mock.patch.object(
            self.facade, "read_json_object", read_spy
        ), self.patch_uuid(self.facade, FIRST_ID):
            created = store.create_fact_group({"label": "Late", "paths": ["/late"]})
        self.assertEqual(created["id"], FIRST_ID)
        self.assertTrue(any(call.args[0] == store.fact_groups_path for call in write_spy.call_args_list))
        self.assertTrue(any(call.args[0] == store.fact_groups_path for call in read_spy.call_args_list))

    def test_cloned_store_operations_match_facade_bytes_modes_and_profile_invariance(self):
        source_store = self.facade.Store(self.parent / "source", clock=lambda: FIRST_TIME)
        source_store.initialize()
        source_store.replace_profile({"firstName": "Ada", "skills": ["Python"]}, 1, "user")
        left_root = clone_store_root(source_store.root, self.parent / "left")
        right_root = clone_store_root(source_store.root, self.parent / "right")
        left = self.facade.Store(left_root, clock=lambda: FIRST_TIME)
        right = self.composed(right_root, clock=lambda: FIRST_TIME)
        left_profile = left.profile_path.read_bytes()
        right_profile = right.profile_path.read_bytes()
        for store in (left, right):
            with self.patch_uuid(self.facade, FIRST_ID, SECOND_ID):
                first = store.create_fact_group({"label": "Zulu", "paths": ["/firstName"]})
                second = store.create_fact_group({"label": "Alpha", "paths": ["/skills"]})
            updated = store.update_fact_group(second["id"], {"order": 0}, second["revision"])
            store.update_fact_group(updated["id"], {"order": 0}, updated["revision"])
            store.delete_fact_group(first["id"], first["revision"])
        self.assertEqual(left.list_fact_groups(), right.list_fact_groups())
        self.assertEqual(left.profile_path.read_bytes(), left_profile)
        self.assertEqual(right.profile_path.read_bytes(), right_profile)
        assert_store_trees_equal(self, left.root, right.root)

    def test_document_validation_matches_facade_and_never_rewrites_corruption(self):
        store = self.make_store()
        store.initialize()
        invalid_documents = (
            {"schemaVersion": 2, "groups": {}, "metadata": {"createdAt": "x", "updatedAt": "x"}},
            {"schemaVersion": 1, "groups": [], "metadata": {"createdAt": "x", "updatedAt": "x"}},
            {"schemaVersion": 1, "groups": {}, "metadata": {"createdAt": "x"}},
        )
        for document in invalid_documents:
            with self.subTest(document=document):
                store.fact_groups_path.write_text(json.dumps(document), encoding="utf-8")
                before = store.fact_groups_path.read_bytes()
                with self.assertRaises(self.facade.StoreError):
                    store.list_fact_groups()
                self.assertEqual(store.fact_groups_path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
