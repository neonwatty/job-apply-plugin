import importlib.util
import json
import os
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

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix-domain sockets required")
    def test_prepared_operation_abandonment_requires_exact_lease(self):
        server = SERVER.SyntheticAccountServer(0)
        operation = "8" * 64
        socket_path = server.prepare_native_operation(operation)
        generation, leased_socket = server.prepared_native_operation_lease(
            operation, socket_path,
        )
        self.assertFalse(server.abandon_native_operation(operation, generation + 1, leased_socket))
        self.assertFalse(server.abandon_native_operation(operation, generation, leased_socket + ".other"))
        self.assertTrue(server.operation_is_registered(operation))
        self.assertTrue(server.abandon_native_operation(operation, generation, leased_socket))
        self.assertFalse(server.operation_is_registered(operation))
        forged = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        forged.connect(socket_path); forged.close()
        server.server_close()

    @unittest.skipUnless(hasattr(socket, "AF_UNIX"), "Unix-domain sockets required")
    def test_abandoned_generation_cannot_retire_replacement(self):
        server = SERVER.SyntheticAccountServer(0)
        operation = "7" * 64
        first_socket = server.prepare_native_operation(operation)
        first_generation, _ = server.prepared_native_operation_lease(operation, first_socket)
        self.assertTrue(server.abandon_native_operation(operation, first_generation, first_socket))
        second_socket = server.prepare_native_operation(operation)
        second_generation, _ = server.prepared_native_operation_lease(operation, second_socket)
        self.assertNotEqual(first_generation, second_generation)
        self.assertFalse(server.abandon_native_operation(operation, first_generation, first_socket))
        self.assertTrue(server.operation_is_registered(operation))
        self.assertTrue(server.abandon_native_operation(operation, second_generation, second_socket))
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

    def test_visible_browser_setup_disables_background_updates(self):
        source = (ROOT / "scripts/qa-account.py").read_text(encoding="utf-8")
        self.assertEqual(source.count('"--disable-background-networking"'), 1)
        self.assertEqual(source.count('"--disable-component-update"'), 1)

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
            attacker_source = root / "adversarial-peer.c"
            attacker_source.write_text(r'''
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <time.h>
#include <unistd.h>

static int send_all(int descriptor, const char *value, size_t length) {
    while (length > 0) {
        ssize_t sent = send(descriptor, value, length, 0);
        if (sent < 0 && errno == EINTR) continue;
        if (sent < 0 && (errno == EPIPE || errno == ECONNRESET)) return 1;
        if (sent <= 0) return -1;
        value += sent;
        length -= (size_t)sent;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    int marker = open(argv[2], O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (marker < 0 || close(marker) != 0) return 3;
    struct timespec pause = {0, 10000000};
    for (int attempt = 0; access(argv[3], F_OK) != 0; attempt++) {
        if (attempt >= 500) return 4;
        nanosleep(&pause, NULL);
    }
    int channel = socket(AF_UNIX, SOCK_STREAM, 0);
    if (channel < 0) return 5;
    int no_sigpipe = 1;
    setsockopt(channel, SOL_SOCKET, SO_NOSIGPIPE, &no_sigpipe, sizeof(no_sigpipe));
    struct timeval timeout = {3, 0};
    setsockopt(channel, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    struct sockaddr_un address;
    memset(&address, 0, sizeof(address));
    address.sun_family = AF_UNIX;
    if (strlen(argv[1]) >= sizeof(address.sun_path)) { close(channel); return 5; }
    memcpy(address.sun_path, argv[1], strlen(argv[1]) + 1);
    if (connect(channel, (struct sockaddr *)&address, sizeof(address)) != 0) {
        close(channel); return 5;
    }
    int sent = send_all(channel, argv[4], strlen(argv[4]));
    if (sent == 0) sent = send_all(channel, "\n", 1);
    if (sent > 0) { close(channel); return 0; }
    if (sent < 0) { close(channel); return 5; }
    shutdown(channel, SHUT_WR);
    char acknowledgment;
    ssize_t received;
    do { received = recv(channel, &acknowledgment, 1, 0); }
    while (received < 0 && errno == EINTR);
    int saved_errno = errno;
    close(channel);
    if (received == 0 || (received < 0 && saved_errno == ECONNRESET)) return 0;
    return received > 0 ? 6 : 5;
}
''', encoding="utf-8")
            compiled = subprocess.run(
                ["xcrun", "clang", "-O2", "-Wall", "-Werror", "-o", str(binary),
                 str(attacker_source)],
                capture_output=True, check=False,
            )
            self.assertEqual(
                (compiled.returncode, compiled.stdout, compiled.stderr), (0, b"", b"")
            )
            payload = json.dumps({
                "operationFingerprint": "sha256:" + operation,
                "nativeOriginAttested": True,
                "signedBrowserIdentityAttested": True,
                "beforeFillAttested": True,
                "duringFillAttested": True,
                "afterClearAttested": True,
                "secureControlCleared": True,
            }, sort_keys=True)
            with tempfile.TemporaryFile() as attacker_stderr:
                attacker = subprocess.Popen([
                    str(binary), socket_path, str(ready), str(release), payload,
                ], stdout=subprocess.DEVNULL, stderr=attacker_stderr)
                try:
                    deadline = time.monotonic() + 5
                    while not ready.exists() and time.monotonic() < deadline:
                        if attacker.poll() is not None:
                            break
                        time.sleep(0.01)
                    self.assertTrue(ready.exists(), "path-swapped peer did not become ready")
                    self.assertIsNone(attacker.poll(), "adversarial peer exited before restoration")
                    os.replace(preserved, binary)
                    release.touch()
                    attacker.wait(timeout=5)
                    attacker_stderr.seek(0)
                    stderr = attacker_stderr.read()
                    self.assertEqual(attacker.returncode, 0, stderr.decode(errors="replace"))
                    self.assertEqual(stderr, b"")
                    self.assertIsNone(server.consume_observation(operation))
                    self.assertEqual(server._signed_identity(binary), server._native_identity)
                finally:
                    release.touch()
                    if attacker.poll() is None:
                        attacker.kill()
                    attacker.wait(timeout=2)
                    if preserved.exists():
                        os.replace(preserved, binary)
                    server.server_close()
