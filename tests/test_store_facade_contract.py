from __future__ import annotations

import ast
import importlib
import inspect
import io
import json
import os
import stat
import sys
import tempfile
import types
import unittest
import uuid
import zipfile
from pathlib import Path
from unittest import mock

from tests.support.store_facade_contract import (
    IMPORTED_SEAMS,
    PRIVATE_MODULE_NAMES,
    PRIVATE_STORE_SIGNATURES,
    PUBLIC_MODULE_NAMES,
    PUBLIC_STORE_SIGNATURES,
    ROOT,
    SCRIPT,
    load_module,
    signatures,
)


PACKAGE_ROOT = ROOT / "scripts" / "job_apply_store"
PACKAGE_FILES = (
    "composition.py",
    "accounts_runtime.py", "cli_parser.py", "cli_dispatch.py",
    "compat_runtime.py", "compat_storage.py", "compat_sessions.py",
    "compat_validation.py", "domains/startup.py",
    "domains/accounts/settings.py", "domains/accounts/registry.py",
    "domains/accounts/operations.py", "domains/accounts/synthetic.py",
    "domains/accounts/email_scope.py", "domains/accounts/email_execution.py",
    "domains/accounts/password_execution.py", "domains/accounts/trusted_fill.py",
    "__init__.py", "constants.py", "errors.py", "io.py", "normalization.py",
    "base.py", "validation/__init__.py", "validation/profile_answers.py",
    "validation/sessions.py", "validation/jobs_resumes.py",
    "validation/extraction.py", "validation/accounts.py", "domains/__init__.py",
    "domains/profile.py", "domains/profile_facts.py",
    "domains/answers/__init__.py", "domains/answers/read.py",
    "domains/answers/mutations.py", "domains/answers/merge.py",
    "domains/answers/cleanup.py", "domains/jobs/__init__.py",
    "domains/jobs/crud.py", "domains/jobs/overview.py",
    "domains/jobs/upsert.py", "domains/jobs/legacy.py",
    "domains/coordinator/__init__.py", "domains/coordinator/persistence.py",
    "domains/resumes/storage.py",
    "domains/resumes/read.py",
    "domains/resumes/mutations.py",
    "domains/resumes/lifecycle.py",
    "domains/extractions/journal.py",
    "domains/extractions/requests.py",
    "domains/extractions/proposals.py",
    "sessions_runtime.py", "domains/sessions/__init__.py",
    "domains/sessions/history.py",
    "domains/sessions/readiness.py",
    "domains/sessions/document.py",
    "domains/sessions/lifecycle.py",
    "domains/resumes/__init__.py", "domains/extractions/__init__.py",
    "domains/coordinator/claims.py", "domains/coordinator/attention.py",
    "domains/coordinator/progress.py", "domains/coordinator/approvals.py",
)


class StoreFacadeContractTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module(name="store_facade_contract")

    def test_required_module_surface_is_preserved_without_freezing_dir(self):
        required = PUBLIC_MODULE_NAMES | PRIVATE_MODULE_NAMES | IMPORTED_SEAMS
        self.assertEqual(len(PUBLIC_MODULE_NAMES), 83)
        self.assertTrue(required <= set(vars(self.module)))
        self.assertEqual(self.module.StoreError.__module__, "store_facade_contract")
        self.assertEqual(self.module.TrustedFillCurrentError.__module__, "store_facade_contract")

    def test_store_class_metadata_and_all_supported_signatures_are_frozen(self):
        store = self.module.Store
        self.assertEqual(store.__name__, "Store")
        self.assertEqual(store.__qualname__, "Store")
        self.assertEqual(store.__module__, "store_facade_contract")
        self.assertIsNone(store.__doc__)
        self.assertEqual(
            str(inspect.signature(store.__init__)),
            "(self, root: 'Path', legacy_profile: 'Path | None' = None, clock=None)",
        )
        self.assertEqual(signatures(store, PUBLIC_STORE_SIGNATURES), PUBLIC_STORE_SIGNATURES)
        self.assertEqual(signatures(store, PRIVATE_STORE_SIGNATURES), PRIVATE_STORE_SIGNATURES)
        with tempfile.TemporaryDirectory() as temporary:
            instance = store(Path(temporary) / "store")
            self.assertEqual(instance._overview_resume_digest_cache, {})

    def test_extracted_exports_preserve_shared_identities(self):
        mutable_constants = {
            name for name in PUBLIC_MODULE_NAMES
            if isinstance(getattr(self.module, name, None), (dict, list, set))
        }
        self.assertIs(self.module.StoreError, self.module._errors.StoreError)
        self.assertIs(
            self.module.TrustedFillCurrentError,
            self.module._errors.TrustedFillCurrentError,
        )
        for name in mutable_constants | {"EMAIL_PATTERN"}:
            with self.subTest(name=name):
                self.assertIs(getattr(self.module, name), getattr(self.module._constants, name))
        companion_names = [name for name in PUBLIC_MODULE_NAMES if name.endswith("_MODULE")]
        for name in companion_names:
            with self.subTest(name=name):
                companion = getattr(self.module, name)
                self.assertEqual(Path(companion.__file__).resolve().parent, SCRIPT.parent.resolve())

    def test_canonical_common_package_is_usable_without_importing_facade(self):
        saved_path = list(sys.path)
        saved = {
            name: value for name, value in sys.modules.items()
            if name == "job_apply_store" or name.startswith("job_apply_store.")
        }
        try:
            sys.path.insert(0, str((ROOT / "scripts").resolve()))
            for name in tuple(sys.modules):
                if name == "job_apply_store" or name.startswith("job_apply_store."):
                    del sys.modules[name]
            package = importlib.import_module("job_apply_store")
            self.assertEqual(package.normalize_question("  Work—AUTH? "), "work auth")
            self.assertIs(package.StoreError, package.errors.StoreError)
            self.assertEqual(package.domains.__name__, "job_apply_store.domains")
            self.assertNotIn("Store", vars(package))
        finally:
            for name in tuple(sys.modules):
                if name == "job_apply_store" or name.startswith("job_apply_store."):
                    del sys.modules[name]
            sys.modules.update(saved)
            sys.path[:] = saved_path

    def test_dependency_direction_size_and_acyclicity(self):
        paths = [PACKAGE_ROOT / relative for relative in PACKAGE_FILES]
        self.assertTrue(all(path.is_file() for path in paths))
        for path in paths:
            with self.subTest(path=path.name):
                self.assertLessEqual(len(path.read_bytes().splitlines()), 500)
                source = path.read_text(encoding="utf-8")
                if path.name == "sessions_runtime.py":
                    # A path anchor locates companions; it does not import the facade.
                    anchor = 'SCRIPT_PATH = Path(__file__).resolve().parent.parent / "job-apply-store.py"'
                    self.assertEqual(source.count(anchor), 1)
                    source = source.replace(anchor, "")
                self.assertNotIn("job-apply-store", source)
        self.assertLessEqual(len((PACKAGE_ROOT / "base.py").read_bytes().splitlines()), 120)

        allowed_base_relatives = {"constants", "errors"}
        base_tree = ast.parse((PACKAGE_ROOT / "base.py").read_text(encoding="utf-8"))
        for node in ast.walk(base_tree):
            if isinstance(node, ast.ImportFrom) and node.level:
                self.assertIn(node.module, allowed_base_relatives)
        for relative in PACKAGE_FILES:
            if not relative.startswith("validation/") or relative.endswith("__init__.py"):
                continue
            tree = ast.parse((PACKAGE_ROOT / relative).read_text(encoding="utf-8"))
            imports = {
                node.module for node in ast.walk(tree)
                if isinstance(node, ast.ImportFrom) and node.module
            }
            self.assertFalse({"base", "facade"} & imports)
            self.assertFalse(any("domain" in name for name in imports))

        modules = {Path(relative).with_suffix("").as_posix().replace("/", ".") for relative in PACKAGE_FILES}
        edges = {name: set() for name in modules}
        for relative in PACKAGE_FILES:
            source = Path(relative).with_suffix("").as_posix().replace("/", ".")
            tree = ast.parse((PACKAGE_ROOT / relative).read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if not isinstance(node, ast.ImportFrom) or not node.level:
                    continue
                prefix = source.split(".")[:-node.level]
                target = ".".join([*prefix, *(node.module or "").split(".")]).strip(".")
                if target in modules:
                    edges[source].add(target)
        visiting = set()
        visited = set()
        def visit(name):
            self.assertNotIn(name, visiting, f"dependency cycle through {name}")
            if name in visited:
                return
            visiting.add(name)
            for target in edges[name]:
                visit(target)
            visiting.remove(name)
            visited.add(name)
        for name in edges:
            visit(name)

    def test_atomic_io_bytes_permissions_and_failure_cleanup_are_unchanged(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "private" / "document.json"
            self.module.atomic_write_json(path, {"z": 1, "emoji": "λ"})
            self.assertEqual(
                path.read_bytes(),
                b'{\n  "emoji": "\xce\xbb",\n  "z": 1\n}\n'.replace(b"\n", os.linesep.encode("ascii")),
            )
            if os.name != "nt":
                self.assertEqual(stat.S_IMODE(path.parent.stat().st_mode), 0o700)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            original = path.read_bytes()
            with mock.patch.object(self.module.os, "replace", side_effect=OSError("stop")):
                with self.assertRaises(OSError):
                    self.module.atomic_write_json(path, {"replacement": True})
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(list(path.parent.glob(".*.tmp")), [])

    def test_normalization_pointer_and_validation_contracts_are_unchanged(self):
        self.assertEqual(self.module.normalize_question("  Work—AUTH? "), "work auth")
        self.assertEqual(self.module.normalize_job_url("HTTPS://Example.COM:443/jobs/1#apply"), "https://example.com/jobs/1")
        self.assertEqual(self.module._pointer_lookup({"a/b": {"~": 3}}, "/a~1b/~0"), (True, 3))
        baseline = self.module._pointer_baseline({"a": 7}, "/a/b")
        self.assertEqual(self.module._replacement_scope(baseline), {"path": "/a", "value": 7})
        with self.assertRaisesRegex(self.module.StoreError, "future schemaVersion 2"):
            self.module.validate_version({"schemaVersion": 2}, "profile")
        with self.assertRaisesRegex(self.module.StoreError, "answer record key"):
            self.module._validate_answer_record("expected", {"key": "other"})
        records = [
            {"requestId": "child", "resumeId": "r", "createdAt": "2026", "supersedesRequestId": "parent"},
            {"requestId": "parent", "resumeId": "r", "createdAt": "2026", "supersedesRequestId": None},
        ]
        self.assertEqual([item["requestId"] for item in self.module.order_extraction_requests(records)], ["parent", "child"])

    def test_late_facade_patch_seams_remain_live_after_store_construction(self):
        with tempfile.TemporaryDirectory() as temporary:
            store = self.module.Store(Path(temporary) / "store")
            fixed_now = "2026-09-04T12:00:00Z"
            original_write = self.module.atomic_write_json
            write_spy = mock.Mock(wraps=original_write)
            with mock.patch.object(self.module, "utc_now", return_value=fixed_now), mock.patch.object(self.module, "atomic_write_json", write_spy):
                store.initialize()
            self.assertGreater(write_spy.call_count, 0)
            profile = json.loads(store.profile_path.read_text(encoding="utf-8"))
            self.assertEqual(profile["metadata"]["createdAt"], fixed_now)

            managed = store.resume_files_path / "late.txt"
            managed.write_text("resume", encoding="utf-8")
            record = {"id": "late", "storageKind": "managed", "managedFile": managed.name}
            identity_spy = mock.Mock(return_value=None)
            with mock.patch.object(self.module, "_managed_resume_digest_cache_identity", identity_spy):
                self.assertTrue(store._managed_resume_observation(record)["exists"])
            self.assertEqual(identity_spy.call_count, 2)

            path_factory = mock.Mock(return_value="late-path")
            with mock.patch.object(self.module, "Path", path_factory):
                self.assertEqual(store._resume_path({"storageKind": "external", "path": "/late"}), "late-path")
            with mock.patch.object(self.module.os, "open", wraps=os.open) as open_spy:
                self.assertIsNotNone(store._private_file_digest(managed))
            self.assertTrue(open_spy.called)
            with mock.patch.object(self.module.secrets, "token_urlsafe", return_value="late-secret"):
                self.assertEqual(store._new_resume_content_revision(), "content_late-secret")
            expected_capability = store.automation_capability("win32")
            with mock.patch.object(self.module, "sys", types.SimpleNamespace(platform="win32")):
                self.assertEqual(store.automation_capability(), expected_capability)
            fixed_uuid = uuid.UUID("00000000-0000-4000-8000-000000000007")
            with mock.patch.object(self.module.uuid, "uuid4", return_value=fixed_uuid):
                request = store._new_extraction_request({"id": "r", "contentRevision": "content_x"})
            self.assertEqual(request["requestId"], f"request-{fixed_uuid}")

            archive = Path(temporary) / "resume.docx"
            with zipfile.ZipFile(archive, "w") as target:
                target.writestr("[Content_Types].xml", "types")
                target.writestr("word/document.xml", "document")
            with mock.patch.object(self.module.zipfile, "ZipFile", wraps=zipfile.ZipFile) as zip_spy:
                self.module._validate_resume_bytes(archive, ".docx")
            self.assertTrue(zip_spy.called)

            with mock.patch.object(self.module, "sys", types.SimpleNamespace(stdin=io.StringIO('{"ok":true}'))):
                self.assertEqual(self.module._read_input("-"), {"ok": True})


if __name__ == "__main__":
    unittest.main()
