from tests.support.chrome_launcher_case import *


class LauncherCase(ChromeLauncherCase):
    def test_start_check_stop_and_profile_reuse(self):
        first = self.start()
        self.assert_closed(first, {"profile", "status", "cdpUrl", "recorderCommand"})
        payload = json.loads(first.stdout)
        self.assertEqual(payload["status"], "ready")
        self.assertRegex(payload["cdpUrl"], r"^http://127\.0\.0\.1:\d+$")
        self.assertIn(payload["cdpUrl"], payload["recorderCommand"])
        profile = self.home / ".job-apply-qa" / "chrome-profiles" / "linkedin-capture"
        marker = profile / "persistence-marker"
        marker.write_text("retained")

        checked = self.run_cli("check", "--profile", "linkedin-capture")
        self.assert_closed(checked, {"profile", "status", "cdpUrl", "recorderCommand"})
        stopped = self.run_cli("stop", "--profile", "linkedin-capture")
        self.assert_closed(stopped, {"profile", "status"})
        self.assertEqual(json.loads(stopped.stdout)["status"], "stopped")
        second = self.start()
        self.assertEqual(second.returncode, 0, second.stderr)
        self.assertEqual(marker.read_text(), "retained")

    def test_concurrent_start_launches_one_supervisor(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.start("concurrent"), range(2)))
        self.assertTrue(all(r.returncode == 0 for r in results), [r.stderr for r in results])
        controls = {json.loads(r.stdout)["cdpUrl"] for r in results}
        self.assertEqual(len(controls), 1)
        self.run_cli("stop", "--profile", "concurrent")

    def test_independent_child_exit_is_reaped_and_runtime_removed(self):
        exiting = Path(self.tmp.name) / "exiting chrome"
        source = self.fake.read_text().replace("server.serve_forever()", "threading.Timer(0.2, server.shutdown).start(); server.serve_forever()")
        exiting.write_text(source)
        exiting.chmod(0o700)
        started = self.run_cli("start", "--profile", "independent", "--chrome-path", str(exiting))
        self.assertEqual(started.returncode, 0, started.stderr)
        runtime = self.home / ".job-apply-qa/runtime/independent"
        deadline = time.time() + 4
        while runtime.exists() and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(runtime.exists())
        checked = self.run_cli("check", "--profile", "independent")
        self.assertEqual(json.loads(checked.stdout)["status"], "stopped")

    def test_startup_failure_cleans_partial_runtime(self):
        failing = Path(self.tmp.name) / "failing chrome"
        failing.write_text("#!/usr/bin/env python3\nraise SystemExit(3)\n")
        failing.chmod(0o700)
        result = self.run_cli("start", "--profile", "startup-failure", "--chrome-path", str(failing))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "Chrome did not become ready\n")
        deadline = time.time() + 3
        runtime = self.home / ".job-apply-qa/runtime/startup-failure"
        while runtime.exists() and time.time() < deadline:
            time.sleep(0.05)
        self.assertFalse(runtime.exists())

    def test_reset_contract_and_active_refusal(self):
        absent = self.run_cli("reset", "--profile", "not-created")
        self.assert_closed(absent, {"profile", "status", "profilePath"})
        self.assertEqual(
            json.loads(absent.stdout),
            {
                "profile": "not-created",
                "status": "manual-removal-required",
                "profilePath": "~/.job-apply-qa/chrome-profiles/not-created",
            },
        )
        self.assertNotIn(str(self.home), absent.stdout)
        confirmed = self.run_cli("reset", "--profile", "not-created", "--confirm", "not-created")
        self.assertNotEqual(confirmed.returncode, 0)
        self.assertEqual(confirmed.stderr, "invalid arguments\n")
        self.assertEqual(self.start().returncode, 0)
        active = self.run_cli("reset", "--profile", "linkedin-capture")
        self.assertNotEqual(active.returncode, 0)
        self.assertEqual(active.stderr, "profile is active; stop it before reset guidance\n")
        self.assertEqual(active.stdout, "")

    def test_bounded_stop_escalates_only_the_retained_child(self):
        stubborn = Path(self.tmp.name) / "stubborn chrome"
        source = self.fake.read_text().replace(
            "signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)",
            "signal.signal(signal.SIGTERM, lambda *_: None); signal.signal(signal.SIGINT, lambda *_: None)",
        )
        stubborn.write_text(source)
        stubborn.chmod(0o700)
        lookalike = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
        try:
            started = self.run_cli("start", "--profile", "stubborn", "--chrome-path", str(stubborn))
            self.assertEqual(started.returncode, 0, started.stderr)
            stopped = self.run_cli("stop", "--profile", "stubborn", timeout=8)
            self.assertEqual(stopped.returncode, 0, stopped.stderr)
            self.assertIsNone(lookalike.poll())
            self.assertFalse((self.home / ".job-apply-qa/runtime/stubborn").exists())
        finally:
            lookalike.terminate()
            lookalike.wait(timeout=3)

    def test_parent_interruption_after_ready_publication_cleans_child_and_runtime(self):
        publication = Path(self.tmp.name) / "ready-published"
        attack = textwrap.dedent("""\
            import importlib.util, pathlib, sys
            spec = importlib.util.spec_from_file_location('launcher_under_attack', sys.argv[1])
            launcher = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(launcher)
            def interrupt_after_publication(payload):
                pathlib.Path(sys.argv[3]).write_text(payload['status'])
                raise KeyboardInterrupt()
            launcher.emit = interrupt_after_publication
            launcher.command_start('parent-interrupt', sys.argv[2])
        """)
        attacked_parent = subprocess.run(
            [sys.executable, "-c", attack, str(LAUNCHER), str(self.fake), str(publication)],
            text=True,
            capture_output=True,
            env=self.env,
            timeout=12,
        )
        self.assertNotEqual(attacked_parent.returncode, 0)
        self.assertEqual(publication.read_text(), "ready")
        runtime = self.home / ".job-apply-qa/runtime/parent-interrupt"
        deadline = time.monotonic() + 6
        while runtime.exists() and time.monotonic() < deadline:
            time.sleep(0.04)
        self.assertFalse(runtime.exists())

    def test_reset_guides_manual_removal_without_mutating_or_opening_trash(self):
        self.assertEqual(self.start("resettable").returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", "resettable").returncode, 0)
        profile = self.home / ".job-apply-qa/chrome-profiles/resettable"
        (profile / "persistent-marker").write_text("retained")

        result = self.run_cli("reset", "--profile", "resettable")
        self.assert_closed(result, {"profile", "status", "profilePath"})
        self.assertEqual(
            json.loads(result.stdout),
            {
                "profile": "resettable",
                "status": "manual-removal-required",
                "profilePath": "~/.job-apply-qa/chrome-profiles/resettable",
            },
        )
        self.assertTrue(profile.is_dir())
        self.assertEqual((profile / "persistent-marker").read_text(), "retained")
        self.assertFalse((self.home / ".Trash").exists())
        self.assertNotIn(str(self.home), result.stdout)

    def test_reset_missing_owner_artifacts_is_ambiguous_and_creates_nothing(self):
        for profile, missing in (
            ("missing-root-owner", "root"),
            ("missing-home-owner", "home"),
            ("missing-both-owners", "both"),
        ):
            with self.subTest(missing=missing):
                self.assertEqual(self.start(profile).returncode, 0)
                self.assertEqual(self.run_cli("stop", "--profile", profile).returncode, 0)
                root_owner = self.home / ".job-apply-qa" / (".ownership-%s.lock" % profile)
                home_owner = self.home / (".job-apply-qa-owner-%s" % profile)
                if missing in ("root", "both"):
                    root_owner.unlink()
                if missing in ("home", "both"):
                    home_owner.unlink()
                before = self.metadata_snapshot()
                result = self.run_cli("reset", "--profile", profile)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertEqual(
                    result.stderr,
                    "profile state is ambiguous; resolve it before reset guidance\n",
                )
                self.assertEqual(self.metadata_snapshot(), before)

    def test_reset_is_readonly_and_metadata_invariant_in_every_owner_state(self):
        stopped = "readonly-stopped"
        self.assertEqual(self.start(stopped).returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", stopped).returncode, 0)
        marker = self.home / ".job-apply-qa/chrome-profiles" / stopped / "do-not-inspect"
        marker.write_text("credential-shaped sentinel")
        before = self.metadata_snapshot()
        output = self.assert_reset_uses_readonly_observation(stopped)
        self.assertEqual(
            json.loads(output),
            {
                "profile": stopped,
                "status": "manual-removal-required",
                "profilePath": "~/.job-apply-qa/chrome-profiles/readonly-stopped",
            },
        )
        self.assertEqual(self.metadata_snapshot(), before)

        active = "readonly-active"
        self.assertEqual(self.start(active).returncode, 0)
        active_runtime = self.home / ".job-apply-qa/runtime" / active
        active_observation_files = (
            self.home / (".job-apply-qa-owner-%s" % active),
            active_runtime / "control.json",
            active_runtime / "state.json",
        )
        old_atime_ns = 1_000_000_000
        for path in active_observation_files:
            value = path.stat()
            os.utime(path, ns=(old_atime_ns, value.st_mtime_ns), follow_symlinks=False)
        before = self.metadata_snapshot()
        self.assert_reset_uses_readonly_observation(active, "profile is active")
        self.assertEqual(self.metadata_snapshot(), before)
        self.assertEqual(self.run_cli("stop", "--profile", active).returncode, 0)

        ambiguous = "readonly-ambiguous"
        self.assertEqual(self.start(ambiguous).returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", ambiguous).returncode, 0)
        (self.home / ".job-apply-qa/runtime" / ambiguous).mkdir(mode=0o700)
        before = self.metadata_snapshot()
        self.assert_reset_uses_readonly_observation(ambiguous, "profile state is ambiguous")
        self.assertEqual(self.metadata_snapshot(), before)

    def test_reset_refuses_ambiguous_runtime_without_safe_removal_guidance(self):
        self.assertEqual(self.start("reset-guard").returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", "reset-guard").returncode, 0)
        runtime = self.home / ".job-apply-qa/runtime/reset-guard"
        runtime.mkdir(mode=0o700)
        ambiguous = self.run_cli("reset", "--profile", "reset-guard")
        self.assertNotEqual(ambiguous.returncode, 0)
        self.assertEqual(
            ambiguous.stderr,
            "profile state is ambiguous; resolve it before reset guidance\n",
        )
        self.assertEqual(ambiguous.stdout, "")
        self.assertNotIn("chrome-profiles", ambiguous.stderr)
