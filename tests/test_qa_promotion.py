from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

import qa.promote as promotion
from qa.promote import (
    PromotionError,
    approve_candidate,
    compile_candidate,
    promote_candidate,
)
from qa.recorder_fs import BrokerError


FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"
NOW = "2026-08-11T12:00:00Z"


class PromotionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.private = self.root / ".qa-private"
        self.session = self.private / "qa-session-20260811-001"
        self.candidate = self.session / "candidate"
        self.destination = self.root / "qa" / "fixtures"
        self.session.mkdir(parents=True)
        os.chmod(self.private, 0o700)
        os.chmod(self.session, 0o700)
        self.destination.mkdir(parents=True)
        self._write_private_inputs()
        compile_candidate(self.session, FIXTURE_ID, self.candidate)

    def _write_private_inputs(self, denied_terms: list[str] | None = None) -> None:
        semantic = {
            "captureId": "capture-001",
            "platformFamily": "linkedin-easy-apply",
            "captureMonth": "2026-08",
            "sourceDeniedTerms": denied_terms or ["Private Person", "Example Corp"],
            "steps": [
                {
                    "checkpoint": "application-opened",
                    "controls": [
                        {"kind": "contact.first_name", "sourceLabel": "Given name", "required": True},
                        {"kind": "contact.last_name", "sourceLabel": "Family name", "required": True},
                        {"kind": "contact.email", "sourceLabel": "Email", "required": True},
                        {"kind": "contact.phone", "sourceLabel": "Phone", "required": True},
                    ],
                },
                {
                    "checkpoint": "step-advanced",
                    "controls": [
                        {"kind": "resume.file", "sourceLabel": "Resume", "required": True},
                    ],
                },
                {
                    "checkpoint": "review-reached",
                    "controls": [],
                    "finalActionObserved": True,
                },
            ],
        }
        receipt = {
            "recorderVersion": "1.0.0",
            "captureMonth": "2026-08",
            "captureId": "capture-001",
            "sourceFiles": {"checkpoints/001.json": "a" * 64},
        }
        (self.session / "semantic.json").write_text(json.dumps(semantic), encoding="utf-8")
        (self.session / "capture-receipt.json").write_text(json.dumps(receipt), encoding="utf-8")

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

    def test_success_promotes_and_deletes_private_session(self) -> None:
        approval = approve_candidate(self.candidate, "qa-owner", now=NOW)
        installed = promote_candidate(self.candidate, self.destination, now=NOW)

        expected = self.destination / FIXTURE_ID
        self.assertEqual(installed, expected)
        for name in ("fixture.json", "provenance.json", "approval.json"):
            self.assertTrue((expected / name).is_file())
        self.assertFalse(self.session.exists())
        self.assertEqual(
            json.loads((expected / "approval.json").read_text(encoding="utf-8")),
            approval,
        )
        fixture_bytes = (expected / "fixture.json").read_bytes()
        self.assertEqual(
            hashlib.sha256(fixture_bytes).hexdigest(),
            approval["fixtureSha256"],
        )

    def test_atomic_failure_preserves_existing_fixture(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        existing = self.destination / FIXTURE_ID
        existing.mkdir(parents=True)
        prior = b'{"prior":true}\n'
        (existing / "fixture.json").write_bytes(prior)

        with mock.patch(
            "qa.promote.exclusive_rename", side_effect=BrokerError("rename-failed")
        ) as replace:
            with self.assertRaisesRegex(PromotionError, "atomic install failed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        replace.assert_called_once()
        self.assertEqual((existing / "fixture.json").read_bytes(), prior)
        self.assertTrue(self.session.exists())

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

    def test_deletion_failure_after_tombstone_keeps_fixture(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)

        with mock.patch(
            "qa.promote._destroy_bound_session",
            side_effect=PromotionError("private session deletion failed"),
        ):
            with self.assertRaisesRegex(PromotionError, "cleanup incomplete") as raised:
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertNotIn("Private Person", str(raised.exception))
        self.assertTrue((self.destination / FIXTURE_ID / "fixture.json").is_file())
        self.assertFalse(self.session.exists())
        self.assertEqual(len(list(self.private.glob(".deleting-*"))), 1)

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

    def test_missing_destination_parents_are_not_created(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        self.destination.rmdir()
        self.destination.parent.rmdir()

        with self.assertRaisesRegex(PromotionError, "unsafe destination path"):
            promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertFalse(self.destination.parent.exists())
        self.assertTrue(self.session.exists())

    def test_missing_posix_capabilities_fail_closed(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        with mock.patch("qa.promote._POSIX_DESCRIPTOR_SUPPORT", False):
            with self.assertRaisesRegex(PromotionError, "unsupported platform"):
                promote_candidate(self.candidate, self.destination, now=NOW)
        self.assertTrue(self.session.exists())

    def test_missing_exclusive_rename_capability_fails_closed(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        with mock.patch("qa.promote._EXCLUSIVE_RENAME", None):
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

    def test_tombstone_rename_failure_rolls_back_fixture(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        original_rename = promotion.exclusive_rename
        calls = 0

        def fail_second_rename(*arguments):
            nonlocal calls
            calls += 1
            if calls == 2:
                raise BrokerError("rename-failed")
            return original_rename(*arguments)

        with mock.patch("qa.promote.exclusive_rename", side_effect=fail_second_rename):
            with self.assertRaisesRegex(PromotionError, "cleanup incomplete"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertEqual(calls, 2)
        self.assertFalse((self.destination / FIXTURE_ID).exists())
        self.assertTrue(self.session.exists())

    def test_late_final_rmdir_failure_keeps_fixture_and_tombstone(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        original_rmdir = promotion.os.rmdir

        def fail_tombstone_rmdir(path, *args, **kwargs):
            if isinstance(path, str) and path.startswith(".deleting-"):
                raise OSError("synthetic final rmdir failure")
            return original_rmdir(path, *args, **kwargs)

        with mock.patch("qa.promote.os.rmdir", side_effect=fail_tombstone_rmdir):
            with self.assertRaisesRegex(PromotionError, "cleanup incomplete"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue((self.destination / FIXTURE_ID / "fixture.json").is_file())
        self.assertFalse(self.session.exists())
        tombstones = list(self.private.glob(".deleting-*"))
        self.assertEqual(len(tombstones), 1)

    def test_new_entry_after_tombstone_keeps_fixture_and_remaining_raw(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        original_destroy = promotion._destroy_bound_session

        def add_entry(binding, deletion_plan):
            descriptor = os.open(
                "new-entry.txt",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=binding.session_descriptor,
            )
            os.close(descriptor)
            return original_destroy(binding, deletion_plan)

        with mock.patch("qa.promote._destroy_bound_session", side_effect=add_entry):
            with self.assertRaisesRegex(PromotionError, "cleanup incomplete"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue((self.destination / FIXTURE_ID / "fixture.json").is_file())
        self.assertFalse(self.session.exists())
        tombstones = list(self.private.glob(".deleting-*"))
        self.assertEqual(len(tombstones), 1)
        self.assertTrue((tombstones[0] / "new-entry.txt").is_file())

    def test_mid_tree_identity_change_keeps_fixture_and_tombstone(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        original_destroy = promotion._destroy_bound_session

        def replace_receipt(binding, deletion_plan):
            os.unlink("capture-receipt.json", dir_fd=binding.session_descriptor)
            descriptor = os.open(
                "capture-receipt.json",
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o600,
                dir_fd=binding.session_descriptor,
            )
            os.close(descriptor)
            return original_destroy(binding, deletion_plan)

        with mock.patch(
            "qa.promote._destroy_bound_session", side_effect=replace_receipt
        ):
            with self.assertRaisesRegex(PromotionError, "cleanup incomplete"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        self.assertTrue((self.destination / FIXTURE_ID / "fixture.json").is_file())
        self.assertFalse(self.session.exists())
        self.assertEqual(len(list(self.private.glob(".deleting-*"))), 1)


if __name__ == "__main__":
    unittest.main()
