from tests.support.chrome_launcher_case import *


class LauncherCase(ChromeLauncherCase):
    def test_private_modes_and_closed_persisted_state(self):
        result = self.start()
        self.assertEqual(result.returncode, 0, result.stderr)
        root = self.home / ".job-apply-qa"
        paths = [root, root / "chrome-profiles", root / "runtime", root / "chrome-profiles/linkedin-capture", root / "runtime/linkedin-capture"]
        for path in paths:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700, path)
            self.assertEqual(path.stat().st_uid, os.getuid())
        for name in ("state.json", "control.json"):
            path = root / "runtime/linkedin-capture" / name
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600, path)
            self.assertTrue(stat.S_ISREG(path.lstat().st_mode))
        owner = self.home / ".job-apply-qa-owner-linkedin-capture"
        self.assertEqual(stat.S_IMODE(owner.stat().st_mode), 0o600)
        self.assertTrue(stat.S_ISREG(owner.lstat().st_mode))
        state = json.loads((root / "runtime/linkedin-capture/state.json").read_text())
        self.assertEqual(set(state), {
            "version", "profile", "status", "cdpPort", "cdpBrowserPathHash", "generation",
        })
        self.assertNotIn("pid", str(state).lower())

    def test_profile_and_cli_validation_are_value_free(self):
        bad_profiles = ["", "UPPER", "../escape", "has/slash", "two--dash", "-edge", "edge-"]
        for profile in bad_profiles:
            with self.subTest(profile=profile):
                result = self.run_cli("check", "--profile=" + profile)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertEqual(result.stderr, "invalid profile identifier\n")
                if profile:
                    self.assertNotIn(profile, result.stderr)
        result = self.run_cli("start", "--profile", "valid", "--chrome-path", "relative")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "invalid Chrome executable\n")
        hidden = self.run_cli("supervise", "--profile", "valid")
        self.assertNotEqual(hidden.returncode, 0)
        self.assertEqual(hidden.stderr, "invalid arguments\n")
        never_created = self.run_cli("check", "--profile", "never-created")
        self.assert_closed(never_created, {"profile", "status"})
        self.assertEqual(json.loads(never_created.stdout)["status"], "stopped")

    def test_output_never_leaks_paths_tokens_pids_or_browser_data(self):
        result = self.start()
        combined = result.stdout + result.stderr
        self.assertNotIn(str(self.home), combined)
        self.assertNotIn(str(self.fake), combined)
        self.assertNotRegex(combined.lower(), r'"(?:token|pid|title|url|path)"')
        control = (self.home / ".job-apply-qa/runtime/linkedin-capture/control.json").read_text()
        token = json.loads(control)["token"]
        self.assertNotIn(token, combined)
        self.assertNotIn("devtools/browser/synthetic", combined)

    def test_symlink_special_file_mode_and_platform_refusal(self):
        root = self.home / ".job-apply-qa"
        root.symlink_to(Path(self.tmp.name))
        result = self.start("symlinked")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "managed storage is unsafe\n")
        root.unlink()
        root.mkdir(mode=0o755)
        result = self.start("bad-mode")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "managed storage is unsafe\n")
        result = self.run_cli("start", "--profile", "unsupported")
        if sys.platform != "darwin":
            self.assertEqual(result.stderr, "unsupported platform\n")

    def test_devtools_symlink_and_executable_symlink_are_refused(self):
        self.assertEqual(self.start("bootstrap").returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", "bootstrap").returncode, 0)
        profile = self.home / ".job-apply-qa/chrome-profiles/boundary"
        profile.mkdir(mode=0o700)
        (profile / "DevToolsActivePort").symlink_to(self.signal_log)
        result = self.start("boundary")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "profile state is ambiguous\n")
        linked = Path(self.tmp.name) / "linked chrome"
        linked.symlink_to(self.fake)
        result = self.run_cli("start", "--profile", "linked", "--chrome-path", str(linked))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "invalid Chrome executable\n")

    def test_stale_devtools_file_is_rejected_and_startup_is_cleaned(self):
        self.assertEqual(self.start("bootstrap").returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", "bootstrap").returncode, 0)
        profile = self.home / ".job-apply-qa/chrome-profiles/stale"
        profile.mkdir(mode=0o700)
        stale = profile / "DevToolsActivePort"
        stale.write_text("9\n/stale\n")
        old = time.time() - 60
        os.utime(stale, (old, old))
        result = self.start("stale")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(":9", result.stdout)
        self.run_cli("stop", "--profile", "stale")

    def test_dangling_managed_entries_are_always_ambiguous(self):
        root = self.home / ".job-apply-qa"
        root.symlink_to(self.home / "missing-root")
        for command in (
            ("start", "--profile", "broken", "--chrome-path", str(self.fake)),
            ("check", "--profile", "broken"),
            ("stop", "--profile", "broken"),
            ("reset", "--profile", "broken"),
        ):
            with self.subTest(command=command[0]):
                result = self.run_cli(*command)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
                self.assertIn(result.stderr, ("managed storage is unsafe\n", "profile state is ambiguous\n"))

    def test_current_runtime_file_mode_is_revalidated_without_signaling(self):
        self.assertEqual(self.start("mode-swap").returncode, 0)
        state = self.home / ".job-apply-qa/runtime/mode-swap/state.json"
        state.chmod(0o644)
        self.signal_log.unlink(missing_ok=True)
        result = self.run_cli("stop", "--profile", "mode-swap")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stderr, "profile state is ambiguous\n")
        self.assertFalse(self.signal_log.exists())
        state.chmod(0o600)
        self.run_cli("stop", "--profile", "mode-swap")

    def test_opened_runtime_file_device_and_hardlinks_are_rejected(self):
        directory = Path(self.tmp.name) / "runtime-files"
        directory.mkdir(mode=0o700)
        state = directory / "state.json"
        state.write_text("{}")
        state.chmod(0o600)
        dir_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        real_fstat = os.fstat

        def changed_device(fd):
            value = real_fstat(fd)
            if fd != dir_fd:
                values = list(value)
                values[2] = value.st_dev + 1
                return os.stat_result(values)
            return value

        try:
            with mock.patch.object(LAUNCHER_MODULE.os, "fstat", side_effect=changed_device):
                with self.assertRaises(LAUNCHER_MODULE.Ambiguous):
                    LAUNCHER_MODULE._safe_regular(dir_fd, "state.json", directory.stat().st_dev)
            os.link(state, directory / "state-copy")
            with self.assertRaises(LAUNCHER_MODULE.Ambiguous):
                LAUNCHER_MODULE._safe_regular(dir_fd, "state.json", directory.stat().st_dev)
        finally:
            os.close(dir_fd)
