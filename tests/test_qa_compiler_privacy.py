from tests.support.compiler_case import *


class CompilerTests(CompilerCase):
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
