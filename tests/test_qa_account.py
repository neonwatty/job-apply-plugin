import importlib.util
import json
import os
import shutil
import socket
import subprocess
import tempfile
import threading
import sys
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module

SERVER = load("account_server_test", ROOT / "qa/account_server.py")
ORACLE = load("account_oracle_test", ROOT / "qa/account_oracle.py")
QA = load("qa_account_test", ROOT / "scripts/qa-account.py")


class SyntheticAccountQATests(unittest.TestCase):
    def test_workday_missing_playwright_refuses_before_external_setup(self):
        missing = subprocess.CompletedProcess([], 1)
        with mock.patch.object(QA.sys, "platform", "darwin"), \
             mock.patch.object(QA.subprocess, "run", return_value=missing) as run, \
             mock.patch.object(QA, "_compile_native") as compile_native, \
             mock.patch.object(QA, "_start_browser") as start_browser:
            with self.assertRaisesRegex(ValueError, "dependencies are unavailable"):
                QA.verify_all(
                    "macos-keychain", owner_approved_visible_browser_tests=True,
                )
        run.assert_called_once()
        compile_native.assert_not_called()
        start_browser.assert_not_called()

    def test_oracle_missing_playwright_refuses_before_external_setup(self):
        missing = subprocess.CompletedProcess([], 1)
        with mock.patch.object(QA.sys, "platform", "darwin"), \
             mock.patch.object(QA.subprocess, "run", return_value=missing) as run, \
             mock.patch.object(QA, "_start_browser") as start_browser, \
             mock.patch.object(
                 QA.ACCOUNT_FLOWS_MACOS.NativeMacOSAccessibilityProvider,
                 "from_reviewed_sources",
             ) as build_native:
            with self.assertRaisesRegex(ValueError, "dependencies are unavailable"):
                QA.verify_oracle_email_only(
                    "macos-accessibility", owner_approved_visible_browser_tests=True,
                )
        run.assert_called_once()
        start_browser.assert_not_called()
        build_native.assert_not_called()

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix-domain sockets required")
    def test_registration_retirement_is_owned_by_exact_generation(self):
        server = SERVER.SyntheticAccountServer(0)
        operation = "9" * 64
        first_socket = server.prepare_native_operation(operation)
        first_generation = server._registrations[operation][0]
        self.assertTrue(server._retire_native_operation(operation, first_generation))
        second_socket = server.prepare_native_operation(operation)
        second_generation = server._registrations[operation][0]
        self.assertNotEqual(first_generation, second_generation)
        self.assertFalse(server._retire_native_operation(operation, first_generation))
        self.assertTrue(server.operation_is_registered(operation))
        for socket_path in (first_socket, second_socket):
            forged = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            forged.connect(socket_path); forged.close()
        server.server_close()

    def test_workday_mismatch_has_value_free_scenario_diagnostics(self):
        result = QA._workday_scenario_result("success", {
            "lifecycleState": "ambiguous", "retryAllowed": False,
            "finalActionAuthorized": False, "secureControlCleared": True,
        })
        self.assertFalse(result["passed"])
        self.assertEqual(result["scenario"], "success")
        self.assertEqual(result["diagnostics"], {
            "expectedLifecycle": "active", "observedLifecycle": "ambiguous",
            "retryDenied": True, "finalActionDenied": True,
            "nativeControlCleared": True,
            "observerStage": None, "nativeTransitionAdvanced": None,
            "observationPending": None, "nativeStage": None, "helperStage": None,
        })
        self.assertNotIn("@", json.dumps(result))

    def test_visible_browser_setup_is_bounded_without_retrying_native_effects(self):
        source = (ROOT / "scripts/qa-account.py").read_text(encoding="utf-8")
        server = (ROOT / "qa/account_server.py").read_text(encoding="utf-8")
        self.assertEqual(source.count("timeout=12"), 2)
        self.assertEqual(source.count("for _ in range(3):"), 2)
        self.assertEqual(source.count("const page = await context.newPage();"), 2)
        self.assertEqual(source.count("if (existing !== page) await existing.close();"), 2)
        self.assertNotIn("context.pages()[0] ?? await context.newPage()", source)
        self.assertIn("listener.settimeout(45)", server)
        self.assertEqual(source.count("provider.provision_or_reuse_and_fill"), 0)

    @unittest.skipUnless(
        os.environ.get("JOB_APPLY_OWNER_APPROVED_VISIBLE_BROWSER_TESTS") == "1",
        "visible browser tests require dedicated opt-in",
    )
    def test_oracle_email_only_oracle_is_value_free_zero_keychain_and_non_final(self):
        if not sys.platform.startswith("darwin"):
            with self.assertRaises(ValueError):
                QA.verify_oracle_email_only(
                    "macos-accessibility", owner_approved_visible_browser_tests=True,
                )
            return
        result = QA.verify_oracle_email_only(
            "macos-accessibility", owner_approved_visible_browser_tests=True,
        )
        self.assertTrue(result["passed"])
        self.assertEqual(result["credentialProviderInvocations"], 0)
        self.assertEqual(result["keychainDelta"], 0)
        self.assertEqual(result["finalActions"], 0)
        self.assertEqual(result["nextActivationsMaximum"], 1)
        self.assertFalse(result["emailTransmittedOverHttp"])
        self.assertNotIn("synthetic@example.invalid", json.dumps(result))

    @unittest.skipUnless(
        os.environ.get("JOB_APPLY_OWNER_APPROVED_VISIBLE_BROWSER_TESTS") == "1",
        "visible browser tests require dedicated opt-in",
    )
    def test_all_scenarios_are_deterministic_and_value_free(self):
        if not sys.platform.startswith("darwin"):
            with self.assertRaises(ValueError):
                QA.verify_all("macos-keychain", owner_approved_visible_browser_tests=True)
            return
        result = QA.verify_all("macos-keychain", owner_approved_visible_browser_tests=True)
        self.assertTrue(result["passed"])
        self.assertFalse(result["submissionAccepted"])
        self.assertEqual({item["scenario"] for item in result["scenarios"]}, set(ORACLE.SCENARIOS))
        self.assertNotIn("password", json.dumps(result).lower())

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix-domain sockets required")
    def test_visible_portal_accepts_no_http_submission(self):
        server = SERVER.SyntheticAccountServer(0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            port = server.server_address[1]
            operation = "a" * 64
            socket_path = server.prepare_native_operation(operation)
            target = f"http://127.0.0.1:{port}/synthetic-account?operation={operation}"
            with urllib.request.urlopen(target) as response:
                page = response.read().decode()
            self.assertIn("SYNTHETIC LOOPBACK ONLY", page)
            request = urllib.request.Request(target, data=b"", method="POST")
            with self.assertRaises(urllib.error.HTTPError) as raised:
                urllib.request.urlopen(request)
            self.assertEqual(raised.exception.code, 405)
            forged = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            forged.connect(socket_path); forged.close()
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix-domain sockets required")
    def test_browser_observations_cannot_publish_before_native_effect(self):
        server = SERVER.SyntheticAccountServer(0)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            port = server.server_address[1]
            operation = "b" * 64
            socket_path = server.prepare_native_operation(operation)
            target = f"http://127.0.0.1:{port}/synthetic-account?operation={operation}"
            with urllib.request.urlopen(target) as response:
                page = response.read().decode()
            self.assertNotIn("effect", page.lower())
            self.assertNotIn("capability", page.lower())
            for lifecycle_label in SERVER.SyntheticAccountServer._PORTAL_TRANSITIONS:
                self.assertNotIn(lifecycle_label.replace("_", " "), page.lower())
            url = f"http://127.0.0.1:{port}/observations/by-operation/{operation}"
            with self.assertRaises(urllib.error.HTTPError) as before:
                urllib.request.urlopen(url)
            self.assertEqual(before.exception.code, 404)
            forged = urllib.request.Request(f"http://127.0.0.1:{port}/native-effect/forged", data=b"", method="POST")
            with self.assertRaises(urllib.error.HTTPError) as denied:
                urllib.request.urlopen(forged)
            self.assertEqual(denied.exception.code, 405)
            forged = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            try:
                forged.connect(socket_path)
                try:
                    forged.sendall(json.dumps({
                        "operationFingerprint": "sha256:" + operation,
                        "nativeOriginAttested": True,
                        "signedBrowserIdentityAttested": True,
                        "beforeFillAttested": True,
                        "duringFillAttested": True,
                        "afterClearAttested": True,
                        "secureControlCleared": True,
                    }).encode() + b"\n")
                except (BrokenPipeError, ConnectionResetError):
                    # The listener authenticates the connected process before
                    # reading payload.  An exact fail-closed rejection may race
                    # this write; either result proves the forged peer cannot
                    # publish an observation.
                    pass
            finally:
                forged.close()
            time.sleep(0.1)
            with self.assertRaises(urllib.error.HTTPError) as after_forgery:
                urllib.request.urlopen(url)
            self.assertEqual(after_forgery.exception.code, 404)
            with self.assertRaises(TypeError):
                server.prepare_native_operation("c" * 64, "success")
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_python_peer_cannot_forge_attestation_for_exact_signed_native_helper(self):
        if not sys.platform.startswith("darwin"):
            self.skipTest("Darwin peer identity is required")
        with tempfile.TemporaryDirectory() as directory:
            binary = Path(directory) / "credential-integration"
            QA._compile_native(binary)
            server = SERVER.SyntheticAccountServer(0, native_helper_path=binary)
            thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
            try:
                operation = "d" * 64
                socket_path = server.prepare_native_operation(operation)
                attacker = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                attacker.connect(socket_path)
                attacker.sendall(json.dumps({
                    "operationFingerprint": "sha256:" + operation,
                    "nativeOriginAttested": True,
                    "signedBrowserIdentityAttested": True,
                    "beforeFillAttested": True,
                    "duringFillAttested": True,
                    "afterClearAttested": True,
                    "secureControlCleared": True,
                }).encode() + b"\n")
                attacker.close(); time.sleep(0.1)
                observation = f"http://127.0.0.1:{server.server_address[1]}/observations/by-operation/{operation}"
                with self.assertRaises(urllib.error.HTTPError) as denied:
                    urllib.request.urlopen(observation)
                self.assertEqual(denied.exception.code, 404)
            finally:
                server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_path_replacement_cannot_authenticate_running_python_as_restored_helper(self):
        if not sys.platform.startswith("darwin"):
            self.skipTest("Darwin dynamic code identity is required")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary = root / "credential-integration"
            preserved = root / "credential-integration.preserved"
            ready = root / "attacker-ready"
            release = root / "attacker-release"
            QA._compile_native(binary)
            server = SERVER.SyntheticAccountServer(0, native_helper_path=binary)
            operation = "e" * 64
            socket_path = server.prepare_native_operation(operation)
            os.replace(binary, preserved)
            shutil.copy2(sys.executable, binary)
            payload = json.dumps({
                "operationFingerprint": "sha256:" + operation,
                "nativeOriginAttested": True,
                "signedBrowserIdentityAttested": True,
                "beforeFillAttested": True,
                "duringFillAttested": True,
                "afterClearAttested": True,
                "secureControlCleared": True,
            }, sort_keys=True)
            attacker_script = r'''
import pathlib, socket, sys, time
socket_path, ready_path, release_path, payload = sys.argv[1:]
pathlib.Path(ready_path).touch()
deadline = time.monotonic() + 5
while not pathlib.Path(release_path).exists():
    if time.monotonic() >= deadline:
        raise SystemExit(4)
    time.sleep(0.01)
channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
channel.settimeout(3)
channel.connect(socket_path)
channel.sendall(payload.encode("utf-8") + b"\n")
channel.shutdown(socket.SHUT_WR)
try:
    acknowledgment = channel.recv(1)
except socket.timeout:
    raise SystemExit(5)
finally:
    channel.close()
raise SystemExit(6 if acknowledgment else 0)
'''
            attacker = subprocess.Popen([
                str(binary), "-c", attacker_script, socket_path,
                str(ready), str(release), payload,
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                deadline = time.monotonic() + 5
                while not ready.exists() and time.monotonic() < deadline:
                    if attacker.poll() is not None:
                        break
                    time.sleep(0.01)
                self.assertTrue(ready.exists(), "path-swapped peer did not become ready")
                os.replace(preserved, binary)
                release.touch()
                stdout, stderr = attacker.communicate(timeout=5)
                self.assertEqual(attacker.returncode, 0, stderr.decode(errors="replace"))
                self.assertEqual((stdout, stderr), (b"", b""))
                self.assertIsNone(server.consume_observation(operation))
                self.assertEqual(server._signed_identity(binary), server._native_identity)
            finally:
                if attacker.poll() is None:
                    attacker.kill(); attacker.wait(timeout=2)
                if preserved.exists():
                    os.replace(preserved, binary)
                server.server_close()
