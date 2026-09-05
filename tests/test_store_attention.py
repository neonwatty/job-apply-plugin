from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_needs_attention_snapshot_is_complete_ordered_redacted_and_converges(self):
        instant = [datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        self.store.replace_profile(
            {"firstName": "Ada"}, expected_revision=0, source="user"
        )
        resume_path = self.home / "attention.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nattention")
        self.store.create_resume(
            {"id": "attention-resume", "label": "Attention", "path": str(resume_path)}
        )

        def ready(job_id, priority):
            created = self.store.create_job({
                "id": job_id,
                "url": f"https://example.com/jobs/{job_id}",
                "role": f"Role {job_id}",
                "company": f"Company {job_id}",
                "priority": priority,
            })
            return self.store.transition_job(job_id, "ready", created["revision"])

        review_ready = ready("review-job", 5)
        review_claim = self.store.acquire_ready_job(
            review_ready["id"], "private-review-owner", review_ready["revision"]
        )
        review = self.store.handoff_claimed_job(
            review_ready["id"], review_claim["token"], "awaiting_review",
            self.review_session(review_claim["job"]["revision"]),
            review_claim["job"]["revision"],
        )["job"]

        needs_ready = ready("needs-job", 4)
        needs_claim = self.store.acquire_ready_job(
            needs_ready["id"], "private-needs-owner", needs_ready["revision"]
        )
        needs = self.store.handoff_claimed_job(
            needs_ready["id"], needs_claim["token"], "needs_info",
            {
                "status": "active",
                "step": "questions",
                "answerKeys": ["secret.answer.key"],
                "pendingFields": [
                    {"question": "Private question?", "state": "missing", "answerKey": "secret.answer.key", "sensitive": True},
                    {"question": "Another private question?", "state": "missing", "answerKey": "other.secret", "sensitive": False},
                ],
            },
            needs_claim["job"]["revision"],
        )["job"]

        browser_ready = ready("browser-action-job", 4)
        browser_claim = self.store.acquire_ready_job(
            browser_ready["id"], "private-browser-owner", browser_ready["revision"]
        )
        browser_action = self.store.handoff_claimed_job(
            browser_ready["id"], browser_claim["token"], "needs_info",
            {
                "status": "active",
                "step": "form",
                "attemptRevision": browser_claim["job"]["revision"],
                "pendingFields": [],
                "blockers": [
                    {"type": "browser_handoff", "code": "unsupported-control"},
                    {"type": "information", "code": "owner-input-required"},
                ],
                "browserHandoff": {
                    "state": "required", "reasonCode": "unsupported-control",
                    "revision": 1,
                },
            },
            browser_claim["job"]["revision"],
        )["job"]

        mixed_ready = ready("mixed-browser-action-job", 4)
        mixed_claim = self.store.acquire_ready_job(
            mixed_ready["id"], "private-mixed-owner", mixed_ready["revision"]
        )
        mixed_action = self.store.handoff_claimed_job(
            mixed_ready["id"], mixed_claim["token"], "needs_info",
            {
                "status": "active",
                "step": "form",
                "attemptRevision": mixed_claim["job"]["revision"],
                "pendingFields": [],
                "blockers": [
                    {"type": "browser_handoff", "code": "unsupported-control"},
                    {"type": "information", "code": "owner-input-required"},
                    {"type": "browser_handoff", "code": "captcha-required"},
                ],
                "browserHandoff": {
                    "state": "required", "reasonCode": "unsupported-control",
                    "revision": 1,
                },
            },
            mixed_claim["job"]["revision"],
        )["job"]

        interrupted_ready = ready("interrupted-job", 3)
        self.store.acquire_ready_job(
            interrupted_ready["id"], "private-interrupted-owner", interrupted_ready["revision"]
        )
        STORE_MODULE.atomic_write_json(
            self.store.coordinator_path,
            {"schemaVersion": STORE_MODULE.SCHEMA_VERSION, "claim": None},
        )

        expired_ready = ready("expired-job", 1)
        expired_claim = self.store.acquire_ready_job(
            expired_ready["id"], "private-expired-owner", expired_ready["revision"]
        )
        instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS + 1)

        projection = self.store.list_needs_attention()
        self.assertEqual(
            [item["reasonCode"] for item in projection["items"]],
            [
                "expired_agent_attempt",
                "claimless_interrupted_attempt",
                "awaiting_human_review",
                "browser_action_required",
                "needs_information",
                "needs_information",
            ],
        )
        allowed = {
            "jobId", "status", "revision", "priority",
            "reasonCode", "reasonLabel", "attentionAt", "guidance",
            "missingInformationCount", "sessionRevision", "session",
        }
        self.assertTrue(all(set(item) == allowed for item in projection["items"]))
        self.assertEqual(projection["items"][-1]["missingInformationCount"], 2)
        browser_row = next(
            item for item in projection["items"]
            if item["jobId"] == browser_action["id"]
        )
        self.assertEqual(browser_row["reasonLabel"], "Browser action required")
        self.assertEqual(browser_row["missingInformationCount"], 0)
        self.assertIn("already known", browser_row["guidance"])
        self.assertNotIn("missing", browser_row["guidance"].lower())
        mixed_row = next(
            item for item in projection["items"]
            if item["jobId"] == mixed_action["id"]
        )
        self.assertEqual(mixed_row["reasonCode"], "needs_information")
        self.assertNotIn("already known", mixed_row["guidance"])
        self.assertEqual(
            {entry["code"] for entry in mixed_row["session"]["blockers"]},
            {"unsupported-control", "owner-input-required", "captcha-required"},
        )
        self.assertEqual(projection, self.store.list_needs_attention())
        serialized = json.dumps(projection)
        for forbidden in (
            expired_claim["token"], "private-expired-owner", "private-review-owner",
            "Private question?", "secret.answer.key", "answerKey",
            "tokenHash", "claimId", "ownerLabel", "operationId", "browserState",
            "Role review-job", "Company review-job",
        ):
            self.assertNotIn(forbidden, serialized)

        recovered = self.store.recover_claim("expired-job", "replacement-owner")
        handed = self.store.handoff_claimed_job(
            "expired-job", recovered["token"], "awaiting_review",
            self.review_session(recovered["job"]["revision"]),
            recovered["job"]["revision"],
        )["job"]
        self.store.transition_job("expired-job", "applied", handed["revision"], user_confirmed=True)
        interrupted = self.store.get_job("interrupted-job")
        interrupted = self.store.transition_job("interrupted-job", "needs_info", interrupted["revision"])
        self.store.transition_job("interrupted-job", "saved", interrupted["revision"])
        self.store.transition_job("review-job", "applied", review["revision"], user_confirmed=True)
        self.store.transition_job("needs-job", "saved", needs["revision"])
        self.store.transition_job(
            "browser-action-job", "saved", browser_action["revision"]
        )
        self.store.transition_job(
            "mixed-browser-action-job", "saved", mixed_action["revision"]
        )
        self.assertEqual(self.store.list_needs_attention()["items"], [])

    def test_pending_answer_recheck_preserves_exact_resume_and_resumes_to_review(self):
        self._make_ready_job(assigned=True)
        resume_before = self.store.get_resume("assigned-resume")
        resume_bytes_before = (
            self.store.resume_files_path / resume_before["managedFile"]
        ).read_bytes()
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "first-owner", ready["revision"])
        pending = {
            "status": "active", "step": "questions", "answerKeys": [],
            "pendingFields": [
                {"question": "Authorization?", "state": "missing", "answerKey": "question.safe", "sensitive": False},
                {"question": "Availability?", "state": "missing", "answerKey": "question.second", "sensitive": False},
            ],
        }
        self.store.save_claim_progress("ready-job", acquired["token"], pending)
        blocked = self.store.handoff_claimed_job(
            "ready-job", acquired["token"], "needs_info", pending,
            acquired["job"]["revision"],
        )
        answer = self.store.put_answer({
            "key": "question.safe", "question": "Authorization?",
            "state": "confirmed", "value": "private accepted value",
        })
        second_answer = self.store.put_answer({
            "key": "question.second", "question": "Availability?",
            "state": "confirmed", "value": "another private value",
        })
        activity = self.store.get_job_activity("ready-job")
        reference = activity["session"]["pendingInformation"][0]["reference"]
        resolved = self.store.resolve_pending_answer(
            "ready-job", reference, blocked["job"]["revision"],
            activity["session"]["revision"], answer["revision"], True,
        )
        self.assertFalse(resolved["ready"])
        self.assertEqual(resolved["job"]["status"], "needs_info")
        self.assertEqual(len(resolved["session"]["pendingInformation"]), 1)
        final_reference = resolved["session"]["pendingInformation"][0]["reference"]
        managed_path = self.store.resume_files_path / resume_before["managedFile"]
        resume_metadata_before = managed_path.stat()
        state_before_changed_resume = (
            self.store.jobs_path.read_bytes(),
            self.store._session_path("ready-job").read_bytes(),
        )
        managed_path.write_bytes(b"changed resume bytes")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "preflight failed"):
            self.store.resolve_pending_answer(
                "ready-job", final_reference, resolved["job"]["revision"],
                resolved["session"]["revision"], second_answer["revision"], True,
            )
        self.assertEqual(
            (self.store.jobs_path.read_bytes(), self.store._session_path("ready-job").read_bytes()),
            state_before_changed_resume,
        )
        managed_path.write_bytes(resume_bytes_before)
        os.utime(
            managed_path,
            ns=(resume_metadata_before.st_atime_ns, resume_metadata_before.st_mtime_ns),
        )
        resolved = self.store.resolve_pending_answer(
            "ready-job", final_reference, resolved["job"]["revision"],
            resolved["session"]["revision"], second_answer["revision"], True,
        )
        self.assertTrue(resolved["ready"])
        self.assertEqual(resolved["session"]["pendingInformation"], [])
        serialized = json.dumps(resolved) + self.store.history_path.read_text(encoding="utf-8") + self.store._session_path("ready-job").read_text(encoding="utf-8")
        self.assertNotIn("private accepted value", serialized)
        self.assertNotIn("another private value", serialized)
        resumed = self.store.acquire_ready_job(
            "ready-job", "second-owner", resolved["job"]["revision"]
        )
        for field in ("id", "revision", "contentRevision", "digest"):
            self.assertEqual(resumed["resume"][field], acquired["resume"][field])
            self.assertEqual(resumed["resume"][field], resume_before[field])
        self.assertEqual(
            (self.store.resume_files_path / resume_before["managedFile"]).read_bytes(),
            resume_bytes_before,
        )
        reviewed = self.store.handoff_claimed_job(
            "ready-job", resumed["token"], "awaiting_review",
            self.review_session(resumed["job"]["revision"]),
            resumed["job"]["revision"],
        )
        self.assertEqual(reviewed["job"]["status"], "awaiting_review")
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["job-started", "job-blocked", "job-started", "reviewed"],
        )

    def test_resolving_last_answer_keeps_job_blocked_by_other_attention(self):
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        answer = self.store.put_answer({
            "question": "Authorization?", "state": "confirmed", "value": "yes",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "blocked-resolution", ready["revision"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "session blocker is invalid"):
            self.store.handoff_claimed_job(
                ready["id"], acquired["token"], "needs_info", {
                    "status": "active",
                    "attemptRevision": acquired["job"]["revision"],
                    "pendingFields": [{
                        "question": "Authorization?", "state": "missing",
                        "answerKey": answer["key"], "sensitive": False,
                    }],
                    "blockers": [{
                        "type": "information", "code": "captcha-required",
                    }],
                }, acquired["job"]["revision"],
            )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Authorization?", "state": "missing",
                    "answerKey": answer["key"], "sensitive": False,
                }],
                "blockers": [{"type": "browser_handoff", "code": "login-required"}],
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        resolved = self.store.resolve_pending_answer(
            ready["id"],
            activity["session"]["pendingInformation"][0]["reference"],
            handed["job"]["revision"], activity["session"]["revision"],
            answer["revision"], owner_confirmed=True,
        )
        self.assertFalse(resolved["ready"])
        self.assertEqual(resolved["job"]["status"], "needs_info")
        self.assertEqual(
            self.store.get_job_activity(ready["id"])["session"]["blockers"],
            [{"type": "browser_handoff", "code": "login-required"}],
        )
        self.assertEqual(
            self.store.get_job_activity(ready["id"])["session"]["browserHandoff"],
            {"state": "required", "reasonCode": "login-required", "revision": 1},
        )

    def test_resolving_last_answer_keeps_required_browser_handoff_blocked(self):
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        answer = self.store.put_answer({
            "question": "Authorization?", "state": "confirmed", "value": "yes",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "browser-handoff-resolution", ready["revision"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "browser handoff is invalid"):
            self.store.handoff_claimed_job(
                ready["id"], acquired["token"], "needs_info", {
                    "status": "active",
                    "attemptRevision": acquired["job"]["revision"],
                    "pendingFields": [{
                        "question": "Authorization?", "state": "missing",
                        "answerKey": answer["key"], "sensitive": False,
                    }],
                    "browserHandoff": {
                        "state": "not_required", "reasonCode": "captcha-required",
                        "revision": 1,
                    },
                }, acquired["job"]["revision"],
            )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Authorization?", "state": "missing",
                    "answerKey": answer["key"], "sensitive": False,
                }],
                "browserHandoff": {
                    "state": "required", "reasonCode": "captcha-required",
                    "revision": 1,
                },
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        resolved = self.store.resolve_pending_answer(
            ready["id"],
            activity["session"]["pendingInformation"][0]["reference"],
            handed["job"]["revision"], activity["session"]["revision"],
            answer["revision"], owner_confirmed=True,
        )
        self.assertFalse(resolved["ready"])
        self.assertEqual(resolved["job"]["status"], "needs_info")
        self.assertEqual(
            self.store.get_job_activity(ready["id"])["session"]["browserHandoff"],
            {"state": "required", "reasonCode": "captcha-required", "revision": 1},
        )

    def test_pending_answer_resolution_negative_matrix_is_side_effect_free(self):
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        safe = self.store.put_answer({"key": "safe", "state": "confirmed", "value": "private"})
        self.store.put_answer({"key": "unconfirmed", "state": "missing"})
        observed = self.store.observe_answer({
            "question": "Declined?", "scope": {"kind": "declined"},
            "state": "missing",
        })
        self.store.review_answer(observed["key"], "declined", observed["revision"])
        self.store.put_answer(
            {"key": "sensitive", "state": "sensitive", "sensitivity": "high", "value": "secret"},
            remember_sensitive=True,
        )
        acquired = self.store.acquire_ready_job("ready-job", "owner", ready["revision"])
        pending = {
            "status": "active", "step": "questions", "answerKeys": [],
            "pendingFields": [
                {"question": "Safe?", "state": "missing", "answerKey": "safe", "sensitive": False},
                {"question": "Missing?", "state": "missing", "answerKey": "absent", "sensitive": False},
                {"question": "Unconfirmed?", "state": "missing", "answerKey": "unconfirmed", "sensitive": False},
                {"question": "Declined?", "state": "missing", "answerKey": observed["key"], "sensitive": False},
                {"question": "Sensitive?", "state": "missing", "answerKey": "sensitive", "sensitive": False},
            ],
        }
        self.store.save_claim_progress("ready-job", acquired["token"], pending)
        blocked = self.store.handoff_claimed_job(
            "ready-job", acquired["token"], "needs_info", pending,
            acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity("ready-job")
        references = [item["reference"] for item in activity["session"]["pendingInformation"]]
        baseline = {
            path: path.read_bytes()
            for path in (
                self.store.jobs_path, self.store._session_path("ready-job"),
                self.store.coordinator_path, self.store.coordinator_journal_path,
                self.store.history_path,
            )
        }
        attempts = [
            (references[0], blocked["job"]["revision"], activity["session"]["revision"], safe["revision"], False, "owner confirmation"),
            (references[0], blocked["job"]["revision"] + 1, activity["session"]["revision"], safe["revision"], True, "job revision conflict"),
            (references[0], blocked["job"]["revision"], activity["session"]["revision"] + 1, safe["revision"], True, "session revision conflict"),
            (references[0], blocked["job"]["revision"], activity["session"]["revision"], safe["revision"] + 1, True, "answer revision conflict"),
            (f"pending_{'0' * 32}", blocked["job"]["revision"], activity["session"]["revision"], safe["revision"], True, "reference is stale"),
        ]
        answer_revisions = [safe["revision"], 1, 1, 2, 1]
        expected_messages = [None, "does not exist", "not accepted and confirmed", "not accepted and confirmed", "not accepted and confirmed"]
        for reference, revision, message in zip(references, answer_revisions, expected_messages):
            if message is None:
                continue
            attempts.append((reference, blocked["job"]["revision"], activity["session"]["revision"], revision, True, message))
        for reference, job_revision, session_revision, answer_revision, confirmed, message in attempts:
            with self.subTest(message=message):
                with self.assertRaisesRegex(STORE_MODULE.StoreError, message):
                    self.store.resolve_pending_answer(
                        "ready-job", reference, job_revision, session_revision,
                        answer_revision, confirmed,
                    )
                for path, content in baseline.items():
                    self.assertEqual(path.read_bytes(), content)
