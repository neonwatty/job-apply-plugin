from tests.support.store_case import *


class StoreTests(StoreTestCase):

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
        resume_path.write_bytes(b"%PDF-1.7\nresume")
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
