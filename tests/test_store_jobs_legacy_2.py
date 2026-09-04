from tests.support.store_case import *


class StoreTests(StoreTestCase):

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
        environment = {
            **os.environ,
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
        }
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
