from __future__ import annotations

import hashlib
import io
import json
import os
from pathlib import Path
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

        with self.assertRaisesRegex(PromotionError, "privacy scan failed"):
            promote_candidate(self.candidate, self.destination, now=NOW)
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
            "qa.promote.os.replace", side_effect=OSError("synthetic failure")
        ) as replace:
            with self.assertRaisesRegex(PromotionError, "atomic install failed"):
                promote_candidate(self.candidate, self.destination, now=NOW)

        replace.assert_called_once()
        self.assertEqual((existing / "fixture.json").read_bytes(), prior)
        self.assertTrue(self.session.exists())

    def test_private_parent_swap_fails_closed_without_deleting_replacement(self) -> None:
        approve_candidate(self.candidate, "qa-owner", now=NOW)
        displaced = self.root / ".qa-private-original"
        original_safe_destination = promotion._safe_destination

        def swap_parent(destination: Path) -> Path:
            result = original_safe_destination(destination)
            self.private.rename(displaced)
            replacement = self.private / self.session.name
            replacement.mkdir(parents=True)
            (replacement / "unrelated.txt").write_text("keep", encoding="utf-8")
            return result

        with mock.patch("qa.promote._safe_destination", side_effect=swap_parent):
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
        original_safe_destination = promotion._safe_destination

        def swap_session(destination: Path) -> Path:
            result = original_safe_destination(destination)
            self.session.rename(displaced)
            self.session.mkdir()
            (self.session / "unrelated.txt").write_text("keep", encoding="utf-8")
            return result

        with mock.patch("qa.promote._safe_destination", side_effect=swap_session):
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
                "qa.promote.Path.mkdir",
                side_effect=OSError("Private Person /sensitive/path"),
            ),
            mock.patch("sys.stderr", stderr),
        ):
            result = promotion.main()

        self.assertEqual(result, 1)
        self.assertIn("candidate creation failed", stderr.getvalue())
        self.assertNotIn("Private Person", stderr.getvalue())
        self.assertNotIn("sensitive", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
