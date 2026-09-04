from __future__ import annotations

import importlib
import inspect
import json
import os
import stat
import tempfile
import threading
import unittest
import uuid
from concurrent.futures import ThreadPoolExecutor
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
    "_proposal_stale_reasons",
    "_proposal_result",
    "_proposal_summary",
    "_create_resume_proposal_locked",
    "create_resume_proposal",
    "complete_resume_extraction_request",
    "get_resume_proposal",
    "list_resume_proposals",
    "review_resume_proposal",
)


class ExtractionProposalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="extraction_proposal_contract")
        cls.leaf = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.extractions.proposals"
        )
        cls.leaf._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.leaf.ExtractionProposalMixin
        cls.composed = composed_store_class(cls.facade.Store, cls.mixin)

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.parent = Path(self.temporary.name)

    def stores(self, label="pair"):
        source = self.parent / f"{label}-source"
        self.facade.Store(source, self.parent / "legacy.json").initialize()
        return (
            self.facade.Store(
                clone_store_root(source, self.parent / f"{label}-original"),
                self.parent / "legacy.json",
            ),
            self.composed(
                clone_store_root(source, self.parent / f"{label}-extracted"),
                self.parent / "legacy.json",
            ),
        )

    def seeded_stores(self, label="seeded", request=False):
        source = self.parent / f"{label}-source"
        seed_store = self.facade.Store(source, self.parent / "legacy.json")
        seed_store.initialize()
        resume, profile = self.seed(seed_store)
        extraction_request = None
        if request:
            extraction_request = seed_store.create_resume_extraction_request(
                resume["id"], resume["revision"]
            )
        stores = (
            self.facade.Store(
                clone_store_root(source, self.parent / f"{label}-original"),
                self.parent / "legacy.json",
            ),
            self.composed(
                clone_store_root(source, self.parent / f"{label}-extracted"),
                self.parent / "legacy.json",
            ),
        )
        return stores, resume, profile, extraction_request

    @staticmethod
    def seed(store, resume_id="proposal-resume"):
        resume = store.create_resume_bytes(
            {"id": resume_id, "label": "Private label"},
            "private.txt",
            b"private resume bytes",
        )
        profile = store.patch_profile(
            {"firstName": "PRIVATE-HUMAN", "contact": "PRIVATE-SCALAR"},
            1,
            "user",
        )
        return resume, profile

    def call_both(self, stores, operation):
        values = [operation(store) for store in stores]
        self.assertEqual(values[0], values[1])
        assert_store_trees_equal(self, stores[0].root, stores[1].root)
        return values[0]

    def assert_same_failure(self, stores, operation, message):
        before = [snapshot_tree(store.root) for store in stores]
        errors = []
        for store in stores:
            with self.assertRaisesRegex(self.facade.StoreError, message) as raised:
                operation(store)
            errors.append(str(raised.exception))
        self.assertEqual(errors[0], errors[1])
        self.assertEqual(
            before, [snapshot_tree(store.root) for store in stores]
        )

    def test_exact_plain_mixin_contract_and_direction(self):
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        self.assertNotIn("super(", inspect.getsource(self.mixin))
        self.assertIsInstance(
            inspect.getattr_static(self.mixin, "_proposal_summary"), staticmethod
        )
        self.assertEqual(
            source_inventory(DOMAIN_ROOT)["extractions.proposals"],
            {"ExtractionProposalMixin": METHODS},
        )
        assert_composed_store_lifecycle(
            self, self.facade.Store, self.mixin, self.composed, METHODS
        )
        assert_domain_import_direction(self, DOMAIN_ROOT)

    def test_create_review_list_and_summary_are_byte_equivalent(self):
        stores, resume, profile, _request = self.seeded_stores()
        fixed = uuid.UUID("11111111-2222-4333-8444-555555555555")
        with (
            mock.patch.object(
                self.facade, "utc_now", return_value="2026-09-04T20:00:00Z"
            ),
            mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed),
        ):
            proposal = self.call_both(
                stores,
                lambda store: store.create_resume_proposal(
                    resume["id"],
                    {
                        "firstName": "PRIVATE-EXTRACTED",
                        "email": "private@example.invalid",
                        "contact": {"phone": "PRIVATE-PHONE"},
                    },
                    resume["revision"],
                    profile["revision"],
                ),
            )
            reviewed = self.call_both(
                stores,
                lambda store: store.review_resume_proposal(
                    proposal["id"],
                    {
                        "decisions": {
                            "/firstName": "keep_current",
                            "/contact/phone": "use_extracted",
                        },
                        "replacementConfirmations": {
                            "/contact/phone": "/contact"
                        },
                    },
                    proposal["revision"],
                    proposal["resultProfileRevision"],
                ),
            )
        self.assertEqual(reviewed["status"], "completed")
        summaries = [store.list_resume_proposals(summary_only=True) for store in stores]
        self.assertEqual(summaries[0], summaries[1])
        self.assertEqual(set(summaries[0][0]), {
            "id", "resumeId", "status", "revision",
            "autoFilledCount", "pendingCount",
        })
        self.assertNotIn("PRIVATE", json.dumps(summaries[0]))
        if os.name != "nt":
            for store in stores:
                self.assertEqual(
                    stat.S_IMODE(store.resume_extractions_path.stat().st_mode), 0o600
                )
                self.assertEqual(
                    stat.S_IMODE(store.resume_extraction_journal_path.stat().st_mode),
                    0o600,
                )

    def test_late_bound_validation_and_profile_seams_remain_patchable(self):
        _original, store = self.stores("seams")
        resume, profile = self.seed(store, "seam-resume")
        with (
            mock.patch.object(
                self.facade, "_pointer_baseline",
                wraps=self.facade._pointer_baseline,
            ) as baseline,
            mock.patch.object(
                self.facade, "_validate_extraction_proposal",
                wraps=self.facade._validate_extraction_proposal,
            ) as validator,
            mock.patch.object(
                self.facade, "utc_now", return_value="2026-09-04T20:30:00Z"
            ) as clock,
        ):
            proposal = store.create_resume_proposal(
                resume["id"], {"firstName": "PRIVATE-EXTRACTED"},
                resume["revision"], profile["revision"],
            )
        self.assertEqual(proposal["createdAt"], "2026-09-04T20:30:00Z")
        self.assertGreaterEqual(baseline.call_count, 1)
        self.assertEqual(validator.call_count, 1)
        self.assertGreaterEqual(clock.call_count, 1)

    def test_stale_baseline_and_replacement_failures_are_exact_noops(self):
        stores, resume, profile, _request = self.seeded_stores("failure")
        fixed = uuid.UUID("22222222-2222-4222-8222-222222222222")
        with mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed):
            proposals = [store.create_resume_proposal(
                resume["id"], {"contact": {"phone": "PRIVATE-PHONE"}},
                resume["revision"], profile["revision"],
            ) for store in stores]
        self.assertEqual(proposals[0], proposals[1])
        self.assert_same_failure(
            stores,
            lambda store: store.review_resume_proposal(
                proposals[0]["id"],
                {"decisions": {"/contact/phone": "use_extracted"}},
                proposals[0]["revision"], proposals[0]["resultProfileRevision"],
            ),
            "replacement confirmation",
        )
        changed = []
        for store in stores:
            changed.append(store.patch_profile(
                {"contact": "PRIVATE-DRIFT"}, profile["revision"], "user"
            ))
        self.assert_same_failure(
            stores,
            lambda store: store.review_resume_proposal(
                proposals[0]["id"],
                {
                    "decisions": {"/contact/phone": "use_extracted"},
                    "replacementConfirmations": {"/contact/phone": "/contact"},
                },
                proposals[0]["revision"],
                changed[stores.index(store)]["revision"],
            ),
            "baseline changed",
        )

    def test_complete_request_is_equivalent_and_binds_content_revision(self):
        stores, resume, _profile, request = self.seeded_stores(
            "request", request=True
        )
        with mock.patch.object(
            self.facade.uuid, "uuid4",
            return_value=uuid.UUID("33333333-3333-4333-8333-333333333333"),
        ):
            result = self.call_both(
                stores,
                lambda store: store.complete_resume_extraction_request(
                    request["requestId"],
                    {"email": "private@example.invalid"},
                    request["revision"], 2,
                ),
            )
        detail = stores[0].get_resume_proposal(result["proposalSummary"]["id"])
        self.assertEqual(detail["resumeContentRevision"], resume["contentRevision"])
        self.assertNotIn("private@example.invalid", json.dumps(result))

    def test_proposal_write_failure_recovers_to_exact_equivalent_trees(self):
        stores, resume, profile, _request = self.seeded_stores("recovery")
        results = []
        fixed = uuid.UUID("44444444-4444-4444-8444-444444444444")
        for store in stores:
            original_write = self.facade.atomic_write_json
            proposal_writes = 0

            def fail_proposal_once(path, payload):
                nonlocal proposal_writes
                if path == store.resume_extractions_path:
                    proposal_writes += 1
                    if proposal_writes == 2:
                        raise OSError("synthetic proposal write failure")
                return original_write(path, payload)

            with (
                mock.patch.object(
                    self.facade, "utc_now", return_value="2026-09-04T21:00:00Z"
                ),
                mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed),
                mock.patch.object(
                    self.facade, "atomic_write_json", side_effect=fail_proposal_once
                ),
            ):
                with self.assertRaisesRegex(OSError, "synthetic proposal write failure"):
                    store.create_resume_proposal(
                        resume["id"], {"email": "private@example.invalid"},
                        resume["revision"], profile["revision"],
                    )
            repaired = type(store)(store.root, self.parent / "legacy.json")
            repaired.initialize()
            results.append(repaired.list_resume_proposals())
        self.assertEqual(results[0], results[1])
        self.assertEqual(len(results[0]), 1)
        assert_store_trees_equal(self, stores[0].root, stores[1].root)

    def test_digest_staleness_is_equivalent_and_does_not_disclose_values(self):
        stores, resume, profile, _request = self.seeded_stores("stale")
        fixed = uuid.UUID("55555555-5555-4555-8555-555555555555")
        with mock.patch.object(self.facade.uuid, "uuid4", return_value=fixed):
            proposals = [store.create_resume_proposal(
                resume["id"], {"firstName": "PRIVATE-EXTRACTED"},
                resume["revision"], profile["revision"],
            ) for store in stores]
        for store in stores:
            managed = store.resume_files_path / resume["managedFile"]
            managed.write_bytes(b"changed private bytes")
        stale = [store.get_resume_proposal(proposals[0]["id"]) for store in stores]
        self.assertEqual(stale[0], stale[1])
        self.assertEqual(stale[0]["staleReasons"], ["resume_file_changed"])
        self.assertNotIn("changed private bytes", json.dumps(stale[0]))

    def test_same_revision_review_race_has_one_winner(self):
        _original, store = self.stores("race")
        resume, profile = self.seed(store)
        proposal = store.create_resume_proposal(
            resume["id"], {"firstName": "PRIVATE-EXTRACTED"},
            resume["revision"], profile["revision"],
        )
        gate = threading.Barrier(2)

        def review(decision):
            gate.wait()
            try:
                return store.review_resume_proposal(
                    proposal["id"], {"decisions": {"/firstName": decision}},
                    proposal["revision"], proposal["resultProfileRevision"],
                )
            except self.facade.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(review, ("keep_current", "use_extracted")))
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertEqual(sum("revision conflict" in item for item in results if isinstance(item, str)), 1)

    def test_root_local_reload_keeps_runtime_bindings_isolated(self):
        self.leaf._bind_runtime(lambda: vars(self.leaf))
        try:
            with self.assertRaisesRegex(self.leaf.StoreError, "must not be empty"):
                self.leaf._late("_validated_candidate")({})
        finally:
            self.leaf._bind_runtime(lambda: vars(self.facade))
        facade_a = load_module(name="proposal_root_a")
        leaf_a = importlib.import_module(
            f"{facade_a._PACKAGE_NAME}.domains.extractions.proposals"
        )
        facade_b = load_module(name="proposal_root_b")
        leaf_b = importlib.import_module(
            f"{facade_b._PACKAGE_NAME}.domains.extractions.proposals"
        )
        self.assertIsNot(leaf_a, leaf_b)
        self.assertIsNot(facade_a.StoreError, facade_b.StoreError)
        leaf_a._bind_runtime(lambda: vars(facade_a))
        leaf_b._bind_runtime(lambda: vars(facade_b))
        self.assertIs(leaf_a._RUNTIME_PROVIDER()["Store"], facade_a.Store)
        self.assertIs(leaf_b._RUNTIME_PROVIDER()["Store"], facade_b.Store)
        with self.assertRaises(facade_a.StoreError):
            leaf_a._late("_validated_candidate")({})
        with self.assertRaises(facade_b.StoreError):
            leaf_b._late("_validated_candidate")({})


if __name__ == "__main__":
    unittest.main()
