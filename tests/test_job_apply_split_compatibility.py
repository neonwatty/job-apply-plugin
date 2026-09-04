import argparse
import importlib.util
import io
import json
import shutil
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
POLICY_PATH = ROOT / "scripts" / "job_apply_policy.py"
MATCH_PATH = ROOT / "scripts" / "job_apply_answer_match.py"
LEGACY_POLICY_STAR_NAMES = {
    "APPLICATION_FIELDS", "APPLICATION_STATUSES", "ATS", "ATTEMPT_FIELDS",
    "AUTHORIZATION_FIELDS", "Any", "CAMPAIGN_FIELDS", "CAMPAIGN_STATUSES",
    "CONFIRMATION_FIELDS", "Callable", "FINGERPRINT", "Iterator",
    "LEASE_DURATION", "MAX_APPLICATIONS", "MAX_DURATION", "OUTCOMES", "Path",
    "PolicyError", "PolicyStore", "RECEIPT_FIELDS", "REFERENCE", "RULE_FIELDS",
    "SCHEMA_VERSION", "SENSITIVE_FIELDS", "STORE_ENV", "annotations",
    "argparse", "build_parser", "confirmation_authority_revision",
    "contextmanager", "datetime", "fcntl", "format_time", "hashlib", "hmac",
    "json", "main", "os", "parse_time", "re", "run", "secrets", "sys",
    "tempfile", "timedelta", "timezone", "urlsplit", "utc_now",
}
POLICY_DESCRIPTION = """Inert local policy authority for bounded Job Apply Auto-submit campaigns.

This helper only creates and evaluates local policy records. It deliberately has
no browser integration and cannot activate a final control.
"""


