from __future__ import annotations

import copy
import importlib
import inspect
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
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


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/jobs/upsert.py"
METHODS = {
    "_job_upsert_payload",
    "_canonical_upsert_input",
    "_upsert_token",
    "_deterministic_job_id",
    "_normalize_upsert_item",
    "_source_identity",
    "_plan_job_upsert",
    "_upsert_result",
    "preview_job_upsert",
    "commit_job_upsert",
}
NOW = "2026-09-04T12:00:00Z"


class StoreJobsUpsertDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_jobs_upsert_domain_contract")
        cls.domain = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.jobs.upsert"
        )
        cls.domain._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.domain.JobUpsertMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def paired_stores(self):
        seed = self.facade.Store(self.home / "seed", self.home / "legacy.json")
        seed.initialize()
        left_root = clone_store_root(seed.root, self.home / "left")
        right_root = clone_store_root(seed.root, self.home / "right")
        return (
            self.facade.Store(left_root, self.home / "left-legacy.json"),
            self.composed(right_root, self.home / "right-legacy.json"),
        )

    def assert_equivalent(self, stores, operation):
        outcomes = [operation(store) for store in stores]
        self.assertEqual(outcomes[0], outcomes[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        return outcomes[0]

    def test_plain_leaf_owns_exact_contract_and_static_descriptors(self):
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertEqual(
            {
                name
                for name, value in vars(self.mixin).items()
                if inspect.isfunction(value) or isinstance(value, staticmethod)
            },
            METHODS,
        )
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        for name in METHODS - {"_plan_job_upsert", "preview_job_upsert", "commit_job_upsert"}:
            self.assertIsInstance(inspect.getattr_static(self.mixin, name), staticmethod)
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        self.assertNotIn("super(", source)

    def test_preview_preserves_every_byte_mode_and_creates_no_lock(self):
        store = self.composed(self.home / "store", self.home / "legacy.json")
        store.initialize()
        before = snapshot_tree(store.root)
        payload = {"jobs": [{"url": "https://example.com/jobs/preview"}]}
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            first = store.preview_job_upsert(payload, "human")
            second = store.preview_job_upsert(payload, "human")
        self.assertEqual(first, second)
        self.assertEqual(snapshot_tree(store.root), before)
        self.assertFalse(store.store_lock_path.exists())

    def test_cloned_create_update_noop_are_result_and_byte_equivalent(self):
        stores = self.paired_stores()
        initial = {
            "jobs": [
                {
                    "url": "HTTPS://Jobs.Example.com:443/openings/42#apply",
                    "source": "LinkedIn",
                    "sourceId": "42",
                    "role": "Human Role",
                }
            ]
        }
        agent = {
            "jobs": [
                {
                    "url": initial["jobs"][0]["url"],
                    "source": "linkedin",
                    "sourceId": "42",
                    "role": "Agent Role",
                    "company": "Acme",
                }
            ]
        }
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            for payload, origin in ((initial, "human"), (agent, "agent"), (agent, "agent")):
                preview = self.assert_equivalent(
                    stores, lambda store: store.preview_job_upsert(payload, origin)
                )
                result = self.assert_equivalent(
                    stores,
                    lambda store: store.commit_job_upsert(
                        payload, origin, preview["token"]
                    ),
                )
        self.assertFalse(result["committed"])
        record = stores[1].get_job(result["decisions"][0]["id"])
        self.assertEqual(record["role"], "Human Role")
        self.assertEqual(record["company"], "Acme")
        self.assertEqual(record["provenance"]["/role"]["origin"], "human")
        self.assertEqual(record["provenance"]["/company"]["origin"], "agent")

    def test_invalid_and_duplicate_identities_keep_order_without_input_mutation(self):
        stores = self.paired_stores()
        payload = {
            "jobs": [
                {"url": "https://example.com/jobs/same", "role": "One"},
                {"url": "https://example.com/jobs/same", "role": "Two"},
                {"url": "https://example.com/jobs/invalid", "priority": True},
                {"url": "https://example.com/jobs/valid", "role": "Valid"},
            ]
        }
        original = copy.deepcopy(payload)
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            preview = self.assert_equivalent(
                stores, lambda store: store.preview_job_upsert(payload, "agent")
            )
            committed = self.assert_equivalent(
                stores,
                lambda store: store.commit_job_upsert(
                    payload, "agent", preview["token"]
                ),
            )
        self.assertEqual(payload, original)
        self.assertEqual(
            [item["action"] for item in committed["decisions"]],
            ["conflict", "conflict", "invalid", "create"],
        )
        self.assertEqual([item["index"] for item in committed["decisions"]], list(range(4)))

    def test_preview_token_drift_is_constant_time_and_same_token_has_one_winner(self):
        store = self.composed(self.home / "race", self.home / "legacy.json")
        store.initialize()
        payload = {"jobs": [{"url": "https://example.com/jobs/race"}]}
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            preview = store.preview_job_upsert(payload, "human")

            def commit():
                try:
                    return store.commit_job_upsert(payload, "human", preview["token"])
                except self.facade.StoreError as error:
                    return str(error)

            with ThreadPoolExecutor(max_workers=2) as executor:
                outcomes = list(executor.map(lambda _index: commit(), range(2)))
        self.assertEqual(sum(isinstance(item, dict) for item in outcomes), 1)
        self.assertEqual(sum("drifted" in item for item in outcomes if isinstance(item, str)), 1)

        compare = mock.Mock(wraps=self.facade.hmac.compare_digest)
        with mock.patch.object(self.facade.hmac, "compare_digest", compare):
            with self.assertRaisesRegex(self.facade.StoreError, "drifted"):
                store.commit_job_upsert(payload, "human", "job-upsert-v1.bad")
        compare.assert_called_once()

    def test_late_runtime_store_static_and_clock_patches_are_live(self):
        payload = {"jobs": [{"url": " https://example.com/jobs/static "}]}
        original = self.facade.Store._job_upsert_payload
        payload_spy = mock.Mock(wraps=original)
        with mock.patch.object(
            self.facade.Store, "_job_upsert_payload", staticmethod(payload_spy)
        ):
            canonical = self.mixin._canonical_upsert_input(payload)
        self.assertEqual(canonical["jobs"][0]["url"], "https://example.com/jobs/static")
        payload_spy.assert_called_once_with(payload)


if __name__ == "__main__":
    unittest.main()
