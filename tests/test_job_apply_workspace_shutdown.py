"""Shutdown must drain request workers without waiting on idle clients."""

import io
import socket
from contextlib import redirect_stderr
import threading
import unittest
from http.server import BaseHTTPRequestHandler

from tests.support.workspace_case import WORKSPACE, tempfile, Path, mock


class ShutdownTests(unittest.TestCase):
    def test_close_waits_for_active_request_work(self):
        entered = threading.Event()
        release = threading.Event()
        finished = threading.Event()
        closed = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def handle(self):
                entered.set()
                release.wait(5)
                self.server.store.patch_profile(
                    {"contact": {"name": "Synthetic Shutdown Test"}},
                    expected_revision=self.server.store.inspect_profile()["revision"],
                    source="user",
                )
                finished.set()

        with tempfile.TemporaryDirectory() as temporary:
            server = WORKSPACE.WorkspaceServer(Path(temporary), 0)
            server.RequestHandlerClass = Handler
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            client = socket.create_connection(server.server_address, timeout=2)
            closer = None
            try:
                self.assertTrue(entered.wait(2))
                server.shutdown()
                def close():
                    server.server_close()
                    closed.set()
                closer = threading.Thread(target=close)
                closer.start()
                self.assertFalse(closed.wait(.2), "server_close abandoned an active worker")
                release.set()
                self.assertTrue(closed.wait(2))
                self.assertTrue(finished.is_set())
                self.assertEqual(server.store.get_profile()["contact"]["name"], "Synthetic Shutdown Test")
            finally:
                release.set()
                client.close()
                server.shutdown()
                server.server_close()
                serving.join(2)
                if closer:
                    closer.join(2)

    def test_close_unblocks_incomplete_request(self):
        entered = threading.Event()
        finished = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def handle(self):
                entered.set()
                try:
                    self.rfile.readline()
                finally:
                    finished.set()

        with tempfile.TemporaryDirectory() as temporary:
            server = WORKSPACE.WorkspaceServer(Path(temporary), 0)
            server.RequestHandlerClass = Handler
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            client = socket.create_connection(server.server_address, timeout=2)
            try:
                client.sendall(b"GET / HTTP/1.1")
                self.assertTrue(entered.wait(2))
                server.shutdown()
                # Model platforms where shutdown does not wake a blocked recv.
                with mock.patch.object(type(next(iter(server._connections))), "shutdown", return_value=None):
                    closer = threading.Thread(target=server.server_close, daemon=True)
                    closer.start()
                    closer.join(2)
                self.assertFalse(closer.is_alive(), "idle client blocked shutdown")
                self.assertTrue(finished.is_set(), "request worker survived shutdown")
            finally:
                client.close()
                server.shutdown()
                server.server_close()
                serving.join(2)

    def test_close_unblocks_response_to_client_that_is_not_reading(self):
        entered = threading.Event()
        finished = threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def handle(self):
                self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4096)
                entered.set()
                try:
                    self.wfile.write(b"x" * (8 * 1024 * 1024))
                finally:
                    finished.set()

        with tempfile.TemporaryDirectory() as temporary:
            server = WORKSPACE.WorkspaceServer(Path(temporary), 0)
            server.RequestHandlerClass = Handler
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            # Constrain the receive window before connecting: Windows may otherwise
            # buffer the entire payload even with a small server send buffer.
            client = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            client.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 4096)
            client.settimeout(2)
            client.connect(server.server_address)
            try:
                self.assertTrue(entered.wait(2))
                self.assertFalse(finished.wait(.3))
                server.shutdown()
                with mock.patch.object(type(next(iter(server._connections))), "shutdown", return_value=None):
                    closer = threading.Thread(target=server.server_close, daemon=True)
                    closer.start()
                    closer.join(2)
                self.assertFalse(closer.is_alive())
                self.assertTrue(finished.is_set())
            finally:
                client.close()
                server.shutdown()
                server.server_close()
                serving.join(2)

    def test_idle_connection_survives_multiple_io_poll_intervals(self):
        entered = threading.Event()
        finished = threading.Event()
        received = []

        class Handler(BaseHTTPRequestHandler):
            def handle(self):
                entered.set()
                received.append(self.rfile.readline())
                self.wfile.write(b"accepted")
                finished.set()

        with tempfile.TemporaryDirectory() as temporary:
            server = WORKSPACE.WorkspaceServer(Path(temporary), 0)
            server.RequestHandlerClass = Handler
            serving = threading.Thread(target=server.serve_forever)
            serving.start()
            client = socket.create_connection(server.server_address, timeout=2)
            try:
                self.assertTrue(entered.wait(2))
                self.assertFalse(finished.wait(.7))
                client.sendall(b"delayed request\n")
                self.assertEqual(client.recv(8), b"accepted")
                self.assertTrue(finished.wait(2))
                self.assertEqual(received, [b"delayed request\n"])
            finally:
                client.close()
                server.shutdown()
                server.server_close()
                serving.join(2)

    def test_disconnect_is_quiet_but_unexpected_worker_error_is_reported(self):
        for error in (BrokenPipeError("disconnected"), RuntimeError("synthetic defect")):
            entered = threading.Event()

            class Handler(BaseHTTPRequestHandler):
                def handle(self):
                    entered.set()
                    raise error

            with self.subTest(error=type(error).__name__), tempfile.TemporaryDirectory() as temporary:
                server = WORKSPACE.WorkspaceServer(Path(temporary), 0)
                server.RequestHandlerClass = Handler
                serving = threading.Thread(target=server.serve_forever)
                output = io.StringIO()
                with redirect_stderr(output):
                    serving.start()
                    client = socket.create_connection(server.server_address, timeout=2)
                    try:
                        self.assertTrue(entered.wait(2))
                    finally:
                        server.shutdown()
                        server.server_close()
                        client.close()
                        serving.join(2)
                if isinstance(error, ConnectionError):
                    self.assertEqual(output.getvalue(), "")
                else:
                    self.assertIn("RuntimeError: synthetic defect", output.getvalue())


