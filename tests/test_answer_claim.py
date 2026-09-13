from tests.support.answer_cli_case import *


class AnswerMemoryIntegrationTests(AnswerCliCase):
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
