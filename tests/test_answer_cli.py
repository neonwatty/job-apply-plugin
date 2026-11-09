from tests.support.answer_cli_case import *


class AnswerMemoryIntegrationTests(AnswerCliCase):
    def test_clean_room_documented_lifecycle(self):
        legacy = {
            "firstName": "Synthetic",
            "lastName": "Applicant",
            "preferences": {"targetTitles": ["Engineer"]},
            "unknownLegacyField": {"preserve": True},
        }
        (self.home / ".claude-job-profile.json").write_text(
            json.dumps(legacy), encoding="utf-8"
        )

        initialized = self.json_store("init")
        self.assertTrue(initialized["migratedLegacyProfile"])
        self.assertEqual(self.json_store("profile-get"), legacy)

        preferences = self.write_input(
            "preferences-input.json", {"remotePreference": "remote only"}
        )
        updated_preferences = self.json_store(
            "preferences-set",
            "--input",
            str(preferences),
            "--expected-revision",
            str(self.json_store("profile-inspect")["revision"]),
            "--source",
            "user",
        )
        self.assertEqual(
            updated_preferences["profile"]["preferences"]["targetTitles"],
            ["Engineer"],
        )
        self.assertEqual(
            updated_preferences["profile"]["preferences"]["remotePreference"],
            "remote only",
        )
        self.assertEqual(
            updated_preferences["factProvenance"]["/preferences/remotePreference"]["source"],
            "user",
        )
        self.assertTrue(self.json_store("profile-get")["unknownLegacyField"]["preserve"])

        confirmed = self.write_input(
            "confirmed-answer.json",
            {
                "question": "Are you authorized to work in the United States?",
                "aliases": ["US work authorization"],
                "value": "Yes",
                "state": "confirmed",
                "source": "user",
                "scope": {"country": "US"},
                "sensitivity": "none",
            },
        )
        saved_answer = self.json_store("answer-put", "--input", str(confirmed))
        reused = self.json_store(
            "answer-find",
            "--question",
            "US work authorization",
            "--scope",
            '{"country":"US"}',
        )
        self.assertEqual(reused["key"], saved_answer["key"])
        self.assertEqual(reused["value"], "Yes")

        sensitive_value = "synthetic-private-answer"
        sensitive = self.write_input(
            "sensitive-answer.json",
            {
                "question": "Disability disclosure?",
                "value": sensitive_value,
                "state": "sensitive",
                "source": "user",
                "scope": {},
                "sensitivity": "high",
            },
        )
        denied = self.run_store("answer-put", "--input", str(sensitive), check=False)
        self.assertEqual(denied.returncode, 2)
        self.assertNotIn(sensitive_value, denied.stderr)
        answers_text = (self.home / ".job-apply" / "answers.json").read_text()
        self.assertNotIn(sensitive_value, answers_text)

        session_input = self.write_input(
            "session.json",
            {
                "status": "active",
                "ats": "greenhouse",
                "company": "Example Corp",
                "role": "Engineer",
                "url": "https://example.com/direct-job",
                "step": "questions",
                "answerKeys": [saved_answer["key"]],
                "pendingFields": [
                    {
                        "question": "Disability disclosure?",
                        "state": "sensitive",
                        "sensitive": True,
                    }
                ],
            },
        )
        self.json_store(
            "session-save", "--id", "example-engineer", "--input", str(session_input)
        )
        resumed = self.json_store("session-load", "--id", "example-engineer")
        self.assertEqual(resumed["step"], "questions")
        self.assertNotIn("url", resumed)
        self.assertNotIn("company", resumed)
        self.assertNotIn("role", resumed)
        self.assertNotIn("value", json.dumps(resumed))

        history_input = self.write_input(
            "history.json",
            {
                "applicationId": "example-engineer",
                "event": "reviewed",
                "company": "Example Corp",
                "role": "Engineer",
                "ats": "greenhouse",
                "answerKeys": [saved_answer["key"]],
            },
        )
        self.json_store("history-append", "--input", str(history_input))
        history = self.json_store("history-list")
        self.assertEqual(history[0]["event"], "reviewed")
        self.assertEqual(history[0]["answerKeys"], [saved_answer["key"]])
        self.assertNotIn("Yes", (self.home / ".job-apply" / "applications.jsonl").read_text())

        self.assertEqual(
            json.loads((self.home / ".claude-job-profile.json").read_text()), legacy
        )
        self.assertFalse((self.home / ".job-apply" / "coordinator.json").exists())
        self.assertFalse((self.home / ".job-apply" / "coordinator-journal.json").exists())

    def test_answer_cli_observed_review_redaction_consent_and_reference_guards(self):
        observed_input = self.write_input(
            "observed.json",
            {"question": "Integration observed question?", "state": "missing", "scope": {"ats": "integration"}},
        )
        observed = self.json_store("answer-observe", "--input", str(observed_input))
        repeated = self.json_store("answer-observe", "--input", str(observed_input))
        self.assertEqual((repeated["key"], repeated["observationCount"]), (observed["key"], 2))
        review_patch = self.write_input("review.json", {"state": "confirmed", "value": "Integration value"})
        accepted = self.json_store(
            "answer-review", "--key", observed["key"], "--decision", "accepted",
            "--expected-revision", str(repeated["revision"]), "--input", str(review_patch),
        )
        stale_put_input = self.write_input(
            "stale-put.json",
            {"key": accepted["key"], "question": accepted["question"], "scope": accepted["scope"], "state": "confirmed", "value": "stale"},
        )
        stale_put = self.run_store("answer-put", "--input", str(stale_put_input), check=False)
        self.assertNotEqual(stale_put.returncode, 0)

        put_boundary_input = self.write_input(
            "put-boundary-observed.json",
            {"question": "CLI put review boundary?", "state": "missing"},
        )
        put_boundary = self.json_store(
            "answer-observe", "--input", str(put_boundary_input)
        )
        pending_put_input = self.write_input(
            "pending-put.json",
            {
                "key": put_boundary["key"],
                "question": put_boundary["question"],
                "scope": put_boundary["scope"],
                "state": "confirmed",
                "value": "put draft",
                "reviewStatus": "accepted",
            },
        )
        pending_put = self.json_store(
            "answer-put",
            "--input",
            str(pending_put_input),
            "--expected-revision",
            str(put_boundary["revision"]),
        )
        self.assertEqual(
            (pending_put["reviewStatus"], pending_put["revision"]),
            ("pending", put_boundary["revision"] + 1),
        )

        accepted_put_input = self.write_input(
            "accepted-put.json",
            {
                "key": accepted["key"],
                "question": accepted["question"],
                "scope": accepted["scope"],
                "state": "confirmed",
                "value": "kept accepted",
                "reviewStatus": "declined",
            },
        )
        accepted_put = self.json_store(
            "answer-put",
            "--input",
            str(accepted_put_input),
            "--expected-revision",
            str(accepted["revision"]),
        )
        accepted_put_input = self.write_input(
            "accepted-put.json",
            {
                "key": accepted["key"],
                "question": accepted["question"],
                "scope": accepted["scope"],
                "state": "confirmed",
                "value": "still accepted",
                "reviewStatus": "pending",
            },
        )
        accepted_put = self.json_store(
            "answer-put",
            "--input",
            str(accepted_put_input),
            "--expected-revision",
            str(accepted_put["revision"]),
        )
        self.assertEqual(accepted_put["reviewStatus"], "accepted")
        for attempted_status in ("pending", "declined"):
            rejected_input = self.write_input(
                f"new-{attempted_status}-put.json",
                {
                    "question": f"New CLI {attempted_status} answer?",
                    "state": "missing",
                    "reviewStatus": attempted_status,
                },
            )
            rejected = self.run_store(
                "answer-put", "--input", str(rejected_input), check=False
            )
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("created through put must have accepted", rejected.stderr)

        sensitive_value = "integration-private-value"
        sensitive_input = self.write_input(
            "integration-sensitive.json",
            {"question": "Integration sensitive question?", "state": "sensitive", "value": sensitive_value, "sensitivity": "high"},
        )
        sensitive = self.json_store("answer-put", "--input", str(sensitive_input), "--remember-sensitive")
        library = self.json_store("answer-list")
        self.assertTrue(all("value" not in item for item in library["items"]))
        conflicting_filters = self.run_store(
            "answer-list", "--review-status", "pending", "--all-review-statuses", check=False
        )
        self.assertNotEqual(conflicting_filters.returncode, 0)
        self.assertIn("not allowed with argument", conflicting_filters.stderr)
        detail = self.json_store("answer-get", "--key", sensitive["key"])
        found_sensitive = self.json_store(
            "answer-find", "--question", "Integration sensitive question?", "--scope", "{}"
        )
        for non_reveal in (sensitive, library, detail, found_sensitive):
            self.assertNotIn(sensitive_value, json.dumps(non_reveal))
        for non_reveal in (sensitive, detail, found_sensitive):
            self.assertNotIn("value", non_reveal)
        self.assertEqual(self.json_store("answer-reveal", "--key", sensitive["key"])["value"], sensitive_value)

        declined_input = self.write_input(
            "declined-observed.json", {"question": "Declined integration lookup?", "state": "missing"}
        )
        declined_pending = self.json_store("answer-observe", "--input", str(declined_input))
        self.json_store(
            "answer-review", "--key", declined_pending["key"], "--decision", "declined",
            "--expected-revision", str(declined_pending["revision"]),
        )
        self.assertIsNone(
            self.json_store("answer-find", "--question", "Declined integration lookup?", "--scope", "{}")
        )

        session_input = self.write_input("answer-session.json", {"status": "active", "answerKeys": [accepted["key"]]})
        self.json_store("session-save", "--id", "answer-cli-session", "--input", str(session_input))
        history_input = self.write_input(
            "answer-history.json",
            {"applicationId": "answer-cli-history", "event": "reviewed", "answerKeys": [accepted["key"]]},
        )
        self.json_store("history-append", "--input", str(history_input))
        trashed = self.json_store("answer-trash", "--key", accepted["key"], "--expected-revision", str(accepted_put["revision"]))
        trash_page = self.json_store(
            "answer-list", "--all-review-statuses", "--include-trashed", "--trashed-only",
            "--offset", "0", "--limit", "1",
        )
        self.assertEqual((trash_page["total"], trash_page["items"][0]["key"]), (1, accepted["key"]))
        blocked = self.run_store("answer-delete", "--key", accepted["key"], "--expected-revision", str(trashed["revision"]), check=False)
        self.assertNotEqual(blocked.returncode, 0)
        self.assertNotIn("Integration value", blocked.stderr)
        self.json_store("session-delete", "--id", "answer-cli-session")
        still_blocked = self.run_store("answer-delete", "--key", accepted["key"], "--expected-revision", str(trashed["revision"]), check=False)
        self.assertIn("application history", still_blocked.stderr)

    def test_answer_cli_merge_is_redacted_and_keeps_value_free_references(self):
        winner_input = self.write_input(
            "merge-winner.json",
            {"question": "Integration canonical winner?", "state": "sensitive", "value": "integration-merge-winner-secret", "sensitivity": "high", "scope": {"country": "US"}},
        )
        source_input = self.write_input(
            "merge-source.json",
            {"question": "Integration duplicate source?", "state": "confirmed", "value": "integration-merge-source-discarded", "scope": {"country": "US"}},
        )
        winner = self.json_store("answer-put", "--input", str(winner_input), "--remember-sensitive")
        source = self.json_store("answer-put", "--input", str(source_input))
        session_input = self.write_input(
            "merge-session.json",
            {"status": "active", "answerKeys": [source["key"]], "pendingFields": [{"question": "Duplicate?", "answerKey": source["key"]}]},
        )
        history_input = self.write_input(
            "merge-history.json",
            {"applicationId": "integration-merge", "event": "reviewed", "answerKeys": [source["key"]]},
        )
        self.json_store("session-save", "--id", "integration-merge", "--input", str(session_input))
        self.json_store("history-append", "--input", str(history_input))
        merged = self.json_store(
            "answer-merge",
            "--winner-key", winner["key"],
            "--source-key", source["key"],
            "--expected-winner-revision", str(winner["revision"]),
            "--expected-source-revision", str(source["revision"]),
        )
        self.assertEqual((merged["key"], merged["mergedFrom"]), (winner["key"], source["key"]))
        self.assertNotIn("value", merged)
        self.assertNotIn("integration-merge-winner-secret", json.dumps(merged))
        self.assertNotIn("integration-merge-source-discarded", (self.home / ".job-apply" / "answers.json").read_text())
        redirected = self.json_store("answer-get", "--key", source["key"])
        self.assertEqual((redirected["key"], redirected["redirectedFrom"]), (winner["key"], source["key"]))
        session = self.json_store("session-load", "--id", "integration-merge")
        self.assertEqual((session["answerKeys"], session["pendingFields"][0]["answerKey"]), ([winner["key"]], winner["key"]))
        history = self.json_store("history-list")
        self.assertEqual(history[0]["answerKeys"], [source["key"]])
        self.assertEqual(merged["referenceCounts"], {"sessions": 1, "history": 1, "total": 2})
        journal = (self.home / ".job-apply" / "coordinator-journal.json").read_text()
        self.assertNotIn("integration-merge-winner-secret", journal)
        self.assertNotIn("integration-merge-source-discarded", journal)
