from __future__ import annotations

import ast
import importlib.util
import inspect
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
FACADE = ROOT / "scripts" / "job-apply-workspace.py"
PACKAGE = ROOT / "scripts" / "job_apply_workspace"
PUBLIC = (
    "LOOPBACK",
    "MAX_BODY_BYTES",
    "MAX_UPLOAD_BYTES",
    "MAX_UPLOAD_BODY_BYTES",
    "MAX_BULK_URLS",
    "ROOT",
    "ASSET_ROOT",
    "ASSETS",
    "STORE_MODULE",
    "loopback_authority",
    "load_store_module",
    "public_resume",
    "public_resumes",
    "public_extraction_request",
    "resume_projection",
    "unified_trash_projection",
    "public_proposal_summary",
    "public_proposal_detail",
    "degraded_boot_status",
    "WorkspaceServer",
    "WorkspaceHandler",
    "build_parser",
    "main",
)


def load_workspace(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise AssertionError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class WorkspaceExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = load_workspace(FACADE, "workspace_extraction_contract")

    def test_compatibility_exports_and_files_are_bounded(self):
        for name in PUBLIC:
            with self.subTest(name=name):
                self.assertTrue(hasattr(self.workspace, name))
        sources = [FACADE, *sorted(PACKAGE.rglob("*.py"))]
        self.assertGreaterEqual(len(sources), 12)
        for path in sources:
            with self.subTest(path=path.relative_to(ROOT)):
                self.assertLessEqual(len(path.read_text(encoding="utf-8").splitlines()), 500)
        self.assertLessEqual(len(inspect.getsource(self.workspace.WorkspaceHandler).splitlines()), 170)

    def test_dependencies_are_directional_and_domains_do_not_cross_import(self):
        for path in sorted(PACKAGE.rglob("*.py")):
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.Import):
                    names = {item.name for item in node.names}
                    self.assertNotIn("job_apply_workspace", names)
                elif isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    self.assertNotIn("job_apply_workspace", module)
                    if "domains" in path.parts:
                        self.assertNotIn(module, {"handler", "cli"})

    def test_two_roots_and_reload_keep_runtime_packages_isolated(self):
        with tempfile.TemporaryDirectory() as temporary:
            roots = []
            for name in ("plugin-a", "plugin-b"):
                root = Path(temporary) / name
                shutil.copytree(
                    ROOT,
                    root,
                    ignore=shutil.ignore_patterns(
                        ".git", ".worktrees", "node_modules", "__pycache__"
                    ),
                )
                roots.append(root)
            modules = [
                load_workspace(
                    root / "scripts" / "job-apply-workspace.py", f"workspace_{index}"
                )
                for index, root in enumerate(roots)
            ]
            self.assertNotEqual(modules[0]._PACKAGE_NAME, modules[1]._PACKAGE_NAME)
            for module, root in zip(modules, roots):
                self.assertTrue(
                    Path(module.STORE_MODULE.__file__).resolve().is_relative_to(
                        root.resolve()
                    )
                )
                package_modules = {
                    name: value
                    for name, value in sys.modules.items()
                    if name == module._PACKAGE_NAME
                    or name.startswith(module._PACKAGE_NAME + ".")
                }
                self.assertGreaterEqual(len(package_modules), 12)
                for value in package_modules.values():
                    self.assertTrue(
                        Path(value.__file__).resolve().is_relative_to(root.resolve())
                    )
            with mock.patch.object(
                modules[0].STORE_MODULE,
                "order_extraction_requests",
                return_value=[],
            ) as a_order, mock.patch.object(
                modules[1].STORE_MODULE,
                "order_extraction_requests",
                return_value=[],
            ) as b_order:
                record = {"id": "resume", "default": False}
                modules[0].resume_projection(record, [], [], [])
                modules[1].resume_projection(record, [], [], [])
            a_order.assert_called_once()
            b_order.assert_called_once()
            b_snapshot = {
                name: value
                for name, value in sys.modules.items()
                if name == modules[1]._PACKAGE_NAME
                or name.startswith(modules[1]._PACKAGE_NAME + ".")
            }
            refreshed = load_workspace(
                roots[0] / "scripts" / "job-apply-workspace.py", "workspace_reload"
            )
            self.assertIsNot(refreshed.WorkspaceHandler, modules[0].WorkspaceHandler)
            for name, value in b_snapshot.items():
                self.assertIs(sys.modules.get(name), value)


if __name__ == "__main__":
    unittest.main()
