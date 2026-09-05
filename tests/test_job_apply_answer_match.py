import copy
import importlib.util
import json
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "job_apply_answer_match.py"
SPEC = importlib.util.spec_from_file_location("job_apply_answer_match", SCRIPT)
MATCH = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MATCH
SPEC.loader.exec_module(MATCH)


def key(marker):
    return f"question.{marker * 64}"


def candidate(
    marker,
    question,
    *,
    aliases=(),
    scope=None,
    field_class="authorization",
    sensitivity="high",
    state="confirmed",
    review_status="accepted",
    record_status="active",
    value_state="seen",
):
    return {
        "key": key(marker),
        "question": question,
        "aliases": list(aliases),
        "scope": dict(scope or {"region": "alpha"}),
        "fieldClass": field_class,
        "sensitivity": sensitivity,
        "state": state,
        "reviewStatus": review_status,
        "recordStatus": record_status,
        "valueState": value_state,
    }


class AnswerCandidateRankingTests(unittest.TestCase):
    def rank(self, question, records, **overrides):
        arguments = {
            "question": question,
            "scope": {"region": "alpha"},
            "field_class": "authorization",
            "sensitivity": "high",
            "candidates": records,
        }
        arguments.update(overrides)
        return MATCH.rank_candidates(**arguments)

    def assert_value_free(self, result):
        serialized = json.dumps(result, sort_keys=True)
        for private_text in (
            "Is permission to work available?",
            "May the applicant work?",
            "Is a work credential present?",
        ):
            self.assertNotIn(private_text, serialized)
        for item in result:
            self.assertEqual(
                set(item), {"answerKey", "confidenceBand", "reasonCodes"}
            )
            self.assertRegex(item["answerKey"], r"^question\.[0-9a-f]{64}$")
            self.assertIn(item["confidenceBand"], MATCH.CONFIDENCE_BANDS)
            self.assertLessEqual(set(item["reasonCodes"]), MATCH.REASON_CODES)

    def test_exact_question_and_alias_are_ranked_without_text(self):
        records = [
            candidate("a", "Is permission to work available?"),
            candidate(
                "b",
                "Is a work credential present?",
                aliases=("May the applicant work?",),
            ),
        ]
        exact = self.rank("Is permission to work available?", [records[0]])
        alias = self.rank("May the applicant work?", [records[1]])

        self.assertEqual(exact[0]["confidenceBand"], "exact")
        self.assertIn("match_exact_question", exact[0]["reasonCodes"])
        self.assertEqual(alias[0]["confidenceBand"], "exact")
        self.assertIn("match_exact_alias", alias[0]["reasonCodes"])
        self.assert_value_free(exact + alias)

    def test_semantic_paraphrase_is_high_and_unrelated_text_is_none(self):
        records = [
            candidate("a", "Does the applicant have permission to work in this jurisdiction?"),
            candidate("b", "Is schedule availability flexible?"),
        ]
        ranked = self.rank(
            "Is employment authorization available in the country?", records
        )

        self.assertEqual(ranked[0]["answerKey"], key("a"))
        self.assertEqual(ranked[0]["confidenceBand"], "high")
        self.assertIn("match_semantic_high", ranked[0]["reasonCodes"])
        self.assertEqual(ranked[1]["confidenceBand"], "none")
        self.assertIn("no_semantic_match", ranked[1]["reasonCodes"])
        self.assert_value_free(ranked)

    def test_single_feature_overlap_is_only_uncertain(self):
        ranked = self.rank(
            "Is permission documented?",
            [candidate("a", "Does permission exist for a separate purpose?")],
        )
        self.assertEqual(ranked[0]["confidenceBand"], "uncertain")
        self.assertIn("match_semantic_uncertain", ranked[0]["reasonCodes"])

    def test_scope_field_class_and_sensitivity_drift_cannot_match(self):
        question = "Is employment authorization available in the country?"
        base = "Does the applicant have permission to work in this jurisdiction?"
        records = [
            candidate("a", base, scope={"region": "beta"}),
            candidate("b", base, field_class="sponsorship"),
            candidate("c", base, sensitivity="personal"),
        ]
        ranked = self.rank(question, records)

        self.assertTrue(all(item["confidenceBand"] == "none" for item in ranked))
        by_key = {item["answerKey"]: item for item in ranked}
        self.assertIn("scope_mismatch", by_key[key("a")]["reasonCodes"])
        self.assertIn("field_class_mismatch", by_key[key("b")]["reasonCodes"])
        self.assertIn("sensitivity_mismatch", by_key[key("c")]["reasonCodes"])

    def test_polarity_drift_cannot_match(self):
        ranked = self.rank(
            "Is permission to work available?",
            [candidate("a", "Is permission to work not available?")],
        )
        self.assertEqual(ranked[0]["confidenceBand"], "none")
        self.assertIn("polarity_mismatch", ranked[0]["reasonCodes"])

    def test_ambiguous_top_tie_is_downgraded_and_ordered_by_key(self):
        records = [
            candidate("b", "May the applicant work?", aliases=("Work permission?",)),
            candidate("a", "Work permission?"),
        ]
        ranked = self.rank("Work permission?", records)

        self.assertEqual([item["answerKey"] for item in ranked], [key("a"), key("b")])
        self.assertTrue(all(item["confidenceBand"] == "uncertain" for item in ranked))
        self.assertTrue(all("ambiguous_tie" in item["reasonCodes"] for item in ranked))

    def test_limit_and_input_order_do_not_change_ranking(self):
        records = [
            candidate("c", "Is schedule availability flexible?"),
            candidate("a", "Does the applicant have permission to work in this jurisdiction?"),
            candidate("b", "Does a work permit exist for this country?"),
        ]
        first = self.rank(
            "Is employment authorization available in the country?", records, limit=2
        )
        second = self.rank(
            "Is employment authorization available in the country?",
            list(reversed(records)),
            limit=2,
        )
        self.assertEqual(first, second)

    def test_ranking_does_not_mutate_inputs(self):
        records = [candidate("a", "May the applicant work?")]
        before = copy.deepcopy(records)
        self.rank("Is work permission available?", records)
        self.assertEqual(records, before)

    def test_validation_errors_are_value_free(self):
        private_input = "PRIVATE_SENTINEL"
        with self.assertRaises(MATCH.AnswerMatchError) as raised:
            self.rank(private_input, [{"key": private_input}])
        self.assertNotIn(private_input, str(raised.exception))


