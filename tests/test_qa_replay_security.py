from tests.support.pdf_fixture import *
from tests.support.replay_case import *


class ReplayCoordinatorTests(ReplayCase):
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
