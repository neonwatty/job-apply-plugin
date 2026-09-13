from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_ready_acquisition_is_exclusive_and_uses_assigned_resume(self):
        self._make_ready_job(assigned=True)
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        self.assertEqual(acquired["job"]["status"], "in_progress")
        self.assertEqual(acquired["resume"]["id"], "assigned-resume")
        self.assertNotIn("tokenHash", acquired["claim"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "live job claim"):
            self.store.acquire_ready_job("ready-job", "claude", ready["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "claim token"):
            self.store.save_claim_progress(
                "ready-job", "wrong-token", {"status": "active", "step": "form"}
            )
        protected = self.store.save_claim_progress(
            "ready-job", acquired["token"], {"status": "active", "step": "protected"}
        )
        for action in (
            lambda: self.store.save_session(
                "ready-job", {"status": "review", "step": "overwrite"}
            ),
            lambda: self.store.delete_session("ready-job"),
        ):
            with self.assertRaisesRegex(
                STORE_MODULE.StoreError, "coordinator operation"
            ):
                action()
        self.assertEqual(self.store.load_session("ready-job"), protected)
        events = self.store.read_history()
        self.assertEqual([event["event"] for event in events], ["job-started"])

    def test_ready_acquisition_rejects_tampered_managed_resume_without_side_effects(self):
        ready = self._make_ready_job(assigned=True)
        resume = self.store.get_resume("assigned-resume")
        managed_path = self.store.resume_files_path / resume["managedFile"]
        managed_path.write_bytes(b"%PDF-1.7\ntampered assigned resume")
        self.store._ensure_coordinator_files()
        before = {
            "jobs": self.store.jobs_path.read_bytes(),
            "coordinator": self.store.coordinator_path.read_bytes(),
            "journal": self.store.coordinator_journal_path.read_bytes(),
            "history": self.store.history_path.read_bytes(),
        }

        preflight = self.store.preflight_job("ready-job")
        self.assertFalse(preflight["ready"])
        self.assertIn("resume_file_changed", preflight["errors"])
        self.assertNotIn("resume_file_changed", preflight["warnings"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "job is not ready"):
            self.store.acquire_ready_job("ready-job", "codex", ready["revision"])

        self.assertEqual(self.store.get_job("ready-job"), ready)
        self.assertIsNone(self.store.claim_status()["claim"])
        self.assertEqual(self.store.jobs_path.read_bytes(), before["jobs"])
        self.assertEqual(self.store.coordinator_path.read_bytes(), before["coordinator"])
        self.assertEqual(self.store.coordinator_journal_path.read_bytes(), before["journal"])
        self.assertEqual(self.store.history_path.read_bytes(), before["history"])

    def test_ready_acquisition_preserves_changed_legacy_resume_warning(self):
        self.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.store.inspect_profile()["revision"],
            source="user",
        )
        external = self.home / "legacy.pdf"
        external.write_bytes(b"%PDF-1.7\nlegacy resume")
        now = "2026-08-25T00:00:00Z"
        document = self.store._load_resumes_document()
        document["resumes"]["legacy"] = {
            "id": "legacy",
            "label": "Legacy",
            "path": str(external),
            "tags": [],
            "default": True,
            "observedSize": external.stat().st_size,
            "observedModifiedAt": STORE_MODULE.observe_resume_file(str(external))["modifiedAt"],
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        STORE_MODULE.atomic_write_json(self.store.resumes_path, document)
        job = self.store.create_job(
            {
                "id": "legacy-job",
                "url": "https://example.com/jobs/legacy",
                "role": "Engineer",
                "company": "Acme",
            }
        )
        ready = self.store.transition_job("legacy-job", "ready", job["revision"])
        external.write_bytes(b"%PDF-1.7\nchanged legacy resume")

        preflight = self.store.preflight_job("legacy-job")
        self.assertTrue(preflight["ready"])
        self.assertNotIn("resume_file_changed", preflight["errors"])
        self.assertIn("resume_file_changed", preflight["warnings"])
        acquired = self.store.acquire_ready_job(
            "legacy-job", "codex", ready["revision"]
        )
        self.assertEqual(acquired["job"]["status"], "in_progress")
        self.assertEqual(acquired["resume"]["path"], str(external))

    def test_expired_claim_requires_explicit_same_job_recovery_and_rotates_token(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        instant[0] += timedelta(seconds=301)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "explicit same-job recovery"):
            self.store.acquire_ready_job("ready-job", "claude", ready["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "claimed job"):
            self.store.recover_claim("different-job", "claude")
        recovered = self.store.recover_claim("ready-job", "claude")
        self.assertNotEqual(recovered["token"], acquired["token"])
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["job-started", "claim-recovered"],
        )

    def test_job_activity_projection_tracks_lifecycle_and_strictly_redacts_secrets(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        ready = self._make_ready_job()
        other = self.store.create_job({
            "id": "other-job", "url": "https://example.com/jobs/other",
            "role": "Other role", "company": "Other company",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "private-owner", ready["revision"]
        )
        progress = {
            "status": "active",
            "step": "questions",
            "answerKeys": ["private.answer.key"],
            "pendingFields": [{
                "question": "Are you authorized to work here?",
                "state": "missing",
                "answerKey": "private.answer.key",
                "sensitive": True,
            }],
        }
        self.store.save_claim_progress(ready["id"], acquired["token"], progress)

        activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(
            (activity["job"]["status"], activity["claim"]["state"]),
            ("in_progress", "active"),
        )
        self.assertEqual(activity["session"]["step"], "questions")
        self.assertEqual(activity["session"]["pendingInformation"][0] | {"reference": "opaque"}, {
            "state": "missing",
            "sensitive": True,
            "reference": "opaque",
            "resolutionEligible": False,
        })
        self.assertRegex(
            activity["session"]["pendingInformation"][0]["reference"],
            r"^pending_[a-f0-9]{32}$",
        )
        self.assertEqual(
            [event["event"] for event in activity["history"]], ["job-started"]
        )
        serialized = json.dumps(activity)
        for forbidden in (
            acquired["token"], "private-owner", "private.answer.key",
            "tokenHash", "claimId", "ownerLabel", "answerKey", "answerKeys",
            "operationId", "resultClaim", "browserState",
        ):
            self.assertNotIn(forbidden, serialized)

        unrelated = self.store.get_job_activity(other["id"])
        self.assertEqual(unrelated["claim"], {"state": "none"})
        self.assertNotIn(ready["id"], json.dumps(unrelated))

        coordinator = self.store._load_coordinator_document()
        STORE_MODULE.atomic_write_json(
            self.store.coordinator_path,
            {"schemaVersion": STORE_MODULE.SCHEMA_VERSION, "claim": None},
        )
        interrupted = self.store.get_job_activity(ready["id"])
        self.assertEqual(interrupted["claim"]["state"], "interrupted")
        self.assertIn("job-transition", interrupted["claim"]["recoveryGuidance"])
        self.assertIn("needs_info", interrupted["claim"]["recoveryGuidance"])
        self.assertNotIn("claim-recover", interrupted["claim"]["recoveryGuidance"])
        STORE_MODULE.atomic_write_json(self.store.coordinator_path, coordinator)

        instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS + 1)
        expired = self.store.get_job_activity(ready["id"])
        self.assertEqual(expired["claim"]["state"], "expired")
        self.assertIn("claim-recover", expired["claim"]["recoveryGuidance"])
        recovered = self.store.recover_claim(ready["id"], "replacement-owner")
        renewed = self.store.get_job_activity(ready["id"])
        self.assertEqual(renewed["claim"]["state"], "active")
        self.assertEqual(
            [event["event"] for event in renewed["history"]],
            ["job-started", "claim-recovered"],
        )
        self.assertNotIn(recovered["token"], json.dumps(renewed))

        handed = self.store.handoff_claimed_job(
            ready["id"], recovered["token"], "needs_info", progress,
            recovered["job"]["revision"],
        )
        handed_activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(handed_activity["job"]["revision"], handed["job"]["revision"])
        self.assertEqual(handed_activity["claim"], {"state": "none"})
        self.assertEqual(
            [event["event"] for event in handed_activity["history"]],
            ["job-started", "claim-recovered", "job-blocked"],
        )

    def test_acquire_and_recover_tokens_are_cli_safe_when_random_payload_leads_hyphen(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        ready = self._make_ready_job()

        with mock.patch.object(
            STORE_MODULE.secrets,
            "token_urlsafe",
            side_effect=["-acquire-payload", "-recovery-payload"],
        ):
            acquired = self.store.acquire_ready_job(
                "ready-job", "codex", ready["revision"]
            )
            self.assertEqual(acquired["token"], "claim_-acquire-payload")
            parsed = STORE_MODULE.build_parser().parse_args(
                [
                    "--root",
                    str(self.root),
                    "claim-heartbeat",
                    "--id",
                    "ready-job",
                    "--token",
                    acquired["token"],
                ]
            )
            self.assertEqual(parsed.token, acquired["token"])
            persisted = self.store.coordinator_path.read_text(encoding="utf-8")
            self.assertNotIn(acquired["token"], persisted)
            self.assertIn(self.store._token_hash(acquired["token"]), persisted)

            instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS + 1)
            recovered = self.store.recover_claim("ready-job", "recovery-agent")
            self.assertEqual(recovered["token"], "claim_-recovery-payload")
            parsed = STORE_MODULE.build_parser().parse_args(
                [
                    "--root",
                    str(self.root),
                    "claim-progress",
                    "--id",
                    "ready-job",
                    "--token",
                    recovered["token"],
                    "--input",
                    "progress.json",
                ]
            )
            self.assertEqual(parsed.token, recovered["token"])
            persisted = self.store.coordinator_path.read_text(encoding="utf-8")
            self.assertNotIn(recovered["token"], persisted)
            self.assertIn(self.store._token_hash(recovered["token"]), persisted)

    def test_claim_handoffs_are_atomic_value_free_and_release_ownership(self):
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        pending = {
            "status": "active", "step": "questions", "answerKeys": ["question.safe"],
            "pendingFields": [{"question": "Authorization?", "state": "missing", "answerKey": "question.safe", "sensitive": False}],
        }
        self.store.save_claim_progress("ready-job", acquired["token"], pending)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unsupported fields"):
            self.store.save_claim_progress(
                "ready-job", acquired["token"],
                {"status": "active", "pendingFields": [{"question": "Salary?", "value": "250K"}]},
            )
        handoff = self.store.handoff_claimed_job(
            "ready-job", acquired["token"], "needs_info", pending,
            acquired["job"]["revision"],
        )
        self.assertEqual(handoff["job"]["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        stored = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (self.store.coordinator_path, self.store.coordinator_journal_path,
                         self.store.history_path, self.store._session_path("ready-job"))
        )
        self.assertNotIn(acquired["token"], stored)
        self.assertNotIn("250K", stored)
        self.assertEqual([event["event"] for event in self.store.read_history()], ["job-started", "job-blocked"])
