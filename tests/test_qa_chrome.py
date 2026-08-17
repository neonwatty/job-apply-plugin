import json
import os
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
import unittest
import http.client
import importlib.util
import io
from contextlib import ExitStack
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
LAUNCHER = REPO / "scripts" / "qa-chrome.py"
LAUNCHER_SPEC = importlib.util.spec_from_file_location("qa_chrome_launcher", LAUNCHER)
LAUNCHER_MODULE = importlib.util.module_from_spec(LAUNCHER_SPEC)
LAUNCHER_SPEC.loader.exec_module(LAUNCHER_MODULE)


class LauncherCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.home.mkdir(mode=0o700)
        self.fake = Path(self.tmp.name) / "fake chrome"
        self.signal_log = Path(self.tmp.name) / "signals.log"
        self.launch_log = Path(self.tmp.name) / "launches.log"
        self.fake.write_text(
            textwrap.dedent(
                """\
                #!/usr/bin/env python3
                import http.server, os, signal, socketserver, sys, threading, time
                user_dir = next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--user-data-dir='))
                launch_log = os.environ.get('SYNTHETIC_LAUNCH_LOG')
                if launch_log: open(launch_log, 'a').write('launched\\n')
                class Handler(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        if self.path != '/json/version':
                            self.send_error(404); return
                        body = ('{"Browser":"Synthetic","Protocol-Version":"1.3",'
                                '"webSocketDebuggerUrl":"ws://127.0.0.1:%d/devtools/browser/synthetic"}'
                                % self.server.server_address[1]).encode('ascii')
                        self.send_response(200); self.send_header('Content-Type', 'application/json')
                        self.send_header('Content-Length', str(len(body))); self.end_headers(); self.wfile.write(body)
                    def log_message(self, *args): pass
                requested_port = int(next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--remote-debugging-port=')))
                server = socketserver.TCPServer(('127.0.0.1', requested_port), Handler)
                port = server.server_address[1]
                open(os.path.join(user_dir, 'DevToolsActivePort'), 'w').write(str(port) + '\\n/devtools/browser/synthetic\\n')
                log = os.environ.get('SYNTHETIC_SIGNAL_LOG')
                def stop(signum, frame):
                    if log: open(log, 'a').write(str(signum) + '\\n')
                    threading.Thread(target=server.shutdown, daemon=True).start()
                signal.signal(signal.SIGTERM, stop); signal.signal(signal.SIGINT, stop)
                server.serve_forever()
                """
            )
        )
        self.fake.chmod(0o700)
        self.env = os.environ.copy()
        self.env.update(
            HOME=str(self.home),
            SYNTHETIC_SIGNAL_LOG=str(self.signal_log),
            SYNTHETIC_LAUNCH_LOG=str(self.launch_log),
        )

    def tearDown(self):
        try:
            self.run_cli("stop", "--profile", "linkedin-capture", timeout=3)
        except Exception:
            pass
        self.tmp.cleanup()

    def run_cli(self, *args, timeout=8):
        return subprocess.run(
            [sys.executable, str(LAUNCHER), *args],
            text=True,
            capture_output=True,
            env=self.env,
            timeout=timeout,
        )

    def start(self, profile="linkedin-capture", timeout=12):
        return self.run_cli("start", "--profile", profile, "--chrome-path", str(self.fake), timeout=timeout)

    def assert_closed(self, result, keys):
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(json.loads(result.stdout)), set(keys))
        self.assertEqual(result.stderr, "")

    def metadata_snapshot(self):
        paths = [self.home]
        for parent, directories, files in os.walk(self.home, followlinks=False):
            base = Path(parent)
            paths.extend(base / name for name in directories)
            paths.extend(base / name for name in files)
        snapshot = {}
        for path in sorted(set(paths)):
            value = path.lstat()
            snapshot[str(path.relative_to(self.home))] = (
                value.st_mode,
                value.st_uid,
                value.st_gid,
                value.st_dev,
                value.st_ino,
                value.st_nlink,
                value.st_size,
                value.st_atime_ns,
                value.st_mtime_ns,
                value.st_ctime_ns,
            )
        return snapshot

    def assert_reset_uses_readonly_observation(self, profile, expected_error=None):
        real_open = os.open
        profile_identity = (
            self.home / ".job-apply-qa" / "chrome-profiles" / profile
        ).stat()

        def readonly_open(path, flags, *args, **kwargs):
            forbidden = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC
            self.assertEqual(flags & forbidden, 0, "reset opened managed state for writing")
            parent_fd = kwargs.get("dir_fd")
            if parent_fd is not None:
                parent = os.fstat(parent_fd)
                self.assertNotEqual(
                    (parent.st_dev, parent.st_ino),
                    (profile_identity.st_dev, profile_identity.st_ino),
                    "reset inspected Chrome profile contents",
                )
            return real_open(path, flags, *args, **kwargs)

        def forbidden_mutation(*_args, **_kwargs):
            self.fail("reset attempted a filesystem mutation")

        def forbidden_data_read(*_args, **_kwargs):
            self.fail("reset read managed file contents")

        output = io.StringIO()
        mutations = ("mkdir", "write", "pwrite", "ftruncate", "rename", "replace", "unlink", "remove", "chmod")
        patches = [mock.patch.object(LAUNCHER_MODULE.os, name, side_effect=forbidden_mutation) for name in mutations]
        patches.extend([
            mock.patch.object(LAUNCHER_MODULE.os, "open", side_effect=readonly_open),
            mock.patch.object(LAUNCHER_MODULE.os, "read", side_effect=forbidden_data_read),
            mock.patch.object(LAUNCHER_MODULE.os, "pread", side_effect=forbidden_data_read),
            mock.patch.object(LAUNCHER_MODULE.sys, "stdout", output),
        ])
        with mock.patch.dict(os.environ, {"HOME": str(self.home)}):
            with ExitStack() as stack:
                for patcher in patches:
                    stack.enter_context(patcher)
                if expected_error is None:
                    LAUNCHER_MODULE.command_reset(profile)
                else:
                    with self.assertRaisesRegex(LAUNCHER_MODULE.UserError, expected_error):
                        LAUNCHER_MODULE.command_reset(profile)
        return output.getvalue()

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

    def test_concurrent_start_launches_one_supervisor(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.start("concurrent"), range(2)))
        self.assertTrue(all(r.returncode == 0 for r in results), [r.stderr for r in results])
        controls = {json.loads(r.stdout)["cdpUrl"] for r in results}
        self.assertEqual(len(controls), 1)
        self.run_cli("stop", "--profile", "concurrent")

    def test_substituted_control_and_stale_runtime_fail_ambiguous_without_signal(self):
        self.assertEqual(self.start().returncode, 0)
        runtime = self.home / ".job-apply-qa/runtime/linkedin-capture"
        control = runtime / "control.json"
        original = control.read_text()
        try:
            control.write_text(original.replace('"token":"', '"token":"00'))
            control.chmod(0o600)
            result = self.run_cli("stop", "--profile", "linkedin-capture")
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stderr, "profile state is ambiguous\n")
            time.sleep(0.1)
            self.assertFalse(self.signal_log.exists())
        finally:
            control.write_text(original)
            control.chmod(0o600)
            self.run_cli("stop", "--profile", "linkedin-capture")

    def test_closed_authenticated_control_rejects_bad_origin_and_schema(self):
        self.assertEqual(self.start().returncode, 0)
        root = self.home / ".job-apply-qa/runtime/linkedin-capture"
        control = json.loads((root / "control.json").read_text())
        connection = http.client.HTTPConnection("127.0.0.1", control["port"], timeout=2)
        body = json.dumps({"action": "stop", "token": control["token"], "extra": True})
        connection.request(
            "POST", "/control", body=body,
            headers={"Host": "127.0.0.1:%d" % control["port"], "Origin": "https://example.invalid", "Content-Type": "application/json"},
        )
        response = connection.getresponse()
        self.assertEqual(response.status, 400)
        self.assertEqual(json.loads(response.read()), {"status": "error"})
        connection.close()
        self.assertEqual(self.run_cli("check", "--profile", "linkedin-capture").returncode, 0)

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

    def test_lookalike_process_is_never_signaled(self):
        lookalike = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "--user-data-dir=linkedin-capture"])
        try:
            self.assertEqual(self.start().returncode, 0)
            self.assertEqual(self.run_cli("stop", "--profile", "linkedin-capture").returncode, 0)
            self.assertIsNone(lookalike.poll())
        finally:
            lookalike.terminate()
            lookalike.wait(timeout=3)

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

    def test_unlocked_stale_runtime_is_ambiguous_and_launches_nothing(self):
        self.assertEqual(self.start("bootstrap").returncode, 0)
        self.assertEqual(self.run_cli("stop", "--profile", "bootstrap").returncode, 0)
        self.signal_log.unlink(missing_ok=True)
        runtime = self.home / ".job-apply-qa/runtime/stale-owner"
        runtime.mkdir(mode=0o700)

        result = self.start("stale-owner")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "profile state is ambiguous\n")
        self.assertFalse(self.signal_log.exists())
        self.assertFalse((runtime / "control.json").exists())

    def test_runtime_rename_and_replacement_cannot_create_second_owner(self):
        self.assertEqual(self.start("runtime-swap").returncode, 0)
        runtime_root = self.home / ".job-apply-qa/runtime"
        runtime = runtime_root / "runtime-swap"
        displaced = runtime_root / "runtime-swap-displaced"
        control = json.loads((runtime / "control.json").read_text())
        runtime.rename(displaced)
        runtime.mkdir(mode=0o700)
        self.signal_log.unlink(missing_ok=True)

        second = self.start("runtime-swap")
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(second.stderr, "profile state is ambiguous\n")
        self.assertFalse(self.signal_log.exists())

        connection = http.client.HTTPConnection("127.0.0.1", control["port"], timeout=2)
        body = json.dumps({"action": "stop", "token": control["token"]})
        connection.request("POST", "/control", body=body, headers={
            "Host": "127.0.0.1:%d" % control["port"],
            "Origin": "qa-chrome://local",
            "Content-Type": "application/json",
        })
        self.assertEqual(connection.getresponse().status, 400)
        connection.close()
        runtime.rmdir()
        displaced.rename(runtime)
        self.run_cli("stop", "--profile", "runtime-swap")

    def test_combined_owner_and_runtime_substitution_cannot_launch_second_child(self):
        self.assertEqual(self.start("combined-swap").returncode, 0)
        owner = self.home / ".job-apply-qa-owner-combined-swap"
        runtime_root = self.home / ".job-apply-qa/runtime"
        runtime = runtime_root / "combined-swap"
        displaced_owner = self.home / ".job-apply-qa-owner-combined-swap-displaced"
        displaced_runtime = runtime_root / "combined-swap-displaced"
        first_control = json.loads((runtime / "control.json").read_text())
        owner.rename(displaced_owner)
        runtime.rename(displaced_runtime)

        second = self.start("combined-swap")
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(second.stdout, "")
        self.assertEqual(second.stderr, "profile state is ambiguous\n")
        self.assertFalse(runtime.exists())

        connection = http.client.HTTPConnection("127.0.0.1", first_control["port"], timeout=2)
        body = json.dumps({"action": "stop", "token": first_control["token"]})
        connection.request("POST", "/control", body=body, headers={
            "Host": "127.0.0.1:%d" % first_control["port"],
            "Origin": "qa-chrome://local",
            "Content-Type": "application/json",
        })
        self.assertEqual(connection.getresponse().status, 400)
        connection.close()
        displaced_runtime.rename(runtime)
        displaced_owner.rename(owner)
        self.run_cli("stop", "--profile", "combined-swap")

    def test_owner_profile_and_runtime_substitution_cannot_launch_second_child(self):
        self.assertEqual(self.start("composed-swap").returncode, 0)
        root = self.home / ".job-apply-qa"
        owner = self.home / ".job-apply-qa-owner-composed-swap"
        profile = root / "chrome-profiles/composed-swap"
        runtime_root = root / "runtime"
        displaced_owner = owner.with_name(owner.name + "-displaced")
        displaced_profile = profile.with_name(profile.name + "-displaced")
        displaced_runtime_root = runtime_root.with_name("runtime-displaced")
        control = json.loads((runtime_root / "composed-swap/control.json").read_text())
        owner.rename(displaced_owner)
        profile.rename(displaced_profile)
        runtime_root.rename(displaced_runtime_root)
        owner.write_text(displaced_owner.read_text())
        owner.chmod(0o600)
        profile.mkdir(mode=0o700)
        runtime_root.mkdir(mode=0o700)

        second = self.start("composed-swap")
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(second.stdout, "")
        self.assertEqual(second.stderr, "profile state is ambiguous\n")

        runtime_root.rmdir()
        profile.rmdir()
        owner.unlink()
        displaced_runtime_root.rename(runtime_root)
        displaced_profile.rename(profile)
        displaced_owner.rename(owner)
        connection = http.client.HTTPConnection("127.0.0.1", control["port"], timeout=2)
        body = json.dumps({"action": "stop", "token": control["token"]})
        connection.request("POST", "/control", body=body, headers={
            "Host": "127.0.0.1:%d" % control["port"],
            "Origin": "qa-chrome://local",
            "Content-Type": "application/json",
        })
        self.assertEqual(connection.getresponse().status, 200)
        connection.close()

    def test_whole_root_replacement_cannot_launch_or_authorize_lifecycle(self):
        profile_name = "root-swap"
        self.assertEqual(self.start(profile_name).returncode, 0)
        root = self.home / ".job-apply-qa"
        displaced = self.home / ".job-apply-qa-displaced"
        original_runtime = root / "runtime" / profile_name
        state_text = (original_runtime / "state.json").read_text()
        control_text = (original_runtime / "control.json").read_text()
        control = json.loads(control_text)
        root.rename(displaced)
        root.mkdir(mode=0o700)
        (root / "chrome-profiles").mkdir(mode=0o700)
        (root / "runtime").mkdir(mode=0o700)

        second = None
        replacement_stop = None
        direct_status = None
        replacement_signaled = None
        try:
            second = self.start(profile_name)
            if second.returncode == 0:
                self.run_cli("stop", "--profile", profile_name)

            replacement_runtime = root / "runtime" / profile_name
            replacement_runtime.mkdir(mode=0o700, exist_ok=True)
            for name, value in (("state.json", state_text), ("control.json", control_text)):
                artifact = replacement_runtime / name
                artifact.write_text(value)
                artifact.chmod(0o600)
            self.signal_log.unlink(missing_ok=True)
            replacement_stop = self.run_cli("stop", "--profile", profile_name)

            connection = http.client.HTTPConnection("127.0.0.1", control["port"], timeout=2)
            body = json.dumps({"action": "stop", "token": control["token"]})
            connection.request("POST", "/control", body=body, headers={
                "Host": "127.0.0.1:%d" % control["port"],
                "Origin": "qa-chrome://local",
                "Content-Type": "application/json",
            })
            direct_status = connection.getresponse().status
            connection.close()
            replacement_signaled = self.signal_log.exists()
        finally:
            for directory in (root / "runtime", root / "chrome-profiles"):
                for child in directory.iterdir():
                    if child.is_dir():
                        for artifact in child.iterdir():
                            artifact.unlink()
                        child.rmdir()
                directory.rmdir()
            for artifact in root.iterdir():
                artifact.unlink()
            root.rmdir()
            displaced.rename(root)
            self.run_cli("stop", "--profile", profile_name)

        self.assertIsNotNone(second)
        self.assertNotEqual(second.returncode, 0)
        self.assertEqual(second.stdout, "")
        self.assertEqual(second.stderr, "profile state is ambiguous\n")
        self.assertEqual(self.launch_log.read_text().splitlines(), ["launched"])
        self.assertIsNotNone(replacement_stop)
        self.assertNotEqual(replacement_stop.returncode, 0)
        self.assertEqual(replacement_stop.stderr, "profile state is ambiguous\n")
        self.assertFalse(replacement_signaled)
        self.assertEqual(direct_status, 400)

    def test_copied_replacement_state_and_control_cannot_signal_child(self):
        self.assertEqual(self.start("copied-state").returncode, 0)
        runtime = self.home / ".job-apply-qa/runtime/copied-state"
        displaced = runtime.with_name(runtime.name + "-displaced")
        state_text = (runtime / "state.json").read_text()
        control_text = (runtime / "control.json").read_text()
        runtime.rename(displaced)
        runtime.mkdir(mode=0o700)
        for name, value in (("state.json", state_text), ("control.json", control_text)):
            target = runtime / name
            target.write_text(value)
            target.chmod(0o600)
        self.signal_log.unlink(missing_ok=True)

        result = self.run_cli("stop", "--profile", "copied-state")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "profile state is ambiguous\n")
        time.sleep(0.15)
        self.assertFalse(self.signal_log.exists())

        for child in runtime.iterdir():
            child.unlink()
        runtime.rmdir()
        displaced.rename(runtime)
        self.run_cli("stop", "--profile", "copied-state")

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

    def test_substituted_devtools_endpoint_must_match_browser_websocket_path(self):
        class UnrelatedHandler(http.server.BaseHTTPRequestHandler):
            def do_GET(handler_self):
                body = json.dumps({
                    "Protocol-Version": "1.3",
                    "webSocketDebuggerUrl": "ws://127.0.0.1:%d/devtools/browser/substituted" % handler_self.server.server_address[1],
                }).encode("ascii")
                handler_self.send_response(200)
                handler_self.send_header("Content-Length", str(len(body)))
                handler_self.end_headers()
                handler_self.wfile.write(body)

            def log_message(self, *_args):
                pass

        unrelated = http.server.ThreadingHTTPServer(("127.0.0.1", 0), UnrelatedHandler)
        thread = threading.Thread(target=unrelated.serve_forever, daemon=True)
        thread.start()
        substituted = Path(self.tmp.name) / "substituted chrome"
        substituted.write_text(textwrap.dedent("""\
            #!/usr/bin/env python3
            import os, signal, sys, time
            user_dir = next(a.split('=', 1)[1] for a in sys.argv if a.startswith('--user-data-dir='))
            port = os.environ['UNRELATED_CDP_PORT']
            open(os.path.join(user_dir, 'DevToolsActivePort'), 'w').write(port + '\\n/devtools/browser/substituted\\n')
            signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
            while True: time.sleep(1)
        """))
        substituted.chmod(0o700)
        self.env["UNRELATED_CDP_PORT"] = str(unrelated.server_address[1])
        try:
            result = self.run_cli(
                "start", "--profile", "substituted-cdp", "--chrome-path", str(substituted), timeout=12,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(result.stdout, "")
            self.assertEqual(result.stderr, "Chrome did not become ready\n")
        finally:
            unrelated.shutdown()
            unrelated.server_close()
            thread.join(timeout=2)

    def test_partial_headers_and_bodies_do_not_pin_shutdown(self):
        self.assertEqual(self.start("slow-control").returncode, 0)
        runtime = self.home / ".job-apply-qa/runtime/slow-control"
        control = json.loads((runtime / "control.json").read_text())

        partial_header = socket.create_connection(("127.0.0.1", control["port"]), timeout=2)
        partial_header.sendall(b"POST /control HTTP/1.1\r\nHost: 127.0.0.1")
        time.sleep(0.7)
        partial_header.close()

        partial_body = socket.create_connection(("127.0.0.1", control["port"]), timeout=2)
        headers = (
            "POST /control HTTP/1.1\r\n"
            "Host: 127.0.0.1:%d\r\n"
            "Origin: qa-chrome://local\r\n"
            "Content-Type: application/json\r\n"
            "Content-Length: 200\r\n\r\n" % control["port"]
        ).encode("ascii")
        partial_body.sendall(headers + b'{"action":"stop"')
        started = time.monotonic()
        result = self.run_cli("stop", "--profile", "slow-control", timeout=7)
        elapsed = time.monotonic() - started
        partial_body.close()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertLess(elapsed, 6.0)
        self.assertFalse(runtime.exists())

    def test_control_connection_saturation_is_bounded(self):
        self.assertEqual(self.start("saturated-control").returncode, 0)
        runtime = self.home / ".job-apply-qa/runtime/saturated-control"
        control = json.loads((runtime / "control.json").read_text())
        sockets = []
        try:
            for _ in range(LAUNCHER_MODULE.MAX_CONTROL_CONNECTIONS + 12):
                client = socket.create_connection(("127.0.0.1", control["port"]), timeout=2)
                client.settimeout(0.25)
                client.sendall(b"POST /control HTTP/1.1\r\nHost: 127.0.0.1")
                sockets.append(client)
            time.sleep(0.15)
            still_open = 0
            for client in sockets:
                try:
                    if client.recv(1) != b"":
                        still_open += 1
                except socket.timeout:
                    still_open += 1
                except (ConnectionResetError, OSError):
                    pass
            self.assertLessEqual(still_open, LAUNCHER_MODULE.MAX_CONTROL_CONNECTIONS)
        finally:
            for client in sockets:
                client.close()
        stopped = self.run_cli("stop", "--profile", "saturated-control", timeout=7)
        self.assertEqual(stopped.returncode, 0, stopped.stderr)
        self.assertFalse(runtime.exists())

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


if __name__ == "__main__":
    unittest.main()
