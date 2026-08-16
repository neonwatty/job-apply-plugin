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

    def valid_greenhouse_fixture(self):
        fixture = self.valid_fixture()
        fixture["id"] = "greenhouse-single-page-2026-08-v1"
        fixture["platformFamily"] = "greenhouse"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control("contact.first_name", required=True),
                    generic_control("contact.last_name", required=True),
                    generic_control("contact.preferred_name", required=False),
                    generic_control("contact.email", required=True),
                    generic_control("contact.phone_country", required=True),
                    generic_control("contact.phone", required=True),
                    generic_control("contact.location_city", required=True),
                    generic_control("resume.file", required=True),
                    generic_control("cover_letter.file", required=False),
                    generic_control("profile.linkedin", required=True),
                    generic_control("profile.website", required=False),
                    generic_control(
                        "authorization.sponsorship_select", required=True
                    ),
                    generic_control("employment.prior_affiliate", required=True),
                    generic_control("source.discovery", required=True),
                    generic_control("referral.contact", required=False),
                ],
                "next": "review",
            },
            {
                "id": "review",
                "kind": "review",
                "title": "Review application",
                "controls": [],
                "finalAction": copy.deepcopy(fixture["steps"][-1]["finalAction"]),
            },
        ]
        return fixture

    def valid_ashby_fixture(self):
        fixture = self.valid_fixture()
        fixture["id"] = "ashby-application-2026-08-v1"
        fixture["platformFamily"] = "ashby"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control("contact.full_name", required=True),
                    generic_control("contact.email", required=True),
                    generic_control("resume.file", required=True),
                ],
                "next": "review",
            },
            {
                "id": "review",
                "kind": "review",
                "title": "Review application",
                "controls": [],
                "finalAction": copy.deepcopy(fixture["steps"][-1]["finalAction"]),
            },
        ]
        return fixture

    def valid_lever_fixture(self):
        fixture = self.valid_fixture()
        fixture["id"] = "lever-application-2026-08-v1"
        fixture["platformFamily"] = "lever"
        kinds = (
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
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [generic_control(kind, required) for kind, required in kinds],
                "next": "review",
            },
            {
                "id": "review",
                "kind": "review",
                "title": "Review application",
                "controls": [],
                "finalAction": copy.deepcopy(fixture["steps"][-1]["finalAction"]),
            },
        ]
        return fixture

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

    def test_catalog_generates_closed_linkedin_screening_controls(self):
        self.assertEqual(
            generic_control("preference.top_choice", required=False),
            {
                "id": "preference.top_choice",
                "kind": "preference.top_choice",
                "role": "checkbox",
                "label": "Mark as a top choice",
                "required": False,
            },
        )
        self.assertEqual(
            generic_control("authorization.sponsorship", required=True),
            {
                "id": "authorization.sponsorship",
                "kind": "authorization.sponsorship",
                "role": "radiogroup",
                "label": "Will you require employment visa sponsorship?",
                "required": True,
                "choices": ["Yes", "No"],
            },
        )

    def test_catalog_choice_shape_is_exact(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"] = [
            generic_control("authorization.sponsorship", required=True)
        ]
        self.assertIsNone(validate_fixture(fixture))

        fixture["steps"][0]["controls"][0]["choices"] = ["No", "Yes"]
        self.assert_contract_error(
            fixture,
            "control authorization.sponsorship has non-catalog choices",
        )

    def test_valid_fixture_is_accepted(self):
        self.assertIsNone(validate_fixture(self.valid_fixture()))

    def test_closed_greenhouse_single_page_fixture_is_accepted(self):
        fixture = self.valid_greenhouse_fixture()
        self.assertIsNone(validate_fixture(fixture))
        controls = fixture["steps"][0]["controls"]
        self.assertEqual(
            next(
                control
                for control in controls
                if control["id"] == "contact.phone_country"
            ),
            {
                "id": "contact.phone_country",
                "kind": "contact.phone_country",
                "role": "combobox",
                "label": "Phone country",
                "required": True,
                "choices": ["United States +1", "Canada +1"],
            },
        )
        self.assertEqual(
            next(
                control
                for control in controls
                if control["id"] == "source.discovery"
            )["choices"],
            ["LinkedIn (Social Media)", "Other"],
        )

    def test_closed_ashby_single_page_fixture_is_accepted(self):
        fixture = self.valid_ashby_fixture()
        self.assertIsNone(validate_fixture(fixture))
        self.assertEqual(
            fixture["steps"][0]["controls"],
            [
                {
                    "id": "contact.full_name",
                    "kind": "contact.full_name",
                    "role": "textbox",
                    "label": "Full name",
                    "required": True,
                },
                generic_control("contact.email", required=True),
                generic_control("resume.file", required=True),
            ],
        )

        fixture["steps"][0]["controls"].append(
            generic_control("contact.phone", required=False)
        )
        self.assert_contract_error(
            fixture, "control kind is not supported for platform"
        )

    def test_closed_lever_fixture_uses_exact_roles_choices_and_order(self):
        fixture = self.valid_lever_fixture()
        self.assertIsNone(validate_fixture(fixture))
        controls = fixture["steps"][0]["controls"]
        self.assertEqual(controls[0]["id"], "resume.file")
        self.assertEqual(
            next(control for control in controls if control["id"] == "contact.location"),
            {
                "id": "contact.location",
                "kind": "contact.location",
                "role": "combobox",
                "label": "Current location",
                "required": True,
                "choices": [
                    "Phoenix, Arizona, United States",
                    "Seattle, Washington, United States",
                ],
            },
        )
        self.assertEqual(
            next(control for control in controls if control["id"] == "eeo.disability")["choices"],
            ["Yes", "No", "Decline to answer"],
        )

        controls[12]["choices"] = ["No", "Yes", "Not applicable"]
        self.assert_contract_error(
            fixture,
            "control authorization.sponsorship_status has non-catalog choices",
        )

    def test_lever_fixture_rejects_step_and_control_profile_drift(self):
        cases = []
        fixture = self.valid_lever_fixture()
        fixture["steps"][0]["id"] = "application"
        fixture["steps"][0]["next"] = "review"
        cases.append(fixture)

        fixture = self.valid_lever_fixture()
        fixture["steps"][0]["title"] = "Other form"
        cases.append(fixture)

        fixture = self.valid_lever_fixture()
        fixture["steps"][1]["title"] = "Other review"
        cases.append(fixture)

        fixture = self.valid_lever_fixture()
        fixture["steps"][0]["controls"][5]["required"] = True
        cases.append(fixture)

        fixture = self.valid_lever_fixture()
        fixture["steps"][0]["controls"][0], fixture["steps"][0]["controls"][1] = (
            fixture["steps"][0]["controls"][1],
            fixture["steps"][0]["controls"][0],
        )
        cases.append(fixture)

        for fixture in cases:
            with self.subTest(fixture=fixture):
                self.assert_contract_error(fixture, "unsupported Lever fixture flow")

    def test_platform_control_catalogs_cannot_be_mixed(self):
        fixture = self.valid_greenhouse_fixture()
        fixture["steps"][0]["controls"].append(
            generic_control("preference.top_choice", required=False)
        )
        self.assert_contract_error(
            fixture, "control kind is not supported for platform"
        )

        fixture = self.valid_fixture()
        fixture["steps"][0]["controls"].append(
            generic_control("contact.location_city", required=True)
        )
        self.assert_contract_error(
            fixture, "control kind is not supported for platform"
        )

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

    def test_fixture_flow_rejects_self_cycle(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["next"] = "step-1"
        self.assert_contract_error(fixture, "fixture flow contains a cycle")

    def test_fixture_flow_rejects_multi_node_cycle(self):
        fixture = self.valid_fixture()
        fixture["steps"][1]["next"] = "step-1"
        self.assert_contract_error(fixture, "fixture flow contains a cycle")

    def test_fixture_flow_rejects_unreachable_declared_step(self):
        fixture = self.valid_fixture()
        fixture["steps"][0]["next"] = "review"
        self.assert_contract_error(fixture, "fixture flow has unreachable steps")

    def test_fixture_flow_rejects_review_entry_with_trailing_forms(self):
        fixture = self.valid_fixture()
        fixture["steps"] = [
            fixture["steps"][2],
            fixture["steps"][0],
            fixture["steps"][1],
        ]
        self.assert_contract_error(fixture, "fixture flow has unreachable steps")

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

    def test_choices_are_not_supported_for_non_choice_controls(self):
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