class LauncherShutdownTests(unittest.TestCase):
    def test_signals_with_keepalive_partial_body_and_disconnected_clients(self):
        import http.client
        import json
        import os
        import signal
        import subprocess
        import sys
        from tests.support.workspace_case import ROOT

        signals = [signal.SIGINT, signal.SIGTERM] if os.name != "nt" else [signal.CTRL_BREAK_EVENT]
        for stop_signal in signals:
            for attempt in range(3):
                with self.subTest(signal=stop_signal, attempt=attempt), tempfile.TemporaryDirectory() as temporary:
                    process = subprocess.Popen(
                        [sys.executable, str(ROOT / "companion/scripts/job-apply-workspace.py"),
                         "--root", str(Path(temporary) / "store"), "--port", "0", "--no-open", "--json"],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
                    )
                    clients = []
                    connection = None
                    try:
                        details = json.loads(process.stdout.readline())
                        address = ("127.0.0.1", details["port"])
                        host = f"127.0.0.1:{details['port']}"
                        connection = http.client.HTTPConnection(*address, timeout=3)
                        connection.request("GET", "/")
                        response = connection.getresponse()
                        self.assertEqual(response.status, 200)
                        response.read()  # Leave HTTP/1.1 keepalive open.
                        for request in (
                            b"GET / HTTP/1.1\r\nHost: ",
                            (f"POST /api/profile HTTP/1.1\r\nHost: {host}\r\n"
                             f"Origin: http://{host}\r\nAuthorization: Bearer {details['url'].split('#token=')[1]}\r\n"
                             "Content-Type: application/json\r\nContent-Length: 100\r\n\r\n{").encode(),
                            f"GET / HTTP/1.1\r\nHost: {host}\r\n\r\n".encode(),
                        ):
                            client = socket.create_connection(address, timeout=3)
                            clients.append(client)
                            client.sendall(request)
                        clients[-1].close()  # Abandon the response before shutdown.
                        process.send_signal(stop_signal)
                        _, errors = process.communicate(timeout=5)
                        self.assertEqual(process.returncode, 0, errors)
                        self.assertNotIn("Fatal Python error", errors)
                        self.assertNotIn("Traceback", errors)
                    finally:
                        for client in clients:
                            client.close()
                        if connection:
                            connection.close()
                        if process.poll() is None:
                            process.kill()
                        process.communicate(timeout=5)
