from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class CommittedScenarioTests(CommittedScenarioCase):
    def test_complete_profile_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())

        self.assertEqual(profile["name"], "Avery Replay")
        self.assertEqual(
            (profile["firstName"], profile["lastName"]),
            ("Avery", "Replay"),
        )
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertRegex(profile["phone"], r"^[2-9][0-9]{2}-555-01[0-9]{2}$")
        self.assertEqual(profile["location"]["city"], "Phoenix")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        for forbidden_key in (
            "workHistory",
            "education",
            "linkedInUrl",
            "portfolioUrl",
            "githubUrl",
        ):
            self.assertNotIn(forbidden_key, profile)

        self.assertEqual(
            expected,
            {
                "controlIds": [
                    "contact.first_name",
                    "contact.last_name",
                    "contact.email",
                    "contact.phone",
                    "resume.file",
                ],
                "resumeFilename": "synthetic-resume.pdf",
            },
        )
        serialized_expected = json.dumps(expected).casefold()
        for value in (
            profile["name"],
            profile["email"],
            profile["phone"],
            profile["location"]["city"],
        ):
            self.assertNotIn(value.casefold(), serialized_expected)

        extracted = validate_committed_synthetic_pdf(
            (scenario_root / "synthetic-resume.pdf").read_bytes()
        )
        for expected_text in (
            "AVERY REPLAY",
            "Fictional Applicant",
            "Phoenix, Arizona",
            "avery.replay@example.com",
            "602-555-0142",
            "Communication",
            "Organization",
            "Problem solving",
            "Attention to detail",
        ):
            self.assertIn(expected_text, extracted)

    def test_greenhouse_complete_profile_scenario_matches_committed_fixture(self) -> None:
        scenario_root = ROOT / "qa/scenarios/greenhouse-complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        fixture = json.loads((
            ROOT / "qa/fixtures/greenhouse-single-page-2026-08-v1/fixture.json"
        ).read_text())
        fixture_control_ids = [
            control["id"]
            for step in fixture["steps"]
            for control in step["controls"]
        ]
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertEqual(expected, {
            "controlIds": fixture_control_ids,
            "resumeFilename": "synthetic-resume.pdf",
        })
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_ashby_complete_profile_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/ashby-complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        self.assertEqual(expected, {
            "controlIds": ["contact.full_name", "contact.email", "resume.file"],
            "resumeFilename": "synthetic-resume.pdf",
        })
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_lever_complete_profile_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/lever-complete-profile"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        self.assertEqual(
            expected["controlIds"],
            [
                "resume.file", "contact.full_name", "contact.email",
                "contact.phone", "contact.location", "employment.current_company",
                "profile.location_url", "profile.linkedin", "profile.github",
                "profile.portfolio", "profile.website",
                "authorization.work_authorized", "authorization.sponsorship_status",
                "source.discovery_radio", "compensation.total_range",
                "compensation.target_salary", "employment.prior_company",
                "conflict.related_person", "conflict.customer_partner_reseller",
                "location.us_resident", "location.city_state",
                "authorization.us_citizen", "authorization.green_card",
                "eeo.gender", "eeo.race", "eeo.veteran", "eeo.disability",
            ],
        )
        self.assertEqual(expected["resumeFilename"], "synthetic-resume.pdf")
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_linkedin_screening_scenario_is_closed_and_synthetic(self) -> None:
        scenario_root = ROOT / "qa/scenarios/linkedin-screening"
        self.assertEqual(
            {path.name for path in scenario_root.iterdir()},
            {"profile.json", "synthetic-resume.pdf", "expected.json"},
        )
        profile = json.loads((scenario_root / "profile.json").read_text())
        expected = json.loads((scenario_root / "expected.json").read_text())
        self.assertEqual(profile["name"], "Avery Replay")
        self.assertRegex(profile["email"], r"^[a-z.]+@example\.com$")
        self.assertRegex(profile["phone"], r"^[2-9][0-9]{2}-555-01[0-9]{2}$")
        self.assertEqual(profile["resumePath"], "synthetic-resume.pdf")
        self.assertEqual(
            expected,
            {
                "controlIds": [
                    "contact.email",
                    "contact.phone",
                    "resume.file",
                    "preference.top_choice",
                    "authorization.sponsorship",
                ],
                "resumeFilename": "synthetic-resume.pdf",
            },
        )
        serialized_expected = json.dumps(expected).casefold()
        for value in (profile["name"], profile["email"], profile["phone"]):
            self.assertNotIn(value.casefold(), serialized_expected)
        self.assertEqual(
            (scenario_root / "synthetic-resume.pdf").read_bytes(),
            (ROOT / "qa/scenarios/complete-profile/synthetic-resume.pdf").read_bytes(),
        )

    def test_linkedin_screening_fresh_prepare_evaluate_cleanup_lifecycle(self) -> None:
        fixture_id = "linkedin-easy-apply-screening-2026-08-v1"
        scenario_id = "linkedin-screening"
        with tempfile.TemporaryDirectory() as directory:
            cli = load_cli()
            cli.FIXTURES_ROOT = ROOT / "qa/fixtures"
            cli.SCENARIOS_ROOT = ROOT / "qa/scenarios"
            cli.RUNS_ROOT = Path(directory) / "fresh-runs"

            prepared = cli._prepare(fixture_id, scenario_id)
            run_root = Path(prepared["storeRoot"]).parent
            report_path = run_root / "report.json"
            self.assertFalse(report_path.exists())
            state = json.loads((run_root / "run.json").read_text())
            fixture = json.loads((run_root / "fixture.json").read_text())
            profile = json.loads((run_root / "profile.json").read_text())
            applicant_values = {
                profile["name"],
                profile["firstName"],
                profile["lastName"],
                profile["email"],
                profile["phone"],
                *profile["location"].values(),
                *profile["skills"],
            }
            browser_answer_sentinels = {
                "qa-screening-browser@example.invalid",
                "480-555-0198",
                "No",
            }
            base_url = ReplayCoordinatorTests.base_url(self, prepared["url"])
            try:
                for step in fixture["steps"]:
                    for control in step["controls"]:
                        event = {
                            "type": (
                                "uploaded" if control["role"] == "file" else "filled"
                            ),
                            "controlId": control["id"],
                            "stepId": step["id"],
                        }
                        if control["role"] == "file":
                            event["expectedFilenameMatched"] = True
                        ReplayCoordinatorTests._post_event(self, prepared["url"], event)
                    ReplayCoordinatorTests._post_event(
                        self,
                        prepared["url"],
                        {
                            "type": (
                                "reviewed" if step["kind"] == "review" else "advanced"
                            ),
                            "controlId": "",
                            "stepId": step["id"],
                        },
                    )

                application_id = "linkedin-screening-application"
                history = [
                    {
                        "schemaVersion": 1,
                        "eventId": "screening-started",
                        "applicationId": application_id,
                        "event": "started",
                        "answerKeys": [],
                        "at": "2026-08-14T12:00:00Z",
                    },
                    {
                        "schemaVersion": 1,
                        "eventId": "screening-reviewed",
                        "applicationId": application_id,
                        "event": "reviewed",
                        "answerKeys": [],
                        "at": "2026-08-14T12:01:00Z",
                    },
                ]
                history_path = Path(prepared["storeRoot"]) / "applications.jsonl"
                history_path.write_text(
                    "".join(json.dumps(item) + "\n" for item in history)
                )
                os.chmod(history_path, 0o600)
                session_path = (
                    Path(prepared["storeRoot"]) / "sessions" / f"{application_id}.json"
                )
                session_path.write_text(
                    json.dumps(
                        {
                            "schemaVersion": 1,
                            "applicationId": application_id,
                            "status": "review",
                            "step": "review",
                            "answerKeys": [],
                            "pendingFields": [],
                            "createdAt": "2026-08-14T12:00:00Z",
                            "updatedAt": "2026-08-14T12:01:00Z",
                        }
                    )
                )
                os.chmod(session_path, 0o600)

                with urllib.request.urlopen(base_url + "/__qa/state", timeout=2) as response:
                    server_state = json.load(response)
                expected_ids = [
                    "contact.email",
                    "contact.phone",
                    "resume.file",
                    "preference.top_choice",
                    "authorization.sponsorship",
                ]
                self.assertEqual(
                    [
                        event["controlId"]
                        for event in server_state["events"]
                        if event["type"] in {"filled", "uploaded"}
                    ],
                    expected_ids,
                )
                self.assertEqual(server_state["finalActionActivations"], 0)
                visible_artifacts = json.dumps(server_state).casefold()
                allowed_event_keys = {
                    "filled": {"type", "controlId", "stepId"},
                    "uploaded": {
                        "type",
                        "controlId",
                        "stepId",
                        "expectedFilenameMatched",
                    },
                    "advanced": {"type", "controlId", "stepId"},
                    "reviewed": {"type", "controlId", "stepId"},
                }
                for event in server_state["events"]:
                    self.assertEqual(set(event), allowed_event_keys[event["type"]])
                for value in applicant_values:
                    self.assertNotIn(value.casefold(), visible_artifacts)
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), visible_artifacts)

                store_root = Path(prepared["storeRoot"])
                store_artifacts = {
                    path.relative_to(store_root).as_posix(): path.read_bytes()
                    for path in store_root.rglob("*")
                    if path.is_file()
                }
                self.assertEqual(
                    set(store_artifacts),
                    {
                        ".store.lock",
                        "answers.json",
                        "applications.jsonl",
                        "fact-groups.json",
                        "jobs.json",
                        "profile.json",
                        "resumes.json",
                        f"sessions/{application_id}.json",
                    },
                )
                serialized_store = (
                    b"\n".join(store_artifacts.values()).decode("utf-8").casefold()
                )
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), serialized_store)

                self.assertFalse(report_path.exists())
                code, report = cli._evaluate(run_root.name)
                self.assertEqual(code, 0)
                self.assertTrue(report_path.is_file())
                self.assertEqual(json.loads(report_path.read_text()), report)
                self.assertEqual(report["scenarioId"], scenario_id)
                self.assertEqual(report["status"], "passed")
                self.assertEqual(set(report["assertions"].values()), {"passed"})
                self.assertEqual(report["missingControlIds"], [])
                self.assertEqual(report["failureCategories"], [])
                serialized_report = json.dumps(report).casefold()
                for value in applicant_values:
                    self.assertNotIn(value.casefold(), serialized_report)
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), serialized_report)
                self.assertEqual(
                    report["assertions"]["final-action-untouched"], "passed"
                )

                cleanup = cli._cleanup(run_root.name)
                self.assertEqual(
                    cleanup,
                    {
                        "runId": run_root.name,
                        "state": "completed",
                        "reportRetained": True,
                    },
                )
                retained = {
                    path.relative_to(run_root).as_posix(): path.read_bytes()
                    for path in run_root.rglob("*")
                    if path.is_file()
                }
                nonempty_retained = {
                    path: payload for path, payload in retained.items() if payload
                }
                self.assertEqual(
                    set(nonempty_retained), {"report.json", "tombstone.json"}
                )
                for path, payload in retained.items():
                    if path not in nonempty_retained:
                        self.assertEqual(payload, b"")
                serialized_retained = (
                    b"\n".join(
                        nonempty_retained[path] for path in sorted(nonempty_retained)
                    )
                    .decode("utf-8")
                    .casefold()
                )
                for value in applicant_values:
                    self.assertNotIn(value.casefold(), serialized_retained)
                for value in browser_answer_sentinels:
                    self.assertNotIn(json.dumps(value).casefold(), serialized_retained)
                tombstone = json.loads(retained["tombstone.json"])
                self.assertEqual(tombstone["scenarioId"], scenario_id)
                self.assertEqual(cli._cleanup(run_root.name), cleanup)
            finally:
                try:
                    request = urllib.request.Request(
                        base_url + "/__qa/shutdown",
                        headers={"X-QA-Run-Token": state["shutdownToken"]},
                        method="POST",
                    )
                    urllib.request.urlopen(request, timeout=2).close()
                except (OSError, urllib.error.URLError):
                    pass

    def test_committed_scenario_prepares_real_store_without_http_leak(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fixture_dir = root / "fixtures" / FIXTURE_ID
            fixture_dir.mkdir(parents=True)
            capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
            receipt = json.loads(
                (PRIVATE_CAPTURE / "capture-receipt.json").read_text()
            )
            fixture = compile_capture(capture, receipt, FIXTURE_ID)
            (fixture_dir / "fixture.json").write_text(json.dumps(fixture))

            cli = load_cli()
            cli.FIXTURES_ROOT = root / "fixtures"
            cli.SCENARIOS_ROOT = ROOT / "qa/scenarios"
            cli.RUNS_ROOT = root / "runs"
            prepared = cli._prepare(FIXTURE_ID, SCENARIO_ID)
            run_root = Path(prepared["storeRoot"]).parent
            state = json.loads((run_root / "run.json").read_text())
            try:
                profile = json.loads(
                    (run_root / "store/profile.json").read_text()
                )["profile"]
                committed_profile = json.loads(
                    (ROOT / "qa/scenarios/complete-profile/profile.json").read_text()
                )
                expected_profile = dict(committed_profile)
                expected_profile["resumePath"] = str(
                    (run_root / "synthetic-resume.pdf").resolve()
                )
                self.assertEqual(profile, expected_profile)

                base_url = ReplayCoordinatorTests.base_url(self, prepared["url"])
                responses = []
                for path in ("/", "/__qa/fixture", "/__qa/state"):
                    with urllib.request.urlopen(base_url + path, timeout=2) as response:
                        responses.append(response.read().decode("utf-8"))
                visible_http = "\n".join(responses).casefold()
                for private_value in (
                    committed_profile["name"],
                    committed_profile["email"],
                    committed_profile["phone"],
                    committed_profile["location"]["city"],
                ):
                    self.assertNotIn(private_value.casefold(), visible_http)
            finally:
                request = urllib.request.Request(
                    ReplayCoordinatorTests.base_url(self, prepared["url"])
                    + "/__qa/shutdown",
                    headers={"X-QA-Run-Token": state["shutdownToken"]},
                    method="POST",
                )
                urllib.request.urlopen(request, timeout=2).close()
