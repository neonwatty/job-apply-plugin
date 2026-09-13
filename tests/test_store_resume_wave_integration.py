"""Production composition ownership and root reload contracts for resume domains."""

import inspect
import sys
import tempfile
import unittest
from pathlib import Path

from tests.support.store_facade_contract import load_module
from tests.test_store_loader_isolation import copy_plugin


DOMAINS = (
    ('resumes', 'storage', 'ResumeStorageMixin', (
        '_load_resumes_document',
        '_managed_resume_path',
        '_resume_path',
        '_resume_for_acquisition',
        '_private_file_digest',
        '_managed_resume_observation',
        '_new_resume_content_revision',
        '_recover_resume_files_locked',
        '_stage_resume_import',
        '_temporary_resume_source',
        '_staged_resume',
        '_install_staged_resume',
    )),
    ('resumes', 'read', 'ResumeReadMixin', (
        'read_resume_content',
        'resolve_resume',
        'get_resume',
        'list_resumes',
        'check_resume',
    )),
    ('resumes', 'mutations', 'ResumeMutationMixin', (
        'create_resume',
        'import_resume',
        'create_resume_bytes',
        'update_resume_bytes',
        'adopt_resume_bytes',
        'update_resume',
        'adopt_resume',
        'set_default_resume',
    )),
    ('resumes', 'lifecycle', 'ResumeLifecycleMixin', (
        'trash_resume',
        'restore_resume',
        '_set_resume_deleted',
        'delete_resume',
    )),
    ('extractions', 'journal', 'ExtractionJournalMixin', (
        '_load_extractions_document',
        '_load_extraction_requests_document',
        '_load_extraction_journal',
        '_ensure_extraction_files_locked',
        '_ensure_extraction_requests_file_locked',
        '_roll_forward_extraction_locked',
        '_commit_extraction_operation_locked',
    )),
    ('extractions', 'requests', 'ExtractionRequestMixin', (
        '_new_extraction_request',
        'create_resume_extraction_request',
        'get_resume_extraction_request',
        'list_resume_extraction_requests',
        '_close_resume_extraction_request_locked',
        'cancel_resume_extraction_request',
        'fail_resume_extraction_request',
        '_close_extraction_request',
        'retry_resume_extraction_request',
    )),
    ('extractions', 'proposals', 'ExtractionProposalMixin', (
        '_proposal_stale_reasons',
        '_proposal_result',
        '_proposal_summary',
        '_create_resume_proposal_locked',
        'create_resume_proposal',
        'complete_resume_extraction_request',
        'get_resume_proposal',
        'list_resume_proposals',
        'review_resume_proposal',
    )),
)


class ResumeWaveIntegrationTests(unittest.TestCase):
    def test_exact_54_method_ownership_and_production_runtime(self):
        facade = load_module(name="resume_wave_ownership")
        seen = set()
        for domain, name, class_name, methods in DOMAINS:
            leaf = getattr(facade, f"_{domain}_{name}_domain")
            mixin = getattr(leaf, class_name)
            self.assertIs(leaf._RUNTIME_PROVIDER(), vars(facade))
            self.assertEqual(facade.Store.__mro__.count(mixin), 1)
            self.assertFalse(seen.intersection(methods))
            seen.update(methods)
            for method in methods:
                owners = [owner for owner in facade.Store.__mro__ if method in vars(owner)]
                self.assertEqual(owners, [mixin])
                self.assertIs(inspect.getattr_static(facade.Store, method),
                              inspect.getattr_static(mixin, method))
        self.assertEqual(len(seen), 54)

    def test_reload_rebinds_all_seven_leaves_without_disturbing_other_root(self):
        with tempfile.TemporaryDirectory() as temporary:
            roots = [copy_plugin(Path(temporary) / name) for name in ("a", "b")]
            first, other = [load_module(root / "scripts/job-apply-store.py", name)
                            for root, name in zip(roots, ("resume_a", "resume_b"))]
            fresh = load_module(roots[0] / "scripts/job-apply-store.py", "resume_fresh")
            for domain, name, _class_name, _methods in DOMAINS:
                attribute = f"_{domain}_{name}_domain"
                prior_leaf, fresh_leaf, other_leaf = [getattr(f, attribute)
                                                     for f in (first, fresh, other)]
                self.assertIsNot(prior_leaf, fresh_leaf)
                self.assertIs(fresh_leaf._RUNTIME_PROVIDER(), vars(fresh))
                self.assertIs(other_leaf._RUNTIME_PROVIDER(), vars(other))
                self.assertIs(sys.modules[other_leaf.__name__], other_leaf)
                self.assertTrue(Path(fresh_leaf.__file__).resolve().is_relative_to(roots[0].resolve()))
            for index, facade in enumerate((fresh, other)):
                facade.utc_now = lambda value=index: f"2026-09-04T20:00:0{value}Z"
                store = facade.Store(Path(temporary) / f"store-{index}")
                resume = store.create_resume_bytes(
                    {"id": "resume", "label": "Private"}, "resume.txt", b"private")
                request = store.create_resume_extraction_request(resume["id"], resume["revision"])
                result = store.complete_resume_extraction_request(
                    request["requestId"], {"email": "private@example.invalid"},
                    request["revision"], 1)
                self.assertEqual(result["request"]["status"], "completed")
                self.assertEqual(resume["createdAt"], f"2026-09-04T20:00:0{index}Z")
                self.assertIsNone(store._load_extraction_journal()["operation"])


if __name__ == "__main__":
    unittest.main()
