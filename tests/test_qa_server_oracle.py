import http.client
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from urllib.parse import urlsplit

from qa.compiler import compile_capture


ROOT = Path(__file__).resolve().parents[1]
PRIVATE_CAPTURE = ROOT / "qa" / "testdata" / "private-capture"
RENDERER = ROOT / "qa" / "renderer"


def valid_fixture():
    capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
    receipt = json.loads((PRIVATE_CAPTURE / "capture-receipt.json").read_text())
    return compile_capture(capture, receipt, "renderer-oracle-v1")


class RunningServer:
    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.fixture_path = Path(self.directory.name) / "fixture.json"
        self.fixture_path.write_text(json.dumps(valid_fixture()))
        self.process = subprocess.Popen(
            [
                "python3",
                "-m",
                "qa.server",
                "--fixture",
                str(self.fixture_path),
                "--port",
                "0",
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        line = self.process.stdout.readline()
        if not line:
            stderr = self.process.stderr.read()
            self.process.wait(timeout=5)
            raise AssertionError(f"server did not start: {stderr}")
        self.startup = json.loads(line)
        self.port = self.startup["port"]
        return self

    def __exit__(self, *_):
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)
        self.process.stdout.close()
        self.process.stderr.close()
        self.directory.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = None if payload is None else json.dumps(payload).encode()
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        raw = response.read()
        result = (
            json.loads(raw.decode())
            if raw
            and response.getheader("Content-Type", "").startswith("application/json")
            else raw
        )
        headers_result = dict(response.getheaders())
        connection.close()
        return response.status, headers_result, result


class ServerOracleTests(unittest.TestCase):
    def test_startup_fixture_and_state_are_local_and_value_free(self):
        with RunningServer() as server:
            parsed = urlsplit(server.startup["url"])
            self.assertEqual(parsed.hostname, "127.0.0.1")
            self.assertEqual(parsed.port, server.port)
            self.assertEqual(server.startup["fixtureId"], "renderer-oracle-v1")
            self.assertNotIn(str(server.fixture_path), json.dumps(server.startup))

            status, headers, fixture = server.request("GET", "/__qa/fixture")
            self.assertEqual(status, 200)
            self.assertEqual(fixture, valid_fixture())
            self.assertEqual(headers["Cache-Control"], "no-store")

            status, headers, state = server.request("GET", "/__qa/state")
            self.assertEqual(status, 200)
            self.assertEqual(state, {"events": [], "finalActionActivations": 0})
            self.assertEqual(headers["Cache-Control"], "no-store")

    def test_closed_semantic_events_accept_only_coherent_fixture_ids(self):
        with RunningServer() as server:
            valid = [
                {
                    "type": "filled",
                    "controlId": "contact.first_name",
                    "stepId": "step-1",
                },
                {
                    "type": "uploaded",
                    "controlId": "resume.file",
                    "stepId": "step-2",
                },
                {
                    "type": "validation",
                    "controlId": "contact.email",
                    "stepId": "step-1",
                },
                {"type": "advanced", "controlId": "", "stepId": "step-1"},
                {"type": "reviewed", "controlId": "", "stepId": "review"},
            ]
            for event in valid:
                status, _, _ = server.request("POST", "/__qa/event", event)
                self.assertEqual(status, 204, event)
            self.assertEqual(server.request("GET", "/__qa/state")[2]["events"], valid)

    def test_invalid_event_requests_do_not_mutate_state(self):
        invalid = [
            {"type": "filled", "controlId": "contact.first_name", "stepId": "step-1", "value": "SECRET"},
            {"type": "unknown", "controlId": "contact.first_name", "stepId": "step-1"},
            {"type": 1, "controlId": "contact.first_name", "stepId": "step-1"},
            {"type": "filled", "controlId": 1, "stepId": "step-1"},
            {"type": "filled", "controlId": "missing", "stepId": "step-1"},
            {"type": "filled", "controlId": "contact.first_name", "stepId": "missing"},
            {"type": "filled", "controlId": "resume.file", "stepId": "step-2"},
            {"type": "uploaded", "controlId": "contact.first_name", "stepId": "step-1"},
            {"type": "validation", "controlId": "resume.file", "stepId": "step-1"},
            {"type": "advanced", "controlId": "", "stepId": "review"},
            {"type": "reviewed", "controlId": "", "stepId": "step-1"},
            [],
        ]
        with RunningServer() as server:
            baseline = server.request("GET", "/__qa/state")[2]
            for payload in invalid:
                with self.subTest(payload=payload):
                    status, _, body = server.request("POST", "/__qa/event", payload)
                    self.assertEqual(status, 400)
                    self.assertNotIn("SECRET", json.dumps(body))
                    self.assertEqual(server.request("GET", "/__qa/state")[2], baseline)

    def test_malformed_chunked_and_oversized_bodies_fail_closed(self):
        with RunningServer() as server:
            cases = [
                (
                    b"not-json",
                    {"Content-Type": "application/json", "Content-Length": "8"},
                ),
                (
                    b"null",
                    {"Content-Type": "application/json", "Content-Length": "4"},
                ),
                (
                    b"{}",
                    {
                        "Content-Type": "application/json",
                        "Transfer-Encoding": "chunked",
                    },
                ),
                (
                    b"{}",
                    {
                        "Content-Type": "application/json",
                        "Content-Length": "invalid",
                    },
                ),
                (
                    b"x",
                    {
                        "Content-Type": "application/json",
                        "Content-Length": str(65537),
                    },
                ),
            ]
            baseline = server.request("GET", "/__qa/state")[2]
            for body, headers in cases:
                connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
                connection.putrequest("POST", "/__qa/event")
                for name, value in headers.items():
                    connection.putheader(name, value)
                connection.endheaders(body)
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 400)
                connection.close()
                self.assertEqual(server.request("GET", "/__qa/state")[2], baseline)

    def test_final_action_is_a_nonredirecting_counted_tripwire(self):
        with RunningServer() as server:
            for expected_count in (1, 2):
                status, headers, body = server.request(
                    "POST", "/__qa/final-action", {"stepId": "review"}
                )
                self.assertEqual(status, 409)
                self.assertNotIn("Location", headers)
                self.assertEqual(body, {"error": "final action blocked by QA tripwire"})
                state = server.request("GET", "/__qa/state")[2]
                self.assertEqual(state["finalActionActivations"], expected_count)
                self.assertEqual(
                    state["events"][-1],
                    {"type": "final-action", "stepId": "review"},
                )

            baseline = server.request("GET", "/__qa/state")[2]
            for payload in (
                {},
                {"stepId": "step-1"},
                {"stepId": "review", "extra": True},
            ):
                status, _, _ = server.request("POST", "/__qa/final-action", payload)
                self.assertEqual(status, 400)
                self.assertEqual(server.request("GET", "/__qa/state")[2], baseline)

    def test_static_routes_are_fixed_secure_and_never_cached(self):
        with RunningServer() as server:
            for path, content_type in (
                ("/", "text/html"),
                ("/app.js", "text/javascript"),
                ("/styles.css", "text/css"),
            ):
                status, headers, body = server.request("GET", path)
                self.assertEqual(status, 200)
                self.assertTrue(headers["Content-Type"].startswith(content_type))
                self.assertEqual(headers["Cache-Control"], "no-store")
                self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
                self.assertEqual(headers["X-Frame-Options"], "DENY")
                self.assertIn("default-src 'self'", headers["Content-Security-Policy"])
                self.assertTrue(body)

            for method, path in (
                ("GET", "/missing"),
                ("GET", "/../contracts.py"),
                ("GET", "/%2e%2e/contracts.py"),
                ("POST", "/app.js"),
                ("PUT", "/__qa/event"),
            ):
                status, headers, _ = server.request(method, path)
                self.assertIn(status, (404, 405))
                self.assertEqual(headers["Cache-Control"], "no-store")

    def test_renderer_is_local_generic_and_has_no_inline_source_script(self):
        index = (RENDERER / "index.html").read_text()
        assets = (
            index
            + (RENDERER / "app.js").read_text()
            + (RENDERER / "styles.css").read_text()
        )
        lowered = assets.lower()
        self.assertNotIn("http://", lowered)
        self.assertNotIn("https://", lowered)
        self.assertNotIn("linkedin", lowered)
        self.assertNotIn("employer", lowered)
        self.assertNotIn("<script>", lowered)
        self.assertIn('<script src="/app.js"', index)


if __name__ == "__main__":
    unittest.main()
