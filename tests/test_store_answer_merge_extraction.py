from __future__ import annotations

import importlib
import inspect
import json
import tempfile
import unittest
import uuid
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
    "_merged_observation_field",
    "_apply_answer_merge_locked",
    "_rewrite_session_answer_key",
    "merge_answers",
)


class AnswerMergeExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="answer_merge_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.answers.merge"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.AnswerMergeMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)

    def stores(self, label="pair"):
        source = self.parent / f"{label}-source"
        self.facade.Store(source, self.parent / "legacy.json").initialize()
        return (
            self.facade.Store(
                clone_store_root(source, self.parent / f"{label}-original"),
                self.parent / "legacy.json",
            ),
            self.composed(
                clone_store_root(source, self.parent / f"{label}-extracted"),
                self.parent / "legacy.json",
            ),
        )

    def seed(self, store):
        winner = store.put_answer({
            "question": "Canonical compensation?", "aliases": ["Preferred compensation"],
            "state": "sensitive", "value": "PRIVATE-WINNER", "sensitivity": "high",
            "observationCount": 2, "observedAt": "2026-09-01T00:00:00Z",
            "lastObservedAt": "2026-09-02T00:00:00Z",
        }, remember_sensitive=True)
        source = store.put_answer({
            "question": "What compensation do you expect?", "state": "confirmed",
            "value": "PRIVATE-SOURCE", "observationCount": 3,
            "observedAt": "2026-08-31T00:00:00Z",
            "lastObservedAt": "2026-09-03T00:00:00Z",
        })
        store.save_session("merge-session", {
            "status": "active", "answerKeys": [source["key"], winner["key"]],
            "pendingFields": [{
                "question": "Compensation?", "answerKey": source["key"],
            }],
        })
        store.append_history({
            "applicationId": "merge-history", "event": "reviewed",
            "answerKeys": [source["key"]],
        })
        return winner, source

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertIsInstance(
            inspect.getattr_static(self.mixin, "_merged_observation_field"), staticmethod
        )
        self.assertIsInstance(
            inspect.getattr_static(self.mixin, "_rewrite_session_answer_key"), staticmethod
        )
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["answers.merge"],
            {"AnswerMergeMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_fixed_clock_nonce_merge_is_byte_equivalent_and_value_free(self):
        stores = self.stores()
        fixed_id = uuid.UUID("11111111-2222-3333-4444-555555555555")
        with (
            mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T18:00:00Z"),
            mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed_id),
        ):
            seeded = [self.seed(store) for store in stores]
            results = [
                store.merge_answers(
                    winner["key"], source["key"], winner["revision"], source["revision"]
                )
                for store, (winner, source) in zip(stores, seeded)
            ]
        self.assertEqual(results[0], results[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        self.assertEqual(results[0]["observationCount"], 5)
        self.assertEqual(results[0]["referenceCounts"], {
            "sessions": 1, "history": 1, "total": 2,
        })
        self.assertNotIn("PRIVATE", json.dumps(results[0]))
        for store, (_, source) in zip(stores, seeded):
            journal = store.coordinator_journal_path.read_text(encoding="utf-8")
            self.assertNotIn("PRIVATE-WINNER", journal)
            self.assertNotIn("PRIVATE-SOURCE", journal)
            session = store.load_session("merge-session")
            self.assertEqual(session["answerKeys"], [results[0]["key"]])
            self.assertNotIn("matchConfidence", session["pendingFields"][0])
            self.assertEqual(store.get_answer(source["key"])["redirectedFrom"], source["key"])

    def test_preflight_uses_deep_copy_and_never_rereads_after_commit(self):
        _, store = self.stores("preflight")
        winner, source = self.seed(store)
        original_apply = store._apply_answer_merge_locked

        def assert_unpersisted(document, operation):
            self.assertIn(source["key"], json.loads(
                store.answers_path.read_text(encoding="utf-8")
            )["answers"])
            return original_apply(document, operation)

        with (
            mock.patch.object(store, "_apply_answer_merge_locked", side_effect=assert_unpersisted),
            mock.patch.object(store, "_get_answer_record", side_effect=AssertionError("reread")),
        ):
            result = store.merge_answers(
                winner["key"], source["key"], winner["revision"], source["revision"]
            )
        self.assertEqual(result["mergedFrom"], source["key"])

    def test_session_rewrite_uses_the_unbound_canonical_validator_adapter(self):
        _, store = self.stores("unbound-session-rewrite")
        winner, source = self.seed(store)
        unrelated = store.put_answer({
            "question": "Are you authorized to work?",
            "state": "confirmed",
            "value": "Yes",
        })
        store.save_session("merge-session", {
            "status": "active",
            "answerKeys": [source["key"], winner["key"], unrelated["key"]],
            "pendingFields": [
                {"question": "Compensation?", "answerKey": source["key"]},
                {
                    "question": "Are you authorized to work?",
                    "answerKey": unrelated["key"],
                },
            ],
        })
        session = store.load_session("merge-session")
        before = json.loads(json.dumps(session))
        unrelated_field = before["pendingFields"][1]
        self.assertEqual(unrelated_field["matchConfidence"], "exact")
        self.assertTrue(unrelated_field["matchReasonCodes"])
        self.leaf._bind_runtime(lambda: vars(self.leaf))
        try:
            rewritten = self.mixin._rewrite_session_answer_key(
                session, source["key"], winner["key"], "2026-09-04T18:30:00Z"
            )
            invalid = json.loads(json.dumps(session))
            invalid["pendingFields"][1]["matchConfidence"] = "invalid"
            with self.assertRaisesRegex(
                self.facade.StoreError, "pending field confidence is invalid"
            ):
                self.mixin._rewrite_session_answer_key(
                    invalid,
                    source["key"],
                    winner["key"],
                    "2026-09-04T18:30:00Z",
                )
        finally:
            self.leaf._bind_runtime(lambda: vars(self.facade))
        self.assertEqual(session, before)
        self.assertEqual(
            rewritten["answerKeys"], [winner["key"], unrelated["key"]]
        )
        self.assertEqual(rewritten["pendingFields"][0]["answerKey"], winner["key"])
        self.assertNotIn("matchConfidence", rewritten["pendingFields"][0])
        self.assertEqual(rewritten["pendingFields"][1], unrelated_field)

    def test_collision_and_stale_fail_before_any_durable_write(self):
        _, store = self.stores("reject")
        winner, source = self.seed(store)
        third = store.put_answer({
            "question": "Third?", "state": "missing",
        })
        document = json.loads(store.answers_path.read_text(encoding="utf-8"))
        document["answers"][third["key"]]["aliases"] = [source["question"]]
        store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        store._ensure_coordinator_files()
        before = snapshot_tree(store.root)
        with self.assertRaisesRegex(self.facade.StoreError, "revision conflict"):
            store.merge_answers(
                winner["key"], source["key"], winner["revision"] + 1, source["revision"]
            )
        self.assertEqual(snapshot_tree(store.root), before)
        with self.assertRaisesRegex(self.facade.StoreError, "collides within scope"):
            store.merge_answers(
                winner["key"], source["key"], winner["revision"], source["revision"]
            )
        self.assertEqual(snapshot_tree(store.root), before)

    def test_each_commit_failure_rolls_forward_on_restart(self):
        for fail_at in range(1, 6):
            for timing in ("before", "after"):
                with self.subTest(fail_at=fail_at, timing=timing):
                    _, store = self.stores(f"crash-{fail_at}-{timing}")
                    winner, source = self.seed(store)
                    store._ensure_coordinator_files()
                    original_write = self.facade.atomic_write_json
                    calls = {"count": 0}

                    def interrupted(path, payload):
                        calls["count"] += 1
                        if calls["count"] == fail_at and timing == "before":
                            raise OSError("simulated merge crash")
                        result = original_write(path, payload)
                        if calls["count"] == fail_at and timing == "after":
                            raise OSError("simulated merge crash")
                        return result

                    with mock.patch.object(
                        self.facade, "atomic_write_json", side_effect=interrupted
                    ):
                        try:
                            store.merge_answers(
                                winner["key"], source["key"],
                                winner["revision"], source["revision"],
                            )
                        except OSError:
                            pass
                    recovered = self.composed(store.root, self.parent / "legacy.json")
                    recovered.initialize()
                    if fail_at == 1 and timing == "before":
                        self.assertIsNotNone(recovered.get_answer(source["key"]))
                        continue
                    merged = recovered.get_answer(winner["key"])
                    self.assertEqual(merged["revision"], winner["revision"] + 1)
                    self.assertEqual(recovered.get_answer(source["key"])["key"], winner["key"])
                    self.assertIsNone(recovered._load_coordinator_journal()["operation"])


if __name__ == "__main__":
    unittest.main()
