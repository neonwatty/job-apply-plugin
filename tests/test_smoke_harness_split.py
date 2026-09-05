import importlib.util
import shutil
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SMOKE = ROOT / "scripts" / "smoke"
sys.path.insert(0, str(SMOKE))
from artifacts import (  # noqa: E402
    CRITICAL_TREES,
    FIXED_CRITICAL_FILES,
    assert_critical_bytes,
    copy_critical,
    critical_paths,
)


def source_fixture(root: Path) -> Path:
    for relative in FIXED_CRITICAL_FILES:
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(f"fixed:{relative}\n".encode())
    for relative in CRITICAL_TREES:
        nested = root / relative / "nested" / "module.test"
        nested.parent.mkdir(parents=True, exist_ok=True)
        nested.write_bytes(f"tree:{relative}\n".encode())
    return root


class SmokeHarnessSplitTests(unittest.TestCase):
    def test_critical_receipt_is_recursive_and_byte_exact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_fixture(root / "source")
            target = root / "target"
            shutil.copytree(source, target)
            inventory = critical_paths(source)
            for tree in CRITICAL_TREES:
                self.assertIn(f"{tree}/nested/module.test", inventory)
            self.assertEqual(tuple(sorted(inventory)), inventory)
            assert_critical_bytes(target, source, label="installed Codex")
            changed = target / "scripts/job_apply_workspace/nested/module.test"
            changed.write_bytes(b"changed\n")
            with self.assertRaisesRegex(
                SystemExit,
                "installed Codex bytes differ for scripts/job_apply_workspace",
            ):
                assert_critical_bytes(target, source, label="installed Codex")
            changed.write_bytes((source / changed.relative_to(target)).read_bytes())
            extra = target / "workspace/nested/unexpected.js"
            extra.write_bytes(b"unexpected\n")
            with self.assertRaisesRegex(SystemExit, "critical package inventory differs"):
                assert_critical_bytes(target, source, label="installed Codex")

    def test_copy_critical_replaces_every_recursive_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = source_fixture(root / "source")
            target = source_fixture(root / "target")
            for relative in critical_paths(target):
                (target / relative).write_bytes(b"old\n")
            copy_critical(source, target)
            assert_critical_bytes(target, source, label="upgraded Codex")

    def test_critical_receipt_rejects_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            source = source_fixture(Path(directory) / "source")
            linked = source / "workspace/nested/linked.js"
            linked.symlink_to(source / "workspace/nested/module.test")
            with self.assertRaisesRegex(SystemExit, "contains a symlink"):
                critical_paths(source)

    def test_shell_is_thin_and_invokes_each_domain(self):
        shell = (ROOT / "scripts/smoke-plugin.sh").read_text(encoding="utf-8")
        self.assertNotIn("<<'PY'", shell)
        self.assertEqual(shell.count("mktemp -d"), 1)
        self.assertEqual(shell.count("trap cleanup EXIT"), 1)
        for module in (
            "store_lifecycle.py",
            "repository_contracts.py",
            "fixture_build.py",
            "upgrade_verify.py",
            "workspace_verify.py",
            "plugin_install_verify.py",
        ):
            self.assertIn(f'scripts/smoke/{module}"', shell)
        for path in SMOKE.glob("*.py"):
            self.assertLessEqual(len(path.read_text(encoding="utf-8").splitlines()), 500)

    def test_domain_modules_are_importable_without_running_smoke(self):
        for path in SMOKE.glob("*.py"):
            spec = importlib.util.spec_from_file_location(f"smoke_test_{path.stem}", path)
            module = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(module)

    def test_preserved_smoke_success_receipts_are_present(self):
        text = "\n".join(path.read_text(encoding="utf-8") for path in SMOKE.glob("*.py"))
        for receipt in (
            "Static smoke assertions passed",
            "Packaged fixture exclusions passed",
            "Isolated prior Codex package installed",
            "Isolated Codex old-to-new replacement and critical-byte parity passed",
            "Packaged Jobs, Facts, managed resume, extraction, Answers merge recovery, unified Trash API, and store launch passed",
            "Isolated Claude Code marketplace install passed",
            "Isolated Codex marketplace install and critical-byte parity passed",
        ):
            self.assertIn(receipt, text)


if __name__ == "__main__":
    unittest.main()
