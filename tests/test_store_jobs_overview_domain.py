from __future__ import annotations

import ast
import importlib
import inspect
import json
import tempfile
import unittest
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/jobs/overview.py"
METHODS = {
    "_task_job_projection", "task_snapshot", "intake_task_job",
    "select_task_job_ready", "owner_beta_overview", "_owner_beta_overview_locked",
    "_preflight_job_record", "preflight_job",
}
FIXED = datetime(2026, 9, 4, 18, 0, tzinfo=timezone.utc)


class JobOverviewDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_jobs_overview_domain_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.jobs.overview"
        )
        cls.mixin = cls.leaf.JobOverviewMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def stores(self, prepare=None):
        original = self.facade.Store(
            self.home / "original", self.home / "legacy", clock=lambda: FIXED
        )
        original.initialize()
        if prepare is not None:
            prepare(original)
        original._ensure_coordinator_files()
        clone_store_root(original.root, self.home / "extracted")
        extracted = self.composed(
            self.home / "extracted", self.home / "other", clock=lambda: FIXED
        )
        return original, extracted

    def both(self, stores, operation, *, compare_tree=True):
        results = [operation(store) for store in stores]
        self.assertEqual(results[0], results[1])
        if compare_tree:
            assert_store_trees_equal(self, stores[0].root, stores[1].root)
        return results[0]

    def both_error(self, stores, operation):
        before = [snapshot_tree(store.root) for store in stores]
        errors = []
        for store in stores:
            with self.assertRaises(self.facade.StoreError) as raised:
                operation(store)
            errors.append(str(raised.exception))
        self.assertEqual(errors[0], errors[1])
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])
        return errors[0]

    def add_external_resume(self, store, resume_id, path, *, default):
        observation = self.facade.observe_resume_file(str(path))
        document = store._load_resumes_document()
        now = "2026-09-04T18:00:00Z"
        document["resumes"][resume_id] = {
            "id": resume_id, "label": resume_id, "path": str(path), "tags": [],
            "default": default, "observedSize": observation["size"],
            "observedModifiedAt": observation["modifiedAt"], "revision": 1,
            "createdAt": now, "updatedAt": now, "deletedAt": None,
        }
        document["metadata"]["updatedAt"] = now
        self.facade.atomic_write_json(store.resumes_path, document)

    def test_exact_plain_leaf_contract_and_direction(self):
        owned = {
            name for name, value in vars(self.mixin).items()
            if inspect.isfunction(value) or isinstance(value, staticmethod)
        }
        self.assertEqual(owned, METHODS)
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        self.assertLessEqual(len(DOMAIN_PATH.read_bytes().splitlines()), 500)
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        tree = ast.parse(source)
        self.assertNotIn("__init__", owned)
        self.assertFalse(any(
            isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.func.id == "super" for node in ast.walk(tree)
        ))

    def test_task_snapshot_is_coherent_exact_and_redacted(self):
        private_url = "https://private.invalid/job?secret=yes"
        def prepare(store):
            store.create_job({
                "id": "private-job", "url": private_url, "role": "Engineer",
                "notes": "owner secret", "provenance": {"private": "secret"},
            })
            store.put_answer({
                "key": "private-answer", "question": "Private?", "state": "sensitive",
                "value": "secret answer",
            }, remember_sensitive=True)
        stores = self.stores(prepare)
        before = [snapshot_tree(store.root) for store in stores]
        snapshot = self.both(stores, lambda store: store.task_snapshot())
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])
        serialized = json.dumps(snapshot)
        for private in (private_url, "owner secret", "secret answer", "provenance"):
            self.assertNotIn(private, serialized)
        projected = snapshot["jobs"][0]
        self.assertEqual(projected["id"], "private-job")
        signature_input = {
            "overview": snapshot["overview"], "jobs": snapshot["jobs"],
            "attentionSignature": snapshot["attention"]["snapshotSignature"],
        }
        expected = self.facade.hashlib.sha256(
            self.facade._canonical_json(signature_input).encode("utf-8")
        ).hexdigest()
        self.assertEqual(snapshot["snapshotSignature"], expected)

    def test_intake_create_noop_conflict_and_late_write_are_exact(self):
        stores = self.stores()
        fixed_uuid = uuid.UUID("00000000-0000-4000-8000-000000000008")
        write = mock.Mock(wraps=self.facade.atomic_write_json)
        with mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed_uuid), mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T18:00:00Z"
        ), mock.patch.object(self.facade, "atomic_write_json", write):
            created = self.both(stores, lambda store: store.intake_task_job({
                "url": "https://private.invalid/intake?secret=yes", "role": "Engineer"
            }))
            self.assertEqual(created["action"], "create")
            self.assertNotIn("private.invalid", json.dumps(created))
            before = [snapshot_tree(store.root) for store in stores]
            noop = self.both(stores, lambda store: store.intake_task_job({
                "url": "https://private.invalid/intake?secret=yes"
            }))
            self.assertEqual(noop["action"], "noop")
            self.assertEqual(before, [snapshot_tree(store.root) for store in stores])
        self.assertEqual(write.call_count, 2)
        trashed = self.both(stores, lambda store: store.trash_job(
            created["job"]["id"], created["job"]["revision"]
        ))
        self.assertEqual(trashed["id"], created["job"]["id"])
        self.assertEqual(
            self.both_error(stores, lambda store: store.intake_task_job({
                "url": "https://private.invalid/intake?secret=yes"
            })),
            "task intake conflict",
        )

    def test_preflight_default_assigned_external_and_managed_are_exact(self):
        default_path = self.home / "default.pdf"
        assigned_path = self.home / "assigned.pdf"
        default_path.write_bytes(b"%PDF-1.7\ndefault")
        assigned_path.write_bytes(b"%PDF-1.7\nassigned")
        def prepare(store):
            store.replace_profile({"firstName": "Ada"}, 1, "user")
            self.add_external_resume(store, "default", default_path, default=True)
            self.add_external_resume(store, "assigned", assigned_path, default=False)
            store.create_job({"id": "uses-default", "url": "https://e.invalid/default"})
            store.create_job({
                "id": "uses-assigned", "url": "https://e.invalid/assigned",
                "resumeId": "assigned",
            })
            content_revision = store._new_resume_content_revision()
            with mock.patch.object(
                store, "_new_resume_content_revision", return_value=content_revision
            ):
                managed = store.create_resume_bytes(
                    {"id": "managed", "label": "Managed"}, "managed.pdf",
                    b"%PDF-1.7\nmanaged",
                )
            store.create_job({
                "id": "uses-managed", "url": "https://e.invalid/managed",
                "resumeId": managed["id"],
            })
        stores = self.stores(prepare)
        for job_id, resume_id in (
            ("uses-default", "default"), ("uses-assigned", "assigned"),
            ("uses-managed", "managed"),
        ):
            result = self.both(stores, lambda store, key=job_id: store.preflight_job(key))
            self.assertTrue(result["ready"])
            self.assertEqual(result["resumeId"], resume_id)
        assigned_path.write_bytes(b"%PDF-1.7\nchanged")
        changed = self.both(stores, lambda store: store.preflight_job("uses-assigned"))
        self.assertTrue(changed["ready"])
        self.assertEqual(changed["warnings"], ["resume_file_changed", "role_missing", "company_missing"])
        for store in stores:
            (store.resume_files_path / "managed.pdf").write_bytes(b"%PDF-1.7\nchanged")
        changed = self.both(stores, lambda store: store.preflight_job("uses-managed"))
        self.assertFalse(changed["ready"])
        self.assertIn("resume_file_changed", changed["errors"])

    def test_selection_requires_confirmation_revision_preflight_and_noop(self):
        resume_path = self.home / "ready.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nready")
        def prepare(store):
            store.replace_profile({"firstName": "Ada"}, 1, "user")
            self.add_external_resume(store, "ready", resume_path, default=True)
            store.create_job({"id": "ready-job", "url": "https://e.invalid/ready"})
        stores = self.stores(prepare)
        self.assertIn("owner confirmation", self.both_error(
            stores, lambda store: store.select_task_job_ready("ready-job", 1, False)
        ))
        self.assertIn("revision conflict", self.both_error(
            stores, lambda store: store.select_task_job_ready("ready-job", 2, True)
        ))
        with mock.patch.object(
            self.facade, "utc_now", return_value="2026-09-04T18:00:01Z"
        ):
            selected = self.both(stores, lambda store: store.select_task_job_ready(
                "ready-job", 1, True
            ))
        self.assertEqual((selected["action"], selected["job"]["status"]), ("ready", "ready"))
        before = [snapshot_tree(store.root) for store in stores]
        self.assertEqual(
            self.both(stores, lambda store: store.select_task_job_ready(
                "ready-job", 2, True
            ))["action"],
            "noop",
        )
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])

    def test_overview_precedence_attention_live_claim_and_digest_cache(self):
        def direct(store, profile, jobs, resumes, claim=None):
            return store._owner_beta_overview_locked(
                profile, jobs, resumes, [], claim, FIXED
            )
        stores = self.stores()
        empty = self.both(stores, lambda store: direct(store, {}, [], []))
        self.assertEqual(empty["nextAction"], "import_resume")
        fake_resume = {"id": "r"}
        self.assertEqual(
            self.both(stores, lambda store: direct(store, {}, [], [fake_resume]))["nextAction"],
            "review_facts",
        )
        attention = {"id": "j", "status": "needs_info", "priority": 0}
        self.assertEqual(
            self.both(stores, lambda store: direct(store, {"name": "Ada"}, [attention], [fake_resume]))["nextAction"],
            "resolve_attention",
        )

        managed_store = self.facade.Store(
            self.home / "managed", self.home / "managed-legacy", clock=lambda: FIXED
        )
        managed_store.initialize()
        managed_store.replace_profile({"firstName": "Ada"}, 1, "user")
        revision = managed_store._new_resume_content_revision()
        with mock.patch.object(managed_store, "_new_resume_content_revision", return_value=revision):
            resume = managed_store.create_resume_bytes(
                {"id": "cached", "label": "Cached"}, "cached.pdf", b"%PDF-1.7\ncached"
            )
        job = managed_store.create_job({
            "id": "cached-job", "url": "https://e.invalid/cached", "resumeId": resume["id"]
        })
        managed_store.transition_job(job["id"], "ready", job["revision"])
        identity = self.facade._managed_resume_digest_cache_identity
        with mock.patch.object(
            self.facade, "_managed_resume_digest_cache_identity",
            side_effect=lambda metadata: identity(metadata, platform_name="posix"),
        ), mock.patch.object(
            managed_store, "_private_file_digest", wraps=managed_store._private_file_digest
        ) as digest:
            first = managed_store.owner_beta_overview()
            second = managed_store.owner_beta_overview()
        self.assertEqual((first["nextAction"], second["nextAction"]), ("handoff_ready_job", "handoff_ready_job"))
        self.assertEqual(digest.call_count, 1)
        managed_store._overview_resume_digest_cache.clear()
        with mock.patch.object(
            self.facade, "_managed_resume_digest_cache_identity", return_value=None
        ), mock.patch.object(
            managed_store, "_private_file_digest", wraps=managed_store._private_file_digest
        ) as digest:
            managed_store.owner_beta_overview()
            managed_store.owner_beta_overview()
        self.assertEqual(digest.call_count, 2)
        self.assertEqual(managed_store._overview_resume_digest_cache, {})

        claim = {
            "jobId": "other", "expiresAt": (FIXED + timedelta(minutes=5)).isoformat().replace("+00:00", "Z")
        }
        ready = {"id": "ready", "status": "ready", "priority": 0}
        with mock.patch.object(
            stores[1], "_preflight_job_record", side_effect=AssertionError("must skip")
        ):
            result = direct(stores[1], {"name": "Ada"}, [ready], [fake_resume], claim)
        self.assertEqual(result["nextAction"], "prepare_job")

    def test_live_claim_blocks_selection_and_corrupt_data_is_not_rewritten(self):
        resume_path = self.home / "claim.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nclaim")
        def prepare(store):
            store.replace_profile({"firstName": "Ada"}, 1, "user")
            self.add_external_resume(store, "claim-r", resume_path, default=True)
            store.create_job({"id": "claimed", "url": "https://e.invalid/claimed"})
            claim = {
                "claimId": "claim-id", "jobId": "claimed", "ownerLabel": "owner",
                "tokenHash": "0" * 64, "acquiredAt": "2026-09-04T17:00:00Z",
                "heartbeatAt": "2026-09-04T17:00:00Z", "expiresAt": "2026-09-04T19:00:00Z",
            }
            self.facade.atomic_write_json(store.coordinator_path, {"schemaVersion": 1, "claim": claim})
        stores = self.stores(prepare)
        self.assertIn("claimed", self.both_error(
            stores, lambda store: store.select_task_job_ready("claimed", 1, True)
        ))
        for store in stores:
            store.jobs_path.write_text('{"schemaVersion":2}', encoding="utf-8")
        before = [snapshot_tree(store.root) for store in stores]
        for store in stores:
            with self.assertRaisesRegex(self.facade.StoreError, "future schemaVersion 2"):
                store.preflight_job("claimed")
        self.assertEqual(before, [snapshot_tree(store.root) for store in stores])


if __name__ == "__main__":
    unittest.main()
