from __future__ import annotations

import importlib
import inspect
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
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
METHODS = (
    "_reject_answer_collisions",
    "put_answer",
    "update_answer",
    "observe_answer",
    "review_answer",
    "trash_answer",
    "restore_answer",
    "_set_answer_deleted",
    "delete_answer",
)


class AnswerMutationExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="answer_mutation_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.answers.mutations"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.AnswerMutationMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        source = parent / "source"
        self.facade.Store(source, parent / "legacy.json").initialize()
        self.original = self.facade.Store(
            clone_store_root(source, parent / "original"), parent / "legacy.json"
        )
        self.extracted = self.composed(
            clone_store_root(source, parent / "extracted"), parent / "legacy.json"
        )

    def call_both(self, operation):
        values = [operation(store) for store in (self.original, self.extracted)]
        self.assertEqual(values[0], values[1])
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return values[0]

    def assert_same_error(self, operation):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        errors = []
        for store in (self.original, self.extracted):
            with self.assertRaises(self.facade.StoreError) as raised:
                operation(store)
            errors.append(str(raised.exception))
        self.assertEqual(errors[0], errors[1])
        self.assertEqual(before, [snapshot_tree(store.root) for store in (self.original, self.extracted)])
        return errors[0]

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["answers.mutations"],
            {"AnswerMutationMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_crud_observation_review_and_delete_are_byte_equivalent(self):
        now = "2026-09-04T16:00:00Z"
        with mock.patch.object(self.facade, "utc_now", return_value=now):
            answer = self.call_both(lambda store: store.put_answer({
                "question": "Expected salary?", "state": "sensitive",
                "value": "PRIVATE-SALARY", "sensitivity": "high",
            }, remember_sensitive=True))
            updated = self.call_both(lambda store: store.update_answer(
                answer["key"], {"aliases": ["Salary expectation"]},
                answer["revision"],
            ))
            observed = self.call_both(lambda store: store.observe_answer({
                "question": "Can you travel?", "state": "missing",
            }))
            observed = self.call_both(lambda store: store.observe_answer({
                "question": "Can you travel!", "state": "missing",
            }))
            reviewed = self.call_both(lambda store: store.review_answer(
                observed["key"], "declined", observed["revision"]
            ))
            trashed = self.call_both(lambda store: store.trash_answer(
                reviewed["key"], reviewed["revision"]
            ))
            unchanged = self.call_both(lambda store: store.trash_answer(
                reviewed["key"], trashed["revision"]
            ))
            self.assertEqual(unchanged, trashed)
            restored = self.call_both(lambda store: store.restore_answer(
                reviewed["key"], trashed["revision"]
            ))
            trashed = self.call_both(lambda store: store.trash_answer(
                reviewed["key"], restored["revision"]
            ))
            self.assertTrue(self.call_both(lambda store: store.delete_answer(
                reviewed["key"], trashed["revision"]
            ))["deleted"])
        self.assertNotIn("PRIVATE-SALARY", repr(updated))

    def test_references_stale_sensitive_and_collision_failures_match(self):
        now = "2026-09-04T17:00:00Z"
        with mock.patch.object(self.facade, "utc_now", return_value=now):
            answer = self.call_both(lambda store: store.put_answer({
                "question": "Portfolio?", "aliases": ["Work samples"],
                "state": "confirmed", "value": "Yes",
            }))
            for store in (self.original, self.extracted):
                store.save_session("active-job", {
                    "status": "active", "answerKeys": [answer["key"]],
                })
            trashed = self.call_both(lambda store: store.trash_answer(
                answer["key"], answer["revision"]
            ))
        self.assertIn("active session", self.assert_same_error(
            lambda store: store.delete_answer(answer["key"], trashed["revision"])
        ))
        self.assertIn("revision conflict", self.assert_same_error(
            lambda store: store.restore_answer(answer["key"], 1)
        ))
        self.assertIn("remember consent", self.assert_same_error(
            lambda store: store.put_answer({
                "question": "Private field?", "state": "sensitive", "value": "SECRET",
            })
        ))
        self.assertIn("collides within scope", self.assert_same_error(
            lambda store: store.put_answer({
                "question": "Different?", "aliases": ["WORK SAMPLES"],
                "state": "missing",
            })
        ))

    def test_each_write_uses_one_answer_snapshot_and_one_lock(self):
        original_load = self.extracted._load_answers_document
        original_lock = self.facade.exclusive_file_lock
        with (
            mock.patch.object(self.extracted, "initialize"),
            mock.patch.object(
                self.extracted, "_load_answers_document", wraps=original_load
            ) as load,
            mock.patch.object(
                self.facade, "exclusive_file_lock", wraps=original_lock
            ) as lock,
        ):
            self.extracted.put_answer({
                "question": "One snapshot?", "state": "missing",
            })
        self.assertEqual(load.call_count, 1)
        self.assertEqual(lock.call_count, 1)

    def test_runtime_provider_keeps_facade_function_patches_live(self):
        with (
            mock.patch.object(
                self.facade, "answer_key", return_value="late.answer.key"
            ) as keyer,
            mock.patch.object(
                self.facade,
                "_validate_answer_record",
                wraps=self.facade._validate_answer_record,
            ) as validator,
            mock.patch.object(
                self.facade,
                "atomic_write_json",
                wraps=self.facade.atomic_write_json,
            ) as writer,
        ):
            result = self.extracted.put_answer({
                "question": "Late-bound identity?", "state": "missing",
            })
        self.assertEqual(result["key"], "late.answer.key")
        self.assertGreaterEqual(keyer.call_count, 1)
        self.assertEqual(validator.call_count, 1)
        self.assertEqual(writer.call_count, 1)

    def test_same_revision_race_has_one_winner(self):
        answer = self.extracted.put_answer({
            "question": "Race?", "state": "confirmed", "value": "initial",
        })
        gate = threading.Barrier(2)

        def update(value):
            gate.wait()
            try:
                return self.extracted.update_answer(
                    answer["key"], {"value": value}, answer["revision"]
                )
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(update, ("first", "second")))
        self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
        self.assertEqual(outcomes.count("answer revision conflict"), 1)

    def test_atomic_write_failure_preserves_tree_and_cleans_temp(self):
        with self.facade.exclusive_file_lock(self.extracted.store_lock_path):
            pass
        before = snapshot_tree(self.extracted.root)
        with mock.patch.object(self.facade.os, "replace", side_effect=OSError("boom")):
            with self.assertRaisesRegex(OSError, "boom"):
                self.extracted.put_answer({
                    "question": "Failed write?", "state": "missing",
                })
        self.assertEqual(snapshot_tree(self.extracted.root), before)
        self.assertEqual(list(self.extracted.root.glob(".answers.json.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
