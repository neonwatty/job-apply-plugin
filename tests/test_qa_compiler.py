import copy
import json
from pathlib import Path
import tempfile
import unittest

from qa.compiler import COMPILER_VERSION, CompilerError, compile_capture
from qa.contracts import CATALOG, FINAL_ACTION, validate_fixture
from qa.privacy import scan_tree


TESTDATA = Path(__file__).resolve().parents[1] / "qa" / "testdata" / "private-capture"
FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"


class CompilerTests(unittest.TestCase):
    def setUp(self):
        self.capture = json.loads((TESTDATA / "semantic.json").read_text())
        self.receipt = json.loads((TESTDATA / "capture-receipt.json").read_text())

    def compile(self, capture=None, receipt=None):
        return compile_capture(
            self.capture if capture is None else capture,
            self.receipt if receipt is None else receipt,
            fixture_id=FIXTURE_ID,
        )

    def assert_rejected_without_echo(self, capture=None, receipt=None):
        private_values = (
            "PRIVATE-SENTINEL",
            "Source Employer",
            "Synthetic Applicant",
            "private-synthetic-capture",
        )
        with self.assertRaises(CompilerError) as raised:
            self.compile(capture, receipt)
        message = str(raised.exception)
        self.assertRegex(message, r"^[a-z][a-z -]+$")
        for value in private_values:
            self.assertNotIn(value, message)
        return message

    def test_compiles_a_contract_valid_fixture(self):
        fixture = self.compile()
        self.assertIsNone(validate_fixture(fixture))

    def test_output_uses_only_catalog_controls_and_fixed_flow(self):
        fixture = self.compile()
        self.assertEqual(
            [(step["id"], step["kind"], step["title"]) for step in fixture["steps"]],
            [
                ("step-1", "form", "Application details"),
                ("step-2", "form", "Resume"),
                ("review", "review", "Review application"),
            ],
        )
        self.assertEqual(fixture["steps"][0]["next"], "step-2")
        self.assertEqual(fixture["steps"][1]["next"], "review")
        self.assertNotIn("next", fixture["steps"][2])
        self.assertNotIn("finalAction", fixture["steps"][0])
        self.assertNotIn("finalAction", fixture["steps"][1])
        self.assertEqual(fixture["steps"][2]["finalAction"], FINAL_ACTION)

        controls = [
            control for step in fixture["steps"] for control in step["controls"]
        ]
        self.assertEqual([control["id"] for control in controls], list(CATALOG))
        for control in controls:
            role, label = CATALOG[control["kind"]]
            self.assertEqual(control["id"], control["kind"])
            self.assertEqual(control["role"], role)
            self.assertEqual(control["label"], label)
            self.assertTrue(control["required"])

    def test_provenance_compiler_version_and_oracle_are_fixed(self):
        fixture = self.compile()
        self.assertEqual(fixture["compilerVersion"], COMPILER_VERSION)
        self.assertIsInstance(COMPILER_VERSION, str)
        self.assertTrue(COMPILER_VERSION)
        self.assertEqual(
            fixture["provenance"],
            {
                "recorderVersion": self.receipt["recorderVersion"],
                "captureMonth": self.receipt["captureMonth"],
                "sourceRecordingSha256": self.receipt["sourceRecordingSha256"],
            },
        )
        self.assertEqual(fixture["oracle"], {"finalActionActivations": 0})

    def test_serialization_contains_no_private_input_or_private_keys(self):
        fixture = self.compile()
        serialized = json.dumps(fixture, sort_keys=True, separators=(",", ":"))
        forbidden = (
            "sourceLabel",
            "sourceDeniedTerms",
            "captureId",
            "Source Employer",
            "Synthetic Applicant",
            "sourceUrl",
            "url",
            "company",
            "roleTitle",
            "applicant",
        )
        for value in forbidden:
            self.assertNotIn(value, serialized)

    def test_compilation_is_deterministic_and_canonicalizable(self):
        first = json.dumps(self.compile(), sort_keys=True, separators=(",", ":"))
        second = json.dumps(self.compile(), sort_keys=True, separators=(",", ":"))
        self.assertEqual(first, second)

    def test_compiled_candidate_passes_privacy_scan_with_denied_terms(self):
        with tempfile.TemporaryDirectory() as directory:
            candidate = Path(directory) / "candidate"
            candidate.mkdir()
            (candidate / "fixture.json").write_text(
                json.dumps(self.compile(), sort_keys=True, separators=(",", ":"))
            )
            self.assertIsNone(scan_tree(candidate, self.capture["sourceDeniedTerms"]))

    def test_rejects_unknown_keys_at_every_private_shape(self):
        cases = []
        capture = copy.deepcopy(self.capture)
        capture["sourceUrl"] = "PRIVATE-SENTINEL"
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0]["sourceUrl"] = "PRIVATE-SENTINEL"
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0]["controls"][0]["sourceUrl"] = "PRIVATE-SENTINEL"
        cases.append((capture, None))
        receipt = copy.deepcopy(self.receipt)
        receipt["sourceUrl"] = "PRIVATE-SENTINEL"
        cases.append((None, receipt))
        for capture, receipt in cases:
            with self.subTest(capture=capture is not None, receipt=receipt is not None):
                self.assert_rejected_without_echo(capture, receipt)

    def test_rejects_wrong_private_container_and_scalar_types(self):
        cases = [
            ([], None),
            ({}, None),
            (None, []),
        ]
        for key, invalid in (
            ("captureId", 7),
            ("platformFamily", []),
            ("captureMonth", 202608),
            ("sourceDeniedTerms", "PRIVATE-SENTINEL"),
            ("checkpoints", {}),
        ):
            capture = copy.deepcopy(self.capture)
            capture[key] = invalid
            cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0] = []
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0]["controls"] = {}
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0]["controls"][0] = []
        cases.append((capture, None))
        for key, invalid in (
            ("recorderVersion", 1),
            ("captureMonth", 202608),
            ("captureId", []),
            ("sourceRecordingSha256", 1),
        ):
            receipt = copy.deepcopy(self.receipt)
            receipt[key] = invalid
            cases.append((None, receipt))
        for capture, receipt in cases:
            with self.subTest(capture_type=type(capture), receipt_type=type(receipt)):
                self.assert_rejected_without_echo(capture, receipt)

    def test_rejects_mismatched_or_invalid_identity_fields(self):
        cases = []
        for key in ("captureId", "captureMonth"):
            receipt = copy.deepcopy(self.receipt)
            receipt[key] = "PRIVATE-SENTINEL"
            cases.append((None, receipt))
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "PRIVATE-SENTINEL"
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["captureMonth"] = "2026-13"
        cases.append((capture, None))
        for capture, receipt in cases:
            self.assert_rejected_without_echo(capture, receipt)

    def test_rejects_invalid_receipt_hash_and_version(self):
        for key, invalid in (
            ("sourceRecordingSha256", "A" * 64),
            ("sourceRecordingSha256", "a" * 63),
            ("sourceRecordingSha256", "g" * 64),
            ("recorderVersion", ""),
            ("recorderVersion", "   "),
        ):
            with self.subTest(key=key, invalid=invalid):
                receipt = copy.deepcopy(self.receipt)
                receipt[key] = invalid
                self.assert_rejected_without_echo(receipt=receipt)

    def test_recorder_version_requires_strict_semver_core_syntax(self):
        for invalid in (
            "nonsense",
            1,
            "1",
            "1.2",
            "1.2.3 extra",
            " 1.2.3",
            "1.2.3 ",
            "\n1.2.3",
            "1.2.3\n",
            "01.2.3",
            "1.02.3",
            "1.2.03",
            None,
        ):
            with self.subTest(invalid=invalid):
                receipt = copy.deepcopy(self.receipt)
                receipt["recorderVersion"] = invalid
                self.assert_rejected_without_echo(receipt=receipt)

        for valid in ("0.0.0", "1.0.0", "12.34.56"):
            with self.subTest(valid=valid):
                receipt = copy.deepcopy(self.receipt)
                receipt["recorderVersion"] = valid
                fixture = self.compile(receipt=receipt)
                self.assertEqual(fixture["provenance"]["recorderVersion"], valid)

    def test_rejects_duplicate_unsupported_or_out_of_order_checkpoints(self):
        variants = []
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"].insert(1, copy.deepcopy(capture["checkpoints"][0]))
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][1]["kind"] = "PRIVATE-SENTINEL"
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0], capture["checkpoints"][1] = (
            capture["checkpoints"][1],
            capture["checkpoints"][0],
        )
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"] = capture["checkpoints"][:2]
        variants.append(capture)
        for capture in variants:
            self.assert_rejected_without_echo(capture=capture)

    def test_rejects_invalid_control_semantics(self):
        variants = []
        for key, invalid in (
            ("kind", "PRIVATE-SENTINEL"),
            ("required", 1),
            ("sourceLabel", 7),
            ("sourceLabel", ""),
        ):
            capture = copy.deepcopy(self.capture)
            capture["checkpoints"][0]["controls"][0][key] = invalid
            variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][0]["controls"].append(
            copy.deepcopy(capture["checkpoints"][0]["controls"][0])
        )
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][1]["controls"][0]["kind"] = "contact.first_name"
        variants.append(capture)
        for capture in variants:
            self.assert_rejected_without_echo(capture=capture)

    def test_rejects_invalid_denied_terms(self):
        for invalid in (None, "PRIVATE-SENTINEL", [7], ["Source Employer", 7]):
            with self.subTest(invalid=invalid):
                capture = copy.deepcopy(self.capture)
                capture["sourceDeniedTerms"] = invalid
                self.assert_rejected_without_echo(capture=capture)

    def test_rejects_missing_review_or_final_action_observation(self):
        variants = []
        capture = copy.deepcopy(self.capture)
        del capture["checkpoints"][2]["finalActionObserved"]
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][2]["finalActionObserved"] = False
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][2]["finalActionObserved"] = 1
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"][2]["controls"] = [
            copy.deepcopy(capture["checkpoints"][0]["controls"][0])
        ]
        variants.append(capture)
        for capture in variants:
            self.assert_rejected_without_echo(capture=capture)


if __name__ == "__main__":
    unittest.main()