def load_path(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module, spec


class SplitIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temporary.cleanup()

    def copied_script(self, root_name, facade_name, package_name):
        copied_root = Path(self.temporary.name) / root_name / "scripts"
        copied_root.mkdir(parents=True)
        shutil.copy2(ROOT / "scripts" / facade_name, copied_root / facade_name)
        shutil.copytree(ROOT / "scripts" / package_name, copied_root / package_name)
        return copied_root / facade_name

    def test_distinct_policy_roots_do_not_share_implementation_state(self):
        first_path = self.copied_script("first", "job_apply_policy.py", "job_apply_policy")
        second_path = self.copied_script("second", "job_apply_policy.py", "job_apply_policy")
        first, _ = load_path(first_path, "isolated_policy_first")
        first.OUTCOMES.add("first_root_only")
        second, _ = load_path(second_path, "isolated_policy_second")

        self.assertNotIn("first_root_only", second.OUTCOMES)
        self.assertIsNot(first.OUTCOMES, second.OUTCOMES)
        self.assertIsNot(first.PolicyError, second.PolicyError)
        self.assertIn(first._PACKAGE_NAME, sys.modules)

    def test_distinct_matcher_roots_do_not_share_implementation_state(self):
        first_path = self.copied_script(
            "first", "job_apply_answer_match.py", "job_apply_answer_matching"
        )
        second_path = self.copied_script(
            "second", "job_apply_answer_match.py", "job_apply_answer_matching"
        )
        first, _ = load_path(first_path, "isolated_match_first")
        first.CONFIDENCE_BANDS.add("first_root_only")
        second, _ = load_path(second_path, "isolated_match_second")

        self.assertNotIn("first_root_only", second.CONFIDENCE_BANDS)
        self.assertIsNot(first.CONFIDENCE_BANDS, second.CONFIDENCE_BANDS)
        self.assertIsNot(first.AnswerMatchError, second.AnswerMatchError)
        self.assertIn(first._PACKAGE_NAME, sys.modules)

    def test_reexecution_refreshes_without_growing_private_modules(self):
        for script, name in (
            (POLICY_PATH, "bounded_reload_policy"),
            (MATCH_PATH, "bounded_reload_match"),
        ):
            with self.subTest(script=script.name):
                module, spec = load_path(script, name)
                package_name = module._PACKAGE_NAME
                first_entries = {
                    key for key in sys.modules
                    if key == package_name or key.startswith(package_name + ".")
                }
                spec.loader.exec_module(module)
                second_entries = {
                    key for key in sys.modules
                    if key == package_name or key.startswith(package_name + ".")
                }
                spec.loader.exec_module(module)
                third_entries = {
                    key for key in sys.modules
                    if key == package_name or key.startswith(package_name + ".")
                }

                self.assertEqual(module._PACKAGE_NAME, package_name)
                self.assertEqual(second_entries, first_entries)
                self.assertEqual(third_entries, first_entries)

    def test_reexecuting_facades_discards_stale_monkeypatches(self):
        for script, name, attribute in (
            (POLICY_PATH, "reload_policy_contract", "_atomic_json"),
            (MATCH_PATH, "reload_match_contract", "rank_candidates"),
        ):
            with self.subTest(script=script.name):
                module, spec = load_path(script, name)
                sentinel = object()
                setattr(module, attribute, sentinel)
                spec.loader.exec_module(module)
                self.assertIsNot(getattr(module, attribute), sentinel)


class PolicyFacadeCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.policy, _ = load_path(POLICY_PATH, "policy_facade_contract")

    def test_run_routes_input_reads_through_facade_export(self):
        args = argparse.Namespace(root=None, command="activate", input="ignored")
        incoming = {"contract": "sentinel"}
        store = mock.Mock()
        store.activate.return_value = {"mode": "sentinel"}
        with mock.patch.object(self.policy, "_read_input", return_value=incoming) as read:
            with mock.patch.object(self.policy, "PolicyStore", return_value=store):
                self.assertEqual(self.policy.run(args), {"mode": "sentinel"})
        read.assert_called_once_with("ignored")
        store.activate.assert_called_once_with(incoming)

    def test_main_routes_parser_and_run_through_facade_exports(self):
        args = argparse.Namespace(command="status")
        parser = mock.Mock()
        parser.parse_args.return_value = args
        output = io.StringIO()
        with mock.patch.object(self.policy, "build_parser", return_value=parser) as build:
            with mock.patch.object(self.policy, "run", return_value={"mode": "patched"}) as run:
                with mock.patch.object(self.policy.sys, "stdout", output):
                    self.assertEqual(self.policy.main(), 0)
        build.assert_called_once_with()
        run.assert_called_once_with(args)
        self.assertEqual(json.loads(output.getvalue()), {"mode": "patched"})

    def test_star_import_inventory_matches_legacy_module(self):
        self.assertEqual(set(self.policy.__all__), LEGACY_POLICY_STAR_NAMES)
        self.assertTrue(all(hasattr(self.policy, name) for name in self.policy.__all__))

    def test_parser_description_matches_legacy_help(self):
        self.assertEqual(self.policy.build_parser().description, POLICY_DESCRIPTION)


class AnswerFacadeCompatibilityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.match, _ = load_path(MATCH_PATH, "match_facade_contract")

    def test_cleanup_routes_ranking_through_facade_export(self):
        winner = {
            "key": "winner", "question": "winner question", "scope": {},
            "fieldClass": "general", "sensitivity": "none", "state": "confirmed",
            "reviewStatus": "accepted", "recordStatus": "active", "valueState": "seen",
        }
        duplicate = {
            "key": "duplicate", "question": "unrelated duplicate", "scope": {},
            "fieldClass": "general", "sensitivity": "none", "state": "missing",
            "reviewStatus": "pending", "recordStatus": "active", "valueState": "missing",
        }
        ranked = [{
            "answerKey": "duplicate", "confidenceBand": "exact",
            "reasonCodes": ["match_exact_question", "scope_match",
                            "field_class_match", "sensitivity_match"],
        }]
        with mock.patch.object(self.match, "rank_candidates", return_value=ranked) as rank:
            proposals = self.match.propose_cleanup(candidates=[winner, duplicate])
        self.assertEqual(proposals[0]["duplicateKey"], "duplicate")
        rank.assert_called_once()


if __name__ == "__main__":
    unittest.main()