class ReusePolicyTests(unittest.TestCase):
    def setUp(self):
        self.record = candidate(
            "a", "Does the applicant have permission to work in this jurisdiction?"
        )
        self.match = MATCH.rank_candidates(
            question="Is employment authorization available in the country?",
            scope={"region": "alpha"},
            field_class="authorization",
            sensitivity="high",
            candidates=[self.record],
        )[0]

    def evaluate(self, **overrides):
        arguments = {
            "match": self.match,
            "candidate": self.record,
            "scope": {"region": "alpha"},
            "field_class": "authorization",
            "sensitivity": "high",
            "mode": MATCH.MODE_STRICT,
            "use_authority": MATCH.AUTHORITY_NONE,
        }
        arguments.update(overrides)
        return MATCH.evaluate_reuse(**arguments)

    def assert_denied(self, result, reason=None):
        self.assertEqual(result["answerKey"], key("a"))
        self.assertIn("owner_confirmation_required", result["reasonCodes"])
        self.assertNotIn("reuse_eligible", result["reasonCodes"])
        if reason:
            self.assertIn(reason, result["reasonCodes"])

    def test_strict_sensitive_requires_explicit_per_use_authority(self):
        self.assert_denied(self.evaluate(), "authority_missing")
        allowed = self.evaluate(use_authority=MATCH.AUTHORITY_PER_USE)
        self.assertIn("reuse_eligible", allowed["reasonCodes"])
        self.assertIn("authority_per_use", allowed["reasonCodes"])

    def test_bounded_loose_requires_policy_authority_and_allowlisted_class(self):
        denied = self.evaluate(
            mode=MATCH.MODE_BOUNDED_LOOSE,
            use_authority=MATCH.AUTHORITY_BOUNDED_POLICY,
            allowed_sensitive_field_classes=("sponsorship",),
        )
        self.assert_denied(denied, "field_class_not_allowlisted")

        allowed = self.evaluate(
            mode=MATCH.MODE_BOUNDED_LOOSE,
            use_authority=MATCH.AUTHORITY_BOUNDED_POLICY,
            allowed_sensitive_field_classes=("authorization",),
        )
        self.assertIn("reuse_eligible", allowed["reasonCodes"])
        self.assertIn("field_class_allowlisted", allowed["reasonCodes"])
        self.assertIn("authority_bounded_policy", allowed["reasonCodes"])

    def test_strict_rejects_bounded_policy_authority(self):
        result = self.evaluate(
            use_authority=MATCH.AUTHORITY_BOUNDED_POLICY,
            allowed_sensitive_field_classes=("authorization",),
        )
        self.assert_denied(result, "authority_missing")

    def test_non_sensitive_accepted_record_authority_is_bounded_to_non_sensitive(self):
        record = candidate(
            "b",
            "Is schedule availability flexible?",
            field_class="availability",
            sensitivity="none",
        )
        match = MATCH.rank_candidates(
            question="Is schedule availability flexible?",
            scope={"region": "alpha"},
            field_class="availability",
            sensitivity="none",
            candidates=[record],
        )[0]
        result = MATCH.evaluate_reuse(
            match=match,
            candidate=record,
            scope={"region": "alpha"},
            field_class="availability",
            sensitivity="none",
            mode=MATCH.MODE_STRICT,
            use_authority=MATCH.AUTHORITY_ACCEPTED_RECORD,
        )
        self.assertIn("reuse_eligible", result["reasonCodes"])
        self.assertIn("authority_accepted_record", result["reasonCodes"])

    def test_uncertain_or_ambiguous_match_never_reuses(self):
        uncertain = dict(self.match)
        uncertain["confidenceBand"] = "uncertain"
        uncertain["reasonCodes"] = ["match_semantic_uncertain"]
        result = self.evaluate(
            match=uncertain, use_authority=MATCH.AUTHORITY_PER_USE
        )
        self.assert_denied(result, "confidence_ineligible")

        ambiguous = dict(self.match)
        ambiguous["reasonCodes"] = [*self.match["reasonCodes"], "ambiguous_tie"]
        result = self.evaluate(
            match=ambiguous, use_authority=MATCH.AUTHORITY_PER_USE
        )
        self.assert_denied(result, "confidence_ineligible")

    def test_scope_sensitivity_or_field_class_drift_never_reuses(self):
        cases = [
            {"scope": {"region": "beta"}},
            {"field_class": "sponsorship"},
            {"sensitivity": "personal"},
        ]
        for override in cases:
            with self.subTest(override=override):
                result = self.evaluate(
                    use_authority=MATCH.AUTHORITY_PER_USE, **override
                )
                self.assert_denied(result)

    def test_pending_deleted_unconfirmed_or_unseen_candidate_never_reuses(self):
        cases = [
            {"reviewStatus": "pending"},
            {"recordStatus": "deleted"},
            {"state": "inferred"},
            {"valueState": "unseen"},
            {"valueState": "missing"},
        ]
        for patch in cases:
            with self.subTest(patch=patch):
                changed = {**self.record, **patch}
                result = self.evaluate(
                    candidate=changed, use_authority=MATCH.AUTHORITY_PER_USE
                )
                self.assert_denied(result)

    def test_policy_evaluation_does_not_mutate_inputs_or_expose_text(self):
        match_before = copy.deepcopy(self.match)
        record_before = copy.deepcopy(self.record)
        result = self.evaluate(use_authority=MATCH.AUTHORITY_PER_USE)
        self.assertEqual(self.match, match_before)
        self.assertEqual(self.record, record_before)
        self.assertEqual(
            set(result), {"answerKey", "confidenceBand", "reasonCodes"}
        )
        self.assertNotIn(self.record["question"], json.dumps(result))


