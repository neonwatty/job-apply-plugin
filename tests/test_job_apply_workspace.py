import http.client
import importlib.util
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


WORKSPACE = load_module("job_apply_workspace_test", ROOT / "scripts" / "job-apply-workspace.py")


class WorkspaceServerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store_root = Path(self.temporary.name) / "store"
        self.server = WORKSPACE.WorkspaceServer(self.store_root, 0, token="test-workspace-token")
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temporary.cleanup()

    def request(self, method, path, payload=None, *, token=True, origin=True, host=None, content_type="application/json", raw=None):
        connection = http.client.HTTPConnection(WORKSPACE.LOOPBACK, self.server.server_port, timeout=3)
        headers = {"Host": host or self.server.expected_host}
        if token:
            headers["Authorization"] = f"Bearer {self.server.token}"
        if origin:
            headers["Origin"] = self.server.origin
        body = raw
        if payload is not None:
            body = json.dumps(payload).encode()
        if body is not None:
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(body))
        connection.request(method, path, body=body, headers=headers)
        response = connection.getresponse()
        data = response.read()
        connection.close()
        try:
            decoded = json.loads(data)
        except (json.JSONDecodeError, UnicodeDecodeError):
            decoded = data
        return response.status, response.getheaders(), decoded

    def create_job(self, url="https://example.com/jobs/one", **fields):
        status, _headers, result = self.request("POST", "/api/jobs", {"job": {"url": url, **fields}})
        self.assertEqual(status, 200, result)
        return result

    def test_binds_exact_ipv4_loopback_and_serves_allowlisted_assets(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        status, headers, body = self.request("GET", "/", token=False, origin=False)
        self.assertEqual(status, 200)
        self.assertIn(b"Jobs Workspace", body)
        header_map = dict(headers)
        self.assertIn("default-src 'self'", header_map["Content-Security-Policy"])
        self.assertEqual(header_map["Cache-Control"], "no-store")
        for path in ("/../scripts/job-apply-store.py", "/%2e%2e/scripts/job-apply-store.py", "/api/files", "/api/command"):
            status, _headers, _body = self.request("GET", path, token=path.startswith("/api/"), origin=False)
            self.assertEqual(status, 404, path)

    def test_all_apis_require_token_and_mutations_require_exact_origin(self):
        status, _headers, body = self.request("GET", "/api/state", token=False, origin=False)
        self.assertEqual((status, body["error"]["code"]), (401, "token_rejected"))
        status, _headers, body = self.request("POST", "/api/jobs", {"job": {"url": "https://example.com/no-origin"}}, origin=False)
        self.assertEqual((status, body["error"]["code"]), (403, "origin_rejected"))
        status, _headers, body = self.request("POST", "/api/jobs", {"job": {"url": "https://example.com/bad-origin"}}, origin=False)
        self.assertEqual(status, 403)
        self.assertEqual(self.server.store.list_jobs(), [])

    def test_rejects_host_options_content_type_malformed_and_oversized_requests(self):
        status, _headers, body = self.request("GET", "/", token=False, origin=False, host=f"localhost:{self.server.server_port}")
        self.assertEqual((status, body["error"]["code"]), (403, "host_rejected"))
        status, _headers, _body = self.request("OPTIONS", "/api/jobs", token=False, origin=False)
        self.assertEqual(status, 405)
        status, _headers, _body = self.request("POST", "/api/jobs", raw=b"{}", content_type="text/plain")
        self.assertEqual(status, 415)
        status, _headers, _body = self.request("POST", "/api/jobs", raw=b"{")
        self.assertEqual(status, 400)
        oversized = b"x" * (WORKSPACE.MAX_BODY_BYTES + 1)
        status, _headers, _body = self.request("POST", "/api/jobs", raw=oversized)
        self.assertEqual(status, 413)
        self.assertEqual(self.server.store.list_jobs(), [])

    def test_pre_body_rejections_close_connection_without_reparsing_bytes(self):
        host = self.server.expected_host
        probes = (
            (
                b"POST /api/jobs HTTP/1.1\r\n"
                + f"Host: {host}\r\n".encode()
                + b"Origin: http://attacker.invalid\r\nContent-Type: application/json\r\n"
                + b"Content-Length: 2\r\n\r\n{}"
                + f"GET /api/state HTTP/1.1\r\nHost: {host}\r\n\r\n".encode(),
                b"HTTP/1.1 401 ",
            ),
            (
                b"POST /api/jobs HTTP/1.1\r\n"
                + f"Host: {host}\r\nAuthorization: Bearer {self.server.token}\r\n".encode()
                + f"Origin: {self.server.origin}\r\nContent-Type: application/json\r\n".encode()
                + f"Content-Length: {WORKSPACE.MAX_BODY_BYTES + 1}\r\n\r\n".encode()
                + b"GET /api/state HTTP/1.1\r\n\r\n",
                b"HTTP/1.1 413 ",
            ),
        )
        for request, expected_status in probes:
            with self.subTest(status=expected_status):
                with socket.create_connection((WORKSPACE.LOOPBACK, self.server.server_port), timeout=3) as connection:
                    connection.sendall(request)
                    response = bytearray()
                    while True:
                        chunk = connection.recv(8192)
                        if not chunk:
                            break
                        response.extend(chunk)
                self.assertIn(expected_status, response)
                self.assertIn(b"Connection: close", response)
                self.assertEqual(response.count(b"HTTP/1.1 "), 1)

    def test_ui_and_store_share_bidirectional_crud(self):
        cli_job = self.server.store.create_job({"url": "https://example.com/cli", "role": "CLI role"})
        status, _headers, state = self.request("GET", "/api/state", origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(state["jobs"][0]["id"], cli_job["id"])
        ui_job = self.create_job("HTTPS://Example.com:443/ui#apply", role="UI role", company="Acme", priority=4)
        canonical = self.server.store.get_job(ui_job["id"])
        self.assertEqual(canonical["normalizedUrl"], "https://example.com/ui")
        self.assertEqual((canonical["role"], canonical["company"], canonical["priority"]), ("UI role", "Acme", 4))
        status, _headers, updated = self.request("PATCH", f"/api/jobs/{ui_job['id']}", {"patch": {"notes": "human note"}, "expectedRevision": ui_job["revision"]})
        self.assertEqual(status, 200)
        self.assertEqual(self.server.store.get_job(ui_job["id"])["notes"], "human note")
        self.assertEqual(updated["revision"], 2)

    def test_revision_conflict_is_409_and_never_overwrites_canonical_data(self):
        job = self.create_job(role="Original")
        cli = self.server.store.update_job(job["id"], {"role": "CLI edit"}, job["revision"])
        status, _headers, body = self.request("PATCH", f"/api/jobs/{job['id']}", {"patch": {"role": "stale UI edit"}, "expectedRevision": job["revision"]})
        self.assertEqual((status, body["error"]["code"]), (409, "revision_conflict"))
        self.assertEqual(self.server.store.get_job(job["id"])["role"], "CLI edit")
        self.assertEqual(self.server.store.get_job(job["id"])["revision"], cli["revision"])

    def test_bulk_capture_keeps_valid_items_and_reports_each_failure(self):
        urls = ["https://example.com/good", "not a url", "https://example.com/good"]
        status, _headers, body = self.request("POST", "/api/jobs/bulk", {"urls": urls})
        self.assertEqual(status, 200)
        self.assertEqual([item["ok"] for item in body["results"]], [True, False, False])
        self.assertEqual(len(self.server.store.list_jobs()), 1)

    def test_preflight_resume_assignment_ready_handoff_and_guarded_applied(self):
        self.server.store.replace_profile({"firstName": "Ada"})
        resume_path = Path(self.temporary.name) / "resume.pdf"
        resume_path.write_bytes(b"resume")
        resume = self.server.store.create_resume({"id": "main", "label": "Main", "path": str(resume_path)})
        job = self.create_job(resumeId=resume["id"], role="Engineer", company="Acme")
        status, _headers, preflight = self.request("GET", f"/api/jobs/{job['id']}/preflight", origin=False)
        self.assertEqual(status, 200)
        self.assertTrue(preflight["ready"])
        status, _headers, ready = self.request("POST", f"/api/jobs/{job['id']}/transition", {"status": "ready", "expectedRevision": job["revision"]})
        self.assertEqual((status, ready["status"]), (200, "ready"))
        self.assertEqual(self.server.store.list_jobs("ready")[0]["id"], job["id"])
        # Applied is never reachable from ready and never accepted without explicit confirmation.
        status, _headers, body = self.request("POST", f"/api/jobs/{job['id']}/transition", {"status": "applied", "expectedRevision": ready["revision"]})
        self.assertEqual(status, 400)
        self.assertIn("unsupported", body["error"]["message"])

    def test_trash_is_guarded_and_no_restore_or_delete_routes_exist(self):
        job = self.create_job()
        status, _headers, trashed = self.request("POST", f"/api/jobs/{job['id']}/trash", {"expectedRevision": job["revision"]})
        self.assertEqual(status, 200)
        self.assertIsNotNone(trashed["deletedAt"])
        self.assertIsNone(self.server.store.get_job(job["id"]))
        for action in ("restore", "delete"):
            status, _headers, _body = self.request("POST", f"/api/jobs/{job['id']}/{action}", {"expectedRevision": trashed["revision"]})
            self.assertEqual(status, 404)


class WorkspaceProcessTests(unittest.TestCase):
    def test_launcher_reports_fragment_token_and_stops_cleanly(self):
        with tempfile.TemporaryDirectory() as temporary:
            process = subprocess.Popen(
                [sys.executable, str(ROOT / "scripts" / "job-apply-workspace.py"), "--root", str(Path(temporary) / "store"), "--port", "0", "--no-open", "--json"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
            )
            try:
                line = process.stdout.readline()
                details = json.loads(line)
                self.assertEqual(details["host"], "127.0.0.1")
                self.assertIn("/#token=", details["url"])
                connection = http.client.HTTPConnection("127.0.0.1", details["port"], timeout=3)
                connection.request("GET", "/", headers={"Host": f"127.0.0.1:{details['port']}"})
                self.assertEqual(connection.getresponse().status, 200)
                connection.close()
                if os.name == "nt":
                    process.send_signal(signal.CTRL_BREAK_EVENT)
                else:
                    process.send_signal(signal.SIGINT)
                self.assertEqual(process.wait(timeout=5), 0)
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
