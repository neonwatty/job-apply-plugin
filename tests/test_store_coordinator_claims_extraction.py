from __future__ import annotations

import importlib
import inspect
import shutil
import tempfile
import threading
import types
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

from tests.support import store_fixtures
from tests.support.store_domain_contract import (
    assert_composed_store_lifecycle,
    assert_method_contract,
    assert_store_trees_equal,
    clone_store_root,
    composed_store_class,
    snapshot_tree,
)
from tests.support.store_facade_contract import ROOT, load_module


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/coordinator/claims.py"
METHODS = (
    "_token_hash",
    "_new_claim_token",
    "_public_claim",
    "_parse_time",
    "claim_status",
    "_require_claim_locked",
    "_require_job_unclaimed_locked",
    "acquire_ready_job",
    "restart_reviewed_job",
    "heartbeat_claim",
    "recover_claim",
)
STATIC_METHODS = {"_token_hash", "_new_claim_token", "_parse_time"}


class CoordinatorClaimsExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="coordinator_claims_extraction_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.coordinator.claims"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.CoordinatorClaimsMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.home = Path(self.temporary.name)

    def prepare_ready(self, store, job_id="ready-job"):
        store.replace_profile(
            {"firstName": "Ada"}, store.inspect_profile()["revision"], "user"
        )
        source = self.home / f"{job_id}.pdf"
        source.write_bytes(b"%PDF-1.7\nclaim extraction")
        resume = store.create_resume(
            {"id": f"{job_id}-resume", "label": "Resume", "path": str(source)}
        )
        job = store.create_job(
            {
                "id": job_id,
                "url": f"https://example.com/jobs/{job_id}",
                "role": "Engineer",
                "company": "Acme",
                "resumeId": resume["id"],
            }
        )
        return store.transition_job(job_id, "ready", job["revision"])

    def ready_pair(self):
        source = self.home / "seed"
        seed = self.facade.Store(source, self.home / "legacy.json")
        ready = self.prepare_ready(seed)
        original = self.facade.Store(
            clone_store_root(source, self.home / "original"),
            self.home / "original-legacy.json",
        )
        extracted = self.composed(
            clone_store_root(source, self.home / "extracted"),
            self.home / "extracted-legacy.json",
        )
        return original, extracted, ready

    def test_exact_plain_mixin_contract_descriptors_and_source_shape(self):
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertEqual(
            {
                name
                for name, value in vars(self.mixin).items()
                if inspect.isfunction(value) or isinstance(value, staticmethod)
            },
            set(METHODS),
        )
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        for name in METHODS:
            expected = staticmethod if name in STATIC_METHODS else type(lambda: None)
            self.assertIsInstance(inspect.getattr_static(self.mixin, name), expected)
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertLessEqual(len(source.splitlines()), 500)
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        self.assertNotIn("super(", source)

    def test_unbound_leaf_uses_canonical_static_defaults(self):
        importlib.reload(self.leaf)
        self.assertEqual(
            self.mixin._token_hash("bearer"),
            "2454ad61c2acc04f0a20fabf7f2bc96f28d19c434052fdefdbb51b46fe534f89",
        )
        self.assertEqual(
            self.mixin._parse_time("2026-09-04T12:00:00Z"),
            datetime(2026, 9, 4, 12, tzinfo=timezone.utc),
        )
        self.leaf._bind_runtime(lambda: vars(self.facade))

    def test_acquire_is_result_and_byte_equivalent_and_redacts_bearer(self):
        original, extracted, ready = self.ready_pair()
        with (
            mock.patch.object(
                self.facade.secrets, "token_urlsafe", return_value="fixed-secret"
            ),
            mock.patch.object(
                self.facade.uuid, "uuid4", return_value="fixed-identifier"
            ),
        ):
            outcomes = [
                store.acquire_ready_job(ready["id"], "worker", ready["revision"])
                for store in (original, extracted)
            ]
        normalized = []
        for outcome, store in zip(outcomes, (original, extracted)):
            normalized.append(
                repr(outcome).replace(str(store.root), "<STORE_ROOT>")
            )
        self.assertEqual(normalized[0], normalized[1])
        assert_store_trees_equal(self, original.root, extracted.root)
        self.assertEqual(outcomes[1]["token"], "claim_fixed-secret")
        self.assertNotIn("tokenHash", outcomes[1]["claim"])
        self.assertNotIn(outcomes[1]["token"], extracted.coordinator_path.read_text())

    def test_patched_generator_and_exact_lease_boundary_stay_live(self):
        instant = [datetime(2026, 9, 4, tzinfo=timezone.utc)]
        store = self.composed(
            self.home / "boundary", self.home / "boundary-legacy.json",
            clock=lambda: instant[0],
        )
        ready = self.prepare_ready(store, "boundary-job")
        with mock.patch.object(
            self.facade.secrets, "token_urlsafe", return_value="-patched"
        ) as generator:
            acquired = store.acquire_ready_job(
                ready["id"], "worker", ready["revision"]
            )
        generator.assert_called_once_with(32)
        self.assertEqual(acquired["token"], "claim_-patched")
        instant[0] += timedelta(seconds=self.facade.CLAIM_LEASE_SECONDS)
        store.claim_status()
        before = snapshot_tree(store.root)
        with self.assertRaisesRegex(self.facade.StoreError, "claim has expired"):
            store.heartbeat_claim(ready["id"], acquired["token"])
        self.assertEqual(snapshot_tree(store.root), before)
        recovered = store.recover_claim(ready["id"], "replacement")
        self.assertNotEqual(recovered["token"], acquired["token"])
        self.assertNotEqual(recovered["claim"]["claimId"], acquired["claim"]["claimId"])

    def test_rejections_are_exact_noops_and_compare_tokens_constantly(self):
        _original, store, ready = self.ready_pair()
        store.claim_status()
        before = snapshot_tree(store.root)
        with self.assertRaisesRegex(self.facade.StoreError, "revision conflict"):
            store.acquire_ready_job(ready["id"], "worker", ready["revision"] - 1)
        self.assertEqual(snapshot_tree(store.root), before)
        acquired = store.acquire_ready_job(ready["id"], "worker", ready["revision"])
        before = snapshot_tree(store.root)
        compare = mock.Mock(wraps=self.facade.hmac.compare_digest)
        with mock.patch.object(self.facade.hmac, "compare_digest", compare):
            with self.assertRaisesRegex(self.facade.StoreError, "token is invalid"):
                store.heartbeat_claim(ready["id"], "wrong-token")
        compare.assert_called_once()
        self.assertEqual(snapshot_tree(store.root), before)
        self.assertNotIn(acquired["token"], store.coordinator_path.read_text())

    def test_acquire_race_has_one_revision_and_journal_winner(self):
        _original, store, ready = self.ready_pair()
        gate = threading.Barrier(2)

        def acquire(owner):
            gate.wait()
            try:
                return store.acquire_ready_job(ready["id"], owner, ready["revision"])
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(acquire, ("one", "two")))
        self.assertEqual(sum(isinstance(value, dict) for value in outcomes), 1)
        self.assertEqual(sum(isinstance(value, str) for value in outcomes), 1)
        self.assertEqual(store.get_job(ready["id"])["revision"], ready["revision"] + 1)
        self.assertEqual(
            [event["event"] for event in store.read_history()].count("job-started"),
            1,
        )
        self.assertIsNone(store._load_coordinator_journal()["operation"])

    def test_recovery_race_and_heartbeat_write_failure_are_atomic(self):
        instant = [datetime(2026, 9, 4, tzinfo=timezone.utc)]
        store = self.composed(
            self.home / "recovery-race",
            self.home / "recovery-race-legacy.json",
            clock=lambda: instant[0],
        )
        ready = self.prepare_ready(store, "recovery-race-job")
        acquired = store.acquire_ready_job(
            ready["id"], "initial", ready["revision"]
        )
        before = snapshot_tree(store.root)
        with mock.patch.object(
            self.facade.os, "replace", side_effect=OSError("simulated write failure")
        ):
            with self.assertRaisesRegex(OSError, "simulated write failure"):
                store.heartbeat_claim(ready["id"], acquired["token"])
        self.assertEqual(snapshot_tree(store.root), before)
        self.assertEqual(list(store.root.glob(".coordinator.json.*.tmp")), [])

        instant[0] += timedelta(seconds=self.facade.CLAIM_LEASE_SECONDS)
        gate = threading.Barrier(2)

        def recover(owner):
            gate.wait()
            try:
                return store.recover_claim(ready["id"], owner)
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(recover, ("one", "two")))
        self.assertEqual(sum(isinstance(value, dict) for value in outcomes), 1)
        self.assertEqual(
            [event["event"] for event in store.read_history()].count(
                "claim-recovered"
            ),
            1,
        )

    def test_review_restart_is_byte_equivalent_and_rejects_missing_consent(self):
        source = self.home / "review-seed"
        seed = self.facade.Store(source, self.home / "review-legacy.json")
        ready = self.prepare_ready(seed, "review-job")
        acquired = seed.acquire_ready_job(ready["id"], "initial", ready["revision"])
        reviewed = seed.handoff_claimed_job(
            ready["id"],
            acquired["token"],
            "awaiting_review",
            store_fixtures.review_session(
                self.facade,
                acquired["job"]["revision"],
                "review",
                "greenhouse-form-readiness-v1",
            ),
            acquired["job"]["revision"],
        )["job"]
        stores = (
            self.facade.Store(
                clone_store_root(source, self.home / "review-original"),
                self.home / "a.json",
            ),
            self.composed(
                clone_store_root(source, self.home / "review-extracted"),
                self.home / "b.json",
            ),
        )
        snapshots = [snapshot_tree(store.root) for store in stores]
        for store, before in zip(stores, snapshots):
            with self.assertRaisesRegex(
                self.facade.StoreError, "explicit owner confirmation"
            ):
                store.restart_reviewed_job(
                    reviewed["id"], "worker", reviewed["revision"]
                )
            self.assertEqual(snapshot_tree(store.root), before)
        with (
            mock.patch.object(self.facade.secrets, "token_urlsafe", return_value="restart"),
            mock.patch.object(self.facade.uuid, "uuid4", return_value="restart-id"),
        ):
            outcomes = [
                store.restart_reviewed_job(
                    reviewed["id"], "worker", reviewed["revision"], True
                )
                for store in stores
            ]
        normalized = [
            repr(outcome).replace(str(store.root), "<STORE_ROOT>")
            for outcome, store in zip(outcomes, stores)
        ]
        self.assertEqual(normalized[0], normalized[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

    def test_root_local_leaf_bindings_survive_two_copied_roots(self):
        ignored = shutil.ignore_patterns(
            ".git", ".worktrees", ".superpowers", "node_modules", "__pycache__"
        )
        roots = (self.home / "plugin-a", self.home / "plugin-b")
        for root in roots:
            shutil.copytree(ROOT, root, ignore=ignored)
        facades = [
            load_module(root / "scripts/job-apply-store.py", f"claims_root_{index}")
            for index, root in enumerate(roots)
        ]
        leaves = [
            importlib.import_module(f"{facade._PACKAGE_NAME}.domains.coordinator.claims")
            for facade in facades
        ]
        for facade, leaf in zip(facades, leaves):
            leaf._bind_runtime(lambda facade=facade: vars(facade))
        with (
            mock.patch.object(
                facades[0],
                "secrets",
                types.SimpleNamespace(token_urlsafe=lambda _size: "root-a"),
            ),
            mock.patch.object(
                facades[1],
                "secrets",
                types.SimpleNamespace(token_urlsafe=lambda _size: "root-b"),
            ),
        ):
            self.assertEqual(leaves[0].CoordinatorClaimsMixin._new_claim_token(), "claim_root-a")
            self.assertEqual(leaves[1].CoordinatorClaimsMixin._new_claim_token(), "claim_root-b")
            importlib.reload(leaves[0])
            leaves[0]._bind_runtime(lambda: vars(facades[0]))
            self.assertEqual(leaves[1].CoordinatorClaimsMixin._new_claim_token(), "claim_root-b")


if __name__ == "__main__":
    unittest.main()
