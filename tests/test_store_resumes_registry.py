from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_resume_registry_tracks_files_defaults_and_revisions(self):
        first_path = self.home / "resume-a.pdf"
        first_path.write_bytes(b"%PDF-1.7\nresume-a")
        first = self.store.create_resume(
            {
                "id": "resume-a",
                "label": "Engineering",
                "path": str(first_path),
                "tags": ["engineering"],
            }
        )
        self.assertTrue(first["default"])
        self.assertEqual(first["observedSize"], len(b"%PDF-1.7\nresume-a"))
        self.assertFalse(self.store.check_resume(first["id"])["changed"])

        missing_path = self.home / "resume-b.txt"
        missing_path.write_text("leadership resume", encoding="utf-8")
        second = self.store.create_resume(
            {
                "id": "resume-b",
                "label": "Leadership",
                "path": str(missing_path),
            }
        )
        self.assertFalse(second["default"])
        self.assertTrue(self.store.check_resume(second["id"])["exists"])
        second = self.store.set_default_resume(
            second["id"], expected_revision=second["revision"]
        )
        self.assertTrue(second["default"])
        refreshed_first = self.store.get_resume(first["id"])
        self.assertFalse(refreshed_first["default"])
        self.assertEqual(refreshed_first["revision"], first["revision"] + 1)

        first_path.write_bytes(b"changed source is no longer canonical")
        self.assertFalse(self.store.check_resume(first["id"])["changed"])
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

    def test_managed_resume_import_is_private_strict_and_source_independent(self):
        source = self.home / "resume.txt"
        source.write_text("Résumé text", encoding="utf-8")
        created = self.store.import_resume(
            {"id": "managed", "label": "Managed", "path": str(source)}
        )
        self.assertEqual(created["storageKind"], "managed")
        self.assertNotIn("path", created)
        stored = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        serialized = json.dumps(stored)
        self.assertNotIn(str(source), serialized)
        managed_path = self.store.resume_files_path / created["managedFile"]
        self.assertEqual(managed_path.read_text(encoding="utf-8"), "Résumé text")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(managed_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.store.resume_files_path.stat().st_mode), 0o700)
        source.unlink()
        self.assertTrue(self.store.check_resume(created["id"])["exists"])

        docx = self.home / "resume.docx"
        with STORE_MODULE.zipfile.ZipFile(docx, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types />")
            archive.writestr("word/document.xml", "<document />")
        imported_docx = self.store.create_resume(
            {"id": "docx", "label": "DOCX", "path": str(docx)}
        )
        self.assertEqual(imported_docx["mediaType"], STORE_MODULE.RESUME_MEDIA_TYPES[".docx"])

        invalid = self.home / "invalid.pdf"
        invalid.write_bytes(b"not a pdf")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "does not match"):
            self.store.create_resume(
                {"id": "invalid", "label": "Invalid", "path": str(invalid)}
            )
        oversized = self.home / "oversized.txt"
        oversized.write_bytes(b"x" * (STORE_MODULE.RESUME_MAX_BYTES + 1))
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "10 MiB"):
            self.store.create_resume(
                {"id": "oversized", "label": "Oversized", "path": str(oversized)}
            )

    def test_owner_like_redacted_pdf_is_a_reproducible_managed_resume_fixture(self):
        source = ROOT / "qa" / "testdata" / "resumes" / "owner-like-redacted.pdf"
        content = source.read_bytes()
        expected_digest = (
            "aa5db02218f2eb40ab26521fb614b8bc"
            "86527fa11ee1c531b5555f6b54aad551"
        )

        self.assertEqual(hashlib.sha256(content).hexdigest(), expected_digest)
        created = self.store.import_resume(
            {"id": "owner-like", "label": "Owner-like redacted", "path": str(source)}
        )

        self.assertEqual(created["storageKind"], "managed")
        self.assertEqual(created["mediaType"], STORE_MODULE.RESUME_MEDIA_TYPES[".pdf"])
        self.assertEqual(created["digest"], expected_digest)
        self.assertNotIn("path", created)
        stored_record, stored_content = self.store.read_resume_content(created["id"])
        self.assertEqual(stored_record["digest"], expected_digest)
        self.assertEqual(stored_content, content)

    def test_failed_managed_staging_is_removed_immediately(self):
        source = self.home / "cleanup.txt"
        source.write_text("synthetic cleanup resume", encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "label"):
            self.store.create_resume(
                {"id": "bad-label", "label": "", "path": str(source)}
            )
        self.assertEqual(list(self.store.resume_files_path.glob(".*.tmp")), [])

        created = self.store.create_resume(
            {"id": "cleanup", "label": "Cleanup", "path": str(source)}
        )
        replacement = self.home / "replacement.pdf"
        replacement.write_bytes(b"%PDF-1.7\nsynthetic replacement")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "tags"):
            self.store.update_resume(
                created["id"],
                {"path": str(replacement), "tags": [""]},
                created["revision"],
            )
        self.assertEqual(list(self.store.resume_files_path.glob(".*.tmp")), [])
        self.assertEqual(self.store.get_resume(created["id"]), created)

    def test_managed_resume_bytes_share_validation_revisions_and_fail_clean_storage(self):
        created = self.store.create_resume_bytes(
            {"id": "browser-bytes", "label": "Browser bytes"},
            "private-browser-name.txt",
            b"synthetic browser resume",
        )
        self.assertNotEqual(created["originalFilename"], "private-browser-name.txt")
        record, content = self.store.read_resume_content(created["id"])
        self.assertEqual((record["id"], content), (created["id"], b"synthetic browser resume"))
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_resume_bytes(created["id"], "new.pdf", b"%PDF-1.7\nnew", 99)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "does not match"):
            self.store.update_resume_bytes(created["id"], "new.pdf", b"not pdf", created["revision"])
        self.assertEqual(self.store.get_resume(created["id"]), created)
        self.assertEqual(list(self.store.resume_files_path.glob(".*.tmp")), [])
        self.assertEqual(list(self.store.resume_files_path.glob(".browser-upload.*")), [])
        updated = self.store.update_resume_bytes(
            created["id"], "new.pdf", b"%PDF-1.7\nnew", created["revision"]
        )
        self.assertEqual((updated["id"], updated["revision"]), (created["id"], created["revision"] + 1))
        self.assertEqual(self.store.read_resume_content(created["id"])[1], b"%PDF-1.7\nnew")
        managed_path = self.store.resume_files_path / updated["managedFile"]
        managed_path.write_bytes(b"%PDF-1.7\ntampered")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unavailable"):
            self.store.read_resume_content(created["id"])

    def test_browser_source_cleanup_failure_does_not_reverse_commit_and_is_recoverable(self):
        original_unlink = Path.unlink

        def fail_browser_cleanup(path, *args, **kwargs):
            if path.name.startswith(".browser-upload."):
                raise PermissionError("synthetic cleanup failure")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_browser_cleanup):
            created = self.store.create_resume_bytes(
                {"id": "cleanup-success", "label": "Cleanup success"},
                "private.txt",
                b"committed bytes",
            )
        self.assertEqual(self.store.get_resume(created["id"])["id"], created["id"])
        orphans = list(self.store.resume_files_path.glob(".browser-upload.*"))
        self.assertEqual(len(orphans), 1)
        old = time.time() - STORE_MODULE.UPLOAD_RECOVERY_GRACE_SECONDS - 1
        os.utime(orphans[0], (old, old))
        self.store.initialize()
        self.assertFalse(orphans[0].exists())

    def test_resume_resolve_returns_only_a_verified_active_managed_path(self):
        created = self.store.create_resume_bytes(
            {"id": "resolved", "label": "Resolved"}, "source.txt", b"resolved bytes"
        )
        resolved = self.store.resolve_resume()
        self.assertEqual(set(resolved), {"id", "revision", "mediaType", "path"})
        self.assertEqual(Path(resolved["path"]).read_bytes(), b"resolved bytes")
        self.assertEqual(self.store.resolve_resume("resolved")["id"], created["id"])
        managed_path = Path(resolved["path"])
        managed_path.write_bytes(b"tampered")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unavailable"):
            self.store.resolve_resume("resolved")
