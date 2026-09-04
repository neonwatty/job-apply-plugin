import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


CHECKER = Path(__file__).resolve().parents[1] / "scripts" / "check-source-size.py"


class SourceSizePolicyTests(unittest.TestCase):
    """A wrong line counter or ratchet check makes a test below fail."""

    def setUp(self):
        self.tempdir = tempfile.TemporaryDirectory()
        self.root = Path(self.tempdir.name)
        self.git("init", "--initial-branch=main")
        self.git("config", "user.email", "policy@example.test")
        self.git("config", "user.name", "Source size policy")
        self.write_source("seed.py", "pass\n")
        self.commit_base()

    def tearDown(self):
        self.tempdir.cleanup()

    def git(self, *args):
        return subprocess.run(
            ["git", *args], cwd=self.root, check=True, text=True,
            capture_output=True,
        )

    def write_source(self, path, contents):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents, encoding="utf-8")

    def write_baseline(self, files):
        self.write_source(
            ".source-size-baseline.json",
            json.dumps({"version": 1, "maximumLines": 500, "files": files}),
        )

    def entry(self, ceiling):
        return {
            "ceiling": ceiling,
            "owner": "modernization",
            "reason": "existing oversized file",
            "removalPhase": "decomposition",
        }

    def commit_base(self):
        self.git("add", "-A")
        self.git("commit", "-m", "baseline")

    def run_check(self):
        return subprocess.run(
            [sys.executable, str(CHECKER), "--base", "HEAD"],
            cwd=self.root, text=True, capture_output=True,
        )

    def test_exactly_500_physical_lines_is_allowed(self):
        self.write_source("exact.py", "pass\n" * 500)

        result = self.run_check()

        self.assertEqual(result.returncode, 0, result.stderr)

    def test_new_file_above_limit_fails(self):
        self.write_source("new.py", "pass\n" * 501)

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("new.py: 501 > 500", result.stderr)

    def test_new_shell_launcher_above_limit_fails(self):
        self.write_source("scripts/new-launcher.sh", "echo safe\n" * 501)

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("scripts/new-launcher.sh: 501 > 500", result.stderr)

    def test_unterminated_final_nonempty_line_counts_as_physical_line(self):
        self.write_source("unterminated.py", "pass\n" * 500 + "pass")

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("unterminated.py: 501 > 500", result.stderr)

    def test_baseline_ceiling_cannot_grow(self):
        self.write_source("legacy.py", "pass\n" * 501)
        self.write_baseline({"legacy.py": self.entry(501)})
        self.commit_base()
        self.write_source("legacy.py", "pass\n" * 502)
        self.write_baseline({"legacy.py": self.entry(502)})

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.py: ceiling increased from 501 to 502", result.stderr)

    def test_shrinking_legacy_file_requires_ceiling_reduction(self):
        self.write_source("legacy.py", "pass\n" * 502)
        self.write_baseline({"legacy.py": self.entry(502)})
        self.commit_base()
        self.write_source("legacy.py", "pass\n" * 501)

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.py: 501 < recorded ceiling 502", result.stderr)

    def test_legacy_file_at_limit_requires_removing_its_baseline_entry(self):
        self.write_source("legacy.py", "pass\n" * 501)
        self.write_baseline({"legacy.py": self.entry(501)})
        self.commit_base()
        self.write_source("legacy.py", "pass\n" * 500)

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.py: 500 <= 500 must be removed from baseline", result.stderr)

    def test_deleted_legacy_file_requires_removing_its_baseline_entry(self):
        self.write_source("legacy.py", "pass\n" * 501)
        self.write_baseline({"legacy.py": self.entry(501)})
        self.commit_base()
        (self.root / "legacy.py").unlink()

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.py: obsolete baseline entry", result.stderr)

    def test_renamed_legacy_file_requires_removing_its_obsolete_entry(self):
        self.write_source("legacy.py", "pass\n" * 501)
        self.write_baseline({"legacy.py": self.entry(501)})
        self.commit_base()
        (self.root / "legacy.py").rename(self.root / "renamed.py")

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.py: obsolete baseline entry", result.stderr)

    def test_baseline_rejects_unmapped_extension(self):
        self.write_source("legacy.rb", "pass\n" * 501)
        self.write_baseline({"legacy.rb": self.entry(501)})

        result = self.run_check()

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("legacy.rb: unsupported source extension", result.stderr)


if __name__ == "__main__":
    unittest.main()
