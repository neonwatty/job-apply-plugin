from tests.support.oracle_fixtures import *
from tests.support.running_replay_server import *


class SemanticOracleTests(SemanticOracleCase):
    def test_absent_history_is_a_failed_assertion(self):
        (self.store.root / "applications.jsonl").unlink()
        report = self.evaluate()
        self.assertEqual(
            report["assertions"]["history-started-reviewed"], "failed"
        )
        self.assertIn("history-missing", report["failureCategories"])

    def test_empty_or_incomplete_history_fails(self):
        cases = (
            [],
            [history_event("started")],
            [history_event("reviewed")],
            [history_event("started"), history_event("reviewed", "application-2")],
            [history_event("reviewed"), history_event("started")],
        )
        for history in cases:
            with self.subTest(history=history):
                self.store.write_history(history)
                report = self.evaluate()
                self.assertEqual(
                    report["assertions"]["history-started-reviewed"], "failed"
                )
                self.assertIn(
                    "history-lifecycle-incomplete", report["failureCategories"]
                )

    def test_completed_history_fails_even_with_valid_lifecycle(self):
        self.store.write_history(
            [
                history_event("started"),
                history_event("reviewed"),
                history_event("completed"),
            ]
        )
        report = self.evaluate()
        self.assertEqual(report["assertions"]["history-not-completed"], "failed")
        self.assertIn("history-completed", report["failureCategories"])

    def test_session_must_correlate_to_a_reviewed_history_application(self):
        session_path = self.store.sessions / "application-1.json"
        session_path.unlink()
        self.store.write_session(valid_session("application-2"), "application-2.json")
        report = self.evaluate()
        self.assertEqual(report["assertions"]["session-present"], "failed")
        self.assertEqual(report["status"], "failed")
        self.assertIn("session-not-correlated", report["failureCategories"])

    def test_session_may_match_any_ordered_reviewed_history_application(self):
        self.store.write_history(
            [
                history_event("started", "application-1"),
                history_event("started", "application-2"),
                history_event("reviewed", "application-2"),
                history_event("reviewed", "application-1"),
            ]
        )
        session_path = self.store.sessions / "application-1.json"
        session_path.unlink()
        self.store.write_session(valid_session("application-2"), "application-2.json")
        self.assertEqual(self.evaluate()["status"], "passed")

    def test_malformed_unreadable_or_value_bearing_history_is_rejected(self):
        history_path = self.store.root / "applications.jsonl"
        cases = (
            "not-json\n",
            json.dumps([]) + "\n",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "applicationId": "application-1",
                    "event": "started",
                }
            )
            + "\n",
            json.dumps(history_event("unknown")) + "\n",
            json.dumps(
                {**history_event("started"), "extra": "HISTORY SECRET"}
            )
            + "\n",
            json.dumps(
                {**history_event("started"), "value": "HISTORY SECRET"}
            )
            + "\n",
            json.dumps(
                {
                    **history_event("started"),
                    "metadata": {"answerValue": "HISTORY SECRET"},
                }
            )
            + "\n",
        )
        for content in cases:
            with self.subTest(content=content[:30]):
                history_path.write_text(content, encoding="utf-8")
                with self.assertRaises(OracleError) as caught:
                    self.evaluate()
                self.assertNotIn("HISTORY SECRET", str(caught.exception))
        history_path.unlink()
        history_path.mkdir()
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

    def test_history_size_is_bounded(self):
        path = self.store.root / "applications.jsonl"
        path.write_bytes(b" " * (1024 * 1024 + 1))
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

    def test_history_line_limit_counts_blank_physical_lines(self):
        path = self.store.root / "applications.jsonl"
        boundary = "".join(
            (
                json.dumps(history_event("started")) + "\n",
                "   \n",
                json.dumps(history_event("reviewed")) + "\n",
            )
        )
        with mock.patch("qa.oracle.MAX_HISTORY_LINES", 3):
            path.write_text(boundary, encoding="utf-8")
            self.assertEqual(self.evaluate()["status"], "passed")

            path.write_text(boundary + "\n", encoding="utf-8")
            with self.assertRaisesRegex(OracleError, "invalid history artifact"):
                self.evaluate()
