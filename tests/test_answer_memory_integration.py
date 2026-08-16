import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"


class AnswerMemoryIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.environment = dict(os.environ)
        self.environment["HOME"] = str(self.home)
        self.environment.pop("JOB_APPLY_STORE_DIR", None)

    def tearDown(self):
        self.temporary.cleanup()

    def write_input(self, name, payload):
        path = self.home / name
        path.write_text(json.dumps(payload), encoding="utf-8")
        if os.name != "nt":
            path.chmod(0o600)
        return path

    def run_store(self, *arguments, check=True):
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            check=False,
            capture_output=True,
            text=True,
            env=self.environment,
        )
        if check and completed.returncode != 0:
            self.fail(f"store command failed: {arguments}: {completed.stderr}")
        return completed

    def json_store(self, *arguments):
        return json.loads(self.run_store(*arguments).stdout)

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
            "preferences-set", "--input", str(preferences)
        )
        self.assertEqual(updated_preferences["targetTitles"], ["Engineer"])
        self.assertEqual(updated_preferences["remotePreference"], "remote only")
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

    def test_skills_share_one_helper_contract_and_manual_submit_boundary(self):
        skills = {
            path.parent.name: path.read_text(encoding="utf-8")
            for path in (ROOT / "skills").glob("*/SKILL.md")
        }
        self.assertEqual(
            set(skills), {"answer-memory", "job-apply", "job-preferences", "job-search"}
        )
        for name, content in skills.items():
            self.assertIn("job-apply-store.py", content, name)
        for name in ("job-apply", "job-preferences", "job-search"):
            self.assertNotIn("Read `~/.claude-job-profile.json`", skills[name])
            self.assertNotIn("Write the collected values into `~/.claude-job-profile.json`", skills[name])
        self.assertIn("--remember-sensitive", skills["answer-memory"])
        self.assertIn("Permission to fill is not permission to remember", skills["answer-memory"])
        self.assertIn(
            "User confirmation never authorizes this skill to click Submit",
            skills["job-apply"],
        )
        self.assertIn("review_only", skills["job-apply"])
        self.assertIn("job_apply_policy.py", skills["job-apply"])
        self.assertIn("atomically claims one final action", skills["job-apply"])

        storage_contract = (
            ROOT / "skills/answer-memory/references/storage-contract.md"
        ).read_text()
        self.assertIn("Greenhouse, LinkedIn Easy Apply, Ashby, and Lever", storage_contract)
        self.assertIn("isolated loopback QA adapter", skills["job-apply"])
        self.assertIn("Every live Submit", skills["job-apply"])
        self.assertIn("separately audited canary", skills["job-apply"])
        self.assertIn("Auto-submit policy", skills["answer-memory"])

    def test_lever_replay_lifecycle_uses_value_free_store_records(self):
        application_id = "qa-run-20260816-ab12cd34"
        self.json_store("init")
        started = self.json_store(
            "replay-transition", "--id", application_id,
            "--transition", "started", "--ats", "lever",
        )
        reviewed = self.json_store(
            "replay-transition", "--id", application_id,
            "--transition", "reviewed", "--ats", "lever",
        )
        self.assertTrue(started["changed"])
        self.assertTrue(reviewed["changed"])
        history = self.json_store("history-list")
        session = self.json_store("session-load", "--id", application_id)
        self.assertEqual([event["event"] for event in history], ["started", "reviewed"])
        self.assertEqual((session["ats"], session["status"]), ("lever", "review"))
        serialized = json.dumps({"history": history, "session": session})
        self.assertNotIn("value", serialized)
        self.assertNotIn("http", serialized)


if __name__ == "__main__":
    unittest.main()
