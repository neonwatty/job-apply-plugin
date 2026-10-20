from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class ReplayCoordinatorTests(ReplayCase):
    def test_supported_lifecycle_is_ordered_idempotent_and_evaluates(self) -> None:
        output, run_root, _state = self.prepare()
        code, result, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(result["changed"])
        code, repeated, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertFalse(repeated["changed"])

        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "replay review event not observed\n")

        self._record_complete_replay_events(output)
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(result["changed"])
        code, repeated, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertFalse(repeated["changed"])

        history = [
            json.loads(line)
            for line in (Path(output["storeRoot"]) / "applications.jsonl").read_text().splitlines()
        ]
        self.assertEqual([event["event"] for event in history], ["started", "reviewed"])
        self.assertTrue(all(event["applicationId"] == run_root.name for event in history))
        serialized = json.dumps(history)
        for forbidden in (self.profile["name"], self.profile["email"], output["url"]):
            self.assertNotIn(forbidden, serialized)

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(report["status"], "passed")
        self.server_cleanup = None
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "run is terminal\n")

    def test_supported_lifecycle_evaluate_cleanup_and_tombstone_retry(self) -> None:
        output, run_root, _state = self.prepare()
        code, started, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(started["changed"])

        self._record_complete_replay_events(output)
        code, reviewed, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertTrue(reviewed["changed"])
        self.assertTrue((run_root / "evaluate.lock").is_file())

        code, report, stderr = self.invoke(["evaluate", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        retained_report = (run_root / "report.json").read_bytes()
        self.server_cleanup = None

        expected = {
            "runId": run_root.name,
            "state": "completed",
            "reportRetained": True,
        }
        code, cleanup, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, cleanup, stderr), (0, expected, ""))
        retained_tombstone = (run_root / "tombstone.json").read_bytes()
        self.assertEqual((run_root / "report.json").read_bytes(), retained_report)
        for path in run_root.rglob("*"):
            if path.is_file() and path.name not in {"report.json", "tombstone.json"}:
                self.assertEqual(path.stat().st_size, 0, path.relative_to(run_root))

        code, cleanup, stderr = self.invoke(["cleanup", "--run-id", run_root.name])
        self.assertEqual((code, cleanup, stderr), (0, expected, ""))
        self.assertEqual((run_root / "report.json").read_bytes(), retained_report)
        self.assertEqual(
            (run_root / "tombstone.json").read_bytes(), retained_tombstone
        )

    def test_reviewed_rejects_missing_started_and_final_action_activation(self) -> None:
        output, run_root, _state = self.prepare()
        self._record_complete_replay_events(output)
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "isolated lifecycle transition failed\n")

        code, _result, stderr = self.invoke(["started", "--run-id", run_root.name])
        self.assertEqual((code, stderr), (0, ""))
        review_id = next(
            step["id"] for step in self.fixture["steps"] if step["kind"] == "review"
        )
        base_url = self.base_url(output["url"])
        request = urllib.request.Request(
            base_url + "/__qa/final-action",
            data=json.dumps({"stepId": review_id}).encode(),
            headers={"Content-Type": "application/json", "Origin": base_url},
            method="POST",
        )
        with self.assertRaises(urllib.error.HTTPError) as captured:
            urllib.request.urlopen(request, timeout=2)
        try:
            self.assertEqual(captured.exception.code, 409)
        finally:
            captured.exception.close()
        code, result, stderr = self.invoke(["reviewed", "--run-id", run_root.name])
        self.assertEqual(code, 2)
        self.assertIsNone(result)
        self.assertEqual(stderr, "replay final action was activated\n")

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

    def test_terminal_publication_serializes_with_lifecycle_transition(self) -> None:
        _output, run_root, state = self.prepare()
        lock = os.open(run_root / "evaluate.lock", os.O_RDWR | os.O_CREAT, 0o600)
        self.addCleanup(os.close, lock)
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

        with ThreadPoolExecutor(max_workers=1) as executor:
            transition = executor.submit(
                self.cli._record_transition, run_root.name, "started"
            )
            time.sleep(0.05)
            self.assertFalse(transition.done())
            (run_root / "completed.json").write_text(
                json.dumps(
                    {"state": "completed", "nonce": state["lifecycleNonce"]}
                )
            )
            fcntl.flock(lock, fcntl.LOCK_UN)
            with self.assertRaisesRegex(self.cli.CoordinatorError, "run is terminal"):
                transition.result(timeout=2)

        history_path = Path(state["storeRoot"]) / "applications.jsonl"
        self.assertEqual(history_path.read_text(), "")

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
