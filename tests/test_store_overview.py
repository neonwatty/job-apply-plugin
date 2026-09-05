from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_owner_beta_overview_is_value_free_and_derives_the_closed_next_action(self):
        self.store.initialize()
        clean = self.store.owner_beta_overview()
        self.assertEqual(clean, {
            "setup": {"hasProfileFacts": False, "hasResume": False},
            "counts": {"jobs": 0, "readyJobs": 0, "attentionJobs": 0, "resumes": 0, "answers": 0},
            "nextAction": "import_resume",
            "targetWorkspace": "resumes",
        })
        resume_path = self.home / "owner-private.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nowner-private")
        self.store.create_resume({"id": "owner-resume", "label": "Owner", "path": str(resume_path)})
        self.assertEqual(self.store.owner_beta_overview()["nextAction"], "review_facts")
        self.store.replace_profile({"email": "private@example.invalid"}, 1, "user")
        self.assertEqual(self.store.owner_beta_overview()["nextAction"], "capture_job")
        job = self.store.create_job({"id": "private-job", "url": "https://private.invalid/job"})
        job = self.store.transition_job(job["id"], "ready", job["revision"])
        projection = self.store.owner_beta_overview()
        self.assertEqual((projection["nextAction"], projection["targetWorkspace"]), ("handoff_ready_job", "jobs"))
        self.assertEqual(set(projection), {"setup", "counts", "nextAction", "targetWorkspace"})
        serialized = json.dumps(projection)
        for private in ("private@example.invalid", "owner-private", "private-job", str(resume_path)):
            self.assertNotIn(private, serialized)

    def test_owner_beta_overview_does_not_treat_search_preferences_as_application_facts(self):
        self.store.initialize()
        self.store.replace_profile(
            {"preferences": {"targetTitles": ["Engineer"]}}, 1, "user"
        )
        resume_path = self.home / "preferences-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\npreferences")
        self.store.create_resume(
            {"id": "preferences-resume", "label": "Preferences", "path": str(resume_path)}
        )
        projection = self.store.owner_beta_overview()
        self.assertFalse(projection["setup"]["hasProfileFacts"])
        self.assertEqual(
            (projection["nextAction"], projection["targetWorkspace"]),
            ("review_facts", "facts"),
        )
        profile = self.store.inspect_profile()
        self.store.patch_profile({"firstName": "Ada"}, profile["revision"], "user")
        self.assertTrue(self.store.owner_beta_overview()["setup"]["hasProfileFacts"])

    def test_owner_beta_overview_never_hands_off_a_ready_job_with_tampered_resume(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "tampered-ready-resume", "label": "Tampered"},
            "resume.pdf",
            b"%PDF-1.7\noriginal",
        )
        job = self.store.create_job(
            {"id": "tampered-ready-job", "url": "https://example.invalid/tampered"}
        )
        job = self.store.transition_job(job["id"], "ready", job["revision"])
        managed_path = self.store.resume_files_path / resume["managedFile"]
        managed_path.write_bytes(b"%PDF-1.7\ntampered")
        projection = self.store.owner_beta_overview()
        self.assertEqual(projection["counts"]["readyJobs"], 1)
        self.assertEqual(
            (projection["nextAction"], projection["targetWorkspace"]),
            ("prepare_job", "jobs"),
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "job is not ready"):
            self.store.acquire_ready_job(job["id"], "owner", job["revision"])

    def test_owner_beta_overview_respects_a_separate_live_global_claim(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume_path = self.home / "claimed-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nclaim")
        self.store.create_resume(
            {"id": "claimed-resume", "label": "Claimed", "path": str(resume_path)}
        )
        first = self.store.create_job(
            {"id": "claimed-first", "url": "https://example.invalid/first"}
        )
        second = self.store.create_job(
            {"id": "claimed-second", "url": "https://example.invalid/second"}
        )
        first = self.store.transition_job(first["id"], "ready", first["revision"])
        second = self.store.transition_job(second["id"], "ready", second["revision"])
        self.store.acquire_ready_job(first["id"], "active-owner", first["revision"])
        projection = self.store.owner_beta_overview()
        self.assertEqual(projection["counts"]["readyJobs"], 1)
        self.assertEqual(projection["counts"]["attentionJobs"], 0)
        self.assertEqual(
            (projection["nextAction"], projection["targetWorkspace"]),
            ("prepare_job", "jobs"),
        )
        self.assertEqual(self.store.get_job(second["id"])["status"], "ready")

    def test_owner_beta_overview_reuses_loaded_documents_and_resume_observations(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "shared-ready-resume", "label": "Shared"},
            "resume.pdf",
            b"%PDF-1.7\nshared-ready-resume",
        )
        for suffix in ("first", "second"):
            job = self.store.create_job({
                "id": f"shared-ready-{suffix}",
                "url": f"https://example.invalid/{suffix}",
                "resumeId": resume["id"],
            })
            self.store.transition_job(job["id"], "ready", job["revision"])

        with (
            mock.patch.object(
                self.store,
                "_load_profile_document",
                wraps=self.store._load_profile_document,
            ) as load_profile,
            mock.patch.object(
                self.store,
                "_load_resumes_document",
                wraps=self.store._load_resumes_document,
            ) as load_resumes,
            mock.patch.object(
                self.store,
                "_managed_resume_observation",
                wraps=self.store._managed_resume_observation,
            ) as observe_resume,
        ):
            projection = self.store.owner_beta_overview()

        self.assertEqual(projection["nextAction"], "handoff_ready_job")
        self.assertEqual(load_profile.call_count, 2)
        self.assertEqual(load_resumes.call_count, 3)
        self.assertEqual(observe_resume.call_count, 1)

    def test_owner_beta_overview_bounds_managed_resume_hashing_and_rechecks_changed_identity(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "cached-ready-resume", "label": "Cached"},
            "resume.pdf",
            b"%PDF-1.7\noriginal-cache-bytes",
        )
        job = self.store.create_job({
            "id": "cached-ready-job",
            "url": "https://example.invalid/cached-ready",
            "resumeId": resume["id"],
        })
        self.store.transition_job(job["id"], "ready", job["revision"])
        managed_path = self.store.resume_files_path / resume["managedFile"]
        cache_identity = STORE_MODULE._managed_resume_digest_cache_identity
        posix_cache_identity = lambda metadata: (
            cache_identity(metadata, platform_name="posix")
        )

        with (
            mock.patch.object(
                STORE_MODULE,
                "_managed_resume_digest_cache_identity",
                side_effect=posix_cache_identity,
            ),
            mock.patch.object(
                self.store,
                "_private_file_digest",
                wraps=self.store._private_file_digest,
            ) as digest,
        ):
            first = self.store.owner_beta_overview()
            second = self.store.owner_beta_overview()
            self.assertEqual(first["nextAction"], "handoff_ready_job")
            self.assertEqual(second["nextAction"], "handoff_ready_job")
            self.assertEqual(digest.call_count, 1)

            original = managed_path.read_bytes()
            managed_path.write_bytes(b"X" * len(original))
            changed = self.store.owner_beta_overview()
            self.assertEqual(changed["nextAction"], "prepare_job")
            self.assertEqual(digest.call_count, 2)

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "job is not ready"):
            self.store.acquire_ready_job(job["id"], "owner", job["revision"] + 1)

    def test_owner_beta_overview_disables_digest_reuse_for_windows_creation_time_semantics(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "windows-cache-resume", "label": "Windows cache"},
            "resume.pdf",
            b"%PDF-1.7\nwindows-original",
        )
        job = self.store.create_job({
            "id": "windows-cache-job",
            "url": "https://example.invalid/windows-cache",
            "resumeId": resume["id"],
        })
        self.store.transition_job(job["id"], "ready", job["revision"])
        managed_path = self.store.resume_files_path / resume["managedFile"]
        cache_identity = STORE_MODULE._managed_resume_digest_cache_identity
        windows_cache_identity = lambda metadata: (
            cache_identity(metadata, platform_name="nt")
        )

        with (
            mock.patch.object(
                STORE_MODULE,
                "_managed_resume_digest_cache_identity",
                side_effect=windows_cache_identity,
            ),
            mock.patch.object(
                self.store,
                "_private_file_digest",
                wraps=self.store._private_file_digest,
            ) as digest,
        ):
            first = self.store.owner_beta_overview()
            second = self.store.owner_beta_overview()
            self.assertEqual(first["nextAction"], "handoff_ready_job")
            self.assertEqual(second["nextAction"], "handoff_ready_job")
            self.assertEqual(digest.call_count, 2)
            self.assertEqual(self.store._overview_resume_digest_cache, {})

            original_metadata = managed_path.stat()
            original = managed_path.read_bytes()
            managed_path.write_bytes(b"X" * len(original))
            os.utime(
                managed_path,
                ns=(original_metadata.st_atime_ns, original_metadata.st_mtime_ns),
            )
            changed = self.store.owner_beta_overview()

        self.assertEqual(changed["nextAction"], "prepare_job")
        self.assertEqual(digest.call_count, 3)

    def test_owner_beta_overview_live_claim_skips_ready_preflight(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume_path = self.home / "live-claim-fast-path.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nlive-claim-fast-path")
        self.store.create_resume({
            "id": "live-claim-fast-path-resume",
            "label": "Fast path",
            "path": str(resume_path),
        })
        first = self.store.create_job({
            "id": "live-claim-fast-path-first",
            "url": "https://example.invalid/live-first",
        })
        second = self.store.create_job({
            "id": "live-claim-fast-path-second",
            "url": "https://example.invalid/live-second",
        })
        first = self.store.transition_job(first["id"], "ready", first["revision"])
        self.store.transition_job(second["id"], "ready", second["revision"])
        self.store.acquire_ready_job(first["id"], "active-owner", first["revision"])

        with mock.patch.object(
            self.store,
            "_preflight_job_record",
            wraps=self.store._preflight_job_record,
        ) as preflight:
            projection = self.store.owner_beta_overview()

        self.assertEqual(projection["nextAction"], "prepare_job")
        preflight.assert_not_called()

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
