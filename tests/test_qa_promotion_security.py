from tests.support.promotion_case import *


class PromotionTests(PromotionCase):
    def test_private_parent_swap_fails_closed_without_deleting_replacement(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        displaced = self.root / ".qa-private-original"
        original_safe_destination = promotion._open_destination_binding

        def swap_parent(destination: Path) -> Path:
            result = original_safe_destination(destination)
            self.private.rename(displaced)
            replacement = self.private / self.session.name
            replacement.mkdir(parents=True)
            (replacement / "unrelated.txt").write_text("keep", encoding="utf-8")
            return result

        with mock.patch("qa.promote._open_destination_binding", side_effect=swap_parent):
            with self.assertRaisesRegex(PromotionError, "private session changed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertEqual(
            (self.private / self.session.name / "unrelated.txt").read_text(
                encoding="utf-8"
            ),
            "keep",
        )
        self.assertTrue((displaced / self.session.name / "candidate").is_dir())
        self.assertFalse((self.destination / FIXTURE_ID).exists())

    def test_private_session_swap_fails_closed_without_deleting_replacement(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        displaced = self.private / "qa-session-original"
        original_safe_destination = promotion._open_destination_binding

        def swap_session(destination: Path) -> Path:
            result = original_safe_destination(destination)
            self.session.rename(displaced)
            self.session.mkdir()
            (self.session / "unrelated.txt").write_text("keep", encoding="utf-8")
            return result

        with mock.patch("qa.promote._open_destination_binding", side_effect=swap_session):
            with self.assertRaisesRegex(PromotionError, "private session changed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertEqual(
            (self.session / "unrelated.txt").read_text(encoding="utf-8"), "keep"
        )
        self.assertTrue((displaced / "candidate").is_dir())
        self.assertFalse((self.destination / FIXTURE_ID).exists())

    def test_first_observation_swap_cannot_replace_guarded_private_tree(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        displaced = self.root / ".qa-private-original"
        original_lstat = Path.lstat
        swapped = False

        def swap_after_observation(path: Path):
            nonlocal swapped
            observed = original_lstat(path)
            if Path(path) == self.private and not swapped:
                swapped = True
                self.private.rename(displaced)
                shutil.copytree(displaced, self.private)
                replacement_session = self.private / self.session.name
                (replacement_session / "unrelated.txt").write_text(
                    "keep", encoding="utf-8"
                )
            return observed

        with mock.patch("qa.promote.Path.lstat", new=swap_after_observation):
            with self.assertRaisesRegex(PromotionError, "private session changed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue(swapped)
        self.assertEqual(
            (self.private / self.session.name / "unrelated.txt").read_text(
                encoding="utf-8"
            ),
            "keep",
        )
        self.assertTrue((displaced / self.session.name / "candidate").is_dir())
        self.assertFalse((self.destination / FIXTURE_ID).exists())

    def test_cross_device_descendant_fails_preflight(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        marker = self.session / "cross-device.txt"
        marker.write_text("safe", encoding="utf-8")
        original_identity = promotion._deletion_entry_identity

        def change_device(entry):
            identity = original_identity(entry)
            if entry.name == marker.name:
                values = list(identity)
                values[2] = identity.st_dev + 1
                return os.stat_result(values)
            return identity

        with mock.patch(
            "qa.promote._deletion_entry_identity", side_effect=change_device
        ):
            with self.assertRaisesRegex(PromotionError, "deletion preflight failed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(marker.exists())

    def test_destination_ancestor_swap_fails_before_install(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        displaced = self.root / "qa-original"
        original_stat = promotion.os.stat
        swapped = False

        def swap_qa_after_stat(path, *args, **kwargs):
            nonlocal swapped
            observed = original_stat(path, *args, **kwargs)
            if path == "qa" and kwargs.get("dir_fd") is not None and not swapped:
                swapped = True
                (self.root / "qa").rename(displaced)
                shutil.copytree(displaced, self.root / "qa")
            return observed

        with mock.patch("qa.promote.os.stat", side_effect=swap_qa_after_stat):
            with self.assertRaisesRegex(PromotionError, "unsafe destination path"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue(swapped)
        self.assertTrue(displaced.is_dir())
        self.assertFalse((self.destination / FIXTURE_ID).exists())

    def test_missing_posix_capabilities_fail_closed(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        with mock.patch("qa.promote._POSIX_DESCRIPTOR_SUPPORT", False):
            with self.assertRaisesRegex(PromotionError, "unsupported platform"):
                promote_candidate(self.candidate, self.destination, now=NOW)
        self.assertTrue(self.session.exists())

    def test_missing_exclusive_rename_capability_fails_closed(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        with mock.patch("qa.promote.exclusive_rename_available", return_value=False):
            with self.assertRaisesRegex(PromotionError, "unsupported platform"):
                promote_candidate(self.candidate, self.destination, now=NOW)
        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(self.session.exists())

    def test_mount_identity_change_is_rejected_before_install(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        original_mount = promotion._descriptor_mount_identity
        calls = 0

        def inject_mount(descriptor):
            nonlocal calls
            calls += 1
            identity = original_mount(descriptor)
            if calls == 2:
                return (identity[0], identity[1] + 1)
            return identity

        with mock.patch(
            "qa.promote._descriptor_mount_identity", side_effect=inject_mount
        ):
            with self.assertRaisesRegex(PromotionError, "unsafe mount boundary"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(self.session.exists())

    @unittest.skipUnless(sys.platform == "darwin", "Darwin mountpoint check")
    def test_darwin_real_mountpoint_is_detected_with_bound_descriptor(self) -> None:
        descriptor = os.open(
            "/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        )
        try:
            identity = os.fstat(descriptor)
            self.assertTrue(
                promotion._darwin_mountpoint_bound(
                    Path("/"), identity, descriptor
                )
            )
        finally:
            os.close(descriptor)

    def test_private_directories_require_current_owner_and_mode_0700(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        os.chmod(self.session, 0o750)

        with self.assertRaisesRegex(PromotionError, "unsafe private permissions"):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(self.session.exists())
