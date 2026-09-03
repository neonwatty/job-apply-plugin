import json
import importlib.util
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"
READINESS_SPEC = importlib.util.spec_from_file_location(
    "job_apply_form_readiness", ROOT / "scripts" / "job_apply_form_readiness.py"
)
READINESS = importlib.util.module_from_spec(READINESS_SPEC)
READINESS_SPEC.loader.exec_module(READINESS)


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

    def review_session(self, attempt_revision):
        fixture = json.loads((
            ROOT / "qa" / "fixtures" / "greenhouse-form-readiness-v1" / "fixture.json"
        ).read_text(encoding="utf-8"))
        observation = READINESS.make_readiness_observation(
            fixture,
            {
                "contact.first_name": "complete",
                "contact.phone_country": "complete",
                "resume.file": "accepted",
                "authorization.sponsorship_select": "complete",
            },
            observation_revision=13,
        )
        return {
            "status": "review", "step": "review", "answerKeys": [],
            "pendingFields": [], "attemptRevision": attempt_revision,
            "readinessInput": {
                "attemptRevision": attempt_revision,
                "evidenceKind": "agent_attested_current_attempt",
                "fixture": fixture,
                "formManifest": READINESS.make_form_manifest(
                    fixture, observation_revision=13
                ),
                "observation": observation,
                "expectedObservationRevision": 13,
            },
        }

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
        self.assertIn("sole existing-record exception to expected-revision input", storage_contract)
        self.assertIn("only the dedicated review operation", storage_contract)
        self.assertIn("Greenhouse, LinkedIn Easy Apply, Ashby, and Lever", storage_contract)
        self.assertIn("isolated loopback QA adapter", skills["job-apply"])
        self.assertIn("Every live Submit", skills["job-apply"])
        self.assertIn("separately audited canary", skills["job-apply"])
        self.assertIn("Auto-submit policy", skills["answer-memory"])
        self.assertIn("job-list --status ready", skills["job-apply"])
        self.assertIn("job-acquire", skills["job-apply"])
        self.assertIn("job-apply-attempt.py", skills["job-apply"])
        self.assertIn("Never fall back to raw `claim-handoff`", skills["job-apply"])
        self.assertIn("--status awaiting_review", skills["job-apply"])
        self.assertIn("--input <private-temp.json>", skills["job-apply"])
        self.assertIn("agent_attested_current_attempt", skills["job-apply"])
        self.assertIn("If the user supplied a job URL", skills["job-apply"])
        self.assertIn("User confirmation never authorizes this skill to click Submit", skills["job-apply"])

    def test_ready_job_cli_lifecycle_reaches_review_and_releases_claim(self):
        self.json_store("init")
        profile = self.write_input("profile.json", {"firstName": "Synthetic"})
        self.json_store(
            "profile-replace",
            "--input",
            str(profile),
            "--expected-revision",
            str(self.json_store("profile-inspect")["revision"]),
            "--source",
            "user",
        )
        resume_path = self.home / "assigned-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nsynthetic resume")
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
        review = self.write_input(
            "review.json", self.review_session(acquired["job"]["revision"])
        )
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

        session_path = self.home / ".job-apply" / "sessions" / f"{job['id']}.json"
        session_before = session_path.read_bytes()
        denied = self.run_store(
            "job-review-restart", "--id", job["id"], "--owner", "restart-agent",
            "--expected-revision", str(handed["job"]["revision"]), check=False,
        )
        self.assertEqual(denied.returncode, 2)
        self.assertEqual(session_path.read_bytes(), session_before)
        restarted = self.json_store(
            "job-review-restart", "--id", job["id"], "--owner", "restart-agent",
            "--expected-revision", str(handed["job"]["revision"]),
            "--owner-confirmed-not-submitted",
        )
        self.assertEqual(restarted["job"]["status"], "in_progress")
        self.assertEqual(session_path.read_bytes(), session_before)
        self.assertEqual(
            [item["event"] for item in self.json_store("history-list")],
            ["job-started", "reviewed", "job-restarted"],
        )
        durable = "\n".join(
            (self.home / ".job-apply" / name).read_text(encoding="utf-8")
            for name in (
                "coordinator.json", "coordinator-journal.json", "applications.jsonl"
            )
        )
        self.assertNotIn(restarted["token"], durable)

    def test_legacy_review_restart_cli_is_one_time_and_byte_preserving(self):
        self.json_store("init")
        profile = self.write_input("legacy-profile.json", {"firstName": "Synthetic"})
        self.json_store(
            "profile-replace", "--input", str(profile), "--expected-revision",
            str(self.json_store("profile-inspect")["revision"]), "--source", "user",
        )
        resume_path = self.home / "legacy-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nlegacy rebuild fixture")
        resume = self.write_input("legacy-resume.json", {
            "id": "legacy-resume", "label": "Legacy", "path": str(resume_path),
        })
        self.json_store("resume-create", "--input", str(resume))
        job_input = self.write_input("legacy-job.json", {
            "id": "legacy-review-job",
            "url": "https://example.com/jobs/legacy-review",
            "resumeId": "legacy-resume",
        })
        job = self.json_store("job-create", "--input", str(job_input))
        job = self.json_store(
            "job-transition", "--id", job["id"], "--status", "ready",
            "--expected-revision", str(job["revision"]),
        )
        acquired = self.json_store(
            "job-acquire", "--id", job["id"], "--owner", "initial-agent",
            "--expected-revision", str(job["revision"]),
        )
        review = self.write_input(
            "legacy-initial-review.json",
            self.review_session(acquired["job"]["revision"]),
        )
        reviewed = self.json_store(
            "claim-handoff", "--id", job["id"], "--token", acquired["token"],
            "--status", "awaiting_review", "--input", str(review),
            "--expected-revision", str(acquired["job"]["revision"]),
        )["job"]
        session_path = self.home / ".job-apply" / "sessions" / f"{job['id']}.json"
        session_path.write_text(json.dumps({
            "schemaVersion": 1,
            "applicationId": job["id"],
            "status": "review",
            "step": "final_review",
            "answerKeys": [],
            "pendingFields": [],
            "createdAt": "2026-08-01T00:00:00Z",
            "updatedAt": "2026-08-01T00:01:00Z",
        }, separators=(",", ":")), encoding="utf-8")
        session_before = session_path.read_bytes()

        restarted = self.json_store(
            "job-review-restart", "--id", job["id"], "--owner", "legacy-agent",
            "--expected-revision", str(reviewed["revision"]),
            "--owner-confirmed-not-submitted",
        )
        self.assertEqual(restarted["job"]["id"], job["id"])
        self.assertEqual(restarted["job"]["status"], "in_progress")
        self.assertEqual(session_path.read_bytes(), session_before)
        self.assertEqual(
            [event["event"] for event in self.json_store("history-list")],
            ["job-started", "reviewed", "legacy-review-rebuild"],
        )
        durable = "\n".join(
            (self.home / ".job-apply" / name).read_text(encoding="utf-8")
            for name in (
                "coordinator.json", "coordinator-journal.json", "applications.jsonl"
            )
        )
        self.assertNotIn(restarted["token"], durable)

    def test_cli_commands_read_safe_future_history_without_rewriting_store(self):
        self.json_store("init")
        self.json_store("claim-status")
        history_path = self.home / ".job-apply" / "applications.jsonl"
        events = [
            {
                "schemaVersion": 1,
                "eventId": f"coordinator-event-{index}",
                "applicationId": "compatibility-job",
                "event": event,
                "status": status,
                "answerKeys": [],
                "at": f"2026-08-28T00:0{index}:00Z",
            }
            for index, (event, status) in enumerate(
                (
                    ("job-started", "in_progress"),
                    ("claim-recovered", "in_progress"),
                    ("job-blocked", "needs_info"),
                    ("future-safe-event", "future-status"),
                ),
                1,
            )
        ]
        history_path.write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )
        store_root = self.home / ".job-apply"
        before = {
            path.relative_to(store_root): path.read_bytes()
            for path in store_root.rglob("*")
            if path.is_file()
        }

        self.json_store("init")
        self.assertEqual(self.json_store("profile-get"), {})
        self.assertEqual(self.json_store("job-list"), [])
        self.assertIsNone(self.json_store("claim-status")["claim"])
        self.assertEqual(self.json_store("history-list"), events)

        after = {
            path.relative_to(store_root): path.read_bytes()
            for path in store_root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)

    def test_cli_history_rejects_future_events_without_complete_audit_envelope(self):
        self.json_store("init")
        history_path = self.home / ".job-apply" / "applications.jsonl"
        valid = {
            "schemaVersion": 1,
            "eventId": "future-cli-event",
            "applicationId": "future-cli-application",
            "event": "future-safe-event",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        invalid_events = (
            {**valid, "schemaVersion": True},
            {key: value for key, value in valid.items() if key != "eventId"},
            {**valid, "eventId": ""},
            {key: value for key, value in valid.items() if key != "at"},
            {**valid, "at": ""},
            {key: value for key, value in valid.items() if key != "answerKeys"},
        )

        for event in invalid_events:
            with self.subTest(event=event):
                history_path.write_text(json.dumps(event) + "\n", encoding="utf-8")
                completed = self.run_store("history-list", check=False)
                self.assertNotEqual(completed.returncode, 0)
                self.assertNotIn("future-cli-application", completed.stderr)

    def test_resume_proposal_cli_autofills_and_reviews_conflicts(self):
        self.json_store("init")
        profile_input = self.write_input("proposal-profile.json", {"firstName": "Human"})
        profile = self.json_store(
            "profile-replace",
            "--input",
            str(profile_input),
            "--expected-revision",
            "1",
            "--source",
            "user",
        )
        resume_path = self.home / "proposal-resume.txt"
        resume_path.write_text("synthetic proposal resume", encoding="utf-8")
        resume_input = self.write_input(
            "proposal-resume.json",
            {"id": "proposal-cli", "label": "Proposal CLI", "path": str(resume_path)},
        )
        resume = self.json_store("resume-import", "--input", str(resume_input))
        candidate_input = self.write_input(
            "proposal-candidate.json",
            {"firstName": "Extracted", "email": "synthetic@example.invalid"},
        )
        proposal = self.json_store(
            "resume-proposal-create",
            "--resume-id",
            resume["id"],
            "--expected-resume-revision",
            str(resume["revision"]),
            "--expected-profile-revision",
            str(profile["revision"]),
            "--input",
            str(candidate_input),
        )
        self.assertEqual(proposal["autoFilledPaths"], ["/email"])
        self.assertEqual(proposal["pendingPaths"], ["/firstName"])
        self.assertEqual(
            self.json_store("resume-proposal-get", "--id", proposal["id"])["id"],
            proposal["id"],
        )
        self.assertEqual(len(self.json_store("resume-proposal-list")), 1)
        review_input = self.write_input(
            "proposal-review.json", {"decisions": {"/firstName": "use_extracted"}}
        )
        reviewed = self.json_store(
            "resume-proposal-review",
            "--id",
            proposal["id"],
            "--expected-revision",
            str(proposal["revision"]),
            "--expected-profile-revision",
            str(proposal["resultProfileRevision"]),
            "--input",
            str(review_input),
        )
        self.assertEqual(reviewed["status"], "completed")
        final_profile = self.json_store("profile-inspect")
        self.assertEqual(final_profile["profile"]["firstName"], "Extracted")
        self.assertEqual(final_profile["factProvenance"]["/firstName"]["source"], "user")

    def test_resume_extraction_request_cli_is_value_free(self):
        self.json_store("init")
        source = self.home / "private-request.txt"
        source.write_text("private resume text", encoding="utf-8")
        resume_input = self.write_input("private-request.json", {
            "id": "request-cli", "label": "Private Resume", "path": str(source)
        })
        resume = self.json_store("resume-import", "--input", str(resume_input))
        request = self.json_store(
            "resume-extraction-request-create", "--resume-id", resume["id"],
            "--expected-resume-revision", str(resume["revision"]),
        )
        listed = self.json_store("resume-extraction-request-list")
        fetched = self.json_store(
            "resume-extraction-request-get", "--id", request["requestId"]
        )
        serialized = json.dumps({"request": request, "listed": listed, "fetched": fetched})
        for forbidden in (source.name, str(source), resume["digest"], "private resume text", "Private Resume"):
            self.assertNotIn(forbidden, serialized)
        failed = self.json_store(
            "resume-extraction-request-fail", "--id", request["requestId"],
            "--reason", "interrupted", "--expected-revision", str(request["revision"]),
        )
        retried = self.json_store(
            "resume-extraction-request-retry", "--id", request["requestId"],
            "--expected-revision", str(failed["revision"]),
            "--expected-resume-revision", str(resume["revision"]),
        )
        candidate = self.write_input("candidate.json", {
            "email": "candidate-private@example.invalid"
        })
        completed = self.json_store(
            "resume-extraction-request-complete", "--id", retried["requestId"],
            "--input", str(candidate), "--expected-request-revision",
            str(retried["revision"]), "--expected-profile-revision", "1",
        )
        self.assertNotIn("candidate-private@example.invalid", json.dumps(completed))

    def test_profile_preparedness_cli_matches_store(self):
        self.json_store("init")
        source = self.home / "preparedness-cli-private.txt"
        source.write_text("preparedness cli private bytes", encoding="utf-8")
        resume_input = self.write_input("preparedness-resume.json", {
            "id": "preparedness-cli", "label": "Preparedness Private Label",
            "path": str(source),
        })
        resume = self.json_store("resume-import", "--input", str(resume_input))
        profile_input = self.write_input("preparedness-profile.json", {
            "firstName": "Private First", "lastName": "Private Last",
            "email": "private-cli@example.invalid", "skills": ["Private Skill"],
        })
        self.json_store(
            "profile-replace", "--input", str(profile_input),
            "--expected-revision", "1", "--source", "user",
        )
        request = self.json_store(
            "resume-extraction-request-create", "--resume-id", resume["id"],
            "--expected-resume-revision", str(resume["revision"]),
        )
        projection = self.json_store("profile-preparedness-get")
        self.assertEqual(
            set(projection), {"essentialSetup", "commonCoverage", "reviewHealth"}
        )
        self.assertEqual(projection["reviewHealth"][0]["requestId"], request["requestId"])
        serialized = json.dumps(projection, sort_keys=True).lower()
        for forbidden in (
            "score", "percent", "employability", "job_ready", "private first",
            "private last", "private-cli@example.invalid", "private skill",
            source.name.lower(), str(source).lower(), resume["digest"],
            "preparedness cli private bytes", "preparedness private label",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_concurrent_cli_acquisition_allows_only_one_global_claim(self):
        self.json_store("init")
        profile = self.write_input("concurrent-profile.json", {"firstName": "Synthetic"})
        self.json_store(
            "profile-replace",
            "--input",
            str(profile),
            "--expected-revision",
            str(self.json_store("profile-inspect")["revision"]),
            "--source",
            "user",
        )
        resume_path = self.home / "concurrent-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
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
