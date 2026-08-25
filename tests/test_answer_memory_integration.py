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
        self.assertEqual(resumed["url"], "https://example.com/direct-job")
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

    def test_skills_share_one_helper_contract_and_manual_submit_boundary(self):
        skills = {
            path.parent.name: path.read_text(encoding="utf-8")
            for path in (ROOT / "skills").glob("*/SKILL.md")
        }
        self.assertEqual(
            set(skills),
            {
                "answer-memory",
                "job-apply",
                "job-preferences",
                "job-search",
                "job-workspace",
            },
        )
        for name in ("answer-memory", "job-apply", "job-preferences", "job-search"):
            self.assertIn("job-apply-store.py", skills[name], name)
        self.assertIn("job-apply-workspace.py", skills["job-workspace"])
        self.assertIn("canonical Store contract", skills["job-workspace"])
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
        self.assertIn("job-list --status ready", skills["job-apply"])
        self.assertIn("job-acquire", skills["job-apply"])
        self.assertIn("claim-handoff --id <job-id> --token <token>", skills["job-apply"])
        self.assertIn("--status awaiting_review", skills["job-apply"])
        self.assertIn("--input <review-session.json>", skills["job-apply"])
        self.assertIn("If the user supplied a job URL", skills["job-apply"])
        self.assertIn("User confirmation never authorizes this skill to click Submit", skills["job-apply"])

    def test_ready_job_cli_lifecycle_reaches_review_and_releases_claim(self):
        self.json_store("init")
        profile = self.write_input("profile.json", {"firstName": "Synthetic"})
        self.json_store("profile-replace", "--input", str(profile))
        resume_path = self.home / "assigned-resume.pdf"
        resume_path.write_bytes(b"synthetic resume")
        resume = self.write_input("resume.json", {
            "id": "assigned-resume", "label": "Assigned", "path": str(resume_path)
        })
        self.json_store("resume-create", "--input", str(resume))
        job_input = self.write_input("job.json", {
            "id": "canonical-ready-job", "url": "https://example.com/jobs/ready",
            "company": "Example", "role": "Engineer", "resumeId": "assigned-resume",
        })
        job = self.json_store("job-create", "--input", str(job_input))
        job = self.json_store(
            "job-transition", "--id", job["id"], "--status", "ready",
            "--expected-revision", str(job["revision"]),
        )
        acquired = self.json_store(
            "job-acquire", "--id", job["id"], "--owner", "integration-agent",
            "--expected-revision", str(job["revision"]),
        )
        self.assertEqual(acquired["job"]["status"], "in_progress")
        self.assertEqual(acquired["resume"]["id"], "assigned-resume")
        progress = self.write_input("progress.json", {
            "status": "active", "step": "questions", "answerKeys": [],
            "pendingFields": [],
        })
        self.json_store(
            "claim-progress", "--id", job["id"], "--token", acquired["token"],
            "--input", str(progress),
        )
        review = self.write_input("review.json", {
            "status": "review", "step": "review", "answerKeys": [],
            "pendingFields": [],
        })
        handed = self.json_store(
            "claim-handoff", "--id", job["id"], "--token", acquired["token"],
            "--status", "awaiting_review", "--input", str(review),
            "--expected-revision", str(acquired["job"]["revision"]),
        )
        self.assertEqual(handed["job"]["status"], "awaiting_review")
        self.assertIsNone(self.json_store("claim-status")["claim"])
        self.assertEqual(
            [item["event"] for item in self.json_store("history-list")],
            ["job-started", "reviewed"],
        )
        serialized = "\n".join(
            (self.home / ".job-apply" / name).read_text(encoding="utf-8")
            for name in ("coordinator.json", "coordinator-journal.json", "applications.jsonl")
        )
        self.assertNotIn(acquired["token"], serialized)
        self.assertNotIn("synthetic resume", serialized)

    def test_concurrent_cli_acquisition_allows_only_one_global_claim(self):
        self.json_store("init")
        profile = self.write_input("concurrent-profile.json", {"firstName": "Synthetic"})
        self.json_store("profile-replace", "--input", str(profile))
        resume_path = self.home / "concurrent-resume.pdf"
        resume_path.write_bytes(b"resume")
        resume = self.write_input("concurrent-resume.json", {
            "id": "concurrent-resume", "label": "Concurrent", "path": str(resume_path)
        })
        self.json_store("resume-create", "--input", str(resume))
        for job_id in ("concurrent-a", "concurrent-b"):
            source = self.write_input(f"{job_id}.json", {
                "id": job_id, "url": f"https://example.com/jobs/{job_id}",
                "resumeId": "concurrent-resume",
            })
            job = self.json_store("job-create", "--input", str(source))
            self.json_store(
                "job-transition", "--id", job_id, "--status", "ready",
                "--expected-revision", str(job["revision"]),
            )
        processes = [
            subprocess.Popen(
                [sys.executable, str(SCRIPT), "job-acquire", "--id", job_id,
                 "--owner", f"agent-{job_id}", "--expected-revision", "2"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                env=self.environment,
            )
            for job_id in ("concurrent-a", "concurrent-b")
        ]
        results = [process.communicate(timeout=10) + (process.returncode,) for process in processes]
        self.assertEqual(sorted(result[2] for result in results), [0, 2])
        self.assertIn("live job claim", "\n".join(result[1] for result in results))
        jobs = {
            job_id: self.json_store("job-get", "--id", job_id)["status"]
            for job_id in ("concurrent-a", "concurrent-b")
        }
        self.assertEqual(sorted(jobs.values()), ["in_progress", "ready"])

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
