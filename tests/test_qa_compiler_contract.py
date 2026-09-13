from tests.support.compiler_case import *


class CompilerTests(CompilerCase):
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
