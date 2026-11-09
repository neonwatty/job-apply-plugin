from __future__ import annotations

import importlib
import inspect
import json
import tempfile
import threading
import time
import types
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
    "_preview_answer_cleanup_document",
    "preview_answer_cleanup",
    "approve_answer_cleanup",
)


class AnswerCleanupExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="answer_cleanup_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.answers.cleanup"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.AnswerCleanupMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        source = parent / "source"
        writer = self.facade.Store(source, parent / "legacy.json")
        writer.initialize()
        self.winner = writer.put_answer({
            "question": "Does the applicant have permission to work in this jurisdiction?",
            "state": "confirmed", "value": "PRIVATE CLEANUP WINNER",
        })
        self.duplicate = writer.observe_answer({
            "question": "Is employment authorization available in the country?",
            "state": "missing",
        })
        self.original = self.facade.Store(
            clone_store_root(source, parent / "original"), parent / "legacy.json"
        )
        self.extracted = self.composed(
            clone_store_root(source, parent / "extracted"), parent / "legacy.json"
        )

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["answers.cleanup"],
            {"AnswerCleanupMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_preview_is_value_free_nonmutating_and_byte_equivalent(self):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        previews = [store.preview_answer_cleanup() for store in (self.original, self.extracted)]
        self.assertEqual(previews[0], previews[1])
        self.assertEqual(before, [snapshot_tree(store.root) for store in (self.original, self.extracted)])
        self.assertNotIn("PRIVATE CLEANUP WINNER", json.dumps(previews[0]))
        self.assertTrue(previews[0]["previewToken"].startswith("answer-cleanup-v1."))

    def test_approval_recomputes_preview_under_merge_lock(self):
        preview = self.extracted.preview_answer_cleanup()
        proposal = preview["proposals"][0]
        packet = {
            "previewToken": preview["previewToken"],
            "winnerKey": proposal["winnerKey"],
            "duplicateKey": proposal["duplicateKey"],
            "winnerRevision": proposal["winnerRevision"],
            "duplicateRevision": proposal["duplicateRevision"],
        }
        entered = threading.Event()
        release = threading.Event()
        original = self.extracted._preview_answer_cleanup_document

        def paused(document):
            result = original(document)
            entered.set()
            self.assertTrue(release.wait(timeout=3))
            return result

        with mock.patch.object(
            self.extracted, "_preview_answer_cleanup_document", side_effect=paused
        ), ThreadPoolExecutor(max_workers=2) as pool:
            approval = pool.submit(
                self.extracted.approve_answer_cleanup, packet, owner_confirmed=True
            )
            self.assertTrue(entered.wait(timeout=3))
            concurrent = pool.submit(self.extracted.put_answer, {
                "question": "Unrelated concurrent answer?", "state": "missing",
            })
            time.sleep(0.05)
            self.assertFalse(concurrent.done())
            release.set()
            self.assertTrue(approval.result(timeout=3)["approved"])
            self.assertIsNotNone(concurrent.result(timeout=3))

    def test_matcher_failure_and_invalid_approval_are_safe_and_nonmutating(self):
        before = snapshot_tree(self.extracted.root)
        matcher = types.SimpleNamespace(
            propose_cleanup=mock.Mock(side_effect=RuntimeError("PRIVATE FAILURE"))
        )
        with mock.patch.object(self.facade, "ANSWER_MATCH_MODULE", matcher):
            with self.assertRaisesRegex(
                self.facade.StoreError, "answer cleanup preview is invalid"
            ) as raised:
                self.extracted.preview_answer_cleanup()
        self.assertNotIn("PRIVATE FAILURE", str(raised.exception))
        self.assertEqual(snapshot_tree(self.extracted.root), before)
        with self.assertRaisesRegex(
            self.facade.StoreError, "explicit owner approval"
        ):
            self.extracted.approve_answer_cleanup({}, owner_confirmed=True)
        self.assertEqual(snapshot_tree(self.extracted.root), before)


if __name__ == "__main__":
    unittest.main()
