from __future__ import annotations

import importlib
import inspect
import tempfile
import unittest
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


DOMAIN_PATH = ROOT / "scripts/job_apply_store/domains/extractions/requests.py"
METHODS = {
    "_new_extraction_request",
    "create_resume_extraction_request",
    "get_resume_extraction_request",
    "list_resume_extraction_requests",
    "_close_resume_extraction_request_locked",
    "cancel_resume_extraction_request",
    "fail_resume_extraction_request",
    "_close_extraction_request",
    "retry_resume_extraction_request",
}
NOW = "2026-09-04T12:00:00Z"


class StoreExtractionRequestsDomainTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.facade = load_module(name="store_extraction_requests_domain_contract")
        cls.journal = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.extractions.journal"
        )
        cls.requests = importlib.import_module(
            f"{cls.facade._PACKAGE_NAME}.domains.extractions.requests"
        )
        cls.journal._bind_runtime(lambda: vars(cls.facade))
        cls.requests._bind_runtime(lambda: vars(cls.facade))
        cls.mixin = cls.requests.ExtractionRequestMixin
        cls.request_contract_composed = composed_store_class(
            cls.facade.Store, cls.mixin
        )
        cls.composed = composed_store_class(
            cls.facade.Store, cls.mixin, cls.journal.ExtractionJournalMixin
        )

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_plain_leaf_owns_exact_contract_and_static_descriptor(self):
        self.assertEqual(self.mixin.__bases__, (object,))
        self.assertNotIn("__init__", vars(self.mixin))
        owned = {
            name
            for name, value in vars(self.mixin).items()
            if inspect.isfunction(value) or isinstance(value, staticmethod)
        }
        self.assertEqual(owned, METHODS)
        assert_method_contract(self, self.facade.Store, self.mixin, METHODS)
        assert_composed_store_lifecycle(
            self,
            self.facade.Store,
            self.mixin,
            self.request_contract_composed,
            METHODS,
        )
        self.assertIsInstance(
            inspect.getattr_static(self.mixin, "_new_extraction_request"), staticmethod
        )
        source = DOMAIN_PATH.read_text(encoding="utf-8")
        self.assertNotIn("job-apply-store", source)
        self.assertNotIn(".domains", source)
        self.assertNotIn("super(", source)

    def paired_stores(self):
        seed = self.facade.Store(self.home / "seed", self.home / "legacy.json")
        seed.initialize()
        source = self.home / "resume.txt"
        source.write_text("private resume contents", encoding="utf-8")
        resume = seed.create_resume({"id": "resume-a", "label": "A", "path": str(source)})
        left = clone_store_root(seed.root, self.home / "left")
        right = clone_store_root(seed.root, self.home / "right")
        return (
            self.facade.Store(left, self.home / "left-legacy.json"),
            self.composed(right, self.home / "right-legacy.json"),
            resume,
        )

    def run_flow(self, store):
        with (
            mock.patch.object(self.facade, "utc_now", return_value=NOW),
            mock.patch.object(
                self.facade.uuid, "uuid4",
                side_effect=[
                    "request-one",
                    "operation-one",
                    "operation-two",
                    "request-two",
                    "operation-three",
                ],
            ),
        ):
            created = store.create_resume_extraction_request("resume-a", 1)
            failed = store.fail_resume_extraction_request(
                created["requestId"], "interrupted", created["revision"]
            )
            retried = store.retry_resume_extraction_request(
                failed["requestId"], failed["revision"], 1
            )
        return created, failed, retried

    def test_create_fail_retry_results_order_and_exact_bytes_match_facade(self):
        facade_store, leaf_store, _resume = self.paired_stores()
        left = self.run_flow(facade_store)
        right = self.run_flow(leaf_store)
        self.assertEqual(left, right)
        self.assertEqual(
            left,
            (
                {
                    "requestId": "request-request-one",
                    "resumeId": "resume-a",
                    "resumeContentRevision": left[0]["resumeContentRevision"],
                    "revision": 1,
                    "status": "requested",
                    "createdAt": NOW,
                    "updatedAt": NOW,
                    "closedAt": None,
                    "proposalId": None,
                    "failureReason": None,
                    "supersedesRequestId": None,
                },
                {
                    "requestId": "request-request-one",
                    "resumeId": "resume-a",
                    "resumeContentRevision": left[0]["resumeContentRevision"],
                    "revision": 2,
                    "status": "failed",
                    "createdAt": NOW,
                    "updatedAt": NOW,
                    "closedAt": NOW,
                    "proposalId": None,
                    "failureReason": "interrupted",
                    "supersedesRequestId": None,
                },
                {
                    "requestId": "request-request-two",
                    "resumeId": "resume-a",
                    "resumeContentRevision": left[0]["resumeContentRevision"],
                    "revision": 1,
                    "status": "requested",
                    "createdAt": NOW,
                    "updatedAt": NOW,
                    "closedAt": None,
                    "proposalId": None,
                    "failureReason": None,
                    "supersedesRequestId": "request-request-one",
                },
            ),
        )
        self.assertEqual(
            [item["requestId"] for item in leaf_store.list_resume_extraction_requests()],
            [left[1]["requestId"], left[2]["requestId"]],
        )
        assert_store_trees_equal(self, facade_store.root, leaf_store.root)

    def test_conflicts_and_validation_failures_are_exact_byte_noops(self):
        _facade_store, store, _resume = self.paired_stores()
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            request = store.create_resume_extraction_request("resume-a", 1)
        checks = (
            lambda: store.create_resume_extraction_request("resume-a", 1),
            lambda: store.fail_resume_extraction_request(request["requestId"], "secret", 1),
            lambda: store.cancel_resume_extraction_request(request["requestId"], 99),
            lambda: store.retry_resume_extraction_request(request["requestId"], 1, 1),
        )
        for operation in checks:
            with self.subTest(operation=operation):
                before = snapshot_tree(store.root)
                with self.assertRaises(self.facade.StoreError):
                    operation()
                self.assertEqual(snapshot_tree(store.root), before)

    def test_static_uuid_clock_and_mutable_validation_seams_are_late_bound(self):
        resume = {"id": "resume-a", "contentRevision": "content-a"}
        with (
            mock.patch.object(self.facade, "utc_now", return_value=NOW) as clock,
            mock.patch.object(self.facade.uuid, "uuid4", return_value="fixed") as identity,
        ):
            request = self.mixin._new_extraction_request(
                resume, "request-superseded"
            )
        self.assertEqual(
            request,
            {
                "requestId": "request-fixed",
                "resumeId": "resume-a",
                "resumeContentRevision": "content-a",
                "revision": 1,
                "status": "requested",
                "createdAt": NOW,
                "updatedAt": NOW,
                "closedAt": None,
                "proposalId": None,
                "failureReason": None,
                "supersedesRequestId": "request-superseded",
            },
        )
        clock.assert_called_once()
        identity.assert_called_once()

        _facade_store, store, _resume = self.paired_stores()
        validator = mock.Mock(side_effect=self.facade._validate_extraction_request)
        with (
            mock.patch.object(self.facade, "_validate_extraction_request", validator),
            mock.patch.object(self.facade, "utc_now", return_value=NOW),
        ):
            store.create_resume_extraction_request("resume-a", 1)
        validator.assert_called_once()

    def test_get_list_filters_missing_file_and_permissions(self):
        store = self.composed(self.home / "missing", self.home / "legacy.json")
        store.initialize()
        self.assertIsNone(store.get_resume_extraction_request("request-missing"))
        self.assertEqual(store.list_resume_extraction_requests(), [])
        facade_store, store, _resume = self.paired_stores()
        with mock.patch.object(self.facade, "utc_now", return_value=NOW):
            request = store.create_resume_extraction_request("resume-a", 1)
        self.assertEqual(
            store.list_resume_extraction_requests("resume-a", "requested"), [request]
        )
        self.assertEqual(store.list_resume_extraction_requests(status="failed"), [])
        self.assertEqual(store.resume_extraction_requests_path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
