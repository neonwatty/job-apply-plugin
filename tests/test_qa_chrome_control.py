from tests.support.chrome_launcher_case import *


class LauncherCase(ChromeLauncherCase):
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

    def test_lookalike_process_is_never_signaled(self):
        lookalike = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)", "--user-data-dir=linkedin-capture"])
        try:
            self.assertEqual(self.start().returncode, 0)
            self.assertEqual(self.run_cli("stop", "--profile", "linkedin-capture").returncode, 0)
            self.assertIsNone(lookalike.poll())
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
