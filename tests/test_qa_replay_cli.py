from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import signal
import tempfile
import time
import unittest
import urllib.request

from qa.compiler import compile_capture


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "qa-replay.py"
PRIVATE_CAPTURE = ROOT / "qa" / "testdata" / "private-capture"
FIXTURE_ID = "linkedin-easy-apply-short-2026-08-v1"
SCENARIO_ID = "complete-profile"
PROMPT = (
    "Use job-apply:job-apply on this approved local LinkedIn Easy Apply QA "
    "fixture: {url}. Use the isolated QA profile already prepared for this "
    "run. Operate the visible form normally and stop at final review exactly "
    "as you would on a live application."
)


def load_cli():
    spec = importlib.util.spec_from_file_location("qa_replay_cli", SCRIPT)
    if spec is None or spec.loader is None:
        raise AssertionError("unable to load replay coordinator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReplayCoordinatorTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.data_root = Path(self.temporary.name)
        self.fixtures = self.data_root / "fixtures"
        self.scenarios = self.data_root / "scenarios"
        self.runs = self.data_root / "runs"
        fixture_dir = self.fixtures / FIXTURE_ID
        scenario_dir = self.scenarios / SCENARIO_ID
        fixture_dir.mkdir(parents=True)
        scenario_dir.mkdir(parents=True)

        capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
        receipt = json.loads(
            (PRIVATE_CAPTURE / "capture-receipt.json").read_text()
        )
        self.fixture = compile_capture(capture, receipt, FIXTURE_ID)
        (fixture_dir / "fixture.json").write_text(json.dumps(self.fixture))
        self.profile = {
            "name": "Avery Example",
            "email": "avery@example.com",
            "resumePath": "synthetic-resume.pdf",
        }
        (scenario_dir / "profile.json").write_text(json.dumps(self.profile))
        (scenario_dir / "synthetic-resume.pdf").write_bytes(
            b"%PDF-1.4\nsynthetic fixture\n%%EOF\n"
        )
        (scenario_dir / "expected.json").write_text(
            json.dumps(
                {
                    "controlIds": [
                        control["id"]
                        for step in self.fixture["steps"]
                        for control in step["controls"]
                    ],
                    "resumeFilename": "synthetic-resume.pdf",
                }
            )
        )
        self.cli = load_cli()
        self.cli.FIXTURES_ROOT = self.fixtures
        self.cli.SCENARIOS_ROOT = self.scenarios
        self.cli.RUNS_ROOT = self.runs
        self.server_pid = None

    def tearDown(self) -> None:
        if self.server_pid is not None:
            try:
                os.kill(self.server_pid, signal.SIGTERM)
            except ProcessLookupError:
                pass

    def invoke(self, arguments: list[str]):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = self.cli.main(arguments)
        output = json.loads(stdout.getvalue()) if stdout.getvalue() else None
        return code, output, stderr.getvalue()

    def prepare(self):
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", SCENARIO_ID]
        )
        self.assertEqual((code, stderr), (0, ""))
        run_root = Path(output["storeRoot"]).parent
        state = json.loads((run_root / "run.json").read_text())
        self.server_pid = state["serverPid"]
        return output, run_root, state

    def test_prepare_creates_isolated_store_and_starts_server(self) -> None:
        output, run_root, state = self.prepare()

        self.assertEqual(
            set(output),
            {"fixtureId", "scenarioId", "url", "storeRoot", "suggestedPrompt"},
        )
        self.assertEqual(output["fixtureId"], FIXTURE_ID)
        self.assertEqual(output["scenarioId"], SCENARIO_ID)
        self.assertEqual(output["suggestedPrompt"], PROMPT.format(url=output["url"]))
        stored_profile = json.loads(
            (run_root / "store/profile.json").read_text()
        )["profile"]
        self.assertEqual(stored_profile["name"], self.profile["name"])
        self.assertEqual(stored_profile["email"], self.profile["email"])
        self.assertEqual(
            Path(stored_profile["resumePath"]),
            (run_root / "synthetic-resume.pdf").resolve(),
        )
        self.assertEqual(
            json.loads((run_root / "profile.json").read_text()), self.profile
        )
        self.assertEqual(
            (run_root / "synthetic-resume.pdf").read_bytes(),
            b"%PDF-1.4\nsynthetic fixture\n%%EOF\n",
        )
        self.assertEqual(state["url"], output["url"])
        with urllib.request.urlopen(output["url"] + "/__qa/state", timeout=2) as response:
            self.assertEqual(json.load(response), {"events": [], "finalActionActivations": 0})

    def _write_passing_store(self, store_root: Path) -> None:
        application_id = "application-1"
        history = [
            {
                "schemaVersion": 1,
                "eventId": "event-started",
                "applicationId": application_id,
                "event": "started",
                "answerKeys": [],
                "at": "2026-08-11T12:00:00Z",
            },
            {
                "schemaVersion": 1,
                "eventId": "event-reviewed",
                "applicationId": application_id,
                "event": "reviewed",
                "answerKeys": [],
                "at": "2026-08-11T12:01:00Z",
            },
        ]
        (store_root / "applications.jsonl").write_text(
            "".join(json.dumps(item) + "\n" for item in history)
        )
        session = {
            "schemaVersion": 1,
            "applicationId": application_id,
            "status": "review",
            "step": "review",
            "answerKeys": [],
            "pendingFields": [],
            "createdAt": "2026-08-11T12:00:00Z",
            "updatedAt": "2026-08-11T12:01:00Z",
        }
        (store_root / "sessions" / f"{application_id}.json").write_text(
            json.dumps(session)
        )

    def _post_event(self, url: str, event: dict) -> None:
        request = urllib.request.Request(
            url + "/__qa/event",
            data=json.dumps(event).encode(),
            headers={"Content-Type": "application/json", "Origin": url},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=2) as response:
            self.assertEqual(response.status, 204)

    def test_evaluate_writes_redacted_report_and_returns_zero_for_pass(self) -> None:
        output, run_root, _state = self.prepare()
        for step in self.fixture["steps"]:
            for control in step["controls"]:
                self._post_event(
                    output["url"],
                    {
                        "type": "uploaded" if control["role"] == "file" else "filled",
                        "controlId": control["id"],
                        "stepId": step["id"],
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
        self._write_passing_store(Path(output["storeRoot"]))

        code, report, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(report["status"], "passed")
        self.assertEqual(
            json.loads((run_root / "report.json").read_text()), report
        )
        serialized = json.dumps(report)
        self.assertNotIn("Avery Example", serialized)
        self.assertNotIn("avery@example.com", serialized)
        self.server_pid = None

    def test_evaluate_returns_one_for_assertion_failure_and_stops_server(self) -> None:
        _output, run_root, state = self.prepare()

        code, report, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual((code, stderr), (1, ""))
        self.assertEqual(report["status"], "failed")
        self.assertTrue((run_root / "report.json").is_file())
        for _ in range(50):
            try:
                os.kill(state["serverPid"], 0)
            except ProcessLookupError:
                break
            time.sleep(0.02)
        else:
            self.fail("fixture server was not stopped")
        self.server_pid = None

    def test_rejects_invalid_identifiers_without_creating_a_run(self) -> None:
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", "../private", "--scenario", SCENARIO_ID]
        )
        self.assertEqual(code, 2)
        self.assertIsNone(output)
        self.assertEqual(stderr, "invalid fixture identifier\n")
        self.assertFalse(self.runs.exists())

    def test_evaluate_rejects_symlinked_run_state(self) -> None:
        self.runs.mkdir()
        run_root = self.runs / "qa-run-20260811-deadbeef"
        run_root.mkdir()
        target = self.data_root / "outside.json"
        target.write_text("{}")
        (run_root / "run.json").symlink_to(target)

        code, output, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual(code, 2)
        self.assertIsNone(output)
        self.assertEqual(stderr, "invalid run state\n")


if __name__ == "__main__":
    unittest.main()
