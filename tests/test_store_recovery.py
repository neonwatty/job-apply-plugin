from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_answer_resolution_journal_recovers_idempotently_before_and_after_each_write(self):
        original_write = STORE_MODULE.atomic_write_json
        for fail_at in range(1, 6):
            for timing in ("before", "after"):
                with self.subTest(fail_at=fail_at, timing=timing), tempfile.TemporaryDirectory() as temporary:
                    root = Path(temporary) / "store"
                    store = STORE_MODULE.Store(root, Path(temporary) / "legacy.json")
                    store.replace_profile(
                        {"firstName": "Ada"},
                        expected_revision=store.inspect_profile()["revision"],
                        source="user",
                    )
                    resume_path = Path(temporary) / "resume.pdf"
                    resume_path.write_bytes(b"%PDF-1.7\njournal")
                    store.create_resume({"id": "resume", "label": "Resume", "path": str(resume_path)})
                    job = store.create_job({
                        "id": "journal-job", "url": "https://example.com/jobs/journal",
                        "role": "Engineer", "company": "Acme",
                    })
                    job = store.transition_job(job["id"], "ready", job["revision"])
                    acquired = store.acquire_ready_job(job["id"], "owner", job["revision"])
                    pending = {
                        "status": "active", "step": "questions", "pendingFields": [{
                            "question": "Authorization?", "state": "missing",
                            "answerKey": "safe", "sensitive": False,
                        }],
                    }
                    store.save_claim_progress(job["id"], acquired["token"], pending)
                    blocked = store.handoff_claimed_job(
                        job["id"], acquired["token"], "needs_info", pending,
                        acquired["job"]["revision"],
                    )
                    answer = store.put_answer({"key": "safe", "state": "confirmed", "value": "private"})
                    activity = store.get_job_activity(job["id"])
                    reference = activity["session"]["pendingInformation"][0]["reference"]
                    calls = {"count": 0}

                    def interrupted_write(path, payload):
                        calls["count"] += 1
                        if calls["count"] == fail_at and timing == "before":
                            raise OSError("simulated answer-resolution interruption")
                        result = original_write(path, payload)
                        if calls["count"] == fail_at and timing == "after":
                            raise OSError("simulated answer-resolution interruption")
                        return result

                    with mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=interrupted_write):
                        with self.assertRaisesRegex(OSError, "simulated answer-resolution interruption"):
                            store.resolve_pending_answer(
                                job["id"], reference, blocked["job"]["revision"],
                                activity["session"]["revision"], answer["revision"], True,
                            )

                    repaired = STORE_MODULE.Store(root, Path(temporary) / "legacy.json")
                    repaired_activity = repaired.get_job_activity(job["id"])
                    if fail_at == 1 and timing == "before":
                        self.assertEqual(repaired.get_job(job["id"])["status"], "needs_info")
                        repaired.resolve_pending_answer(
                            job["id"], reference, blocked["job"]["revision"],
                            activity["session"]["revision"], answer["revision"], True,
                        )
                    self.assertEqual(repaired.get_job(job["id"])["status"], "ready")
                    self.assertEqual(repaired.get_job_activity(job["id"])["session"]["pendingInformation"], [])
                    revision = repaired.get_job(job["id"])["revision"]
                    repaired.get_job_activity(job["id"])
                    repaired.initialize()
                    self.assertEqual(repaired.get_job(job["id"])["revision"], revision)
                    self.assertIsNone(repaired._load_coordinator_journal()["operation"])

    def test_coordinator_journal_rolls_forward_after_partial_failure_without_duplicates(self):
        self._make_ready_job()
        original = STORE_MODULE.atomic_write_json
        failed = {"done": False}

        def fail_coordinator_once(path, payload):
            if path == self.store.coordinator_path and payload.get("claim") is not None and not failed["done"]:
                failed["done"] = True
                raise OSError("simulated crash")
            return original(path, payload)

        with mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_coordinator_once):
            with self.assertRaises(OSError):
                ready = self.store.get_job("ready-job")
                self.store.acquire_ready_job(
                    "ready-job", "codex", ready["revision"]
                )
        repaired = STORE_MODULE.Store(self.root, self.legacy)
        status = repaired.claim_status()
        self.assertIsNotNone(status["claim"])
        self.assertEqual(repaired.get_job("ready-job")["status"], "in_progress")
        self.assertEqual([event["event"] for event in repaired.read_history()], ["job-started"])
        self.assertIsNone(repaired._load_coordinator_journal()["operation"])

    def test_claimed_jobs_reject_generic_mutations_and_divergence_claim_actions(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        revision = acquired["job"]["revision"]
        for action in (
            lambda: self.store.transition_job("ready-job", "awaiting_review", revision),
            lambda: self.store.trash_job("ready-job", revision),
            lambda: self.store.delete_job("ready-job", revision),
        ):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "coordinator operation"):
                action()

        document = json.loads(self.store.jobs_path.read_text(encoding="utf-8"))
        document["jobs"]["ready-job"]["status"] = "awaiting_review"
        document["jobs"]["ready-job"]["revision"] += 1
        self.store.jobs_path.write_text(json.dumps(document), encoding="utf-8")
        for action in (
            lambda: self.store.heartbeat_claim("ready-job", acquired["token"]),
            lambda: self.store.save_claim_progress(
                "ready-job", acquired["token"], {"status": "active", "step": "form"}
            ),
            lambda: self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "awaiting_review",
                {"status": "review", "step": "review"}, revision + 1,
            ),
            lambda: self.store.recover_claim("ready-job", "recovery-agent"),
        ):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "not in progress"):
                action()

    def test_lease_boundary_expires_exactly_at_expires_at(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "claim has expired"):
            self.store.heartbeat_claim("ready-job", acquired["token"])
        recovered = self.store.recover_claim("ready-job", "recovery-agent")
        self.assertNotEqual(recovered["token"], acquired["token"])

    def test_expected_revisions_and_default_resume_are_enforced(self):
        ready = self._make_ready_job()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.acquire_ready_job("ready-job", "codex", ready["revision"] - 1)
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        self.assertEqual(acquired["resume"]["id"], "default-resume")
        updated = self.store.update_job(
            "ready-job", {"notes": "human update"}, acquired["job"]["revision"]
        )
        review = self.review_session(updated["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "awaiting_review", review,
                acquired["job"]["revision"],
            )
        self.assertIsNotNone(self.store.claim_status()["claim"])
        handed = self.store.handoff_claimed_job(
            "ready-job", acquired["token"], "awaiting_review", review,
            updated["revision"],
        )
        self.assertEqual(handed["job"]["status"], "awaiting_review")
