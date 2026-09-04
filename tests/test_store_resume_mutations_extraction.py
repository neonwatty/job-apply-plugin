from __future__ import annotations

import importlib
import inspect
import json
import shutil
import sys
import tempfile
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, nullcontext
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_domain_import_direction,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
    source_inventory,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_ROOT = ROOT / "scripts" / "job_apply_store" / "domains"
METHODS = (
    "create_resume",
    "import_resume",
    "create_resume_bytes",
    "update_resume_bytes",
    "adopt_resume_bytes",
    "update_resume",
    "adopt_resume",
    "set_default_resume",
)


class ResumeMutationExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="resume_mutation_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.resumes.mutations"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.ResumeMutationMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        parent = Path(self.temporary.name)
        self.inputs = parent / "inputs"
        self.inputs.mkdir()
        source = parent / "source"
        self.facade.Store(source, parent / "legacy.json").initialize()
        self.original = self.facade.Store(
            clone_store_root(source, parent / "original"), parent / "legacy.json"
        )
        self.extracted = self.composed(
            clone_store_root(source, parent / "extracted"), parent / "legacy.json"
        )

    def call_both(self, operation):
        values = [operation(store) for store in (self.original, self.extracted)]
        self.assertEqual(values[0], values[1])
        assert_store_trees_equal(self, self.original.root, self.extracted.root)
        return values[0]

    def assert_same_error(self, operation):
        before = [snapshot_tree(store.root) for store in (self.original, self.extracted)]
        messages = []
        for store in (self.original, self.extracted):
            with self.assertRaises(self.facade.StoreError) as raised:
                operation(store)
            messages.append(str(raised.exception))
        self.assertEqual(messages[0], messages[1])
        self.assertEqual(
            before,
            [snapshot_tree(store.root) for store in (self.original, self.extracted)],
        )
        return messages[0]

    def source(self, name: str, content: str) -> Path:
        path = self.inputs / name
        path.write_text(content, encoding="utf-8")
        return path

    def create(self, resume_id: str, name: str, content: str):
        path = self.source(name, content)
        return self.call_both(
            lambda store: store.create_resume(
                {"id": resume_id, "label": f" {resume_id} ", "path": str(path)}
            )
        )

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["resumes.mutations"],
            {"ResumeMutationMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_leaves_are_root_local_across_two_roots_and_reload(self):
        with tempfile.TemporaryDirectory() as temporary:
            copied = []
            for name in ("plugin-a", "plugin-b"):
                root = Path(temporary) / name
                shutil.copytree(
                    ROOT,
                    root,
                    ignore=shutil.ignore_patterns(
                        ".git", ".worktrees", "node_modules", "__pycache__"
                    ),
                )
                copied.append(root)
            loaded = [
                load_module(root / "scripts" / "job-apply-store.py", f"resume_{index}")
                for index, root in enumerate(copied)
            ]
            pairs = []
            stores = []
            for index, (module, root) in enumerate(zip(loaded, copied)):
                mutation = importlib.import_module(
                    f"{module._PACKAGE_NAME}.domains.resumes.mutations"
                )
                lifecycle = importlib.import_module(
                    f"{module._PACKAGE_NAME}.domains.resumes.lifecycle"
                )
                for leaf in (mutation, lifecycle):
                    self.assertTrue(
                        Path(leaf.__file__).resolve().is_relative_to(root.resolve())
                    )
                create_at = f"2026-09-04T23:00:0{index}Z"
                lifecycle_at = f"2026-09-04T23:01:0{index}Z"
                mutation_runtime = {
                    **vars(module),
                    "utc_now": lambda value=create_at: value,
                }
                lifecycle_runtime = {
                    **vars(module),
                    "utc_now": lambda value=lifecycle_at: value,
                }
                mutation._bind_runtime(lambda value=mutation_runtime: value)
                lifecycle._bind_runtime(lambda value=lifecycle_runtime: value)
                composed = composed_store_class(
                    module.Store,
                    mutation.ResumeMutationMixin,
                    lifecycle.ResumeLifecycleMixin,
                )
                source = root / f"resume-{index}.txt"
                source.write_text(f"root {index} resume", encoding="utf-8")
                with mock.patch.object(
                    module.secrets, "token_urlsafe", return_value="a" * 43
                ):
                    store = composed(root / "store")
                    created = store.create_resume(
                        {
                            "id": f"root-{index}",
                            "label": f"Root {index}",
                            "path": str(source),
                        }
                    )
                    trashed = store.trash_resume(
                        created["id"], created["revision"]
                    )
                self.assertEqual(created["createdAt"], create_at)
                self.assertEqual(trashed["deletedAt"], lifecycle_at)
                pairs.append((mutation, lifecycle))
                stores.append((store, trashed))
            self.assertIsNot(pairs[0][0], pairs[1][0])
            b_provider = pairs[1][1]._RUNTIME_PROVIDER
            b_module = sys.modules[pairs[1][1].__name__]
            reloaded = load_module(
                copied[0] / "scripts" / "job-apply-store.py", "resume_reload"
            )
            fresh = importlib.import_module(
                f"{reloaded._PACKAGE_NAME}.domains.resumes.mutations"
            )
            self.assertIsNot(fresh, pairs[0][0])
            fresh_lifecycle = importlib.import_module(
                f"{reloaded._PACKAGE_NAME}.domains.resumes.lifecycle"
            )
            self.assertIsNot(fresh_lifecycle, pairs[0][1])
            fresh._bind_runtime(
                lambda: {**vars(reloaded), "utc_now": lambda: "2026-09-05T01:00:00Z"}
            )
            fresh_lifecycle._bind_runtime(
                lambda: {**vars(reloaded), "utc_now": lambda: "2026-09-05T02:00:00Z"}
            )
            fresh_store = composed_store_class(
                reloaded.Store,
                fresh.ResumeMutationMixin,
                fresh_lifecycle.ResumeLifecycleMixin,
            )(copied[0] / "reloaded-store")
            fresh_created = fresh_store.create_resume(
                {"id": "reload", "label": "Reload", "path": str(copied[0] / "resume-0.txt")}
            )
            fresh_trashed = fresh_store.trash_resume(
                fresh_created["id"], fresh_created["revision"]
            )
            self.assertEqual(fresh_created["createdAt"], "2026-09-05T01:00:00Z")
            self.assertEqual(fresh_trashed["deletedAt"], "2026-09-05T02:00:00Z")
            self.assertIs(sys.modules[pairs[1][1].__name__], b_module)
            self.assertIs(pairs[1][1]._RUNTIME_PROVIDER, b_provider)
            b_store, b_trashed = stores[1]
            restored = b_store.restore_resume(
                b_trashed["id"], b_trashed["revision"]
            )
            self.assertEqual(restored["updatedAt"], "2026-09-04T23:01:01Z")

    def test_unbound_mutation_runtime_uses_shared_canonical_validator(self):
        source = self.source("canonical.txt", "canonical resume")
        with mock.patch.object(
            self.facade.secrets, "token_urlsafe", return_value="a" * 43
        ):
            created = self.extracted.create_resume(
                {"id": "canonical", "label": "Canonical", "path": str(source)}
            )
            self.leaf._bind_runtime(lambda: {})
            try:
                updated = self.extracted.update_resume(
                    created["id"], {"label": "Unbound"}, created["revision"]
                )
            finally:
                self.leaf._bind_runtime(lambda: vars(self.facade))
        self.assertEqual(updated["label"], "Unbound")

    def test_create_update_bytes_and_default_are_byte_equivalent(self):
        with (
            mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T18:00:00Z"),
            mock.patch.object(
                self.facade.secrets, "token_urlsafe", return_value="a" * 43
            ),
        ):
            first = self.create("resume-one", "one.txt", "first resume")
            upload = self.source("browser-two.txt", "second resume")
            second = self.call_both(
                lambda store: self._with_temporary_source(
                    store,
                    upload,
                    lambda: store.create_resume_bytes(
                        {"id": "resume-two", "label": "Second", "default": False},
                        "two.txt",
                        b"second resume",
                    ),
                )
            )
            metadata = self.call_both(
                lambda store: store.update_resume(
                    first["id"], {"label": " Revised ", "tags": [" main "]},
                    first["revision"],
                )
            )
            replacement_upload = self.source("browser-one.txt", "replacement")
            replaced = self.call_both(
                lambda store: self._with_temporary_source(
                    store,
                    replacement_upload,
                    lambda: store.update_resume_bytes(
                        metadata["id"],
                        "one.txt",
                        b"replacement",
                        metadata["revision"],
                    ),
                )
            )
            selected = self.call_both(
                lambda store: store.set_default_resume(
                    second["id"], second["revision"]
                )
            )
        self.assertEqual(metadata["label"], "Revised")
        self.assertEqual(metadata["tags"], ["main"])
        self.assertNotEqual(replaced["digest"], first["digest"])
        self.assertTrue(selected["default"])

    def test_import_adopt_and_guards_match_without_exposing_content(self):
        with (
            mock.patch.object(self.facade, "utc_now", return_value="2026-09-04T19:00:00Z"),
            mock.patch.object(
                self.facade.secrets, "token_urlsafe", return_value="a" * 43
            ),
        ):
            path = self.source("import.txt", "PRIVATE-RESUME-VALUE")
            imported = self.call_both(
                lambda store: store.import_resume(
                    {"id": "imported", "label": "Imported", "path": str(path)}
                )
            )
            self.assertNotIn("PRIVATE-RESUME-VALUE", repr(imported))
            duplicate = self.source("duplicate.txt", "PRIVATE-RESUME-VALUE")
            self.assertIn(
                "already managed",
                self.assert_same_error(
                    lambda store: store.create_resume(
                        {"id": "duplicate", "label": "Duplicate", "path": str(duplicate)}
                    )
                ),
            )
            self.assertIn(
                "revision conflict",
                self.assert_same_error(
                    lambda store: store.update_resume("imported", {"label": "No"}, 99)
                ),
            )
            legacy = self.source("legacy.txt", "legacy resume")
            for store in (self.original, self.extracted):
                document = json.loads(store.resumes_path.read_text(encoding="utf-8"))
                document["resumes"]["legacy"] = {
                    "id": "legacy", "label": "Legacy", "path": str(legacy),
                    "tags": [], "default": False, "observedSize": legacy.stat().st_size,
                    "observedModifiedAt": self.facade.observe_resume_file(str(legacy))["modifiedAt"],
                    "revision": 4, "createdAt": "2026-09-04T19:00:00Z",
                    "updatedAt": "2026-09-04T19:00:00Z", "deletedAt": None,
                }
                self.facade.atomic_write_json(store.resumes_path, document)
            adopted = self.call_both(
                lambda store: self._with_temporary_source(
                    store,
                    legacy,
                    lambda: store.adopt_resume_bytes(
                        "legacy", "legacy.txt", b"adopted bytes", 4
                    ),
                )
            )
        self.assertEqual(adopted["revision"], 5)
        self.assertNotIn("path", adopted)

    @staticmethod
    def _with_temporary_source(store, source, operation):
        with mock.patch.object(
            store, "_temporary_resume_source", return_value=nullcontext(source)
        ):
            return operation()

    def test_same_revision_race_has_one_winner(self):
        path = self.source("race.txt", "race resume")
        resume = self.extracted.create_resume(
            {"id": "race", "label": "Race", "path": str(path)}
        )

        def update(label):
            try:
                return self.extracted.update_resume(
                    "race", {"label": label}, resume["revision"]
                )
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(update, ("first", "second")))
        self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
        self.assertEqual(outcomes.count("resume revision conflict"), 1)

    def test_content_update_stales_open_request_in_one_journaled_operation(self):
        with (
            mock.patch.object(
                self.facade.secrets, "token_urlsafe", return_value="a" * 43
            ),
            mock.patch.object(
                self.facade.uuid,
                "uuid4",
                return_value=uuid.UUID("00000000-0000-4000-8000-000000000002"),
            ),
            mock.patch.object(
                self.facade, "utc_now", return_value="2026-09-04T22:00:00Z"
            ),
        ):
            resume = self.create("requested", "requested.txt", "request source")
            requests = [
                store.create_resume_extraction_request(
                    resume["id"], resume["revision"]
                )
                for store in (self.original, self.extracted)
            ]
            self.assertEqual(requests[0], requests[1])
            replacement = self.source("requested-new.txt", "new request source")
            spies = []
            with ExitStack() as stack:
                for store in (self.original, self.extracted):
                    spies.append(
                        stack.enter_context(
                            mock.patch.object(
                                store,
                                "_commit_extraction_operation_locked",
                                wraps=store._commit_extraction_operation_locked,
                            )
                        )
                    )
                updated = self.call_both(
                    lambda store: store.update_resume(
                        resume["id"],
                        {"path": str(replacement)},
                        resume["revision"],
                    )
                )
        self.assertEqual(updated["revision"], resume["revision"] + 1)
        for spy in spies:
            self.assertEqual(spy.call_count, 1)
            arguments = spy.call_args.args
            self.assertEqual(arguments[:3], ("resume-request-close", None, None))
            self.assertEqual(
                next(iter(arguments[3]["requests"].values()))["status"], "stale"
            )
            self.assertEqual(arguments[4]["resumes"][resume["id"]], updated)
        for store in (self.original, self.extracted):
            request = store.get_resume_extraction_request(requests[0]["requestId"])
            self.assertEqual(request["status"], "stale")
            self.assertIsNone(store._load_extraction_journal()["operation"])

    def test_atomic_metadata_failure_rolls_back_replacement_exactly(self):
        path = self.source("stable.txt", "stable bytes")
        resume = self.extracted.create_resume(
            {"id": "stable", "label": "Stable", "path": str(path)}
        )
        replacement = self.source("replacement.txt", "replacement bytes")
        before = snapshot_tree(self.extracted.root)
        with mock.patch.object(
            self.facade, "atomic_write_json", side_effect=OSError("synthetic")
        ):
            with self.assertRaisesRegex(OSError, "synthetic"):
                self.extracted.update_resume(
                    resume["id"], {"path": str(replacement)}, resume["revision"]
                )
        self.assertEqual(snapshot_tree(self.extracted.root), before)


if __name__ == "__main__":
    unittest.main()
