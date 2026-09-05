from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
    def test_binds_exact_ipv4_loopback_and_serves_allowlisted_assets(self):
        self.assertEqual(self.server.server_address[0], "127.0.0.1")
        self.assertEqual(WORKSPACE.loopback_authority(80), ("http://127.0.0.1", "127.0.0.1"))
        self.assertEqual(WORKSPACE.loopback_authority(8080), ("http://127.0.0.1:8080", "127.0.0.1:8080"))
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
