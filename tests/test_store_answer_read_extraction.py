from __future__ import annotations

import ast
import importlib
import inspect
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

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


DOMAINS_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
READ_METHODS = (
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
)
DEFERRED_METHODS = {
    "_reject_answer_collisions",
    "_preview_answer_cleanup_document",
    "preview_answer_cleanup",
    "approve_answer_cleanup",
    "put_answer",
    "update_answer",
    "observe_answer",
    "review_answer",
    "merge_answers",
    "trash_answer",
    "restore_answer",
    "delete_answer",
    "initialize",
}


class AnswerReadExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="answer_read_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.answers.read"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.AnswerReadMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        source = parent / "source"
        writer = self.facade.Store(source, parent / "legacy.json")
        writer.initialize()
        accepted = writer.put_answer({
            "question": "Are you authorized to work here?",
            "aliases": ["Work authorization"],
            "state": "confirmed",
            "value": "Yes",
            "fieldClass": "authorization",
        })
        sensitive = writer.put_answer({
            "question": "Expected compensation?",
            "state": "sensitive",
            "value": "PRIVATE-SALARY",
            "sensitivity": "high",
        }, remember_sensitive=True)
        pending = writer.observe_answer({
            "question": "Pending availability?", "state": "inferred", "value": "Soon",
        })
        declined = writer.observe_answer({
            "question": "Declined travel?", "state": "missing",
        })
        declined = writer.review_answer(
            declined["key"], "declined", declined["revision"]
        )
        trashed = writer.put_answer({
            "question": "Trashed preference?", "state": "confirmed", "value": "Old",
        })
        trashed = writer.trash_answer(trashed["key"], trashed["revision"])
        winner = writer.put_answer({
            "question": "Canonical location?", "state": "confirmed", "value": "Remote",
        })
        source_answer = writer.put_answer({
            "question": "Preferred workplace?", "state": "missing",
        })
        writer.save_session("read-session", {
            "status": "active",
            "answerKeys": [accepted["key"], source_answer["key"]],
            "pendingFields": [{
                "question": "Expected compensation?",
                "answerKey": sensitive["key"],
            }],
        })
        writer.append_history({
            "applicationId": "read-history",
            "event": "reviewed",
            "answerKeys": [accepted["key"], source_answer["key"]],
        })
        winner = writer.merge_answers(
            winner["key"], source_answer["key"],
            winner["revision"], source_answer["revision"],
        )
        original_root = clone_store_root(source, parent / "original")
        extracted_root = clone_store_root(source, parent / "extracted")
        self.original = self.facade.Store(original_root, parent / "legacy.json")
        self.extracted = self.composed(extracted_root, parent / "legacy.json")
        self.ids = {
            "accepted": accepted["key"],
            "sensitive": sensitive["key"],
            "pending": pending["key"],
            "declined": declined["key"],
            "trashed": trashed["key"],
            "winner": winner["key"],
            "redirect": source_answer["key"],
        }

    def assert_read_parity(self, method, *args, **kwargs):
        original_before = snapshot_tree(self.original.root)
        extracted_before = snapshot_tree(self.extracted.root)
        expected = getattr(self.original, method)(*args, **kwargs)
        actual = getattr(self.extracted, method)(*args, **kwargs)
        self.assertEqual(actual, expected)
        self.assertEqual(snapshot_tree(self.original.root), original_before)
        self.assertEqual(snapshot_tree(self.extracted.root), extracted_before)
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return actual

    def test_method_contract_identity_inventory_and_deferred_boundaries(self):
        assert_method_contract(self, self.facade.Store, self.mixin, READ_METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertFalse(DEFERRED_METHODS & vars(self.mixin).keys())
        for name in READ_METHODS:
            with self.subTest(name=name):
                self.assertIs(
                    inspect.getattr_static(self.composed, name),
                    inspect.getattr_static(self.mixin, name),
                )
        inventory = source_inventory(DOMAINS_ROOT)
        self.assertEqual(inventory["answers.__init__"], {})
        self.assertEqual(
            inventory["answers.read"], {"AnswerReadMixin": READ_METHODS}
        )
        init_path = DOMAINS_ROOT / "answers" / "__init__.py"
        init_tree = ast.parse(init_path.read_text(encoding="utf-8"))
        self.assertFalse([
            node for node in ast.walk(init_tree)
            if isinstance(node, (ast.Import, ast.ImportFrom))
        ])
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        assert_domain_import_direction(self, DOMAINS_ROOT)

    def test_reads_match_current_store_without_mutating_either_clone(self):
        accepted = self.assert_read_parity("get_answer", self.ids["accepted"])
        redirected = self.assert_read_parity("get_answer", self.ids["redirect"])
        self.assertEqual(redirected["redirectedFrom"], self.ids["redirect"])
        self.assert_read_parity("get_answer", self.ids["trashed"])
        self.assert_read_parity("get_answer", self.ids["trashed"], True)
        self.assert_read_parity("list_answers")
        self.assert_read_parity("list_answers", None, False, "pending")
        self.assert_read_parity("list_answers", None, False, "declined")
        self.assert_read_parity("list_answers", None, True, None)
        self.assert_read_parity(
            "query_answers", "preference", None, None, True, False, 0, 20
        )
        sensitive = self.assert_read_parity("get_answer", self.ids["sensitive"])
        self.assertNotIn("PRIVATE-SALARY", repr(sensitive))
        revealed = self.assert_read_parity("reveal_answer", self.ids["sensitive"])
        self.assertEqual(revealed["value"], "PRIVATE-SALARY")
        found = self.assert_read_parity("find_answer", "Work authorization", {})
        self.assertEqual(found["key"], self.ids["accepted"])
        self.assertIsNone(
            self.assert_read_parity("find_answer", "Pending availability?", {})
        )
        semantic = self.assert_read_parity("semantic_answer_lookup", {
            "question": "Can the applicant work here?",
            "scope": {},
            "fieldClass": "authorization",
            "sensitivity": "none",
            "mode": "strict",
            "useAuthority": "accepted_record",
            "limit": 5,
        })
        self.assertFalse(semantic["mutated"])
        self.assertEqual(
            accepted["referenceCounts"],
            {"sessions": 1, "history": 1, "total": 2},
        )

    def test_public_reads_load_one_answers_document_snapshot(self):
        operations = (
            ("get", lambda: self.extracted.get_answer(self.ids["redirect"])),
            ("list", lambda: self.extracted.list_answers()),
            ("query", lambda: self.extracted.query_answers()),
            ("reveal", lambda: self.extracted.reveal_answer(self.ids["sensitive"])),
            ("find", lambda: self.extracted.find_answer("Work authorization", {})),
            ("semantic", lambda: self.extracted.semantic_answer_lookup({
                "question": "Work authorization",
                "scope": {},
                "fieldClass": "authorization",
                "sensitivity": "none",
                "mode": "strict",
                "useAuthority": "accepted_record",
            })),
        )
        for label, operation in operations:
            with self.subTest(operation=label):
                original_load = self.extracted._load_answers_document
                with (
                    mock.patch.object(self.extracted, "initialize"),
                    mock.patch.object(
                        self.extracted,
                        "_load_answers_document",
                        wraps=original_load,
                    ) as load_document,
                ):
                    operation()
                self.assertEqual(load_document.call_count, 1)

    def test_runtime_provider_keeps_late_facade_patches_live(self):
        with (
            mock.patch.object(
                self.facade, "read_json_object", wraps=self.facade.read_json_object
            ) as reader,
            mock.patch.object(
                self.facade, "validate_version", wraps=self.facade.validate_version
            ) as validate_version,
            mock.patch.object(
                self.facade,
                "_validate_answer_record",
                wraps=self.facade._validate_answer_record,
            ) as validate_record,
            mock.patch.object(
                self.facade,
                "_validate_answer_redirects",
                wraps=self.facade._validate_answer_redirects,
            ) as validate_redirects,
        ):
            self.extracted._load_answers_document()
        self.assertEqual(reader.call_count, 1)
        self.assertEqual(validate_version.call_count, 1)
        self.assertGreater(validate_record.call_count, 0)
        self.assertEqual(validate_redirects.call_count, 1)

        with mock.patch.object(
            self.facade, "normalize_question", return_value="late-normalized"
        ) as normalize:
            self.assertEqual(
                self.extracted._answer_candidates({"question": "Original?"}),
                {"late-normalized"},
            )
        normalize.assert_called_once_with("Original?")
        with mock.patch.object(
            self.facade, "answer_key", wraps=self.facade.answer_key
        ) as keyer:
            self.extracted.find_answer("No matching answer", {})
        self.assertEqual(keyer.call_count, 1)
        with mock.patch.object(
            self.facade, "_json_values_equal", wraps=self.facade._json_values_equal
        ) as equality:
            self.extracted.find_answer("Work authorization", {})
        self.assertGreater(equality.call_count, 0)

        matcher = types.SimpleNamespace(
            rank_candidates=mock.Mock(return_value=[{"answerKey": self.ids["accepted"]}]),
            evaluate_reuse=mock.Mock(return_value={"decision": "late-match"}),
        )
        with (
            mock.patch.object(self.facade, "ANSWER_MATCH_MODULE", matcher),
            mock.patch.object(self.extracted, "initialize"),
        ):
            result = self.extracted.semantic_answer_lookup({
                "question": "Late matcher?",
                "scope": {},
                "fieldClass": "authorization",
                "sensitivity": "none",
                "mode": "strict",
                "useAuthority": "accepted_record",
            })
        self.assertEqual(result, {
            "candidates": [{"decision": "late-match"}], "mutated": False,
        })
        self.assertEqual(matcher.rank_candidates.call_count, 1)
        self.assertEqual(matcher.evaluate_reuse.call_count, 1)


if __name__ == "__main__":
    unittest.main()
