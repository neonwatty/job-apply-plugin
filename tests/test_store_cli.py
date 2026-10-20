from tests.support.store_case import *


class StoreTests(StoreTestCase):

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

        preferences_input = self.home / "preferences.json"
        preferences_input.write_text(
            json.dumps({"remotePreference": "hybrid"}), encoding="utf-8"
        )
        preferences = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "preferences-set",
                "--input",
                str(preferences_input),
                "--expected-revision",
                "2",
                "--source",
                "user",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        preference_result = json.loads(preferences.stdout)
        self.assertEqual(preference_result["revision"], 3)
        self.assertEqual(
            preference_result["factProvenance"]["/preferences/remotePreference"]["source"],
            "user",
        )

        replacement_input = self.home / "profile-replacement.json"
        replacement_input.write_text(
            json.dumps({"firstName": "Grace", "preferences": {"remotePreference": "hybrid"}}),
            encoding="utf-8",
        )
        replaced = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "profile-replace",
                "--input",
                str(replacement_input),
                "--expected-revision",
                "3",
                "--source",
                "user",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(replaced.stdout)["revision"], 4)

        resume_file = self.home / "resume.pdf"
        resume_file.write_bytes(b"%PDF-1.7\nresume")
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
        resolved = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "resume-resolve",
                "--id",
                "main-resume",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        resolved_record = json.loads(resolved.stdout)
        self.assertEqual(resolved_record["id"], "main-resume")
        self.assertTrue(Path(resolved_record["path"]).is_file())

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
        projection = json.loads(listed.stdout)
        self.assertEqual(projection["total"], 1)
        self.assertEqual(projection["items"][0]["key"], json.loads(updated.stdout)["key"])
        self.assertNotIn("value", projection["items"][0])

    def test_paths_exposes_separate_inert_policy_root_without_changing_v1_store(self):
        self.store.initialize()
        paths = self.store.paths()
        self.assertEqual(paths["schemaVersion"], 1)
        self.assertEqual(paths["factGroups"], str(self.root / "fact-groups.json"))
        self.assertEqual(paths["jobs"], str(self.root / "jobs.json"))
        self.assertEqual(paths["resumes"], str(self.root / "resumes.json"))
        self.assertEqual(paths["autoSubmitPolicy"], str(self.root / "auto-submit"))
        self.assertFalse((self.root / "auto-submit").exists())
        self.assertEqual(self.store.get_profile(), {})
