import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from qa.compiler import COMPILER_VERSION, CompilerError, compile_capture
from qa.contracts import CATALOG, FINAL_ACTION, ContractError, validate_fixture
from qa.privacy import scan_tree


TESTDATA = Path(__file__).resolve().parents[1] / "qa" / "testdata" / "private-capture"
FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"


def source_files_digest(source_files):
    canonical = json.dumps(
        source_files, sort_keys=True, separators=(",", ":"), ensure_ascii=False
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


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

    def linkedin_screening_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {
                        "kind": "contact.email",
                        "sourceLabel": "Email",
                        "required": True,
                    },
                    {
                        "kind": "contact.phone",
                        "sourceLabel": "Mobile",
                        "required": True,
                    },
                ],
            },
            {
                "checkpoint": "step-advanced",
                "controls": [
                    {"kind": "resume.file", "sourceLabel": "Upload", "required": True}
                ],
            },
            {
                "checkpoint": "step-advanced",
                "controls": [
                    {
                        "kind": "preference.top_choice",
                        "sourceLabel": "Top choice",
                        "required": False,
                    }
                ],
            },
            {
                "checkpoint": "step-advanced",
                "controls": [
                    {
                        "kind": "authorization.sponsorship",
                        "sourceLabel": "Private source question",
                        "required": True,
                    }
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def greenhouse_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "greenhouse"
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {"kind": kind, "sourceLabel": f"Observed {index}", "required": required}
                    for index, (kind, required) in enumerate(
                        (
                            ("contact.first_name", True),
                            ("contact.last_name", True),
                            ("contact.preferred_name", False),
                            ("contact.email", True),
                            ("contact.phone_country", True),
                            ("contact.phone", True),
                            ("contact.location_city", True),
                            ("resume.file", True),
                            ("cover_letter.file", False),
                            ("profile.linkedin", True),
                            ("profile.website", False),
                            ("authorization.sponsorship_select", True),
                            ("employment.prior_affiliate", True),
                            ("source.discovery", True),
                            ("referral.contact", False),
                        ),
                        start=1,
                    )
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def ashby_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "ashby"
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {"kind": "contact.full_name", "sourceLabel": "Observed 1", "required": True},
                    {"kind": "contact.email", "sourceLabel": "Observed 2", "required": True},
                    {"kind": "resume.file", "sourceLabel": "Observed 3", "required": True},
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def lever_capture(self):
        capture = copy.deepcopy(self.capture)
        capture["platformFamily"] = "lever"
        profile = (
            ("resume.file", True),
            ("contact.full_name", True),
            ("contact.email", True),
            ("contact.phone", True),
            ("contact.location", True),
            ("employment.current_company", False),
            ("profile.location_url", False),
            ("profile.linkedin", True),
            ("profile.github", False),
            ("profile.portfolio", False),
            ("profile.website", False),
            ("authorization.work_authorized", True),
            ("authorization.sponsorship_status", True),
            ("source.discovery_radio", False),
            ("compensation.total_range", True),
            ("compensation.target_salary", False),
            ("employment.prior_company", True),
            ("conflict.related_person", True),
            ("conflict.customer_partner_reseller", True),
            ("location.us_resident", True),
            ("location.city_state", True),
            ("authorization.us_citizen", False),
            ("authorization.green_card", False),
            ("eeo.gender", False),
            ("eeo.race", False),
            ("eeo.veteran", False),
            ("eeo.disability", False),
        )
        capture["steps"] = [
            {
                "checkpoint": "application-opened",
                "controls": [
                    {
                        "kind": kind,
                        "sourceLabel": f"Observed {index}",
                        "required": required,
                    }
                    for index, (kind, required) in enumerate(profile, start=1)
                ],
            },
            {
                "checkpoint": "review-reached",
                "controls": [],
                "finalActionObserved": True,
            },
        ]
        return capture

    def test_compiles_a_contract_valid_fixture(self):
        fixture = self.compile()
        self.assertIsNone(validate_fixture(fixture))

    def test_compiles_current_linkedin_screening_flow(self):
        fixture = self.compile(capture=self.linkedin_screening_capture())
        self.assertIsNone(validate_fixture(fixture))
        self.assertEqual(
            [
                tuple(control["id"] for control in step["controls"])
                for step in fixture["steps"]
            ],
            [
                ("contact.email", "contact.phone"),
                ("resume.file",),
                ("preference.top_choice",),
                ("authorization.sponsorship",),
                (),
            ],
        )
        self.assertEqual(
            [step["title"] for step in fixture["steps"]],
            [
                "Contact information",
                "Resume",
                "Job preference",
                "Work authorization",
                "Review application",
            ],
        )
        self.assertEqual(fixture["steps"][3]["next"], "review")
        self.assertEqual(
            fixture["steps"][3]["controls"][0]["choices"], ["Yes", "No"]
        )

    def test_compiles_closed_greenhouse_single_page_flow(self):
        fixture = self.compile(capture=self.greenhouse_capture())
        self.assertIsNone(validate_fixture(fixture))
        self.assertEqual(fixture["platformFamily"], "greenhouse")
        self.assertEqual(
            [step["title"] for step in fixture["steps"]],
            ["Application form", "Review application"],
        )
        controls = fixture["steps"][0]["controls"]
        self.assertEqual(
            [control["id"] for control in controls],
            [
                "contact.first_name",
                "contact.last_name",
                "contact.preferred_name",
                "contact.email",
                "contact.phone_country",
                "contact.phone",
                "contact.location_city",
                "resume.file",
                "cover_letter.file",
                "profile.linkedin",
                "profile.website",
                "authorization.sponsorship_select",
                "employment.prior_affiliate",
                "source.discovery",
                "referral.contact",
            ],
        )
        self.assertEqual(
            next(
                control
                for control in controls
                if control["id"] == "authorization.sponsorship_select"
            )["choices"],
            ["Yes", "No"],
        )

    def test_greenhouse_flow_remains_closed(self):
        capture = self.greenhouse_capture()
        capture["steps"][0]["controls"][2]["required"] = True
        self.assert_rejected_without_echo(capture=capture)

    def test_compiles_closed_ashby_single_page_flow(self):
        fixture = self.compile(capture=self.ashby_capture())
        self.assertIsNone(validate_fixture(fixture))
        self.assertEqual(fixture["platformFamily"], "ashby")
        self.assertEqual(
            [step["title"] for step in fixture["steps"]],
            ["Application form", "Review application"],
        )
        self.assertEqual(
            [control["id"] for control in fixture["steps"][0]["controls"]],
            ["contact.full_name", "contact.email", "resume.file"],
        )

    def test_ashby_flow_remains_closed(self):
        capture = self.ashby_capture()
        capture["steps"][0]["controls"][0]["required"] = False
        self.assert_rejected_without_echo(capture=capture)

    def test_compiles_exact_closed_lever_single_page_flow(self):
        fixture = self.compile(capture=self.lever_capture())
        self.assertIsNone(validate_fixture(fixture))
        self.assertEqual(fixture["platformFamily"], "lever")
        self.assertEqual(
            [step["title"] for step in fixture["steps"]],
            ["Application form", "Review application"],
        )
        controls = fixture["steps"][0]["controls"]
        self.assertEqual(
            [control["id"] for control in controls],
            [control["kind"] for control in self.lever_capture()["steps"][0]["controls"]],
        )
        self.assertEqual(
            next(control for control in controls if control["id"] == "compensation.total_range")["choices"],
            [
                "Below $100,000",
                "$100,000–$199,999",
                "$200,000–$259,999",
                "$260,000+",
            ],
        )
        self.assertEqual(
            next(control for control in controls if control["id"] == "eeo.race")["role"],
            "radiogroup",
        )

    def test_lever_flow_rejects_any_profile_drift(self):
        capture = self.lever_capture()
        capture["steps"][0]["controls"][5]["required"] = True
        self.assert_rejected_without_echo(capture=capture)

        capture = self.lever_capture()
        capture["steps"][0]["controls"].append(
            {"kind": "contact.first_name", "sourceLabel": "Private", "required": False}
        )
        self.assert_rejected_without_echo(capture=capture)

        capture = self.lever_capture()
        capture["steps"][0]["controls"][11], capture["steps"][0]["controls"][12] = (
            capture["steps"][0]["controls"][12],
            capture["steps"][0]["controls"][11],
        )
        self.assert_rejected_without_echo(capture=capture)

        capture = self.ashby_capture()
        capture["steps"][0]["controls"].append(
            {"kind": "contact.phone", "sourceLabel": "Private", "required": False}
        )
        self.assert_rejected_without_echo(capture=capture)

        capture = self.greenhouse_capture()
        capture["steps"][0]["controls"].append(
            {"kind": "preference.top_choice", "sourceLabel": "Private", "required": False}
        )
        self.assert_rejected_without_echo(capture=capture)

    def test_screening_flow_remains_closed(self):
        capture = self.linkedin_screening_capture()
        capture["steps"][2]["controls"][0]["required"] = True
        self.assert_rejected_without_echo(capture=capture)

        capture = self.linkedin_screening_capture()
        capture["steps"][3]["controls"][0]["kind"] = "PRIVATE-SENTINEL"
        self.assert_rejected_without_echo(capture=capture)

    def test_compiler_error_is_a_contract_error(self):
        capture = copy.deepcopy(self.capture)
        capture["unexpected"] = "PRIVATE-SENTINEL"
        with self.assertRaises(ContractError) as raised:
            self.compile(capture=capture)
        self.assertIsInstance(raised.exception, CompilerError)
        self.assertNotIn("PRIVATE-SENTINEL", str(raised.exception))

    def test_rejects_retired_checkpoints_and_kind_input_shape(self):
        capture = copy.deepcopy(self.capture)
        capture["checkpoints"] = capture.pop("steps")
        self.assert_rejected_without_echo(capture=capture)

        capture = copy.deepcopy(self.capture)
        capture["steps"][0]["kind"] = capture["steps"][0].pop("checkpoint")
        self.assert_rejected_without_echo(capture=capture)

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
        self.assertEqual(
            [control["id"] for control in controls],
            [
                "contact.first_name",
                "contact.last_name",
                "contact.email",
                "contact.phone",
                "resume.file",
            ],
        )
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
                "sourceRecordingSha256": source_files_digest(
                    self.receipt["sourceFiles"]
                ),
            },
        )
        self.assertEqual(fixture["oracle"], {"finalActionActivations": 0})

    def test_source_file_digest_is_canonical_and_content_sensitive(self):
        first = copy.deepcopy(self.receipt)
        reversed_items = reversed(list(first["sourceFiles"].items()))
        reordered = copy.deepcopy(first)
        reordered["sourceFiles"] = dict(reversed_items)
        self.assertEqual(
            self.compile(receipt=first),
            self.compile(receipt=reordered),
        )

        path_changed = copy.deepcopy(first)
        file_hash = path_changed["sourceFiles"].pop(
            "checkpoints/application-opened/page.html"
        )
        path_changed["sourceFiles"]["checkpoints/application-opened/body.html"] = (
            file_hash
        )
        hash_changed = copy.deepcopy(first)
        hash_changed["sourceFiles"]["checkpoints/application-opened/page.html"] = (
            "d" * 64
        )
        original_digest = self.compile(receipt=first)["provenance"][
            "sourceRecordingSha256"
        ]
        self.assertNotEqual(
            original_digest,
            self.compile(receipt=path_changed)["provenance"][
                "sourceRecordingSha256"
            ],
        )
        self.assertNotEqual(
            original_digest,
            self.compile(receipt=hash_changed)["provenance"][
                "sourceRecordingSha256"
            ],
        )

    def test_rejects_invalid_source_file_maps_paths_and_hashes(self):
        invalid_source_files = (
            {},
            [],
            {"": "a" * 64},
            {"/PRIVATE-SENTINEL": "a" * 64},
            {".": "a" * 64},
            {"..": "a" * 64},
            {"a/./b.html": "a" * 64},
            {"a/../b.html": "a" * 64},
            {"a\\b.html": "a" * 64},
            {"C:/capture/page.html": "a" * 64},
            {"C:\\capture\\page.html": "a" * 64},
            {"a//b.html": "a" * 64},
            {"a/PRIVATE-SENTINEL\n.html": "a" * 64},
            {"a.html": "A" * 64},
            {"a.html": "a" * 63},
            {"a.html": "g" * 64},
            {"a.html": 7},
        )
        for invalid in invalid_source_files:
            with self.subTest(invalid=invalid):
                receipt = copy.deepcopy(self.receipt)
                receipt["sourceFiles"] = invalid
                self.assert_rejected_without_echo(receipt=receipt)

    def test_source_file_work_limits_accept_boundaries_and_reject_excess(self):
        receipt = copy.deepcopy(self.receipt)
        receipt["sourceFiles"] = {"one": "a" * 64, "two": "b" * 64}
        with mock.patch("qa.compiler.MAX_SOURCE_FILES", 2):
            self.assertIsNotNone(self.compile(receipt=receipt))

            receipt["sourceFiles"]["three"] = "c" * 64
            self.assert_rejected_without_echo(receipt=receipt)

        receipt = copy.deepcopy(self.receipt)
        receipt["sourceFiles"] = {"ééé": "a" * 64}
        with mock.patch("qa.compiler.MAX_SOURCE_PATH_CHARS", 3):
            self.assertIsNotNone(self.compile(receipt=receipt))

            receipt["sourceFiles"] = {"éééé": "a" * 64}
            self.assert_rejected_without_echo(receipt=receipt)

    def test_private_text_and_capture_identifiers_are_noninterfering(self):
        first_capture = copy.deepcopy(self.capture)
        first_receipt = copy.deepcopy(self.receipt)
        second_capture = copy.deepcopy(self.capture)
        second_receipt = copy.deepcopy(self.receipt)

        second_capture["captureId"] = "PRIVATE-SENTINEL-SECOND-CAPTURE"
        second_receipt["captureId"] = "PRIVATE-SENTINEL-SECOND-CAPTURE"
        second_capture["sourceDeniedTerms"] = [
            "PRIVATE-SENTINEL-DENIED-ONE",
            "PRIVATE-SENTINEL-DENIED-TWO",
        ]
        label_index = 0
        for step in second_capture["steps"]:
            for control in step["controls"]:
                label_index += 1
                control["sourceLabel"] = (
                    f"PRIVATE-SENTINEL-SOURCE-LABEL-{label_index}"
                )

        first_bytes = json.dumps(
            self.compile(first_capture, first_receipt),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        second_bytes = json.dumps(
            self.compile(second_capture, second_receipt),
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        self.assertEqual(first_bytes, second_bytes)

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
        capture["steps"][0]["sourceUrl"] = "PRIVATE-SENTINEL"
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["steps"][0]["controls"][0]["sourceUrl"] = "PRIVATE-SENTINEL"
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
            ("steps", {}),
        ):
            capture = copy.deepcopy(self.capture)
            capture[key] = invalid
            cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["steps"][0] = []
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["steps"][0]["controls"] = {}
        cases.append((capture, None))
        capture = copy.deepcopy(self.capture)
        capture["steps"][0]["controls"][0] = []
        cases.append((capture, None))
        for key, invalid in (
            ("recorderVersion", 1),
            ("captureMonth", 202608),
            ("captureId", []),
            ("sourceFiles", []),
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

    def test_rejects_invalid_recorder_version(self):
        for key, invalid in (
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
        capture["steps"].insert(1, copy.deepcopy(capture["steps"][0]))
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][1]["checkpoint"] = "PRIVATE-SENTINEL"
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][0], capture["steps"][1] = (
            capture["steps"][1],
            capture["steps"][0],
        )
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"] = capture["steps"][:2]
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
            capture["steps"][0]["controls"][0][key] = invalid
            variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][0]["controls"].append(
            copy.deepcopy(capture["steps"][0]["controls"][0])
        )
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][1]["controls"][0]["kind"] = "contact.first_name"
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
        del capture["steps"][2]["finalActionObserved"]
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][2]["finalActionObserved"] = False
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][2]["finalActionObserved"] = 1
        variants.append(capture)
        capture = copy.deepcopy(self.capture)
        capture["steps"][2]["controls"] = [
            copy.deepcopy(capture["steps"][0]["controls"][0])
        ]
        variants.append(capture)
        for capture in variants:
            self.assert_rejected_without_echo(capture=capture)


if __name__ == "__main__":
    unittest.main()
