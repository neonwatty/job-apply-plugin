from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class ReplayCoordinatorTests(ReplayCase):
    def test_prepare_creates_isolated_store_and_starts_server(self) -> None:
        output, run_root, state = self.prepare()

        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(output["fixtureId"], FIXTURE_ID)
        self.assertEqual(output["scenarioId"], SCENARIO_ID)
        self.assertEqual(output["suggestedPrompt"], PROMPT.format(url=output["url"]))
        route_token = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]
        self.assertRegex(
            route_token,
            r"^qa-run-20[0-9]{6}-[a-f0-9]{8}\.[a-f0-9]{64}$",
        )
        code, route, stderr = self.invoke(["resolve", "--route-token", route_token])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(route, {"storeRoot": output["storeRoot"]})
        stored_document = json.loads((run_root / "store/profile.json").read_text())
        stored_profile = stored_document["profile"]
        self.assertEqual(stored_profile["name"], self.profile["name"])
        self.assertEqual(stored_profile["email"], self.profile["email"])
        self.assertEqual(
            Path(stored_profile["resumePath"]),
            (run_root / "synthetic-resume.pdf").resolve(),
        )
        self.assertEqual(
            stored_document["metadata"]["factProvenance"]["/resumePath"]["source"],
            "resume",
        )
        self.assertEqual(
            json.loads((run_root / "profile.json").read_text()), self.profile
        )
        self.assertEqual(
            (run_root / "synthetic-resume.pdf").read_bytes(),
            b"%PDF-1.4\nsynthetic fixture\n%%EOF\n",
        )
        self.assertEqual(state["url"], self.base_url(output["url"]))
        self.assertNotIn("serverPid", state)
        self.assertEqual(stat.S_IMODE(run_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((run_root / "run.json").stat().st_mode), 0o600)
        with urllib.request.urlopen(self.base_url(output["url"]) + "/__qa/state", timeout=2) as response:
            self.assertEqual(json.load(response), {"events": [], "finalActionActivations": 0})

    def test_prepare_uses_closed_greenhouse_guidance_without_changing_shape(self) -> None:
        self.cli.FIXTURES_ROOT = ROOT / "qa/fixtures"
        self.cli.SCENARIOS_ROOT = ROOT / "qa/scenarios"
        output = self.cli._prepare(
            "greenhouse-single-page-2026-08-v1", "greenhouse-complete-profile"
        )
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])

        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(
            output["suggestedPrompt"],
            PROMPT.format(url=output["url"]).replace(
                "LinkedIn Easy Apply", "Greenhouse"
            ),
        )
        code, started, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(started["changed"])
        fixture = json.loads((run_root / "fixture.json").read_text())
        for step in fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
                        **(
                            {"expectedFilenameMatched": True}
                            if control["role"] == "file"
                            else {}
                        ),
                    },
                )
            self._post_event(
                output["url"],
                {
                    "type": "reviewed" if step["kind"] == "review" else "advanced",
                    "controlId": "",
                    "stepId": step["id"],
                },
            )
        code, reviewed, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(reviewed["changed"])
        session = json.loads(
            (Path(output["storeRoot"]) / "sessions" / f"{run_root.name}.json").read_text()
        )
        self.assertEqual((session["ats"], session["status"]), ("greenhouse", "review"))

    def test_prepare_uses_closed_ashby_guidance_without_changing_shape(self) -> None:
        fixture_id = "ashby-application-2026-08-v1"
        scenario_id = "ashby-complete-profile"
        fixture_dir = self.fixtures / fixture_id
        scenario_dir = self.scenarios / scenario_id
        fixture_dir.mkdir()
        scenario_dir.mkdir()
        fixture = json.loads(json.dumps(self.fixture))
        fixture["id"] = fixture_id
        fixture["platformFamily"] = "ashby"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    {"id": "contact.full_name", "kind": "contact.full_name", "role": "textbox", "label": "Full name", "required": True},
                    {"id": "contact.email", "kind": "contact.email", "role": "textbox", "label": "Email address", "required": True},
                    {"id": "resume.file", "kind": "resume.file", "role": "file", "label": "Resume", "required": True},
                ],
                "next": "review",
            },
            fixture["steps"][-1],
        ]
        (fixture_dir / "fixture.json").write_text(json.dumps(fixture))
        profile = json.loads(
            (ROOT / "qa/scenarios/ashby-complete-profile/profile.json").read_text()
        )
        (scenario_dir / "profile.json").write_text(json.dumps(profile))
        (scenario_dir / "expected.json").write_text(json.dumps({
            "controlIds": ["contact.full_name", "contact.email", "resume.file"],
            "resumeFilename": "synthetic-resume.pdf",
        }))
        (scenario_dir / "synthetic-resume.pdf").write_bytes(
            (ROOT / "qa/scenarios/ashby-complete-profile/synthetic-resume.pdf").read_bytes()
        )

        output = self.cli._prepare(fixture_id, scenario_id)
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])
        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(
            output["suggestedPrompt"],
            PROMPT.format(url=output["url"]).replace("LinkedIn Easy Apply", "Ashby"),
        )

    def test_prepare_uses_closed_lever_guidance_without_changing_shape(self) -> None:
        fixture_id = "lever-application-2026-08-v1"
        scenario_id = "lever-complete-profile"
        fixture_dir = self.fixtures / fixture_id
        scenario_dir = self.scenarios / scenario_id
        fixture_dir.mkdir()
        scenario_dir.mkdir()
        fixture = json.loads(json.dumps(self.fixture))
        fixture["id"] = fixture_id
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
        (fixture_dir / "fixture.json").write_text(json.dumps(fixture))
        source_scenario = ROOT / "qa/scenarios/lever-complete-profile"
        for filename in ("profile.json", "expected.json", "synthetic-resume.pdf"):
            target = scenario_dir / filename
            source = source_scenario / filename
            if filename.endswith(".pdf"):
                target.write_bytes(source.read_bytes())
            else:
                target.write_text(source.read_text())

        output = self.cli._prepare(fixture_id, scenario_id)
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_cleanup = (output["url"], state["shutdownToken"])
        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(
            output["suggestedPrompt"],
            PROMPT.format(url=output["url"]).replace("LinkedIn Easy Apply", "Lever"),
        )

    def test_expected_resume_contract_is_closed_and_required(self) -> None:
        expected_path = self.scenarios / SCENARIO_ID / "expected.json"
        expected = json.loads(expected_path.read_text())
        expected["resumeFilename"] = "wrong.pdf"
        expected_path.write_text(json.dumps(expected))

        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", SCENARIO_ID]
        )

        self.assertEqual((code, output, stderr), (2, None, "invalid scenario package\n"))
        self.assertFalse(self.runs.exists())

    def test_prepare_rejects_scenario_outside_closed_allowlist(self) -> None:
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", "other-scenario"]
        )

        self.assertEqual(
            (code, output, stderr),
            (2, None, "invalid scenario identifier\n"),
        )
        self.assertFalse(self.runs.exists())
