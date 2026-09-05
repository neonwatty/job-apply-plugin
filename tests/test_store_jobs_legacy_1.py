from tests.support.store_case import *


class StoreTests(StoreTestCase):

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
            source.write_bytes(source.read_bytes() + b"\n")
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
