import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"
SPEC = importlib.util.spec_from_file_location("job_apply_store", SCRIPT)
STORE_MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(STORE_MODULE)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.root = self.home / ".job-apply"
        self.legacy = self.home / ".claude-job-profile.json"
        self.store = STORE_MODULE.Store(self.root, self.legacy)

    def tearDown(self):
        self.temporary.cleanup()

    def test_migrates_legacy_profile_once_and_preserves_unknown_fields(self):
        legacy = {
            "firstName": "Ada",
            "preferences": {"remotePreference": "remote only"},
            "futureCustomField": {"keep": True},
        }
        self.legacy.write_text(json.dumps(legacy), encoding="utf-8")

        first = self.store.initialize()
        self.assertTrue(first["migratedLegacyProfile"])
        self.assertEqual(self.store.get_profile(), legacy)

        self.legacy.write_text(json.dumps({"firstName": "Changed"}), encoding="utf-8")
        second = self.store.initialize()
        self.assertFalse(second["migratedLegacyProfile"])
        self.assertEqual(self.store.get_profile(), legacy)

    def test_preferences_merge_preserves_profile_and_existing_preferences(self):
        self.store.initialize()
        self.store.replace_profile(
            {
                "firstName": "Ada",
                "preferences": {"targetTitles": ["Engineer"], "salary": "200K"},
            }
        )
        updated = self.store.set_preferences({"salary": "250K"})
        self.assertEqual(
            updated, {"targetTitles": ["Engineer"], "salary": "250K"}
        )
        self.assertEqual(self.store.get_profile()["firstName"], "Ada")

    def test_profile_patch_edits_nested_facts_with_revision_and_provenance(self):
        self.store.initialize()
        self.store.replace_profile(
            {
                "firstName": "Ada",
                "location": {"city": "London", "country": "UK"},
                "skills": ["Python"],
                "portfolioUrl": "https://example.com",
            }
        )
        before = self.store.inspect_profile()
        updated = self.store.patch_profile(
            {
                "location": {"city": "Phoenix"},
                "skills": ["Python", "Rust"],
                "portfolioUrl": None,
            },
            expected_revision=before["revision"],
            source="user",
        )
        self.assertEqual(updated["profile"]["location"], {"city": "Phoenix", "country": "UK"})
        self.assertEqual(updated["profile"]["skills"], ["Python", "Rust"])
        self.assertNotIn("portfolioUrl", updated["profile"])
        self.assertEqual(updated["revision"], before["revision"] + 1)
        self.assertEqual(
            set(updated["factProvenance"]),
            {"/location/city", "/skills", "/portfolioUrl"},
        )
        self.assertTrue(
            all(
                item["source"] == "user"
                for item in updated["factProvenance"].values()
            )
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.patch_profile(
                {"firstName": "Grace"},
                expected_revision=before["revision"],
                source="user",
            )

    def test_profile_patch_replaces_parent_provenance_with_specific_changes(self):
        self.store.initialize()
        first = self.store.patch_profile(
            {"location": {"city": "Phoenix", "country": "US"}},
            expected_revision=1,
            source="resume",
        )
        second = self.store.patch_profile(
            {"location": {"city": "Tempe"}},
            expected_revision=first["revision"],
            source="user",
        )
        self.assertEqual(second["factProvenance"]["/location/city"]["source"], "user")
        self.assertEqual(
            second["factProvenance"]["/location/country"]["source"], "resume"
        )

    def test_existing_v1_profile_without_revision_upgrades_on_first_patch(self):
        self.root.mkdir(parents=True)
        self.store.profile_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "profile": {"firstName": "Ada"},
                    "metadata": {
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                    },
                }
            ),
            encoding="utf-8",
        )
        self.store.initialize()
        inspected = self.store.inspect_profile()
        self.assertEqual(inspected["revision"], 1)
        updated = self.store.patch_profile(
            {"firstName": "Grace"}, expected_revision=1, source="user"
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["profile"]["firstName"], "Grace")

    def test_atomic_write_failure_keeps_previous_document_and_cleans_temp(self):
        self.store.initialize()
        before = self.store.profile_path.read_text(encoding="utf-8")
        with mock.patch.object(STORE_MODULE.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                self.store.replace_profile({"firstName": "Grace"})
        self.assertEqual(self.store.profile_path.read_text(encoding="utf-8"), before)
        self.assertEqual(list(self.root.glob(".profile.json.*.tmp")), [])

    @unittest.skipIf(os.name == "nt", "POSIX permissions only")
    def test_private_permissions(self):
        self.store.initialize()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.store.sessions_path.stat().st_mode), 0o700)
        for path in (
            self.store.profile_path,
            self.store.answers_path,
            self.store.jobs_path,
            self.store.resumes_path,
            self.store.history_path,
        ):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_corrupt_and_future_documents_fail_closed(self):
        self.root.mkdir(parents=True)
        self.store.profile_path.write_text("not json", encoding="utf-8")
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.initialize()
        self.assertEqual(self.store.profile_path.read_text(encoding="utf-8"), "not json")

        self.store.profile_path.write_text(
            json.dumps(
                {"schemaVersion": 99, "profile": {}, "metadata": {}}
            ),
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.initialize()
        self.assertEqual(json.loads(self.store.profile_path.read_text())["schemaVersion"], 99)

    def test_answer_key_normalization_alias_lookup_and_confirmed_reuse(self):
        first = STORE_MODULE.answer_key(
            "Are you AUTHORIZED to work in the U.S.?", {"country": "US"}
        )
        second = STORE_MODULE.answer_key(
            "  are you authorized—to work in the u.s.  ", {"country": "US"}
        )
        self.assertEqual(first, second)
        answer = self.store.put_answer(
            {
                "question": "Are you authorized to work in the U.S.?",
                "aliases": ["US work authorization"],
                "value": "Yes",
                "state": "confirmed",
                "source": "user",
                "scope": {"country": "US"},
                "sensitivity": "none",
            }
        )
        self.assertEqual(answer["state"], "confirmed")
        found = self.store.find_answer(
            "US work authorization", {"country": "US"}
        )
        self.assertEqual(found["value"], "Yes")
        self.assertIsNotNone(found["confirmedAt"])

    def test_all_answer_states_and_sensitive_consent(self):
        self.store.put_answer(
            {"question": "Preferred start date?", "state": "inferred", "value": "June"}
        )
        self.store.put_answer(
            {"question": "Security clearance?", "state": "missing", "value": None}
        )
        placeholder = self.store.put_answer(
            {"question": "Disability disclosure?", "state": "sensitive", "value": None}
        )
        self.assertIsNone(placeholder["value"])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.put_answer(
                {
                    "question": "Disability disclosure?",
                    "state": "sensitive",
                    "value": "Prefer not to answer",
                }
            )
        remembered = self.store.put_answer(
            {
                "question": "Disability disclosure?",
                "state": "sensitive",
                "value": "Prefer not to answer",
            },
            remember_sensitive=True,
        )
        self.assertIn("rememberedWithConsentAt", remembered)

    def test_tampered_sensitive_answer_without_consent_fails_closed(self):
        self.store.initialize()
        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        document["answers"]["sensitive.example"] = {
            "key": "sensitive.example",
            "question": "Sensitive question?",
            "aliases": [],
            "value": "private",
            "state": "sensitive",
            "source": "user",
            "scope": {},
            "sensitivity": "high",
            "confirmedAt": None,
            "updatedAt": "2026-07-18T00:00:00Z",
        }
        self.store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.get_answer("sensitive.example")

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

    def test_job_transitions_require_supported_flow_and_user_submission(self):
        self.store.replace_profile({"firstName": "Ada"})
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"resume")
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
        job = self.store.transition_job(
            job["id"], "in_progress", expected_revision=job["revision"]
        )
        job = self.store.transition_job(
            job["id"], "awaiting_review", expected_revision=job["revision"]
        )
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

    def test_resume_registry_tracks_files_defaults_and_revisions(self):
        first_path = self.home / "resume-a.pdf"
        first_path.write_bytes(b"resume-a")
        first = self.store.create_resume(
            {
                "id": "resume-a",
                "label": "Engineering",
                "path": str(first_path),
                "tags": ["engineering"],
            }
        )
        self.assertTrue(first["default"])
        self.assertEqual(first["observedSize"], len(b"resume-a"))
        self.assertFalse(self.store.check_resume(first["id"])["changed"])

        missing_path = self.home / "resume-b.pdf"
        second = self.store.create_resume(
            {
                "id": "resume-b",
                "label": "Leadership",
                "path": str(missing_path),
            }
        )
        self.assertFalse(second["default"])
        self.assertFalse(self.store.check_resume(second["id"])["exists"])
        second = self.store.set_default_resume(
            second["id"], expected_revision=second["revision"]
        )
        self.assertTrue(second["default"])
        refreshed_first = self.store.get_resume(first["id"])
        self.assertFalse(refreshed_first["default"])
        self.assertEqual(refreshed_first["revision"], first["revision"] + 1)

        first_path.write_bytes(b"changed-resume-a")
        self.assertTrue(self.store.check_resume(first["id"])["changed"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_resume(
                first["id"], {"label": "Old"}, expected_revision=first["revision"]
            )
        updated = self.store.update_resume(
            first["id"],
            {"label": "Updated Engineering", "tags": ["staff"]},
            expected_revision=refreshed_first["revision"],
        )
        self.assertEqual(updated["label"], "Updated Engineering")
        self.assertEqual(self.store.list_resumes()[0]["id"], second["id"])

    def test_resume_assignment_prevents_trash_until_job_is_reassigned(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"resume")
        resume = self.store.create_resume(
            {"id": "resume-main", "label": "Main", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {
                "id": "assigned-job",
                "url": "https://example.com/jobs/assigned",
                "resumeId": resume["id"],
            }
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "assigned"):
            self.store.trash_resume(
                resume["id"], expected_revision=resume["revision"]
            )
        job = self.store.update_job(
            job["id"], {"resumeId": None}, expected_revision=job["revision"]
        )
        self.assertIsNone(job["resumeId"])
        trashed = self.store.trash_resume(
            resume["id"], expected_revision=resume["revision"]
        )
        self.assertIsNotNone(trashed["deletedAt"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "does not exist"):
            self.store.update_job(
                job["id"],
                {"resumeId": resume["id"]},
                expected_revision=job["revision"],
            )
        restored = self.store.restore_resume(
            resume["id"], expected_revision=trashed["revision"]
        )
        trashed_again = self.store.trash_resume(
            resume["id"], expected_revision=restored["revision"]
        )
        self.assertEqual(
            self.store.delete_resume(
                resume["id"], expected_revision=trashed_again["revision"]
            ),
            {"deleted": True, "id": resume["id"]},
        )

    def test_tampered_resume_store_with_multiple_defaults_fails_closed(self):
        first_path = self.home / "first.pdf"
        second_path = self.home / "second.pdf"
        first_path.write_bytes(b"first")
        second_path.write_bytes(b"second")
        first = self.store.create_resume(
            {"id": "first", "label": "First", "path": str(first_path)}
        )
        second = self.store.create_resume(
            {"id": "second", "label": "Second", "path": str(second_path)}
        )
        document = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        document["resumes"][first["id"]]["default"] = True
        document["resumes"][second["id"]]["default"] = True
        self.store.resumes_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "more than one"):
            self.store.list_resumes()

    def test_resume_permanent_delete_rejects_trashed_job_reference(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"resume")
        resume = self.store.create_resume(
            {"id": "resume-main", "label": "Main", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {
                "id": "job-main",
                "url": "https://example.com/jobs/main",
                "resumeId": resume["id"],
            }
        )
        job = self.store.trash_job(job["id"], expected_revision=job["revision"])
        resume = self.store.trash_resume(
            resume["id"], expected_revision=resume["revision"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "referenced"):
            self.store.delete_resume(
                resume["id"], expected_revision=resume["revision"]
            )
        self.store.delete_job(job["id"], expected_revision=job["revision"])
        self.assertEqual(
            self.store.delete_resume(
                resume["id"], expected_revision=resume["revision"]
            ),
            {"deleted": True, "id": resume["id"]},
        )

    def test_history_is_minimal_parseable_and_rejects_answer_values(self):
        event = self.store.append_history(
            {
                "applicationId": "acme-role-1",
                "event": "started",
                "company": "Acme",
                "role": "Engineer",
                "answerKeys": ["work_authorization.us"],
            }
        )
        self.assertEqual(event["answerKeys"], ["work_authorization.us"])
        parsed = self.store.read_history()
        self.assertEqual(len(parsed), 1)
        self.assertNotIn("value", parsed[0])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.append_history(
                {
                    "applicationId": "acme-role-1",
                    "event": "progressed",
                    "answerValue": "secret",
                }
            )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.append_history(
                {
                    "applicationId": "acme-role-1",
                    "event": "progressed",
                    "company": {"answerValue": "private"},
                }
            )

    def test_tampered_history_fails_closed(self):
        self.store.initialize()
        self.store.history_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "eventId": "event-1",
                    "applicationId": "acme-role-1",
                    "event": "started",
                    "answerKeys": [],
                    "company": {"value": "private"},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.read_history()

    def test_replay_transitions_are_ordered_idempotent_and_value_free(self):
        application_id = "qa-run-20260815-1234abcd"
        started = self.store.record_replay_transition(
            application_id, "started", "greenhouse"
        )
        repeated = self.store.record_replay_transition(
            application_id, "started", "greenhouse"
        )
        reviewed = self.store.record_replay_transition(
            application_id, "reviewed", "greenhouse"
        )
        reviewed_again = self.store.record_replay_transition(
            application_id, "reviewed", "greenhouse"
        )

        self.assertTrue(started["changed"])
        self.assertFalse(repeated["changed"])
        self.assertTrue(reviewed["changed"])
        self.assertFalse(reviewed_again["changed"])
        history = self.store.read_history()
        self.assertEqual([event["event"] for event in history], ["started", "reviewed"])
        self.assertTrue(all(event["answerKeys"] == [] for event in history))
        session = self.store.load_session(application_id)
        self.assertEqual(session["status"], "review")
        self.assertEqual(session["step"], "review")
        serialized = json.dumps({"history": history, "session": session})
        for forbidden in ("http://", "https://", "routeToken", "resumePath", "value"):
            self.assertNotIn(forbidden, serialized)

    def test_ashby_replay_transitions_are_supported_and_value_free(self):
        application_id = "qa-run-20260815-5678abcd"
        self.store.record_replay_transition(application_id, "started", "ashby")
        self.store.record_replay_transition(application_id, "reviewed", "ashby")
        history = self.store.read_history()
        session = self.store.load_session(application_id)
        self.assertEqual([event["ats"] for event in history], ["ashby", "ashby"])
        self.assertEqual((session["ats"], session["status"]), ("ashby", "review"))
        self.assertNotIn("value", json.dumps({"history": history, "session": session}))

    def test_lever_replay_transitions_are_supported_and_value_free(self):
        application_id = "qa-run-20260816-5678abcd"
        self.store.record_replay_transition(application_id, "started", "lever")
        self.store.record_replay_transition(application_id, "reviewed", "lever")
        history = self.store.read_history()
        session = self.store.load_session(application_id)
        self.assertEqual([event["ats"] for event in history], ["lever", "lever"])
        self.assertEqual((session["ats"], session["status"]), ("lever", "review"))
        serialized = json.dumps({"history": history, "session": session})
        self.assertNotIn("value", serialized)
        self.assertNotIn("http", serialized)

    def test_replay_review_requires_started_and_rejects_terminal_or_mismatched_ats(self):
        application_id = "qa-run-20260815-1234abcd"
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "has not started"):
            self.store.record_replay_transition(
                application_id, "reviewed", "linkedin-easy-apply"
            )

        self.store.record_replay_transition(
            application_id, "started", "linkedin-easy-apply"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "ATS does not match"):
            self.store.record_replay_transition(
                application_id, "reviewed", "greenhouse"
            )
        self.store.append_history(
            {
                "applicationId": application_id,
                "event": "abandoned",
                "ats": "linkedin-easy-apply",
                "answerKeys": [],
            }
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "terminal"):
            self.store.record_replay_transition(
                application_id, "reviewed", "linkedin-easy-apply"
            )

    def test_session_round_trip_rejects_values_and_path_traversal(self):
        session = self.store.save_session(
            "acme-role-1",
            {
                "status": "active",
                "ats": "greenhouse",
                "step": "questions",
                "answerKeys": ["work_authorization.us"],
                "pendingFields": [
                    {
                        "question": "Salary expectation?",
                        "state": "sensitive",
                        "answerKey": "salary.expectation",
                        "sensitive": True,
                    }
                ],
            },
        )
        loaded = self.store.load_session("acme-role-1")
        self.assertEqual(loaded["updatedAt"], session["updatedAt"])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.save_session(
                "acme-role-2",
                {
                    "pendingFields": [
                        {"question": "Salary?", "state": "sensitive", "value": "250K"}
                    ]
                },
            )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.load_session("../profile")

    def test_tampered_session_fails_closed(self):
        self.store.initialize()
        path = self.store.sessions_path / "acme-role-1.json"
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "applicationId": "acme-role-1",
                    "status": "active",
                    "answerKeys": [],
                    "pendingFields": [],
                    "company": {"value": "private"},
                    "createdAt": "2026-07-18T00:00:00Z",
                    "updatedAt": "2026-07-18T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.load_session("acme-role-1")

    def test_cli_uses_machine_readable_json_and_store_override(self):
        environment = dict(os.environ)
        environment["HOME"] = str(self.home)
        environment[STORE_MODULE.STORE_ENV] = str(self.root)
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "init"],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        result = json.loads(completed.stdout)
        self.assertTrue(result["initialized"])
        self.assertEqual(result["root"], str(self.root))

    def test_job_cli_round_trip_uses_shared_json_contract(self):
        job_input = self.home / "job.json"
        job_input.write_text(
            json.dumps(
                {
                    "id": "cli-job",
                    "url": "https://example.com/jobs/cli",
                    "role": "Engineer",
                }
            ),
            encoding="utf-8",
        )
        created = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "job-create",
                "--input",
                str(job_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        record = json.loads(created.stdout)
        listed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "job-list",
                "--status",
                "saved",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(listed.stdout), [record])

    def test_profile_and_resume_cli_commands_use_shared_revisions(self):
        subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "init"],
            check=True,
            capture_output=True,
            text=True,
        )
        patch_input = self.home / "profile-patch.json"
        patch_input.write_text(
            json.dumps({"firstName": "Ada", "skills": ["Python"]}),
            encoding="utf-8",
        )
        patched = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "profile-patch",
                "--input",
                str(patch_input),
                "--expected-revision",
                "1",
                "--source",
                "user",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(patched.stdout)["revision"], 2)

        resume_file = self.home / "resume.pdf"
        resume_file.write_bytes(b"resume")
        resume_input = self.home / "resume.json"
        resume_input.write_text(
            json.dumps(
                {"id": "main-resume", "label": "Main", "path": str(resume_file)}
            ),
            encoding="utf-8",
        )
        created = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "resume-create",
                "--input",
                str(resume_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        listed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "resume-list",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(listed.stdout), [json.loads(created.stdout)])

    def test_paths_exposes_separate_inert_policy_root_without_changing_v1_store(self):
        self.store.initialize()
        paths = self.store.paths()
        self.assertEqual(paths["schemaVersion"], 1)
        self.assertEqual(paths["jobs"], str(self.root / "jobs.json"))
        self.assertEqual(paths["resumes"], str(self.root / "resumes.json"))
        self.assertEqual(paths["autoSubmitPolicy"], str(self.root / "auto-submit"))
        self.assertFalse((self.root / "auto-submit").exists())
        self.assertEqual(self.store.get_profile(), {})

    def test_cli_filesystem_failure_is_terse(self):
        blocker = self.home / "not-a-directory"
        blocker.write_text("Ada private data", encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(blocker), "init"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertNotIn("Traceback", completed.stderr)
        self.assertNotIn("Ada private data", completed.stderr)
        self.assertIn("storage operation failed", completed.stderr)


if __name__ == "__main__":
    unittest.main()
