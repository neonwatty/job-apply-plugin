"""Regression tests for smoke artifact containment at fixture boundaries."""

import shutil
import tempfile
import unittest
from pathlib import Path

from tests.test_smoke_harness_split import source_fixture
from artifacts import assert_critical_bytes, copy_critical, critical_paths


class SmokeArtifactContainmentTests(unittest.TestCase):
    def test_installed_receipt_requires_skill_reference_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_fixture(root / "source")
            reference = source / "skills/job-apply/references/application.md"
            reference.parent.mkdir(parents=True, exist_ok=True)
            reference.write_text("Manual review procedure\n")
            installed = root / "installed"
            shutil.copytree(source, installed)
            relative = reference.relative_to(source)
            self.assertIn(str(relative), critical_paths(source))
            (installed / relative).write_text("Stale procedure\n")
            with self.assertRaisesRegex(SystemExit, "bytes differ"):
                assert_critical_bytes(installed, source, label="installed")
            (installed / relative).unlink()
            with self.assertRaisesRegex(SystemExit, "inventory differs"):
                assert_critical_bytes(installed, source, label="installed")

    def test_inventory_and_receipts_reject_symlinked_ancestors(self):
        for relative in ("scripts", "skills/answer-memory", ".codex-plugin", "workspace"):
            with self.subTest(relative=relative), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = source_fixture(root / "source")
                installed = source_fixture(root / "installed")
                outside = root / "outside"
                shutil.move(installed / relative, outside)
                (installed / relative).symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(SystemExit, "contains a symlink"):
                    critical_paths(installed)
                with self.assertRaisesRegex(SystemExit, "contains a symlink"):
                    assert_critical_bytes(installed, source, label="installed")

    def test_copy_rejects_destination_file_symlink_before_any_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_fixture(root / "source")
            target = source_fixture(root / "target")
            first = target / ".codex-plugin/plugin.json"
            first.write_bytes(b"unchanged target manifest")
            outside = root / "outside.txt"
            outside.write_bytes(b"private sentinel")
            destination = target / "scripts/job-apply-store.py"
            destination.unlink()
            destination.symlink_to(outside)
            with self.assertRaisesRegex(SystemExit, "contains a symlink"):
                copy_critical(source, target)
            self.assertEqual(outside.read_bytes(), b"private sentinel")
            self.assertEqual(first.read_bytes(), b"unchanged target manifest")
            self.assertTrue(destination.is_symlink())

    def test_copy_rejects_destination_ancestor_and_dangling_symlinks(self):
        for dangling in (False, True):
            with self.subTest(dangling=dangling), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                source = source_fixture(root / "source")
                target = root / "target"
                target.mkdir()
                outside = root / "outside"
                if not dangling:
                    outside.mkdir()
                (target / "scripts").symlink_to(outside, target_is_directory=True)
                with self.assertRaisesRegex(SystemExit, "contains a symlink"):
                    copy_critical(source, target)
                self.assertFalse((target / ".codex-plugin").exists())
                if dangling:
                    self.assertFalse(outside.exists())
                else:
                    self.assertEqual(list(outside.iterdir()), [])

    def test_copy_into_empty_fixture_preserves_exact_receipt(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_fixture(root / "source")
            target = root / "target"
            target.mkdir()
            copy_critical(source, target)
            assert_critical_bytes(target, source, label="copied")
