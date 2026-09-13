from tests.support.promotion_case import *


class PromotionTests(PromotionCase):
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