class CleanupProposalTests(unittest.TestCase):
    def test_cleanup_proposes_only_clear_accepted_to_pending_duplicate(self):
        winner = candidate(
            "a", "Does the applicant have permission to work in this jurisdiction?"
        )
        duplicate = candidate(
            "b",
            "Is employment authorization available in the country?",
            state="missing",
            review_status="pending",
            value_state="missing",
        )
        unrelated = candidate(
            "c",
            "Is schedule availability flexible?",
            state="missing",
            review_status="pending",
            value_state="missing",
        )
        winner["value"] = "PRIVATE_ANSWER_SENTINEL"
        duplicate["applicationIdentity"] = "PRIVATE_APPLICATION_SENTINEL"
        records = [duplicate, unrelated, winner]
        before = copy.deepcopy(records)

        proposals = MATCH.propose_cleanup(candidates=records)

        self.assertEqual(records, before)
        self.assertEqual(len(proposals), 1)
        self.assertEqual(proposals[0]["winnerKey"], key("a"))
        self.assertEqual(proposals[0]["duplicateKey"], key("b"))
        self.assertEqual(proposals[0]["confidenceBand"], "high")
        self.assertIn("cleanup_merge_proposed", proposals[0]["reasonCodes"])
        self.assertLessEqual(set(proposals[0]["reasonCodes"]), MATCH.REASON_CODES)
        self.assertEqual(
            set(proposals[0]),
            {"winnerKey", "duplicateKey", "confidenceBand", "reasonCodes"},
        )
        self.assertRegex(proposals[0]["winnerKey"], r"^question\.[0-9a-f]{64}$")
        self.assertRegex(proposals[0]["duplicateKey"], r"^question\.[0-9a-f]{64}$")
        serialized = json.dumps(proposals, sort_keys=True)
        for private_text in (
            winner["question"],
            duplicate["question"],
            unrelated["question"],
            winner["value"],
            duplicate["applicationIdentity"],
        ):
            self.assertNotIn(private_text, serialized)

    def test_cleanup_does_not_choose_between_two_accepted_records(self):
        records = [
            candidate("a", "Does the applicant have permission to work?"),
            candidate("b", "Is employment authorization available?"),
        ]
        self.assertEqual(MATCH.propose_cleanup(candidates=records), [])

    def test_cleanup_requires_one_unique_winner_for_each_pending_duplicate(self):
        shared_question = "Does the applicant have permission to work?"
        records = [
            candidate("a", shared_question),
            candidate("b", shared_question),
            candidate(
                "c",
                shared_question,
                state="missing",
                review_status="pending",
                value_state="missing",
            ),
        ]
        before = copy.deepcopy(records)

        self.assertEqual(MATCH.propose_cleanup(candidates=records), [])
        self.assertEqual(
            MATCH.propose_cleanup(candidates=list(reversed(records))), []
        )
        self.assertEqual(records, before)

    def test_cleanup_rejects_scope_or_sensitivity_drift(self):
        winner = candidate("a", "Does the applicant have permission to work?")
        drifted = candidate(
            "b",
            "Is employment authorization available?",
            scope={"region": "beta"},
            state="missing",
            review_status="pending",
            value_state="missing",
        )
        self.assertEqual(
            MATCH.propose_cleanup(candidates=[winner, drifted]), []
        )


class AnswerMatchSplitContractTests(unittest.TestCase):
    def test_facade_reexports_functions_from_directional_modules(self):
        self.assertTrue(MATCH.rank_candidates.__module__.endswith(".scoring"))
        self.assertTrue(MATCH.evaluate_reuse.__module__.endswith(".reuse"))
        self.assertTrue(MATCH._cleanup.propose_cleanup.__module__.endswith(".cleanup"))
        for name in (
            "AnswerMatchError",
            "CONFIDENCE_BANDS",
            "REASON_CODES",
            "rank_candidates",
            "evaluate_reuse",
            "propose_cleanup",
        ):
            self.assertIn(name, MATCH.__all__)


if __name__ == "__main__":
    unittest.main()
