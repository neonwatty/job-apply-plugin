import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
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
        self.store.claim_status()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.store.sessions_path.stat().st_mode), 0o700)
        for path in (
            self.store.profile_path,
            self.store.answers_path,
            self.store.jobs_path,
            self.store.resumes_path,
            self.store.history_path,
            self.store.coordinator_path,
            self.store.coordinator_journal_path,
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

    def test_answer_list_update_revisions_and_recoverable_delete(self):
        answer = self.store.put_answer(
            {
                "question": "Preferred start date?",
                "state": "confirmed",
                "value": "June",
                "aliases": ["Start date"],
            }
        )
        self.assertEqual(answer["revision"], 1)
        self.assertEqual(self.store.list_answers(), [answer])
        updated = self.store.update_answer(
            answer["key"],
            {"value": "July", "aliases": ["Start date", "START DATE"]},
            expected_revision=answer["revision"],
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["value"], "July")
        self.assertEqual(updated["aliases"], ["start date"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_answer(
                answer["key"], {"value": "August"}, expected_revision=1
            )

        trashed = self.store.trash_answer(
            answer["key"], expected_revision=updated["revision"]
        )
        self.assertIsNone(self.store.get_answer(answer["key"]))
        self.assertEqual(
            self.store.get_answer(answer["key"], include_trashed=True), trashed
        )
        self.assertIsNone(self.store.find_answer("Preferred start date?", {}))
        restored = self.store.restore_answer(
            answer["key"], expected_revision=trashed["revision"]
        )
        trashed_again = self.store.trash_answer(
            answer["key"], expected_revision=restored["revision"]
        )
        self.assertEqual(
            self.store.delete_answer(
                answer["key"], expected_revision=trashed_again["revision"]
            ),
            {"deleted": True, "key": answer["key"]},
        )

    def test_answer_sensitive_update_requires_new_remember_consent(self):
        answer = self.store.put_answer(
            {
                "question": "Salary expectation?",
                "state": "sensitive",
                "value": "200K",
                "sensitivity": "high",
            },
            remember_sensitive=True,
        )
        unchanged = self.store.update_answer(
            answer["key"],
            {"aliases": ["Expected salary"]},
            expected_revision=answer["revision"],
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "remember consent"):
            self.store.update_answer(
                answer["key"],
                {"value": "250K"},
                expected_revision=unchanged["revision"],
            )
        changed = self.store.update_answer(
            answer["key"],
            {"value": "250K"},
            expected_revision=unchanged["revision"],
            remember_sensitive=True,
        )
        self.assertEqual(changed["value"], "250K")
        self.assertIn("rememberedWithConsentAt", changed)

    def test_answer_permanent_delete_rejects_live_session_reference(self):
        answer = self.store.put_answer(
            {"question": "Portfolio?", "state": "confirmed", "value": "Yes"}
        )
        self.store.save_session(
            "active-job",
            {"status": "active", "answerKeys": [answer["key"]]},
        )
        trashed = self.store.trash_answer(
            answer["key"], expected_revision=answer["revision"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "active session"):
            self.store.delete_answer(
                answer["key"], expected_revision=trashed["revision"]
            )
        self.store.delete_session("active-job")
        self.assertTrue(
            self.store.delete_answer(
                answer["key"], expected_revision=trashed["revision"]
            )["deleted"]
        )

    def test_profile_noop_and_answer_delete_do_not_reenter_coordinator_lock(self):
        self.store.replace_profile({"firstName": "Ada"})
        self.store.claim_status()
        before = self.store.inspect_profile()
        unchanged = self.store.patch_profile(
            {"firstName": "Ada"}, before["revision"], "user"
        )
        self.assertEqual(unchanged, before)

        answer = self.store.put_answer(
            {"question": "Portfolio?", "state": "confirmed", "value": "Yes"}
        )
        trashed = self.store.trash_answer(answer["key"], answer["revision"])
        self.assertTrue(
            self.store.delete_answer(answer["key"], trashed["revision"])["deleted"]
        )

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

    def test_job_upsert_token_rejects_source_case_plan_drift(self):
        job = self.store.create_job(
            {
                "id": "source-case-drift",
                "url": "https://example.com/jobs/source-case-drift",
                "source": "LinkedIn",
            }
        )
        preview_input = {
            "jobs": [{"url": job["url"], "source": "LinkedIn"}]
        }
        preview = self.store.preview_job_upsert(preview_input, "human")
        self.assertEqual(preview["decisions"][0]["action"], "noop")

        altered_input = {
            "jobs": [{"url": job["url"], "source": "linkedin"}]
        }
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
            self.store.commit_job_upsert(altered_input, "human", preview["token"])
        self.assertEqual(self.store.get_job(job["id"]), job)

    def test_agent_ignores_protected_invalid_resume_before_validation(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"resume")
        resume = self.store.create_resume(
            {"id": "protected-resume", "label": "Protected", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {
                "id": "protected-resume-job",
                "url": "https://example.com/jobs/protected-resume",
                "resumeId": resume["id"],
            }
        )

        updated = self.store.update_job(
            job["id"],
            {"resumeId": "missing-resume", "company": "Acme"},
            expected_revision=job["revision"],
            origin="agent",
        )
        self.assertEqual(updated["resumeId"], resume["id"])
        self.assertEqual(updated["company"], "Acme")

    def test_job_upsert_preview_commit_cli_walkthrough(self):
        subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "init"],
            check=True,
            capture_output=True,
            text=True,
        )
        input_path = self.home / "upsert.json"
        input_path.write_text(
            json.dumps(
                {
                    "jobs": [
                        {
                            "url": "HTTPS://Jobs.Example.com:443/openings/42#apply",
                            "source": "LinkedIn",
                            "sourceId": "42",
                            "role": "Staff Engineer",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        def command(name, *extra):
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(self.root),
                    name,
                    "--input",
                    str(input_path),
                    "--origin",
                    "human",
                    *extra,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(completed.stdout)

        preview = command("job-upsert-preview")
        self.assertEqual(preview["summary"]["create"], 1)
        job_id = preview["decisions"][0]["id"]
        committed = command("job-upsert-commit", "--token", preview["token"])
        self.assertTrue(committed["committed"])
        self.assertEqual(committed["decisions"][0]["id"], job_id)

        replay_preview = command("job-upsert-preview")
        self.assertEqual(replay_preview["summary"]["noop"], 1)
        before = self.store.jobs_path.read_bytes()
        replay = command(
            "job-upsert-commit", "--token", replay_preview["token"]
        )
        self.assertFalse(replay["committed"])
        self.assertEqual(self.store.jobs_path.read_bytes(), before)
        self.assertEqual(self.store.get_job(job_id)["status"], "saved")

    def test_job_upsert_identity_conflicts_are_deterministic(self):
        first = self.store.create_job(
            {
                "id": "first",
                "url": "https://example.com/jobs/first",
                "source": "LinkedIn",
                "sourceId": "first-id",
            }
        )
        second = self.store.create_job(
            {
                "id": "second",
                "url": "https://example.com/jobs/second",
                "source": "LinkedIn",
                "sourceId": "second-id",
            }
        )
        cross_identity = {
            "jobs": [
                {
                    "url": first["url"],
                    "source": "linkedin",
                    "sourceId": second["sourceId"],
                }
            ]
        }
        preview = self.store.preview_job_upsert(cross_identity, "agent")
        self.assertEqual(preview["decisions"][0]["action"], "conflict")

        duplicates = {
            "jobs": [
                {"url": "https://example.com/jobs/new", "role": "One"},
                {"url": "https://example.com/jobs/new", "role": "Two"},
            ]
        }
        one = self.store.preview_job_upsert(duplicates, "agent")
        two = self.store.preview_job_upsert(duplicates, "agent")
        self.assertEqual(one["decisions"], two["decisions"])
        self.assertEqual(
            [item["action"] for item in one["decisions"]],
            ["conflict", "conflict"],
        )

        identical = {
            "jobs": [
                {"url": "https://example.com/jobs/same", "role": "Same"},
                {"url": "https://example.com/jobs/same", "role": "Same"},
            ]
        }
        collapsed = self.store.preview_job_upsert(identical, "human")
        self.assertEqual(
            [item["action"] for item in collapsed["decisions"]],
            ["create", "noop"],
        )
        self.assertEqual(
            collapsed["decisions"][0]["id"], collapsed["decisions"][1]["id"]
        )

    def test_job_upsert_preserves_human_edits_and_records_provenance(self):
        self.store.initialize()
        human = {
            "jobs": [
                {
                    "url": "https://example.com/jobs/provenance",
                    "source": "LinkedIn",
                    "sourceId": "provenance",
                    "role": "Human Role",
                }
            ]
        }
        preview = self.store.preview_job_upsert(human, "human")
        self.store.commit_job_upsert(human, "human", preview["token"])
        job_id = preview["decisions"][0]["id"]

        agent = {
            "jobs": [
                {
                    "url": human["jobs"][0]["url"],
                    "source": "linkedin",
                    "sourceId": "provenance",
                    "role": "Agent Role",
                    "company": "Acme",
                    "description": "Agent supplied",
                }
            ]
        }
        agent_preview = self.store.preview_job_upsert(agent, "agent")
        self.assertEqual(agent_preview["decisions"][0]["fields"], ["company", "description"])
        self.store.commit_job_upsert(agent, "agent", agent_preview["token"])
        record = self.store.get_job(job_id)
        self.assertEqual(record["role"], "Human Role")
        self.assertEqual(record["company"], "Acme")
        self.assertEqual(record["description"], "Agent supplied")
        self.assertEqual(record["provenance"]["/role"]["origin"], "human")
        self.assertEqual(record["provenance"]["/company"]["origin"], "agent")
        self.assertEqual(
            record["provenance"]["/company"]["observationSource"], "linkedin"
        )

        edited = self.store.update_job(
            job_id, {"role": "Human Edited Role"}, record["revision"]
        )
        ignored = self.store.update_job(
            job_id,
            {"role": "Agent Retry", "company": "New Acme"},
            edited["revision"],
            origin="agent",
        )
        self.assertEqual(ignored["role"], "Human Edited Role")
        self.assertEqual(ignored["company"], "New Acme")
        self.assertEqual(ignored["provenance"]["/role"]["origin"], "human")
        self.assertEqual(ignored["provenance"]["/company"]["origin"], "agent")

    def test_job_upsert_preview_is_non_mutating_and_rejects_drift(self):
        self.store.initialize()
        before = {
            path.name: (path.stat().st_mtime_ns, path.read_bytes())
            for path in self.root.iterdir()
            if path.is_file()
        }
        payload = {"jobs": [{"url": "https://example.com/jobs/preview"}]}
        preview = self.store.preview_job_upsert(payload, "human")
        after = {
            path.name: (path.stat().st_mtime_ns, path.read_bytes())
            for path in self.root.iterdir()
            if path.is_file()
        }
        self.assertEqual(after, before)
        self.assertNotIn(".store.lock", after)

        self.store.create_job(
            {"id": "drift", "url": "https://example.com/jobs/drift"}
        )
        current = self.store.jobs_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
            self.store.commit_job_upsert(
                payload, "human", preview["token"]
            )
        self.assertEqual(self.store.jobs_path.read_bytes(), current)

    def test_job_upsert_partial_records_remain_saved(self):
        self.store.initialize()
        payload = {
            "jobs": [
                {"url": "https://example.com/jobs/url-only"},
                {"url": "https://example.com/jobs/invalid", "role": ["invalid"]},
            ]
        }
        preview = self.store.preview_job_upsert(payload, "agent")
        job_id = preview["decisions"][0]["id"]
        committed = self.store.commit_job_upsert(
            payload, "agent", preview["token"]
        )
        self.assertEqual(committed["summary"]["create"], 1)
        self.assertEqual(committed["summary"]["invalid"], 1)
        record = self.store.get_job(job_id)
        self.assertEqual(record["status"], "saved")
        self.assertNotIn("role", record)
        self.assertNotIn("company", record)
        self.assertEqual(record["provenance"]["/url"]["origin"], "agent")

    def _write_legacy_search_report(self, name="search-2026-08-24T12-00-00.md"):
        legacy_root = self.home / ".claude-job-searches"
        legacy_root.mkdir(exist_ok=True)
        path = legacy_root / name
        path.write_text(
            """# Job Search Results — 2026-08-24

## Results (ranked by score)

### 1. Staff Engineer — Acme Corp (Score: 92)
- **Source**: LinkedIn
- **Location**: Remote
- **Salary**: $250K
- **Description**: Build reliable systems.
- **Apply**: Easy Apply
- **URL**: https://example.com/jobs/staff#apply

### 2. Missing Link — Example Co (Score: 75)
- **Source**: Hacker News
- **Apply**: Ask the poster
""",
            encoding="utf-8",
        )
        return path

    def test_legacy_job_discovery_preview_is_deterministic_and_non_mutating(self):
        source = self._write_legacy_search_report()
        source_before = source.read_bytes()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            first = self.store.preview_legacy_jobs([])
            second = self.store.preview_legacy_jobs([])
        self.assertEqual(first, second)
        self.assertFalse(self.root.exists())
        self.assertNotIn("token", first)
        self.assertEqual([item["state"] for item in first["items"]], ["valid", "invalid"])
        self.assertEqual(first["items"][1]["reason"], "missing_url")
        self.assertEqual(source.read_bytes(), source_before)

    def test_legacy_job_selected_commit_absent_store_provenance_and_rerun(self):
        source = self._write_legacy_search_report()
        source_before = source.read_bytes()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            self.assertFalse(self.root.exists())
            self.assertEqual(preview["summary"]["create"], 1)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])
            replay_preview = self.store.preview_legacy_jobs(selected)
            before = self.store.jobs_path.read_bytes()
            replay = self.store.commit_legacy_jobs(selected, replay_preview["token"])
        self.assertTrue(committed["committed"])
        self.assertFalse(replay["committed"])
        self.assertEqual(self.store.jobs_path.read_bytes(), before)
        self.assertEqual(source.read_bytes(), source_before)
        job_id = committed["decisions"][0]["id"]
        record = self.store.get_job(job_id)
        self.assertEqual(record["role"], "Staff Engineer")
        self.assertEqual(record["company"], "Acme Corp")
        self.assertEqual(record["provenance"]["/role"]["origin"], "migration")
        self.assertEqual(record["legacySources"][0]["relativePath"], source.name)
        self.assertNotIn(str(self.home), json.dumps(record["legacySources"]))

    def test_legacy_job_commit_rejects_source_selection_and_store_drift(self):
        source = self._write_legacy_search_report()
        self.store.initialize()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            source.write_text(source.read_text() + "\n", encoding="utf-8")
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
                self.store.commit_legacy_jobs(selected, preview["token"])

            fresh_discovery = self.store.preview_legacy_jobs([])
            fresh_selected = [fresh_discovery["items"][0]["itemId"]]
            fresh = self.store.preview_legacy_jobs(fresh_selected)
            self.store.create_job({"id": "drift", "url": "https://example.com/drift"})
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
                self.store.commit_legacy_jobs(fresh_selected, fresh["token"])
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "unknown item"):
                self.store.preview_legacy_jobs(["legacy-item-000000000000000000000000"])

    def test_legacy_migration_never_overwrites_human_or_agent_fields(self):
        self._write_legacy_search_report()
        existing = self.store.create_job(
            {"url": "https://example.com/jobs/staff", "role": "Human Role"},
            origin="human",
        )
        agent = self.store.update_job(
            existing["id"], {"company": "Agent Company"}, existing["revision"], origin="agent"
        )
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])
        record = self.store.get_job(existing["id"])
        self.assertEqual(record["role"], "Human Role")
        self.assertEqual(record["company"], "Agent Company")
        self.assertEqual(committed["decisions"][0]["fields"], ["compensation", "description", "legacySources", "location", "source"])
        self.assertEqual(agent["revision"] + 1, record["revision"])

    def test_legacy_migration_fills_a_human_cleared_field(self):
        self._write_legacy_search_report()
        existing = self.store.create_job(
            {"url": "https://example.com/jobs/staff", "role": "Human Role"},
            origin="human",
        )
        cleared = self.store.update_job(
            existing["id"], {"role": ""}, existing["revision"], origin="human"
        )
        self.assertEqual(cleared["provenance"]["/role"]["origin"], "human")

        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])

        record = self.store.get_job(existing["id"])
        self.assertEqual(record["role"], "Staff Engineer")
        self.assertEqual(record["provenance"]["/role"]["origin"], "migration")
        self.assertIn("role", committed["decisions"][0]["fields"])

    def test_legacy_migration_refreshes_migration_authored_source(self):
        source = self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            created = self.store.commit_legacy_jobs(selected, preview["token"])

            original_digest = self.store.get_job(created["decisions"][0]["id"])[
                "legacySources"
            ][0]["sourceSha256"]
            source.write_text(
                source.read_text(encoding="utf-8").replace(
                    "**Source**: LinkedIn", "**Source**: Company site"
                ),
                encoding="utf-8",
            )
            refreshed_discovery = self.store.preview_legacy_jobs([])
            refreshed_selected = [refreshed_discovery["items"][0]["itemId"]]
            refreshed_preview = self.store.preview_legacy_jobs(refreshed_selected)
            refreshed = self.store.commit_legacy_jobs(
                refreshed_selected, refreshed_preview["token"]
            )

        record = self.store.get_job(created["decisions"][0]["id"])
        self.assertEqual(refreshed["decisions"][0]["action"], "update")
        self.assertEqual(record["source"], "Company site")
        self.assertEqual(record["provenance"]["/source"]["origin"], "migration")
        self.assertNotEqual(record["legacySources"][0]["sourceSha256"], original_digest)

    def test_legacy_migration_uses_stable_locator_to_refresh_url(self):
        source = self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            created = self.store.commit_legacy_jobs(selected, preview["token"])
            job_id = created["decisions"][0]["id"]

            source.write_text(
                source.read_text(encoding="utf-8").replace(
                    "https://example.com/jobs/staff",
                    "https://example.com/jobs/staff-corrected",
                ),
                encoding="utf-8",
            )
            refreshed_discovery = self.store.preview_legacy_jobs([])
            refreshed_selected = [refreshed_discovery["items"][0]["itemId"]]
            refreshed_preview = self.store.preview_legacy_jobs(refreshed_selected)
            refreshed = self.store.commit_legacy_jobs(
                refreshed_selected, refreshed_preview["token"]
            )

        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(
            jobs[0]["url"], "https://example.com/jobs/staff-corrected#apply"
        )
        self.assertEqual(
            jobs[0]["normalizedUrl"], "https://example.com/jobs/staff-corrected"
        )
        self.assertEqual(jobs[0]["provenance"]["/url"]["origin"], "migration")
        self.assertEqual(refreshed["decisions"][0]["action"], "update")
        self.assertIn("url", refreshed["decisions"][0]["fields"])

    def test_legacy_entry_locator_survives_report_reordering(self):
        source = self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            original_item = discovery["items"][0]
            selected = [original_item["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            created = self.store.commit_legacy_jobs(selected, preview["token"])
            job_id = created["decisions"][0]["id"]

            original = source.read_text(encoding="utf-8")
            reordered = original.replace(
                "### 1. Staff Engineer — Acme Corp (Score: 92)",
                "### 2. Staff Engineer — Acme Corp (Score: 92)",
            ).replace(
                "### 2. Missing Link — Example Co (Score: 75)",
                "### 3. Missing Link — Example Co (Score: 75)",
            )
            inserted = (
                "### 1. New Role — New Co (Score: 99)\n"
                "- **URL**: https://example.com/jobs/new\n\n"
            )
            source.write_text(
                reordered.replace("## Results (ranked by score)\n", "## Results (ranked by score)\n\n" + inserted),
                encoding="utf-8",
            )

            moved_discovery = self.store.preview_legacy_jobs([])
            moved_item = next(
                item
                for item in moved_discovery["items"]
                if item.get("job", {}).get("url")
                == "https://example.com/jobs/staff#apply"
            )
            self.assertEqual(moved_item["itemId"], original_item["itemId"])
            moved_preview = self.store.preview_legacy_jobs([moved_item["itemId"]])
            moved = self.store.commit_legacy_jobs(
                [moved_item["itemId"]], moved_preview["token"]
            )

        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(jobs[0]["role"], "Staff Engineer")
        self.assertEqual(moved["decisions"][0]["id"], job_id)

    def test_duplicate_legacy_headings_keep_content_bound_locators(self):
        reports = self.home / ".claude-job-searches"
        reports.mkdir(parents=True)
        source = reports / "search-duplicate-headings.md"

        def report(first_url, second_url):
            return (
                "## Results (ranked by score)\n\n"
                "### 1. Engineer — Acme (Score: 90)\n"
                f"- **URL**: {first_url}\n\n"
                "### 2. Engineer — Acme (Score: 90)\n"
                f"- **URL**: {second_url}\n"
            )

        first_url = "https://example.com/jobs/duplicate-a"
        second_url = "https://example.com/jobs/duplicate-b"
        source.write_text(report(first_url, second_url), encoding="utf-8")
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            first_item = next(
                item for item in discovery["items"] if item["job"]["url"] == first_url
            )
            preview = self.store.preview_legacy_jobs([first_item["itemId"]])
            created = self.store.commit_legacy_jobs(
                [first_item["itemId"]], preview["token"]
            )
            job_id = created["decisions"][0]["id"]

            source.write_text(report(second_url, first_url), encoding="utf-8")
            reordered = self.store.preview_legacy_jobs([])
            moved_first = next(
                item for item in reordered["items"] if item["job"]["url"] == first_url
            )
            self.assertEqual(moved_first["itemId"], first_item["itemId"])
            moved_preview = self.store.preview_legacy_jobs([moved_first["itemId"]])
            moved = self.store.commit_legacy_jobs(
                [moved_first["itemId"]], moved_preview["token"]
            )

        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(jobs[0]["url"], first_url)
        self.assertEqual(moved["decisions"][0]["id"], job_id)

    def test_legacy_discovery_uses_path_fallback_on_windows(self):
        self._write_legacy_search_report()
        with (
            mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home),
            mock.patch.object(STORE_MODULE.os, "name", "nt"),
        ):
            discovery = self.store.preview_legacy_jobs([])
        self.assertEqual(discovery["items"][0]["state"], "valid")
        self.assertFalse(self.root.exists())

    def test_legacy_migration_skips_protected_source_and_fills_empty_fields(self):
        self._write_legacy_search_report()
        existing = self.store.create_job(
            {
                "url": "https://example.com/jobs/staff#apply",
                "source": "Company site",
            },
            origin="human",
        )

        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])

        record = self.store.get_job(existing["id"])
        self.assertEqual(record["source"], "Company site")
        self.assertEqual(record["provenance"]["/source"]["origin"], "human")
        self.assertEqual(record["role"], "Staff Engineer")
        self.assertEqual(record["company"], "Acme Corp")
        self.assertNotIn("source", committed["decisions"][0]["fields"])

    def test_migration_origin_is_private_to_guided_legacy_methods(self):
        self.store.initialize()
        existing = self.store.create_job(
            {"id": "authority-boundary", "url": "https://example.com/authority"}
        )
        payload = {"jobs": [{"url": "https://example.com/forged"}]}

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.create_job(payload["jobs"][0], origin="migration")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.update_job(
                existing["id"],
                {"role": "Forged"},
                existing["revision"],
                origin="migration",
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.preview_job_upsert(payload, "migration")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.commit_job_upsert(payload, "migration", "forged-token")
        self.assertIsNone(
            next(
                (
                    record
                    for record in self.store.list_jobs()
                    if record["normalizedUrl"] == "https://example.com/forged"
                ),
                None,
            )
        )

    def test_generic_job_cli_rejects_migration_origin(self):
        self.store.initialize()
        input_path = self.home / "forged-migration.json"
        input_path.write_text(
            json.dumps({"jobs": [{"url": "https://example.com/forged-cli"}]}),
            encoding="utf-8",
        )
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        commands = (
            ["job-create", "--input", str(input_path), "--origin", "migration"],
            ["job-upsert-preview", "--input", str(input_path), "--origin", "migration"],
            [
                "job-upsert-commit",
                "--input",
                str(input_path),
                "--origin",
                "migration",
                "--token",
                "forged-token",
            ],
            [
                "job-update",
                "--id",
                "missing",
                "--input",
                str(input_path),
                "--expected-revision",
                "1",
                "--origin",
                "migration",
            ],
        )
        for arguments in commands:
            completed = subprocess.run(
                [*base, *arguments], capture_output=True, text=True
            )
            self.assertEqual(completed.returncode, 2)
            self.assertIn("invalid choice", completed.stderr)
            self.assertNotIn("migration-authored", completed.stdout)

    def test_generic_methods_reject_forged_migration_provenance(self):
        forged = {
            "/forged": {
                "origin": "migration",
                "observationSource": "legacy",
                "updatedAt": "2026-08-24T00:00:00Z",
            }
        }
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.create_job(
                {
                    "url": "https://example.com/forged-create",
                    "provenance": forged,
                }
            )

        ordinary = self.store.create_job(
            {"id": "ordinary-provenance", "url": "https://example.com/ordinary"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.update_job(
                ordinary["id"],
                {"provenance": forged},
                ordinary["revision"],
            )

    def test_human_edits_preserve_but_cannot_alter_guided_migration_provenance(self):
        self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])
        job_id = committed["decisions"][0]["id"]
        guided = self.store.get_job(job_id)
        original_company = guided["provenance"]["/company"]

        altered = json.loads(json.dumps(guided["provenance"]))
        altered["/company"]["updatedAt"] = "2000-01-01T00:00:00Z"
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.update_job(
                job_id,
                {"provenance": altered},
                guided["revision"],
            )

        removed = json.loads(json.dumps(guided["provenance"]))
        del removed["/company"]
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.update_job(
                job_id,
                {"provenance": removed},
                guided["revision"],
            )

        corrected = self.store.update_job(
            job_id,
            {"role": "Human Corrected Role", "provenance": guided["provenance"]},
            guided["revision"],
        )
        self.assertEqual(corrected["role"], "Human Corrected Role")
        self.assertEqual(corrected["provenance"]["/role"]["origin"], "human")
        self.assertEqual(corrected["provenance"]["/company"], original_company)

    def test_generic_cli_rejects_forged_migration_provenance(self):
        self.store.initialize()
        ordinary = self.store.create_job(
            {"id": "cli-provenance", "url": "https://example.com/cli-provenance"}
        )
        forged = {
            "/forged": {
                "origin": "migration",
                "observationSource": "legacy",
                "updatedAt": "2026-08-24T00:00:00Z",
            }
        }
        create_input = self.home / "forged-create.json"
        create_input.write_text(
            json.dumps(
                {
                    "url": "https://example.com/forged-cli-provenance",
                    "provenance": forged,
                }
            ),
            encoding="utf-8",
        )
        update_input = self.home / "forged-update.json"
        update_input.write_text(json.dumps({"provenance": forged}), encoding="utf-8")
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        commands = (
            ["job-create", "--input", str(create_input)],
            [
                "job-update",
                "--id",
                ordinary["id"],
                "--input",
                str(update_input),
                "--expected-revision",
                str(ordinary["revision"]),
            ],
        )
        for arguments in commands:
            completed = subprocess.run(
                [*base, *arguments], capture_output=True, text=True
            )
            self.assertEqual(completed.returncode, 2)
            self.assertIn("reserved for guided legacy imports", completed.stderr)
            self.assertEqual(completed.stdout, "")

    @unittest.skipIf(os.name == "nt", "symlink behavior is platform-specific")
    def test_legacy_discovery_rejects_symlinks_and_limits(self):
        legacy_root = self.home / ".claude-job-searches"
        legacy_root.mkdir()
        target = self.home / "outside.md"
        target.write_text("outside", encoding="utf-8")
        (legacy_root / "search-link.md").symlink_to(target)
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "regular files"):
                self.store.preview_legacy_jobs([])
        (legacy_root / "search-link.md").unlink()
        (legacy_root / "search-large.md").write_bytes(b"x" * (STORE_MODULE.LEGACY_SEARCH_MAX_FILE_BYTES + 1))
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "per-file"):
                self.store.preview_legacy_jobs([])

    def test_legacy_job_cli_walkthrough_uses_fixed_home_root(self):
        self._write_legacy_search_report()
        environment = {**os.environ, "HOME": str(self.home)}
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        discovered = subprocess.run(
            [*base, "legacy-jobs-preview"], check=True, capture_output=True, text=True, env=environment
        )
        item_id = json.loads(discovered.stdout)["items"][0]["itemId"]
        preview = subprocess.run(
            [*base, "legacy-jobs-preview", "--select", item_id], check=True,
            capture_output=True, text=True, env=environment,
        )
        token = json.loads(preview.stdout)["token"]
        committed = subprocess.run(
            [*base, "legacy-jobs-commit", "--select", item_id, "--confirm", token],
            check=True, capture_output=True, text=True, env=environment,
        )
        self.assertTrue(json.loads(committed.stdout)["committed"])

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
        acquired = self.store.acquire_ready_job(
            job["id"], "unit-test-agent", job["revision"]
        )
        job = acquired["job"]
        handoff = self.store.handoff_claimed_job(
            job["id"], acquired["token"], "awaiting_review",
            {"status": "review", "step": "review", "pendingFields": []},
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

    def _make_ready_job(self, job_id="ready-job", assigned=False):
        self.store.replace_profile({"firstName": "Ada"})
        default_path = self.home / "default.pdf"
        default_path.write_bytes(b"default-resume")
        self.store.create_resume(
            {"id": "default-resume", "label": "Default", "path": str(default_path)}
        )
        resume_id = None
        if assigned:
            assigned_path = self.home / "assigned.pdf"
            assigned_path.write_bytes(b"assigned-resume")
            assigned_resume = self.store.create_resume(
                {"id": "assigned-resume", "label": "Assigned", "path": str(assigned_path)}
            )
            resume_id = assigned_resume["id"]
        job = self.store.create_job({
            "id": job_id, "url": f"https://example.com/jobs/{job_id}",
            "role": "Engineer", "company": "Acme", "resumeId": resume_id,
        })
        return self.store.transition_job(job_id, "ready", job["revision"])

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
        review = {"status": "review", "step": "review", "pendingFields": []}
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

    def test_acquisition_and_handoff_roll_forward_at_each_failure_boundary(self):
        original_write = STORE_MODULE.atomic_write_json

        def ready_store(case):
            root = self.home / "boundaries" / case
            store = STORE_MODULE.Store(root, self.legacy)
            store.replace_profile({"firstName": "Ada"})
            resume_path = root / "resume.pdf"
            resume_path.write_bytes(b"resume")
            store.create_resume({"id": "resume", "label": "Resume", "path": str(resume_path)})
            job = store.create_job({"id": "job", "url": f"https://example.com/{case}"})
            ready = store.transition_job("job", "ready", job["revision"])
            store.claim_status()
            return store, ready

        acquisition_boundaries = {
            "journal-write": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is not None,
            "jobs": lambda store, path, payload: path == store.jobs_path,
            "history": None,
            "coordinator": lambda store, path, payload: path == store.coordinator_path and payload.get("claim") is not None,
            "journal-clear": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is None,
        }
        for name, predicate in acquisition_boundaries.items():
            with self.subTest(operation="acquire", boundary=name):
                store, ready = ready_store(f"acquire-{name}")
                if name == "history":
                    patcher = mock.patch.object(
                        store, "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                else:
                    failed = {"done": False}
                    def fail_once(path, payload, predicate=predicate, store=store):
                        if predicate(store, path, payload) and not failed["done"]:
                            failed["done"] = True
                            raise OSError("simulated crash")
                        return original_write(path, payload)
                    patcher = mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_once)
                with patcher, self.assertRaises(OSError):
                    store.acquire_ready_job("job", "agent", ready["revision"])
                repaired = STORE_MODULE.Store(store.root, self.legacy)
                if name == "journal-write":
                    self.assertIsNone(repaired.claim_status()["claim"])
                    self.assertEqual(repaired.get_job("job")["status"], "ready")
                    self.assertEqual(repaired.read_history(), [])
                    continue
                self.assertIsNotNone(repaired.claim_status()["claim"])
                self.assertEqual(repaired.get_job("job")["status"], "in_progress")
                self.assertEqual([event["event"] for event in repaired.read_history()], ["job-started"])

        handoff_boundaries = {
            "journal-write": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is not None,
            "jobs": lambda store, path, payload: path == store.jobs_path,
            "session": lambda store, path, payload: path == store._session_path("job"),
            "history": None,
            "coordinator": lambda store, path, payload: path == store.coordinator_path and payload.get("claim") is None,
            "journal-clear": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is None,
        }
        for name, predicate in handoff_boundaries.items():
            with self.subTest(operation="handoff", boundary=name):
                store, ready = ready_store(f"handoff-{name}")
                acquired = store.acquire_ready_job("job", "agent", ready["revision"])
                if name == "history":
                    patcher = mock.patch.object(
                        store, "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                else:
                    failed = {"done": False}
                    def fail_once(path, payload, predicate=predicate, store=store):
                        if predicate(store, path, payload) and not failed["done"]:
                            failed["done"] = True
                            raise OSError("simulated crash")
                        return original_write(path, payload)
                    patcher = mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_once)
                with patcher, self.assertRaises(OSError):
                    store.handoff_claimed_job(
                        "job", acquired["token"], "awaiting_review",
                        {"status": "review", "step": "review"},
                        acquired["job"]["revision"],
                    )
                repaired = STORE_MODULE.Store(store.root, self.legacy)
                if name == "journal-write":
                    self.assertIsNotNone(repaired.claim_status()["claim"])
                    self.assertEqual(repaired.get_job("job")["status"], "in_progress")
                    self.assertFalse(repaired._session_path("job").exists())
                    self.assertEqual(
                        [event["event"] for event in repaired.read_history()],
                        ["job-started"],
                    )
                    continue
                self.assertIsNone(repaired.claim_status()["claim"])
                self.assertEqual(repaired.get_job("job")["status"], "awaiting_review")
                self.assertEqual(repaired.load_session("job")["status"], "review")
                self.assertEqual(
                    [event["event"] for event in repaired.read_history()],
                    ["job-started", "reviewed"],
                )

    def test_pending_coordinator_operation_repairs_partial_history_tail(self):
        ready = self._make_ready_job()

        def append_partial_then_crash(event):
            encoded = (
                json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            descriptor = os.open(
                self.store.history_path,
                os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                0o600,
            )
            try:
                os.write(descriptor, encoded[: len(encoded) // 2])
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            raise OSError("simulated process crash after partial append")

        with mock.patch.object(
            self.store,
            "_append_history_event_idempotent_locked",
            side_effect=append_partial_then_crash,
        ):
            with self.assertRaisesRegex(OSError, "partial append"):
                self.store.acquire_ready_job("ready-job", "codex", ready["revision"])

        self.assertFalse(self.store.history_path.read_bytes().endswith(b"\n"))
        repaired = STORE_MODULE.Store(self.root, self.legacy)
        self.assertIsNotNone(repaired.claim_status()["claim"])
        self.assertEqual(repaired.get_job("ready-job")["status"], "in_progress")
        self.assertEqual(
            [event["event"] for event in repaired.read_history()], ["job-started"]
        )
        self.assertIsNone(repaired._load_coordinator_journal()["operation"])

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

    def test_answer_library_cli_lists_and_updates_by_revision(self):
        answer_input = self.home / "answer.json"
        answer_input.write_text(
            json.dumps(
                {
                    "question": "Preferred start date?",
                    "state": "confirmed",
                    "value": "June",
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
                "answer-put",
                "--input",
                str(answer_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        record = json.loads(created.stdout)
        update_input = self.home / "answer-update.json"
        update_input.write_text(json.dumps({"value": "July"}), encoding="utf-8")
        updated = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "answer-update",
                "--key",
                record["key"],
                "--expected-revision",
                str(record["revision"]),
                "--input",
                str(update_input),
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
                "answer-list",
                "--state",
                "confirmed",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(listed.stdout), [json.loads(updated.stdout)])

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
