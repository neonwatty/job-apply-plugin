from tests.support.promotion_case import *


class PromotionTests(PromotionCase):
    def test_missing_approval_blocks_promotion(self) -> None:
        with self.assertRaisesRegex(PromotionError, "approval required"):
            promote_candidate(self.candidate, self.destination, now=NOW)
        self.assertTrue(self.session.exists())
        self.assertFalse((self.destination / FIXTURE_ID).exists())

    def test_fixture_hash_mismatch_blocks_promotion(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        fixture_path = self.candidate / "fixture.json"
        fixture_path.write_bytes(fixture_path.read_bytes() + b"\n")

        with self.assertRaisesRegex(PromotionError, "fixture hash mismatch"):
            promote_candidate(self.candidate, self.destination, now=NOW)
        self.assertTrue(self.session.exists())

    def test_privacy_failure_blocks_promotion(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        manifest_path = self.candidate / "review-manifest.json"
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["stringCategories"].append("Private Person")
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

        with self.assertRaisesRegex(PromotionError, "privacy scan failed") as raised:
            promote_candidate(self.candidate, self.destination, now=NOW)
        self.assertNotIn("Private Person", str(raised.exception))
        self.assertTrue(self.session.exists())

    def test_compile_cli_redacts_filesystem_errors(self) -> None:
        stderr = io.StringIO()
        arguments = [
            "qa.promote",
            "compile",
            "--capture",
            str(self.session),
            "--fixture-id",
            FIXTURE_ID,
            "--candidate",
            str(self.candidate),
        ]
        # Recreate the pre-compilation state used by the command.
        for child in self.candidate.iterdir():
            child.unlink()
        self.candidate.rmdir()

        with (
            mock.patch.object(sys, "argv", arguments),
            mock.patch(
                "qa.promote.os.mkdir",
                side_effect=OSError("Private Person /sensitive/path"),
            ),
            mock.patch("sys.stderr", stderr),
        ):
            result = promotion.main()

        self.assertEqual(result, 1)
        self.assertIn("candidate creation failed", stderr.getvalue())
        self.assertNotIn("Private Person", stderr.getvalue())
        self.assertNotIn("sensitive", stderr.getvalue())

    def test_destination_inside_private_tree_is_rejected(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        overlapping = self.candidate / "qa" / "fixtures"
        overlapping.mkdir(parents=True)

        with self.assertRaisesRegex(PromotionError, "unsafe destination path"):
            promote_candidate(self.candidate, overlapping, now=NOW)

        self.assertTrue(self.session.exists())

    def test_existing_empty_fixture_target_is_never_replaced(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        existing = self.destination / FIXTURE_ID
        existing.mkdir()

        with self.assertRaisesRegex(PromotionError, "destination exists"):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue(existing.is_dir())
        self.assertEqual(list(existing.iterdir()), [])
        self.assertTrue(self.session.exists())

    def test_deep_raw_tree_fails_preflight_before_install(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        current = self.session
        for index in range(40):
            current = current / f"d{index}"
            current.mkdir()

        with self.assertRaisesRegex(PromotionError, "deletion preflight failed"):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(self.session.exists())

    def test_privacy_failure_never_echoes_sensitive_filename(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        sensitive = "Private Person secret.txt"
        (self.candidate / sensitive).write_text("safe", encoding="utf-8")

        with self.assertRaisesRegex(PromotionError, "invalid candidate inventory") as raised:
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertNotIn(sensitive, str(raised.exception))

    def test_wide_raw_tree_fails_bounded_preflight(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        wide = self.session / "wide"
        wide.mkdir()
        for index in range(promotion.MAX_DELETE_ENTRIES_PER_DIRECTORY + 1):
            (wide / f"f{index}").touch()

        with self.assertRaisesRegex(PromotionError, "deletion preflight failed"):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(wide.exists())

    def test_fixture_bytes_are_read_once_and_installed_from_snapshot(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        fixture_path = self.candidate / "fixture.json"
        original_fixture = fixture_path.read_bytes()
        original_read = promotion._read_regular_at
        fixture_reads = 0

        def mutate_after_read(directory_descriptor, name, diagnostic):
            nonlocal fixture_reads
            data = original_read(directory_descriptor, name, diagnostic)
            if name == "fixture.json":
                fixture_reads += 1
                fixture_path.write_bytes(b'{"tampered":true}\n')
            return data

        with mock.patch("qa.promote._read_regular_at", side_effect=mutate_after_read):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertEqual(fixture_reads, 1)
        self.assertEqual(
            (self.destination / FIXTURE_ID / "fixture.json").read_bytes(),
            original_fixture,
        )

    def test_candidate_aba_during_privacy_scan_fails_closed(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        displaced = self.session / "candidate-original"
        original_scan = promotion._scan_snapshot

        def swap_candidate(snapshot, denied_terms):
            original_scan(snapshot, denied_terms)
            self.candidate.rename(displaced)
            shutil.copytree(displaced, self.candidate)

        with mock.patch("qa.promote._scan_snapshot", side_effect=swap_candidate):
            with self.assertRaisesRegex(PromotionError, "private session changed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue(displaced.is_dir())
        self.assertTrue(self.candidate.is_dir())
        self.assertFalse((self.destination / FIXTURE_ID).exists())

    def test_missing_destination_parents_are_not_created(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        self.destination.rmdir()
        self.destination.parent.rmdir()

        with self.assertRaisesRegex(PromotionError, "unsafe destination path"):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse(self.destination.parent.exists())
        self.assertTrue(self.session.exists())
