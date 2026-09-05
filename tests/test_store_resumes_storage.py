from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_managed_resume_duplicate_replace_and_rollback_are_deterministic(self):
        source = self.home / "original.pdf"
        source.write_bytes(b"%PDF-1.7\noriginal")
        created = self.store.create_resume(
            {"id": "stable", "label": "Stable", "path": str(source)}
        )
        metadata_only = self.store.update_resume(
            created["id"], {"label": "Stable metadata"}, created["revision"]
        )
        self.assertEqual(metadata_only["contentRevision"], created["contentRevision"])
        created = metadata_only
        duplicate = self.home / "duplicate.pdf"
        duplicate.write_bytes(source.read_bytes())
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already managed"):
            self.store.create_resume(
                {"id": "duplicate", "label": "Duplicate", "path": str(duplicate)}
            )
        trashed = self.store.trash_resume(created["id"], created["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already managed"):
            self.store.create_resume(
                {"id": "duplicate", "label": "Duplicate", "path": str(duplicate)}
            )
        created = self.store.restore_resume(created["id"], trashed["revision"])
        replacement = self.home / "replacement.txt"
        replacement.write_text("replacement", encoding="utf-8")
        updated = self.store.update_resume(
            created["id"], {"path": str(replacement)}, created["revision"]
        )
        self.assertEqual(updated["id"], created["id"])
        self.assertEqual(updated["revision"], created["revision"] + 1)
        self.assertNotEqual(updated["digest"], created["digest"])
        self.assertNotEqual(updated["contentRevision"], created["contentRevision"])
        self.assertFalse((self.store.resume_files_path / created["managedFile"]).exists())

        failed_source = self.home / "failed.txt"
        failed_source.write_text("failed replacement", encoding="utf-8")
        canonical_path = self.store.resume_files_path / updated["managedFile"]
        canonical_bytes = canonical_path.read_bytes()
        with mock.patch.object(
            STORE_MODULE, "atomic_write_json", side_effect=OSError("synthetic")
        ):
            with self.assertRaises(OSError):
                self.store.update_resume(
                    updated["id"], {"path": str(failed_source)}, updated["revision"]
                )
        self.assertEqual(canonical_path.read_bytes(), canonical_bytes)
        self.assertEqual(self.store.get_resume(updated["id"]), updated)

        quarantine = self.store.resume_files_path / (
            f".{updated['managedFile']}.synthetic.quarantine"
        )
        os.replace(canonical_path, quarantine)
        self.store.initialize()
        self.assertTrue(canonical_path.exists())
        self.assertFalse(quarantine.exists())

    def test_legacy_resume_adoption_preserves_identity_and_rolls_back_delete(self):
        self.store.initialize()
        external = self.home / "legacy.pdf"
        external.write_bytes(b"%PDF-1.7\nlegacy")
        now = "2026-08-25T00:00:00Z"
        document = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        document["resumes"]["legacy"] = {
            "id": "legacy",
            "label": "Legacy",
            "path": str(external),
            "tags": [],
            "default": True,
            "observedSize": external.stat().st_size,
            "observedModifiedAt": STORE_MODULE.observe_resume_file(str(external))["modifiedAt"],
            "revision": 4,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        STORE_MODULE.atomic_write_json(self.store.resumes_path, document)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "adopted"):
            self.store.resolve_resume("legacy")
        adopted = self.store.adopt_resume("legacy", None, 4)
        self.assertEqual((adopted["id"], adopted["revision"]), ("legacy", 5))
        self.assertNotIn("path", adopted)
        external.unlink()
        trashed = self.store.trash_resume("legacy", adopted["revision"])
        managed_path = self.store.resume_files_path / adopted["managedFile"]
        with mock.patch.object(
            STORE_MODULE, "atomic_write_json", side_effect=OSError("synthetic")
        ):
            with self.assertRaises(OSError):
                self.store.delete_resume("legacy", trashed["revision"])
        self.assertTrue(managed_path.exists())
        self.assertEqual(
            self.store.get_resume("legacy", include_trashed=True)["revision"],
            trashed["revision"],
        )

    def test_resume_assignment_prevents_trash_until_job_is_reassigned(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
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
        alternate_path = self.home / "alternate.txt"
        alternate_path.write_text("alternate resume", encoding="utf-8")
        alternate = self.store.create_resume(
            {"id": "resume-alternate", "label": "Alternate", "path": str(alternate_path)}
        )
        self.store.set_default_resume(alternate["id"], alternate["revision"])
        resume = self.store.get_resume(resume["id"])
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
        first_path.write_bytes(b"%PDF-1.7\nfirst")
        second_path.write_bytes(b"%PDF-1.7\nsecond")
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
        resume_path.write_bytes(b"%PDF-1.7\nresume")
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
