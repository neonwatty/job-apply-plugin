from tests.support.oracle_fixtures import *
from tests.support.running_replay_server import *


class SemanticOracleTests(SemanticOracleCase):
    def test_complete_profile_passes_with_only_redacted_report_fields(self):
        report = self.evaluate()
        self.assertEqual(
            set(report),
            {
                "fixtureId",
                "scenarioId",
                "status",
                "assertions",
                "missingControlIds",
                "failureCategories",
            },
        )
        self.assertEqual(report["fixtureId"], "renderer-oracle-v1")
        self.assertEqual(report["scenarioId"], "complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])
        serialized = json.dumps(report)
        for secret in (
            "Synthetic Company Secret",
            "Synthetic Role Secret",
            "Synthetic pending description secret",
            str(self.store.root),
            "question.stable",
            "example.com",
        ):
            self.assertNotIn(secret, serialized)

    def test_committed_linkedin_screening_fixture_passes_with_closed_identity(self):
        fixture = json.loads(
            (
                ROOT
                / "qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json"
            ).read_text()
        )
        events = complete_events(fixture)
        optional = next(
            control
            for step in fixture["steps"]
            for control in step["controls"]
            if control["id"] == "preference.top_choice"
        )
        events.insert(
            -1,
            {
                "type": "filled",
                "controlId": optional["id"],
                "stepId": "step-3",
            },
        )

        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "linkedin-screening"},
            events=events,
        )

        self.assertEqual(report["scenarioId"], "linkedin-screening")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])

    def test_committed_greenhouse_fixture_passes_with_closed_identity(self):
        fixture = json.loads((
            ROOT / "qa/fixtures/greenhouse-single-page-2026-08-v1/fixture.json"
        ).read_text())
        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "greenhouse-complete-profile"},
            events=complete_events(fixture),
        )
        self.assertEqual(report["scenarioId"], "greenhouse-complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])

    def test_ashby_complete_profile_scenario_passes_with_closed_identity(self):
        fixture = valid_fixture()
        fixture["id"] = "ashby-application-2026-08-v1"
        fixture["platformFamily"] = "ashby"
        fixture["steps"][0]["controls"] = [
            {
                "id": "contact.full_name",
                "kind": "contact.full_name",
                "role": "textbox",
                "label": "Full name",
                "required": True,
            },
            {
                "id": "contact.email",
                "kind": "contact.email",
                "role": "textbox",
                "label": "Email address",
                "required": True,
            },
            {
                "id": "resume.file",
                "kind": "resume.file",
                "role": "file",
                "label": "Resume",
                "required": True,
            },
        ]
        fixture["steps"] = [fixture["steps"][0], fixture["steps"][-1]]
        fixture["steps"][0]["next"] = "review"
        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "ashby-complete-profile"},
            events=complete_events(fixture),
        )
        self.assertEqual(report["scenarioId"], "ashby-complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})

    def test_lever_complete_profile_scenario_passes_with_closed_identity(self):
        fixture = valid_fixture()
        fixture["id"] = "lever-application-2026-08-v1"
        fixture["platformFamily"] = "lever"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control(kind, required)
                    for kind, required in LEVER_CONTROL_PROFILE
                ],
                "next": "review",
            },
            fixture["steps"][-1],
        ]
        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "lever-complete-profile"},
            events=complete_events(fixture),
        )
        self.assertEqual(report["scenarioId"], "lever-complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])

    def test_store_root_may_be_an_already_open_owned_descriptor(self):
        descriptor = os.open(
            self.store.root,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        displaced = self.store.root.parent / "original-store"
        try:
            self.store.root.rename(displaced)
            replacement = OracleStore(self.store.root)
            replacement.write_history([])

            report = self.evaluate(store_root=descriptor)

            self.assertEqual(report["status"], "passed")
            self.assertTrue(os.fstat(descriptor).st_ino)
        finally:
            os.close(descriptor)

    def test_each_required_non_file_control_is_required(self):
        required = sorted(
            control["id"]
            for step in self.fixture["steps"]
            for control in step["controls"]
            if control["required"] and control["role"] != "file"
        )
        for missing_id in required:
            with self.subTest(missing_id=missing_id):
                events = [
                    event
                    for event in self.events
                    if not (
                        event["type"] == "filled"
                        and event["controlId"] == missing_id
                    )
                ]
                report = self.evaluate(events=events)
                self.assertEqual(report["status"], "failed")
                self.assertEqual(
                    report["assertions"]["required-fields-filled"], "failed"
                )
                self.assertEqual(report["missingControlIds"], [missing_id])
                self.assertIn("required-fields-missing", report["failureCategories"])

    def test_missing_required_upload_fails(self):
        events = [event for event in self.events if event["type"] != "uploaded"]
        report = self.evaluate(events=events)
        self.assertEqual(report["assertions"]["resume-uploaded"], "failed")
        self.assertEqual(report["missingControlIds"], ["resume.file"])
        self.assertIn("required-upload-missing", report["failureCategories"])

    def test_wrong_resume_filename_match_fails_without_exposing_filename(self):
        events = [
            {
                **event,
                "expectedFilenameMatched": False,
            }
            if event["type"] == "uploaded"
            else event
            for event in self.events
        ]
        report = self.evaluate(events=events)
        self.assertEqual(report["assertions"]["resume-filename-matched"], "failed")
        self.assertIn("resume-filename-mismatch", report["failureCategories"])
        self.assertNotIn("filename", json.dumps(report["missingControlIds"]))

    def test_missing_review_event_fails(self):
        events = [event for event in self.events if event["type"] != "reviewed"]
        report = self.evaluate(events=events)
        self.assertEqual(report["assertions"]["review-reached"], "failed")
        self.assertIn("review-not-reached", report["failureCategories"])

    def test_duplicate_success_events_are_tolerated(self):
        report = self.evaluate(events=self.events + [dict(self.events[0])])
        self.assertEqual(report["status"], "passed")

    def test_malformed_unknown_or_incoherent_events_fail_value_free(self):
        invalid = [
            [],
            {"type": "filled", "controlId": "contact.first_name"},
            {
                "type": "filled",
                "controlId": "contact.first_name",
                "stepId": "step-1",
                "value": "EVENT SECRET",
            },
            {"type": "mystery", "controlId": "", "stepId": "review"},
            {"type": 1, "controlId": "", "stepId": "review"},
            {"type": "filled", "controlId": 1, "stepId": "step-1"},
            {"type": "filled", "controlId": "missing-secret", "stepId": "step-1"},
            {
                "type": "filled",
                "controlId": "contact.first_name",
                "stepId": "missing-secret",
            },
            {"type": "filled", "controlId": "resume.file", "stepId": "step-2"},
            {
                "type": "uploaded",
                "controlId": "contact.first_name",
                "stepId": "step-1",
            },
            {"type": "advanced", "controlId": "x", "stepId": "step-1"},
            {"type": "advanced", "controlId": "", "stepId": "review"},
            {"type": "reviewed", "controlId": "", "stepId": "step-1"},
            {"type": "final-action", "stepId": "step-1"},
        ]
        for event in invalid:
            with self.subTest(event=event):
                with self.assertRaises(OracleError) as caught:
                    self.evaluate(events=self.events + [event])
                diagnostic = str(caught.exception)
                self.assertNotIn("EVENT SECRET", diagnostic)
                self.assertNotIn("missing-secret", diagnostic)

    def test_event_count_is_bounded(self):
        with self.assertRaisesRegex(OracleError, "invalid events"):
            self.evaluate(events=[dict(self.events[0])] * 10_001)

    def test_any_final_action_event_fails_even_in_saturated_list(self):
        for events in (
            self.events + [{"type": "final-action", "stepId": "review"}],
            [dict(self.events[0])] * 9_999
            + [{"type": "final-action", "stepId": "review"}],
        ):
            with self.subTest(size=len(events)):
                report = self.evaluate(events=events)
                self.assertEqual(
                    report["assertions"]["final-action-untouched"], "failed"
                )
                self.assertIn("final-action-activated", report["failureCategories"])

    def test_invalid_fixture_and_scenario_diagnostics_are_value_free(self):
        fixture = dict(self.fixture)
        fixture["private-secret"] = "FIXTURE SECRET"
        cases = (
            {"fixture": fixture},
            {"scenario": {"id": "SECRET SCENARIO"}},
            {"scenario": {"id": "other-scenario"}},
            {"scenario": {"id": "complete-profile", "value": "SECRET"}},
            {"scenario": []},
            {"store_root": Path(self.temporary.name) / "SECRET missing store"},
        )
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(OracleError) as caught:
                    self.evaluate(**case)
                self.assertNotIn("SECRET", str(caught.exception))
