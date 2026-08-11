import copy
import unittest

from qa.contracts import ContractError, generic_control, validate_fixture


class ContractTests(unittest.TestCase):
    def valid_fixture(self):
        return {
            "schemaVersion": 1,
            "id": "linkedin-easy-apply-short-2026-08-v1",
            "platformFamily": "linkedin-easy-apply",
            "captureMonth": "2026-08",
            "compilerVersion": "1.0.0",
            "provenance": {
                "recorderVersion": "1.0.0",
                "captureMonth": "2026-08",
                "sourceRecordingSha256": "a" * 64,
            },
            "steps": [
                {
                    "id": "step-1",
                    "kind": "form",
                    "title": "Application details",
                    "controls": [
                        generic_control("contact.first_name", required=True),
                        generic_control("contact.last_name", required=True),
                        generic_control("contact.email", required=True),
                        generic_control("contact.phone", required=True),
                    ],
                    "next": "step-2",
                },
                {
                    "id": "step-2",
                    "kind": "form",
                    "title": "Application details",
                    "controls": [generic_control("resume.file", required=True)],
                    "next": "review",
                },
                {
                    "id": "review",
                    "kind": "review",
                    "title": "Review application",
                    "controls": [],
                    "finalAction": {
                        "id": "final.apply",
                        "label": "Submit application",
                        "enabled": True,
                        "tripwire": True,
                    },
                },
            ],
            "oracle": {"finalActionActivations": 0},
        }

    def assert_contract_error(self, fixture, message):
        with self.assertRaisesRegex(ContractError, f"^{message}$"):
            validate_fixture(fixture)

    def test_catalog_generates_source_independent_contact_control(self):
        self.assertEqual(
            generic_control("contact.first_name", required=True),
            {
                "id": "contact.first_name",
                "kind": "contact.first_name",
                "role": "textbox",
                "label": "First name",
                "required": True,
            },
        )

    def test_valid_fixture_is_accepted(self):
        self.assertIsNone(validate_fixture(self.valid_fixture()))

    def test_fixture_rejects_unknown_keys_and_source_strings(self):
        fixture = self.valid_fixture()
        fixture["sourceUrl"] = "https://linkedin.example/private"
        with self.assertRaisesRegex(ContractError, "unknown fixture key"):
            validate_fixture(fixture)

    def test_duplicate_control_ids_are_rejected(self):
        fixture = self.valid_fixture()
        fixture["steps"][1]["controls"] = [
            copy.deepcopy(fixture["steps"][0]["controls"][0])
        ]
        self.assert_contract_error(fixture, "duplicate control id")

    def test_review_step_is_required(self):
        fixture = self.valid_fixture()
        fixture["steps"][2]["kind"] = "form"
        self.assert_contract_error(fixture, "review step is required")

    def test_enabled_tripwire_is_required(self):
        fixture = self.valid_fixture()
        fixture["steps"][2]["finalAction"]["tripwire"] = False
        self.assert_contract_error(
            fixture, "enabled final-action tripwire is required"
        )

    def test_final_action_boolean_types_are_strict(self):
        fixture = self.valid_fixture()
        fixture["steps"][2]["finalAction"]["enabled"] = 1
        self.assert_contract_error(
            fixture, "enabled final-action tripwire is required"
        )

    def test_next_target_must_exist(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["next"] = "missing"
        self.assert_contract_error(fixture, "next target does not exist")

    def test_oracle_requires_zero_final_activations(self):
        fixture = self.valid_fixture()
        fixture["oracle"]["finalActionActivations"] = 1
        self.assert_contract_error(
            fixture, "oracle must require zero final-action activations"
        )

    def test_duplicate_step_ids_are_rejected(self):
        fixture = self.valid_fixture()
        fixture["steps"][1]["id"] = "step-1"
        self.assert_contract_error(fixture, "duplicate step id")

    def test_invalid_fixture_ids_are_rejected(self):
        for invalid in (
            "LinkedIn-v1",
            "linkedin_easy_apply-v1",
            "linkedin-v0",
            "linkedin-v01",
            "linkedin-v1-extra",
            "",
            1,
        ):
            with self.subTest(invalid=invalid):
                fixture = self.valid_fixture()
                fixture["id"] = invalid
                self.assert_contract_error(fixture, "invalid fixture id")

    def test_invalid_capture_months_are_rejected(self):
        for invalid in ("1999-12", "2026-00", "2026-13", "2026-8", 202608):
            with self.subTest(invalid=invalid):
                fixture = self.valid_fixture()
                fixture["captureMonth"] = invalid
                self.assert_contract_error(fixture, "invalid capture month")

    def test_platform_and_schema_are_strict(self):
        fixture = self.valid_fixture()
        fixture["platformFamily"] = "other"
        self.assert_contract_error(fixture, "unsupported platform family")

        fixture = self.valid_fixture()
        fixture["schemaVersion"] = 2
        self.assert_contract_error(fixture, "unsupported fixture schemaVersion")

        fixture = self.valid_fixture()
        fixture["schemaVersion"] = True
        self.assert_contract_error(fixture, "unsupported fixture schemaVersion")

    def test_top_level_field_types_are_rejected(self):
        cases = (
            ("compilerVersion", 1, "compilerVersion must be a non-empty string"),
            ("compilerVersion", "  ", "compilerVersion must be a non-empty string"),
            ("provenance", [], "provenance must be an object"),
            ("steps", {}, "steps must be an array"),
            ("oracle", [], "oracle must be an object"),
        )
        for key, invalid, message in cases:
            with self.subTest(key=key, invalid=invalid):
                fixture = self.valid_fixture()
                fixture[key] = invalid
                self.assert_contract_error(fixture, message)

    def test_unknown_step_and_control_keys_are_rejected(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["sourceTitle"] = "private"
        self.assert_contract_error(fixture, "unknown step key: sourceTitle")

        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"][0]["sourceLabel"] = "private"
        self.assert_contract_error(fixture, "unknown control key: sourceLabel")

    def test_step_and_control_container_types_are_rejected(self):
        fixture = self.valid_fixture()
        fixture["steps"][0] = "step"
        self.assert_contract_error(fixture, "step must be an object")

        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"] = {}
        self.assert_contract_error(fixture, "controls must be an array")

        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"][0] = "control"
        self.assert_contract_error(fixture, "control must be an object")

    def test_step_strings_are_required(self):
        for key, invalid in (("id", ""), ("kind", "  "), ("title", 7)):
            with self.subTest(key=key, invalid=invalid):
                fixture = self.valid_fixture()
                fixture["steps"][0][key] = invalid
                self.assert_contract_error(
                    fixture, f"step {key} must be a non-empty string"
                )

    def test_unsupported_step_kinds_are_rejected(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["kind"] = "redirect-with-source-script"
        self.assert_contract_error(
            fixture, "unsupported step kind: redirect-with-source-script"
        )

    def test_unsupported_catalog_kinds_are_rejected(self):
        with self.assertRaisesRegex(
            ContractError, "^unsupported control kind: employer.name$"
        ):
            generic_control("employer.name", required=True)

        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"][0]["kind"] = "employer.name"
        self.assert_contract_error(
            fixture, "unsupported control kind: employer.name"
        )

    def test_non_catalog_control_values_are_rejected(self):
        cases = (
            ("id", "custom", "control custom has non-catalog id"),
            ("role", "combobox", "control contact.first_name has non-catalog role"),
            ("label", "Given name", "control contact.first_name has non-catalog label"),
        )
        for key, invalid, message in cases:
            with self.subTest(key=key):
                fixture = self.valid_fixture()
                fixture["steps"][0]["controls"][0][key] = invalid
                self.assert_contract_error(fixture, message)

    def test_required_must_be_boolean(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"][0]["required"] = 1
        self.assert_contract_error(fixture, "control required must be a boolean")

        with self.assertRaisesRegex(
            ContractError, "^control required must be a boolean$"
        ):
            generic_control("contact.first_name", required=1)

    def test_choices_are_not_supported_by_catalog_v1(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"][0]["choices"] = []
        self.assert_contract_error(fixture, "control choices are not supported")

    def test_nested_receipt_and_action_objects_are_closed(self):
        fixture = self.valid_fixture()
        fixture["provenance"]["sourceUrl"] = "private"
        self.assert_contract_error(fixture, "unknown provenance key: sourceUrl")

        fixture = self.valid_fixture()
        fixture["steps"][2]["finalAction"]["href"] = "private"
        self.assert_contract_error(fixture, "unknown finalAction key: href")

        fixture = self.valid_fixture()
        fixture["oracle"]["extra"] = True
        self.assert_contract_error(fixture, "unknown oracle key: extra")

    def test_provenance_values_are_validated(self):
        cases = (
            ("recorderVersion", "", "recorderVersion must be a non-empty string"),
            ("captureMonth", "2026-13", "invalid provenance capture month"),
            (
                "sourceRecordingSha256",
                "not-a-hash",
                "invalid source recording sha256",
            ),
        )
        for key, invalid, message in cases:
            with self.subTest(key=key):
                fixture = self.valid_fixture()
                fixture["provenance"][key] = invalid
                self.assert_contract_error(fixture, message)

    def test_missing_required_fields_fail_closed(self):
        for key in (
            "schemaVersion",
            "id",
            "platformFamily",
            "captureMonth",
            "compilerVersion",
            "provenance",
            "steps",
            "oracle",
        ):
            with self.subTest(key=key):
                fixture = self.valid_fixture()
                del fixture[key]
                with self.assertRaises(ContractError):
                    validate_fixture(fixture)


if __name__ == "__main__":
    unittest.main()
