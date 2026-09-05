from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_job_crud_normalizes_urls_rejects_duplicates_and_checks_revisions(self):
        created = self.store.create_job(
            {
                "id": "acme-engineer",
                "url": "HTTPS://Jobs.Example.com:443/roles/1#apply",
                "source": "manual",
                "role": "Engineer",
                "company": "Acme",
                "priority": 4,
            }
        )
        self.assertEqual(created["normalizedUrl"], "https://jobs.example.com/roles/1")
        self.assertEqual(created["status"], "saved")
        self.assertEqual(created["revision"], 1)
        self.assertEqual(self.store.get_job("acme-engineer"), created)
        self.assertEqual(self.store.list_jobs(), [created])

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already exists"):
            self.store.create_job(
                {
                    "id": "duplicate",
                    "url": "https://jobs.example.com/roles/1",
                }
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "credentials"):
            self.store.create_job(
                {
                    "id": "credential-url",
                    "url": "https://user:private@example.com/jobs/2",
                }
            )

        updated = self.store.update_job(
            "acme-engineer",
            {"notes": "Strong match", "priority": 5},
            expected_revision=1,
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["notes"], "Strong match")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_job(
                "acme-engineer", {"role": "Staff Engineer"}, expected_revision=1
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unsupported fields"):
            self.store.update_job(
                "acme-engineer", {"status": "applied"}, expected_revision=2
            )

    def test_job_update_human_can_clear_optional_fields(self):
        job = self.store.create_job(
            {
                "id": "human-clears",
                "url": "https://example.com/jobs/human-clears",
                "role": "Engineer",
                "description": "Original description",
                "notes": "Original notes",
            }
        )
        cleared = self.store.update_job(
            job["id"],
            {"role": "", "description": "", "notes": None},
            expected_revision=job["revision"],
        )
        self.assertEqual(cleared["revision"], job["revision"] + 1)
        self.assertEqual(cleared["role"], "")
        self.assertEqual(cleared["description"], "")
        self.assertIsNone(cleared["notes"])
        for field in ("role", "description", "notes"):
            self.assertEqual(cleared["provenance"][f"/{field}"]["origin"], "human")

        ignored = self.store.update_job(
            job["id"],
            {"role": "", "description": None, "notes": ""},
            expected_revision=cleared["revision"],
            origin="agent",
        )
        self.assertEqual(ignored, cleared)

    def test_job_update_human_preserves_validation_and_string_values(self):
        job = self.store.create_job(
            {
                "id": "human-update-values",
                "url": "https://example.com/jobs/original",
                "role": "Engineer",
                "provenance": {"legacy": {"keep": True}},
            }
        )
        updated = self.store.update_job(
            job["id"],
            {
                "url": " HTTPS://Jobs.Example.com:443/new#apply ",
                "role": "  Principal Engineer  ",
                "company": "",
                "provenance": {"custom": {"version": 1}},
            },
            expected_revision=job["revision"],
        )
        self.assertEqual(updated["url"], "HTTPS://Jobs.Example.com:443/new#apply")
        self.assertEqual(updated["normalizedUrl"], "https://jobs.example.com/new")
        self.assertEqual(updated["role"], "  Principal Engineer  ")
        self.assertEqual(updated["company"], "")
        self.assertIn("custom", updated["provenance"])
        self.assertNotIn("legacy", updated["provenance"])
        for field in ("url", "role", "company"):
            self.assertEqual(updated["provenance"][f"/{field}"]["origin"], "human")

        agent = self.store.update_job(
            job["id"],
            {
                "company": "Agent Company",
                "location": "Remote",
                "provenance": {"/role": {"origin": "agent"}, "hijack": True},
            },
            expected_revision=updated["revision"],
            origin="agent",
        )
        self.assertEqual(agent["company"], "")
        self.assertEqual(agent["location"], "Remote")
        self.assertEqual(agent["provenance"]["/company"]["origin"], "human")
        self.assertEqual(agent["provenance"]["/location"]["origin"], "agent")
        self.assertEqual(agent["provenance"]["/role"]["origin"], "human")
        self.assertIn("custom", agent["provenance"])
        self.assertNotIn("hijack", agent["provenance"])

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "HTTP or HTTPS"):
            self.store.update_job(
                job["id"],
                {"url": "not-a-url"},
                expected_revision=agent["revision"],
            )

    def test_agent_cannot_refill_human_cleared_fields(self):
        job = self.store.create_job(
            {
                "id": "human-cleared-precedence",
                "url": "https://example.com/jobs/human-cleared-precedence",
                "role": "Original Role",
            }
        )
        cleared = self.store.update_job(
            job["id"], {"role": ""}, expected_revision=job["revision"]
        )

        direct = self.store.update_job(
            job["id"],
            {"role": "Agent Role", "company": "Acme"},
            expected_revision=cleared["revision"],
            origin="agent",
        )
        self.assertEqual(direct["role"], "")
        self.assertEqual(direct["company"], "Acme")
        self.assertEqual(direct["provenance"]["/role"]["origin"], "human")

        payload = {
            "jobs": [
                {
                    "url": job["url"],
                    "role": "Agent Retry",
                    "description": "Agent supplied",
                }
            ]
        }
        preview = self.store.preview_job_upsert(payload, "agent")
        self.assertEqual(preview["decisions"][0]["fields"], ["description"])
        self.store.commit_job_upsert(payload, "agent", preview["token"])
        record = self.store.get_job(job["id"])
        self.assertEqual(record["role"], "")
        self.assertEqual(record["description"], "Agent supplied")
        self.assertEqual(record["provenance"]["/role"]["origin"], "human")

    def test_job_transitions_require_supported_flow_and_user_submission(self):
        self.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.store.inspect_profile()["revision"],
            source="user",
        )
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
        self.store.create_resume(
            {"id": "main-resume", "label": "Main", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {"id": "acme-role", "url": "https://example.com/jobs/1"}
        )
        preflight = self.store.preflight_job(job["id"])
        self.assertTrue(preflight["ready"])
        self.assertEqual(preflight["resumeId"], "main-resume")
        self.assertEqual(set(preflight["warnings"]), {"role_missing", "company_missing"})
        job = self.store.transition_job(
            job["id"], "ready", expected_revision=job["revision"]
        )
        acquired = self.store.acquire_ready_job(
            job["id"], "unit-test-agent", job["revision"]
        )
        job = acquired["job"]
        handoff = self.store.handoff_claimed_job(
            job["id"], acquired["token"], "awaiting_review",
            self.review_session(job["revision"]),
            job["revision"],
        )
        job = handoff["job"]
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "user confirmation"):
            self.store.transition_job(
                job["id"], "applied", expected_revision=job["revision"]
            )
        job = self.store.transition_job(
            job["id"],
            "applied",
            expected_revision=job["revision"],
            user_confirmed=True,
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "requires a supported outcome"):
            self.store.transition_job(
                job["id"], "closed", expected_revision=job["revision"]
            )
        job = self.store.transition_job(
            job["id"],
            "closed",
            expected_revision=job["revision"],
            closed_outcome="rejected",
        )
        self.assertEqual((job["status"], job["closedOutcome"]), ("closed", "rejected"))

    def test_ready_transition_fails_closed_without_profile_or_resume(self):
        job = self.store.create_job(
            {"id": "not-ready", "url": "https://example.com/jobs/not-ready"}
        )
        preflight = self.store.preflight_job(job["id"])
        self.assertFalse(preflight["ready"])
        self.assertEqual(
            set(preflight["errors"]), {"profile_empty", "resume_missing"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "not ready"):
            self.store.transition_job(
                job["id"], "ready", expected_revision=job["revision"]
            )

    def test_job_trash_restore_and_permanent_delete_are_guarded(self):
        job = self.store.create_job(
            {"id": "acme-role", "url": "https://example.com/jobs/1"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "must be trashed"):
            self.store.delete_job(job["id"], expected_revision=job["revision"])

        trashed = self.store.trash_job(job["id"], expected_revision=job["revision"])
        self.assertIsNotNone(trashed["deletedAt"])
        self.assertIsNone(self.store.get_job(job["id"]))
        self.assertEqual(
            self.store.get_job(job["id"], include_trashed=True), trashed
        )
        self.assertEqual(self.store.list_jobs(), [])

        restored = self.store.restore_job(
            job["id"], expected_revision=trashed["revision"]
        )
        self.assertIsNone(restored["deletedAt"])
        trashed_again = self.store.trash_job(
            job["id"], expected_revision=restored["revision"]
        )
        result = self.store.delete_job(
            job["id"], expected_revision=trashed_again["revision"]
        )
        self.assertEqual(result, {"deleted": True, "id": job["id"]})
        self.assertIsNone(self.store.get_job(job["id"], include_trashed=True))

    def test_trash_only_filters_are_symmetric_and_job_delete_blocks_nonterminal_session(self):
        self.store.save_session(
            "session-job",
            {"status": "active", "answerKeys": [], "pendingFields": []},
        )
        active_job = self.store.create_job(
            {"id": "active-job", "url": "https://example.com/jobs/active"}
        )
        session_job = self.store.create_job(
            {"id": "session-job", "url": "https://example.com/jobs/session"}
        )
        trashed_job = self.store.trash_job(
            session_job["id"], session_job["revision"]
        )
        self.assertEqual(
            [item["id"] for item in self.store.list_jobs(trashed_only=True)],
            ["session-job"],
        )
        self.assertEqual([item["id"] for item in self.store.list_jobs()], [active_job["id"]])
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "nonterminal application session"
        ):
            self.store.delete_job(trashed_job["id"], trashed_job["revision"])
        self.assertIsNotNone(
            self.store.get_job(trashed_job["id"], include_trashed=True)
        )

        first_path = self.home / "first-trash-filter.pdf"
        second_path = self.home / "second-trash-filter.pdf"
        first_path.write_bytes(b"%PDF-1.7\nfirst")
        second_path.write_bytes(b"%PDF-1.7\nsecond")
        first = self.store.create_resume(
            {"id": "active-resume", "label": "Active", "path": str(first_path)}
        )
        second = self.store.create_resume(
            {"id": "trash-resume", "label": "Trash", "path": str(second_path)}
        )
        second = self.store.trash_resume(second["id"], second["revision"])
        self.assertEqual(
            [item["id"] for item in self.store.list_resumes(trashed_only=True)],
            [second["id"]],
        )
        self.assertEqual(
            [item["id"] for item in self.store.list_resumes()], [first["id"]]
        )

    def test_tampered_job_store_fails_closed(self):
        self.store.initialize()
        document = json.loads(self.store.jobs_path.read_text(encoding="utf-8"))
        document["jobs"]["bad-job"] = {
            "id": "bad-job",
            "url": "https://example.com/job",
            "normalizedUrl": "https://different.example.com/job",
            "status": "saved",
            "priority": 0,
            "revision": 1,
            "provenance": {},
            "createdAt": "2026-08-24T00:00:00Z",
            "updatedAt": "2026-08-24T00:00:00Z",
            "deletedAt": None,
        }
        self.store.jobs_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "normalized URL"):
            self.store.list_jobs()
