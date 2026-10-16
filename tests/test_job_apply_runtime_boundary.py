"""Legacy readers must reject native ownership before touching fictional data."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]


class RuntimeBoundaryTests(unittest.TestCase):
    def test_native_markers_reject_reads_and_init_without_changes(self):
        for marker in (".native-store-clone", ".native-jobs-fixture"):
            for surface, operation in (("store", "init"), ("store", "profile-inspect"),
                                       ("task", "snapshot")):
                with self.subTest(marker=marker, surface=surface, operation=operation):
                    with tempfile.TemporaryDirectory() as directory:
                        root = Path(directory)
                        (root / marker).write_text("invalid marker still owns boundary")
                        # Intentionally unreadable by either schema. Runtime identity
                        # must win over a misleading record-validation diagnostic.
                        (root / "resumes.json").write_text("fictional private sentinel")
                        before = {p.name: p.read_bytes() for p in root.iterdir()}
                        result = subprocess.run(
                            [sys.executable, str(ROOT / "scripts" / f"job-apply-{surface}.py"),
                             "--root", str(root), operation], capture_output=True, text=True,
                        )
                        self.assertEqual(result.returncode, 2)
                        output = result.stdout + result.stderr
                        self.assertIn("native_runtime_required", output)
                        self.assertIn("apps/companion/command.mjs", output)
                        self.assertNotIn("fictional private sentinel", output)
                        self.assertNotIn(str(root), output)
                        if surface == "task":
                            self.assertEqual(json.loads(result.stdout)["error"]["code"],
                                             "native_runtime_required")
                        self.assertEqual(before, {p.name: p.read_bytes() for p in root.iterdir()})

    def test_environment_root_and_dangling_marker_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            try:
                (root / ".native-store-clone").symlink_to(root / "absent")
            except OSError:
                self.skipTest("symlinks unavailable")
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/job-apply-task.py"), "snapshot"],
                env={**os.environ, "JOB_APPLY_STORE_DIR": str(root)},
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 2)
            self.assertIn("native_runtime_required", result.stdout)
            self.assertEqual([p.name for p in root.iterdir()], [".native-store-clone"])

    def test_unmarked_reference_store_still_initializes(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(ROOT / "scripts/job-apply-store.py"),
                 "--root", str(Path(directory) / "store"), "init"],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
