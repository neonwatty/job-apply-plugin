from __future__ import annotations

import contextlib
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import stat
import unittest
import urllib.error
import urllib.request
from urllib.parse import parse_qs, urlsplit
from unittest import mock

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
        self.server_cleanup = None

    def tearDown(self) -> None:
        if self.server_cleanup is not None:
            url, token = self.server_cleanup
            try:
                request = urllib.request.Request(
                    self.base_url(url) + "/__qa/shutdown",
                    headers={"X-QA-Run-Token": token},
                    method="POST",
                )
                urllib.request.urlopen(request, timeout=2).close()
            except (OSError, urllib.error.URLError):
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
        self.server_cleanup = (output["url"], state["shutdownToken"])
        return output, run_root, state

    def base_url(self, url: str) -> str:
        parsed = urlsplit(url)
        return f"{parsed.scheme}://{parsed.netloc}"

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
        self.assertEqual(state["url"], self.base_url(output["url"]))
        self.assertNotIn("serverPid", state)
        self.assertEqual(stat.S_IMODE(run_root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE((run_root / "run.json").stat().st_mode), 0o600)
        with urllib.request.urlopen(self.base_url(output["url"]) + "/__qa/state", timeout=2) as response:
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
        url = self.base_url(url)
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
        self.server_cleanup = None

        second_code, second_report, second_stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )
        self.assertEqual((second_code, second_stderr), (0, ""))
        self.assertEqual(second_report, report)

    def test_evaluate_returns_one_for_assertion_failure_and_stops_server(self) -> None:
        _output, run_root, state = self.prepare()

        code, report, stderr = self.invoke(
            ["evaluate", "--run-id", run_root.name]
        )

        self.assertEqual((code, stderr), (1, ""))
        self.assertEqual(report["status"], "failed")
        self.assertTrue((run_root / "report.json").is_file())
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(_output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None

    def test_rejects_invalid_identifiers_without_creating_a_run(self) -> None:
        code, output, stderr = self.invoke(
            ["prepare", "--fixture", "../private", "--scenario", SCENARIO_ID]
        )
        self.assertEqual(code, 2)
        self.assertIsNone(output)
        self.assertEqual(stderr, "invalid fixture identifier\n")
        self.assertFalse(self.runs.exists())

    def test_prepare_rejects_preexisting_nonprivate_runs_root(self) -> None:
        self.runs.mkdir(mode=0o755)
        os.chmod(self.runs, 0o755)

        code, output, stderr = self.invoke(
            ["prepare", "--fixture", FIXTURE_ID, "--scenario", SCENARIO_ID]
        )

        self.assertEqual(
            (code, output, stderr),
            (2, None, "run directory creation failed\n"),
        )
        self.assertEqual(stat.S_IMODE(self.runs.stat().st_mode), 0o755)

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

    def test_prepare_never_touches_default_or_legacy_store(self) -> None:
        home = self.data_root / "home"
        default_store = home / ".job-apply"
        default_store.mkdir(parents=True)
        sentinel = default_store / "sentinel.txt"
        sentinel.write_text("keep")
        legacy = home / ".claude-job-profile.json"
        legacy.write_text(json.dumps({"private": "do not copy"}))

        with mock.patch.dict(os.environ, {"HOME": str(home)}):
            output, run_root, _state = self.prepare()

        self.assertEqual(sentinel.read_text(), "keep")
        self.assertEqual(legacy.read_text(), json.dumps({"private": "do not copy"}))
        self.assertNotIn("do not copy", (run_root / "store/profile.json").read_text())
        route_token = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]
        self.assertEqual(
            self.invoke(["resolve", "--route-token", route_token])[1],
            {"storeRoot": output["storeRoot"]},
        )

    def test_wrong_route_token_and_server_token_fail_closed(self) -> None:
        output, run_root, state = self.prepare()
        code, route, stderr = self.invoke(["resolve", "--route-token", "b" * 64])
        self.assertEqual((code, route, stderr), (2, None, "unknown QA route\n"))

        state_path = run_root / "run.json"
        original = json.loads(state_path.read_text())
        tampered = dict(original)
        tampered["shutdownToken"] = "b" * 64
        state_path.write_text(json.dumps(tampered))
        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual((code, report, stderr), (2, None, "fixture server identity mismatch\n"))
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=2
        ) as response:
            self.assertEqual(response.status, 200)
        state_path.write_text(json.dumps(original))

    def test_evaluate_lock_prevents_concurrent_or_replayed_mutation(self) -> None:
        _output, run_root, _state = self.prepare()
        lock = os.open(run_root / "evaluate.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])

        self.assertEqual(
            (code, report, stderr),
            (2, None, "evaluation already in progress\n"),
        )

    def test_stale_server_marks_run_abandoned_idempotently(self) -> None:
        output, run_root, state = self.prepare()
        request = urllib.request.Request(
            self.base_url(output["url"]) + "/__qa/shutdown",
            headers={"X-QA-Run-Token": state["shutdownToken"]},
            method="POST",
        )
        urllib.request.urlopen(request, timeout=2).close()
        self.server_cleanup = None

        first = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(first, (2, None, "fixture server unavailable\n"))
        self.assertEqual(
            json.loads((run_root / "abandoned.json").read_text())["state"],
            "abandoned",
        )
        second = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(second, (2, None, "run is abandoned\n"))

    def test_tampered_completed_report_never_echoes_injected_values(self) -> None:
        _output, run_root, state = self.prepare()
        (run_root / "report.json").write_text(
            json.dumps({"status": "passed", "secret": "DO NOT ECHO"})
        )
        (run_root / "completed.json").write_text(
            json.dumps(
                {"state": "completed", "nonce": state["lifecycleNonce"]}
            )
        )

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])

        self.assertEqual((code, report, stderr), (2, None, "invalid run report\n"))
        self.assertNotIn("DO NOT ECHO", stderr)

    def test_cached_report_shape_and_semantics_fail_closed(self) -> None:
        output, run_root, _state = self.prepare()
        for step in self.fixture["steps"]:
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
        self._write_passing_store(Path(output["storeRoot"]))
        self.assertEqual(self.invoke(["evaluate", "--run-id", run_root.name])[0], 0)
        self.server_cleanup = None
        report_path = run_root / "report.json"
        valid = json.loads(report_path.read_text())
        cases = []
        malformed = dict(valid)
        malformed["missingControlIds"] = [{}]
        cases.append(malformed)
        malformed = dict(valid)
        malformed["missingControlIds"] = ["resume.file", "resume.file"]
        cases.append(malformed)
        malformed = json.loads(json.dumps(valid))
        malformed["assertions"]["review-reached"] = "failed"
        cases.append(malformed)
        malformed = dict(valid)
        malformed["status"] = "failed"
        cases.append(malformed)
        malformed = dict(valid)
        malformed["failureCategories"] = ["unknown-category"]
        cases.append(malformed)
        for malformed in cases:
            with self.subTest(malformed=malformed):
                report_path.write_text(json.dumps(malformed))
                os.chmod(report_path, 0o600)
                code, report, stderr = self.invoke(
                    ["evaluate", "--run-id", run_root.name]
                )
                self.assertEqual((code, report, stderr), (2, None, "invalid run report\n"))

    def test_route_resolution_is_direct_with_more_than_256_retained_runs(self) -> None:
        self.runs.mkdir(mode=0o700)
        os.chmod(self.runs, 0o700)
        for index in range(300):
            (self.runs / f"retained-{index:03d}").mkdir()
        output, _run_root, _state = self.prepare()
        route = parse_qs(urlsplit(output["url"]).fragment)["qa-route"][0]

        code, resolved, stderr = self.invoke(["resolve", "--route-token", route])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(resolved, {"storeRoot": output["storeRoot"]})

    def test_run_parent_replacement_keeps_store_and_report_descriptor_anchored(self) -> None:
        output, run_root, _state = self.prepare()
        for step in self.fixture["steps"]:
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
        self._write_passing_store(Path(output["storeRoot"]))
        displaced = self.runs / "anchored-original"
        original_verify = self.cli._verify_identity

        def replace_parent(state):
            run_root.rename(displaced)
            run_root.mkdir(mode=0o700)
            os.chmod(run_root, 0o700)
            return original_verify(state)

        with mock.patch.object(self.cli, "_verify_identity", side_effect=replace_parent):
            code, report, stderr = self.invoke(
                ["evaluate", "--run-id", run_root.name]
            )

        self.assertEqual((code, report["status"], stderr), (0, "passed", ""))
        self.assertTrue((displaced / "report.json").is_file())
        self.assertFalse((run_root / "report.json").exists())
        self.server_cleanup = None

    def test_cleanup_abandons_prepared_run_and_is_idempotent(self) -> None:
        output, run_root, _state = self.prepare()

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(
            result,
            {"runId": run_root.name, "state": "abandoned", "reportRetained": False},
        )
        self.assertFalse((run_root / "store").exists())
        self.assertEqual(json.loads((run_root / "tombstone.json").read_text()), result)
        with self.assertRaises((OSError, urllib.error.URLError)):
            urllib.request.urlopen(
                self.base_url(output["url"]) + "/__qa/state", timeout=1
            )
        self.server_cleanup = None
        self.assertEqual(
            self.invoke(["cleanup", "--run-id", run_root.name]),
            (0, result, ""),
        )

    def test_cleanup_prunes_completed_synthetic_data_but_retains_report(self) -> None:
        output, run_root, _state = self.prepare()
        code, report, _stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual(code, 1)
        self.server_cleanup = None

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(result["state"], "completed")
        self.assertTrue(result["reportRetained"])
        self.assertEqual(json.loads((run_root / "report.json").read_text()), report)
        for name in ("store", "fixture.json", "profile.json", "expected.json", "run.json"):
            self.assertFalse((run_root / name).exists())

    def test_cleanup_never_stops_a_server_that_fails_run_authentication(self) -> None:
        output, run_root, _state = self.prepare()
        state_path = run_root / "run.json"
        state = json.loads(state_path.read_text())
        state["shutdownToken"] = "b" * 64
        state_path.write_text(json.dumps(state))
        os.chmod(state_path, 0o600)

        code, result, stderr = self.invoke(["cleanup", "--run-id", run_root.name])

        self.assertEqual((code, result, stderr), (2, None, "fixture server identity mismatch\n"))
        with urllib.request.urlopen(
            self.base_url(output["url"]) + "/__qa/state", timeout=1
        ) as response:
            self.assertEqual(response.status, 200)

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

    def test_skills_document_mandatory_qa_root_routing(self) -> None:
        answer_memory = (ROOT / "skills/answer-memory/SKILL.md").read_text()
        job_apply = (ROOT / "skills/job-apply/SKILL.md").read_text()
        for document in (answer_memory, job_apply):
            self.assertIn("qa-replay.py", document)
            self.assertIn("--route-token", document)
            self.assertIn("--root", document)
            self.assertIn("before", document.lower())
            self.assertIn("#qa-route=<run-id>.<64-lowercase-hex-token>", document)
            self.assertIn("cleanup --run-id", document)
            self.assertIn("report", document.lower())
        coordinator = SCRIPT.read_text()
        self.assertNotIn("os.kill(", coordinator)
        self.assertNotIn('["ps",', coordinator)


if __name__ == "__main__":
    unittest.main()
