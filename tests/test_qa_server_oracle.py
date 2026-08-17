import http.client
import hashlib
import json
import os
from pathlib import Path
import queue
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import urlsplit

from qa.compiler import compile_capture
from qa.contracts import LEVER_CONTROL_PROFILE, generic_control
from qa.oracle import OracleError, evaluate_run
from qa.server import ReplayHTTPServer
from scripts.job_apply_policy import PolicyStore, confirmation_authority_revision


ROOT = Path(__file__).resolve().parents[1]
PRIVATE_CAPTURE = ROOT / "qa" / "testdata" / "private-capture"
RENDERER = ROOT / "qa" / "renderer"


def valid_fixture():
    capture = json.loads((PRIVATE_CAPTURE / "semantic.json").read_text())
    receipt = json.loads((PRIVATE_CAPTURE / "capture-receipt.json").read_text())
    return compile_capture(capture, receipt, "renderer-oracle-v1")


def complete_events(fixture=None):
    fixture = fixture or valid_fixture()
    events = []
    for step in fixture["steps"]:
        for control in step["controls"]:
            if not control["required"]:
                continue
            events.append(
                {
                    "type": "uploaded" if control["role"] == "file" else "filled",
                    "controlId": control["id"],
                    "stepId": step["id"],
                    **(
                        {"expectedFilenameMatched": True}
                        if control["role"] == "file"
                        else {}
                    ),
                }
            )
        if step["kind"] == "form":
            events.append(
                {"type": "advanced", "controlId": "", "stepId": step["id"]}
            )
        else:
            events.append(
                {"type": "reviewed", "controlId": "", "stepId": step["id"]}
            )
    return events


def history_event(event, application_id="application-1", **extra):
    return {
        "schemaVersion": 1,
        "eventId": f"event-{event}",
        "applicationId": application_id,
        "event": event,
        "answerKeys": ["question.stable"],
        "at": "2026-08-11T12:00:00Z",
        **extra,
    }


def valid_session(application_id="application-1"):
    return {
        "schemaVersion": 1,
        "applicationId": application_id,
        "status": "review",
        "ats": "synthetic-ats",
        "company": "Synthetic Company Secret",
        "role": "Synthetic Role Secret",
        "url": "https://example.com/private-application",
        "step": "review",
        "answerKeys": ["question.stable"],
        "pendingFields": [
            {
                "question": "Synthetic pending description secret",
                "state": "missing",
                "answerKey": "question.pending",
                "sensitive": False,
            }
        ],
        "createdAt": "2026-08-11T12:00:00Z",
        "updatedAt": "2026-08-11T12:01:00Z",
    }


class OracleStore:
    def __init__(self, root):
        self.root = Path(root)
        self.sessions = self.root / "sessions"
        self.sessions.mkdir(parents=True)

    def write_history(self, events):
        (self.root / "applications.jsonl").write_text(
            "".join(json.dumps(event) + "\n" for event in events),
            encoding="utf-8",
        )

    def write_session(self, session=None, name="application-1.json"):
        (self.sessions / name).write_text(
            json.dumps(session or valid_session()), encoding="utf-8"
        )

    def make_valid(self):
        self.write_history(
            [
                history_event(
                    "started",
                    company="Synthetic Company Secret",
                    role="Synthetic Role Secret",
                ),
                history_event("reviewed"),
            ]
        )
        self.write_session()
        return self


class RunningServer:
    shutdown_token = "a" * 64

    def __init__(self, auto_submit=False):
        self.auto_submit = auto_submit

    def __enter__(self):
        self.directory = tempfile.TemporaryDirectory()
        self.fixture_path = Path(self.directory.name) / "fixture.json"
        self.fixture_path.write_text(json.dumps(valid_fixture()))
        self.process = None
        try:
            self.process = subprocess.Popen(
                [
                    "python3",
                    "-m",
                    "qa.server",
                    "--fixture",
                    str(self.fixture_path),
                    "--port",
                    "0",
                    "--expected-resume-filename",
                    "synthetic-resume.pdf",
                    "--shutdown-token",
                    self.shutdown_token,
                    *(
                        ["--auto-submit-policy-root", str(Path(self.directory.name) / "policy")]
                        if self.auto_submit
                        else []
                    ),
                ],
                cwd=ROOT,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
            )
            startup_lines = queue.Queue()
            reader = threading.Thread(
                target=lambda: startup_lines.put(self.process.stdout.readline()),
                daemon=True,
            )
            reader.start()
            try:
                line = startup_lines.get(timeout=5)
            except queue.Empty:
                raise AssertionError("server startup timed out") from None
            if not line:
                raise AssertionError("server exited before startup")
            self.startup = json.loads(line)
            self.port = self.startup["port"]
            if self.auto_submit:
                self.policy_store = PolicyStore(Path(self.directory.name) / "policy")
                self.application_ref = "application:" + "1" * 64
                base_url = f"http://127.0.0.1:{self.port}"
                revision = lambda label: "sha256:" + hashlib.sha256(label.encode()).hexdigest()
                self.authorization = {
                    "applicationRef": self.application_ref,
                    "origin": base_url,
                    "urlFingerprint": revision("synthetic-url"),
                    "ats": "linkedin",
                    "jobFingerprint": revision("synthetic-job"),
                    "formRevision": revision("synthetic-form"),
                    "finalControlRevision": revision("synthetic-control"),
                    "resumeRevision": revision("synthetic-resume"),
                    "answerRevisions": [],
                }
                rule = {key: self.authorization[key] for key in {
                    "applicationRef", "origin", "urlFingerprint", "ats",
                    "jobFingerprint", "formRevision", "finalControlRevision",
                }}
                self.policy_store.activate({
                    "riskAcknowledged": True,
                    "applicationRules": [rule],
                    "resumeRevision": self.authorization["resumeRevision"],
                    "sensitiveAllowlist": [],
                    "confirmationAuthorityRevision": confirmation_authority_revision(
                        self.shutdown_token
                    ),
                    "maxApplications": 1,
                    "durationSeconds": 300,
                })
                self.lease = self.policy_store.authorize(self.authorization)
            return self
        except BaseException:
            self._cleanup()
            raise

    def __exit__(self, *_):
        self._cleanup()

    def _cleanup(self):
        try:
            if self.process is not None and self.process.poll() is None:
                self.process.terminate()
                try:
                    self.process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.process.kill()
                    self.process.wait(timeout=5)
        finally:
            if self.process is not None:
                if self.process.stdout is not None:
                    self.process.stdout.close()
                if self.process.stderr is not None:
                    self.process.stderr.close()
            self.directory.cleanup()

    def request(self, method, path, payload=None, headers=None):
        body = None if payload is None else json.dumps(payload).encode()
        request_headers = dict(headers or {})
        if payload is not None:
            request_headers.setdefault("Content-Type", "application/json")
        if method == "POST":
            request_headers.setdefault(
                "Origin", f"http://127.0.0.1:{self.port}"
            )
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

    def raw_request(self, method, path, body=b"", headers=None, skip_host=False):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        connection.putrequest(method, path, skip_host=skip_host)
        for name, value in (headers or {}).items():
            connection.putheader(name, value)
        connection.endheaders(body)
        response = connection.getresponse()
        raw = response.read()
        connection.close()
        return response.status, raw


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
                    "expectedFilenameMatched": True,
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
            {"type": "uploaded", "controlId": "resume.file", "stepId": "step-2"},
            {"type": "uploaded", "controlId": "resume.file", "stepId": "step-2", "expectedFilenameMatched": "yes"},
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

    def test_local_api_rejects_spoofed_or_simple_post_headers(self):
        event = json.dumps(
            {
                "type": "filled",
                "controlId": "contact.first_name",
                "stepId": "step-1",
            }
        ).encode()
        with RunningServer() as server:
            baseline = server.request("GET", "/__qa/state")[2]
            valid_host = f"127.0.0.1:{server.port}"
            valid_origin = f"http://127.0.0.1:{server.port}"
            cases = (
                {
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/json",
                    "Origin": valid_origin,
                },
                {
                    "Host": "attacker.invalid",
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/json",
                    "Origin": valid_origin,
                },
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/json",
                },
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/json",
                    "Origin": "http://attacker.invalid",
                },
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Origin": valid_origin,
                },
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Content-Type": "text/plain",
                    "Origin": valid_origin,
                },
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/x-www-form-urlencoded",
                    "Origin": valid_origin,
                },
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/json; charset=iso-8859-1",
                    "Origin": valid_origin,
                },
            )
            for headers in cases:
                with self.subTest(headers=headers):
                    status, body = server.raw_request(
                        "POST",
                        "/__qa/event",
                        event,
                        headers,
                        skip_host=True,
                    )
                    self.assertIn(status, (400, 403, 415))
                    self.assertNotIn(b"attacker.invalid", body)
                    self.assertEqual(server.request("GET", "/__qa/state")[2], baseline)

            status, _ = server.raw_request(
                "POST",
                "/__qa/event",
                event,
                {
                    "Host": valid_host,
                    "Content-Length": str(len(event)),
                    "Content-Type": "application/json; charset=utf-8",
                    "Origin": valid_origin,
                },
                skip_host=True,
            )
            self.assertEqual(status, 204)

    def test_get_requires_the_exact_local_host_without_origin(self):
        with RunningServer() as server:
            status, _ = server.raw_request(
                "GET", "/__qa/state", headers={}, skip_host=True
            )
            self.assertEqual(status, 400)
            status, _ = server.raw_request(
                "GET",
                "/__qa/state",
                headers={"Host": "attacker.invalid"},
                skip_host=True,
            )
            self.assertEqual(status, 400)
            self.assertEqual(server.request("GET", "/__qa/state")[0], 200)

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
                headers["Origin"] = f"http://127.0.0.1:{server.port}"
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

    def test_auto_submit_endpoint_requires_private_capability_and_consumes_claim_once(self):
        with RunningServer(auto_submit=True) as server:
            payload = {
                "stepId": "review",
                "applicationRef": server.application_ref,
                "leaseId": server.lease["leaseId"],
                "attempt": server.lease["attempt"],
                "authorization": server.authorization,
                "safetyChecks": {
                "loginRequired": False,
                "captchaPresent": False,
                "mfaRequired": False,
                "accountCreationRequired": False,
                "controlAccessible": True,
                "redirected": False,
                },
            }
            baseline = server.request("GET", "/__qa/state")[2]
            for headers in ({}, {"X-QA-Run-Token": "b" * 64}):
                status, _, body = server.request(
                    "POST", "/__qa/auto-submit/final-action", payload, headers=headers
                )
                self.assertEqual((status, body), (404, {"error": "not found"}))
                self.assertEqual(server.request("GET", "/__qa/state")[2], baseline)

            headers = {"X-QA-Run-Token": server.shutdown_token}
            for boundary in (
                "loginRequired",
                "captchaPresent",
                "mfaRequired",
                "accountCreationRequired",
                "redirected",
                "controlAccessible",
            ):
                unsafe = json.loads(json.dumps(payload))
                unsafe["safetyChecks"][boundary] = boundary != "controlAccessible"
                status, _, _ = server.request(
                    "POST", "/__qa/auto-submit/final-action", unsafe, headers=headers
                )
                self.assertEqual(status, 409)
                self.assertEqual(
                    server.request("GET", "/__qa/state")[2]["finalActionActivations"], 0
                )
            status, _, confirmation = server.request(
                "POST", "/__qa/auto-submit/final-action", payload, headers=headers
            )
            self.assertEqual(status, 200)
            self.assertRegex(confirmation["claimId"], r"^claim:[a-f0-9]{64}$")
            self.assertEqual(confirmation["source"], "isolated_loopback")
            self.assertIs(confirmation["activationObserved"], True)
            self.assertEqual(
                server.request("GET", "/__qa/state")[2]["finalActionActivations"], 1
            )
            status, _, _ = server.request(
                "POST", "/__qa/auto-submit/final-action", payload, headers=headers
            )
            self.assertEqual(status, 409)
            self.assertEqual(
                server.request("GET", "/__qa/state")[2]["finalActionActivations"], 1
            )

    def test_auto_submit_rechecks_kill_and_rejects_unknown_authority_fields(self):
        with RunningServer(auto_submit=True) as server:
            payload = {
                "stepId": "review",
                "applicationRef": server.application_ref,
                "leaseId": server.lease["leaseId"],
                "attempt": server.lease["attempt"],
                "authorization": server.authorization,
                "safetyChecks": {
                    "loginRequired": False,
                    "captchaPresent": False,
                    "mfaRequired": False,
                    "accountCreationRequired": False,
                    "controlAccessible": True,
                    "redirected": False,
                },
            }
            headers = {"X-QA-Run-Token": server.shutdown_token}
            injected = json.loads(json.dumps(payload))
            injected["authorization"]["ignorePolicy"] = True
            self.assertEqual(
                server.request("POST", "/__qa/auto-submit/final-action", injected, headers=headers)[0],
                409,
            )
            server.policy_store.kill()
            self.assertEqual(
                server.request("POST", "/__qa/auto-submit/final-action", payload, headers=headers)[0],
                409,
            )
            self.assertEqual(server.request("GET", "/__qa/state")[2]["finalActionActivations"], 0)

    def test_hidden_identity_and_shutdown_require_exact_token(self):
        with RunningServer() as server:
            for path in ("/__qa/identity", "/__qa/shutdown"):
                method = "GET" if path.endswith("identity") else "POST"
                status, _, body = server.request(method, path)
                self.assertEqual(status, 404)
                self.assertEqual(body, {"error": "not found"})

                status, _, body = server.request(
                    method,
                    path,
                    headers={"X-QA-Run-Token": "b" * 64},
                )
                self.assertEqual(status, 404)
                self.assertEqual(body, {"error": "not found"})

            status, _, identity = server.request(
                "GET",
                "/__qa/identity",
                headers={"X-QA-Run-Token": server.shutdown_token},
            )
            self.assertEqual(
                (status, identity),
                (200, {"fixtureId": "renderer-oracle-v1"}),
            )

            status, _, body = server.request(
                "POST",
                "/__qa/shutdown",
                headers={"X-QA-Run-Token": server.shutdown_token},
            )
            self.assertEqual((status, body), (204, b""))
            server.process.wait(timeout=5)

    def test_final_action_evicts_events_and_always_activates_at_capacity(self):
        with mock.patch("qa.server.MAX_EVENTS", 2):
            replay_server = ReplayHTTPServer(valid_fixture(), 0)
            thread = threading.Thread(target=replay_server.serve_forever)
            thread.start()
            client = object.__new__(RunningServer)
            client.port = replay_server.server_address[1]
            try:
                for control_id in ("contact.first_name", "contact.last_name"):
                    status, _, _ = client.request(
                        "POST",
                        "/__qa/event",
                        {
                            "type": "filled",
                            "controlId": control_id,
                            "stepId": "step-1",
                        },
                    )
                    self.assertEqual(status, 204)

                for expected_count in (1, 2, 3):
                    status, _, _ = client.request(
                        "POST", "/__qa/final-action", {"stepId": "review"}
                    )
                    self.assertEqual(status, 409)
                    state = client.request("GET", "/__qa/state")[2]
                    self.assertEqual(
                        state["finalActionActivations"], expected_count
                    )
                    self.assertLessEqual(len(state["events"]), 2)
                    self.assertEqual(
                        state["events"][-1],
                        {"type": "final-action", "stepId": "review"},
                    )
            finally:
                replay_server.shutdown()
                replay_server.server_close()
                thread.join(timeout=5)

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
        self.assertIn(
            "async function recordEvent(type, controlId, stepId)", assets
        )
        self.assertIn("function renderControl(control)", assets)


class SemanticOracleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.store = OracleStore(Path(self.temporary.name) / "store").make_valid()
        self.fixture = valid_fixture()
        self.scenario = {"id": "complete-profile"}
        self.events = complete_events(self.fixture)

    def tearDown(self):
        self.temporary.cleanup()

    def evaluate(self, **overrides):
        return evaluate_run(
            overrides.get("fixture", self.fixture),
            overrides.get("scenario", self.scenario),
            overrides.get("events", self.events),
            overrides.get("store_root", self.store.root),
        )

    def test_complete_profile_passes_with_only_redacted_report_fields(self):
        report = self.evaluate()
        self.assertEqual(
            set(report),
            {
                "fixtureId",
                "scenarioId",
                "status",
                "assertions",
                "missingControlIds",
                "failureCategories",
            },
        )
        self.assertEqual(report["fixtureId"], "renderer-oracle-v1")
        self.assertEqual(report["scenarioId"], "complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])
        serialized = json.dumps(report)
        for secret in (
            "Synthetic Company Secret",
            "Synthetic Role Secret",
            "Synthetic pending description secret",
            str(self.store.root),
            "question.stable",
            "example.com",
        ):
            self.assertNotIn(secret, serialized)

    def test_committed_linkedin_screening_fixture_passes_with_closed_identity(self):
        fixture = json.loads(
            (
                ROOT
                / "qa/fixtures/linkedin-easy-apply-screening-2026-08-v1/fixture.json"
            ).read_text()
        )
        events = complete_events(fixture)
        optional = next(
            control
            for step in fixture["steps"]
            for control in step["controls"]
            if control["id"] == "preference.top_choice"
        )
        events.insert(
            -1,
            {
                "type": "filled",
                "controlId": optional["id"],
                "stepId": "step-3",
            },
        )

        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "linkedin-screening"},
            events=events,
        )

        self.assertEqual(report["scenarioId"], "linkedin-screening")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])

    def test_committed_greenhouse_fixture_passes_with_closed_identity(self):
        fixture = json.loads((
            ROOT / "qa/fixtures/greenhouse-single-page-2026-08-v1/fixture.json"
        ).read_text())
        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "greenhouse-complete-profile"},
            events=complete_events(fixture),
        )
        self.assertEqual(report["scenarioId"], "greenhouse-complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])

    def test_ashby_complete_profile_scenario_passes_with_closed_identity(self):
        fixture = valid_fixture()
        fixture["id"] = "ashby-application-2026-08-v1"
        fixture["platformFamily"] = "ashby"
        fixture["steps"][0]["controls"] = [
            {
                "id": "contact.full_name",
                "kind": "contact.full_name",
                "role": "textbox",
                "label": "Full name",
                "required": True,
            },
            {
                "id": "contact.email",
                "kind": "contact.email",
                "role": "textbox",
                "label": "Email address",
                "required": True,
            },
            {
                "id": "resume.file",
                "kind": "resume.file",
                "role": "file",
                "label": "Resume",
                "required": True,
            },
        ]
        fixture["steps"] = [fixture["steps"][0], fixture["steps"][-1]]
        fixture["steps"][0]["next"] = "review"
        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "ashby-complete-profile"},
            events=complete_events(fixture),
        )
        self.assertEqual(report["scenarioId"], "ashby-complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})

    def test_lever_complete_profile_scenario_passes_with_closed_identity(self):
        fixture = valid_fixture()
        fixture["id"] = "lever-application-2026-08-v1"
        fixture["platformFamily"] = "lever"
        fixture["steps"] = [
            {
                "id": "step-1",
                "kind": "form",
                "title": "Application form",
                "controls": [
                    generic_control(kind, required)
                    for kind, required in LEVER_CONTROL_PROFILE
                ],
                "next": "review",
            },
            fixture["steps"][-1],
        ]
        report = self.evaluate(
            fixture=fixture,
            scenario={"id": "lever-complete-profile"},
            events=complete_events(fixture),
        )
        self.assertEqual(report["scenarioId"], "lever-complete-profile")
        self.assertEqual(report["status"], "passed")
        self.assertEqual(set(report["assertions"].values()), {"passed"})
        self.assertEqual(report["missingControlIds"], [])
        self.assertEqual(report["failureCategories"], [])

    def test_store_root_may_be_an_already_open_owned_descriptor(self):
        descriptor = os.open(
            self.store.root,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
        )
        displaced = self.store.root.parent / "original-store"
        try:
            self.store.root.rename(displaced)
            replacement = OracleStore(self.store.root)
            replacement.write_history([])

            report = self.evaluate(store_root=descriptor)

            self.assertEqual(report["status"], "passed")
            self.assertTrue(os.fstat(descriptor).st_ino)
        finally:
            os.close(descriptor)

    def test_each_required_non_file_control_is_required(self):
        required = sorted(
            control["id"]
            for step in self.fixture["steps"]
            for control in step["controls"]
            if control["required"] and control["role"] != "file"
        )
        for missing_id in required:
            with self.subTest(missing_id=missing_id):
                events = [
                    event
                    for event in self.events
                    if not (
                        event["type"] == "filled"
                        and event["controlId"] == missing_id
                    )
                ]
                report = self.evaluate(events=events)
                self.assertEqual(report["status"], "failed")
                self.assertEqual(
                    report["assertions"]["required-fields-filled"], "failed"
                )
                self.assertEqual(report["missingControlIds"], [missing_id])
                self.assertIn("required-fields-missing", report["failureCategories"])

    def test_missing_required_upload_fails(self):
        events = [event for event in self.events if event["type"] != "uploaded"]
        report = self.evaluate(events=events)
        self.assertEqual(report["assertions"]["resume-uploaded"], "failed")
        self.assertEqual(report["missingControlIds"], ["resume.file"])
        self.assertIn("required-upload-missing", report["failureCategories"])

    def test_wrong_resume_filename_match_fails_without_exposing_filename(self):
        events = [
            {
                **event,
                "expectedFilenameMatched": False,
            }
            if event["type"] == "uploaded"
            else event
            for event in self.events
        ]
        report = self.evaluate(events=events)
        self.assertEqual(report["assertions"]["resume-filename-matched"], "failed")
        self.assertIn("resume-filename-mismatch", report["failureCategories"])
        self.assertNotIn("filename", json.dumps(report["missingControlIds"]))

    def test_missing_review_event_fails(self):
        events = [event for event in self.events if event["type"] != "reviewed"]
        report = self.evaluate(events=events)
        self.assertEqual(report["assertions"]["review-reached"], "failed")
        self.assertIn("review-not-reached", report["failureCategories"])

    def test_duplicate_success_events_are_tolerated(self):
        report = self.evaluate(events=self.events + [dict(self.events[0])])
        self.assertEqual(report["status"], "passed")

    def test_malformed_unknown_or_incoherent_events_fail_value_free(self):
        invalid = [
            [],
            {"type": "filled", "controlId": "contact.first_name"},
            {
                "type": "filled",
                "controlId": "contact.first_name",
                "stepId": "step-1",
                "value": "EVENT SECRET",
            },
            {"type": "mystery", "controlId": "", "stepId": "review"},
            {"type": 1, "controlId": "", "stepId": "review"},
            {"type": "filled", "controlId": 1, "stepId": "step-1"},
            {"type": "filled", "controlId": "missing-secret", "stepId": "step-1"},
            {
                "type": "filled",
                "controlId": "contact.first_name",
                "stepId": "missing-secret",
            },
            {"type": "filled", "controlId": "resume.file", "stepId": "step-2"},
            {
                "type": "uploaded",
                "controlId": "contact.first_name",
                "stepId": "step-1",
            },
            {"type": "advanced", "controlId": "x", "stepId": "step-1"},
            {"type": "advanced", "controlId": "", "stepId": "review"},
            {"type": "reviewed", "controlId": "", "stepId": "step-1"},
            {"type": "final-action", "stepId": "step-1"},
        ]
        for event in invalid:
            with self.subTest(event=event):
                with self.assertRaises(OracleError) as caught:
                    self.evaluate(events=self.events + [event])
                diagnostic = str(caught.exception)
                self.assertNotIn("EVENT SECRET", diagnostic)
                self.assertNotIn("missing-secret", diagnostic)

    def test_event_count_is_bounded(self):
        with self.assertRaisesRegex(OracleError, "invalid events"):
            self.evaluate(events=[dict(self.events[0])] * 10_001)

    def test_any_final_action_event_fails_even_in_saturated_list(self):
        for events in (
            self.events + [{"type": "final-action", "stepId": "review"}],
            [dict(self.events[0])] * 9_999
            + [{"type": "final-action", "stepId": "review"}],
        ):
            with self.subTest(size=len(events)):
                report = self.evaluate(events=events)
                self.assertEqual(
                    report["assertions"]["final-action-untouched"], "failed"
                )
                self.assertIn("final-action-activated", report["failureCategories"])

    def test_invalid_fixture_and_scenario_diagnostics_are_value_free(self):
        fixture = dict(self.fixture)
        fixture["private-secret"] = "FIXTURE SECRET"
        cases = (
            {"fixture": fixture},
            {"scenario": {"id": "SECRET SCENARIO"}},
            {"scenario": {"id": "other-scenario"}},
            {"scenario": {"id": "complete-profile", "value": "SECRET"}},
            {"scenario": []},
            {"store_root": Path(self.temporary.name) / "SECRET missing store"},
        )
        for case in cases:
            with self.subTest(case=case):
                with self.assertRaises(OracleError) as caught:
                    self.evaluate(**case)
                self.assertNotIn("SECRET", str(caught.exception))

    def test_absent_history_is_a_failed_assertion(self):
        (self.store.root / "applications.jsonl").unlink()
        report = self.evaluate()
        self.assertEqual(
            report["assertions"]["history-started-reviewed"], "failed"
        )
        self.assertIn("history-missing", report["failureCategories"])

    def test_empty_or_incomplete_history_fails(self):
        cases = (
            [],
            [history_event("started")],
            [history_event("reviewed")],
            [history_event("started"), history_event("reviewed", "application-2")],
            [history_event("reviewed"), history_event("started")],
        )
        for history in cases:
            with self.subTest(history=history):
                self.store.write_history(history)
                report = self.evaluate()
                self.assertEqual(
                    report["assertions"]["history-started-reviewed"], "failed"
                )
                self.assertIn(
                    "history-lifecycle-incomplete", report["failureCategories"]
                )

    def test_completed_history_fails_even_with_valid_lifecycle(self):
        self.store.write_history(
            [
                history_event("started"),
                history_event("reviewed"),
                history_event("completed"),
            ]
        )
        report = self.evaluate()
        self.assertEqual(report["assertions"]["history-not-completed"], "failed")
        self.assertIn("history-completed", report["failureCategories"])

    def test_session_must_correlate_to_a_reviewed_history_application(self):
        session_path = self.store.sessions / "application-1.json"
        session_path.unlink()
        self.store.write_session(valid_session("application-2"), "application-2.json")
        report = self.evaluate()
        self.assertEqual(report["assertions"]["session-present"], "failed")
        self.assertEqual(report["status"], "failed")
        self.assertIn("session-not-correlated", report["failureCategories"])

    def test_session_may_match_any_ordered_reviewed_history_application(self):
        self.store.write_history(
            [
                history_event("started", "application-1"),
                history_event("started", "application-2"),
                history_event("reviewed", "application-2"),
                history_event("reviewed", "application-1"),
            ]
        )
        session_path = self.store.sessions / "application-1.json"
        session_path.unlink()
        self.store.write_session(valid_session("application-2"), "application-2.json")
        self.assertEqual(self.evaluate()["status"], "passed")

    def test_malformed_unreadable_or_value_bearing_history_is_rejected(self):
        history_path = self.store.root / "applications.jsonl"
        cases = (
            "not-json\n",
            json.dumps([]) + "\n",
            json.dumps(
                {
                    "schemaVersion": 2,
                    "applicationId": "application-1",
                    "event": "started",
                }
            )
            + "\n",
            json.dumps(history_event("unknown")) + "\n",
            json.dumps(
                {**history_event("started"), "extra": "HISTORY SECRET"}
            )
            + "\n",
            json.dumps(
                {**history_event("started"), "value": "HISTORY SECRET"}
            )
            + "\n",
            json.dumps(
                {
                    **history_event("started"),
                    "metadata": {"answerValue": "HISTORY SECRET"},
                }
            )
            + "\n",
        )
        for content in cases:
            with self.subTest(content=content[:30]):
                history_path.write_text(content, encoding="utf-8")
                with self.assertRaises(OracleError) as caught:
                    self.evaluate()
                self.assertNotIn("HISTORY SECRET", str(caught.exception))
        history_path.unlink()
        history_path.mkdir()
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

    def test_history_size_is_bounded(self):
        path = self.store.root / "applications.jsonl"
        path.write_bytes(b" " * (1024 * 1024 + 1))
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

    def test_history_line_limit_counts_blank_physical_lines(self):
        path = self.store.root / "applications.jsonl"
        boundary = "".join(
            (
                json.dumps(history_event("started")) + "\n",
                "   \n",
                json.dumps(history_event("reviewed")) + "\n",
            )
        )
        with mock.patch("qa.oracle.MAX_HISTORY_LINES", 3):
            path.write_text(boundary, encoding="utf-8")
            self.assertEqual(self.evaluate()["status"], "passed")

            path.write_text(boundary + "\n", encoding="utf-8")
            with self.assertRaisesRegex(OracleError, "invalid history artifact"):
                self.evaluate()

    def test_absent_session_directory_or_json_files_fails(self):
        for remove_directory in (False, True):
            with self.subTest(remove_directory=remove_directory):
                for path in self.store.sessions.glob("*.json"):
                    path.unlink()
                if remove_directory:
                    self.store.sessions.rmdir()
                report = self.evaluate()
                self.assertEqual(report["assertions"]["session-present"], "failed")
                self.assertIn("session-missing", report["failureCategories"])
                if remove_directory:
                    self.store.sessions.mkdir()

    def test_malformed_or_future_sessions_are_rejected(self):
        cases = (
            "not-json",
            json.dumps([]),
            json.dumps({**valid_session(), "schemaVersion": 2}),
            json.dumps({**valid_session(), "future": True}),
        )
        session_path = self.store.sessions / "application-1.json"
        for content in cases:
            with self.subTest(content=content[:30]):
                session_path.write_text(content, encoding="utf-8")
                with self.assertRaises(OracleError) as caught:
                    self.evaluate()
                self.assertNotIn("SESSION SECRET", str(caught.exception))

    def test_value_bearing_sessions_are_scored_as_redacted_failures(self):
        deeply_nested = valid_session()
        deeply_nested["pendingFields"][0]["details"] = {
            "nested": {"VaLuE": "SESSION SECRET"}
        }
        cases = (
            {**valid_session(), "value": "SESSION SECRET"},
            {**valid_session(), "answerValue": "SESSION SECRET"},
            {**valid_session(), "mixedcasevAlUe": "SESSION SECRET"},
            deeply_nested,
        )
        session_path = self.store.sessions / "application-1.json"
        for session in cases:
            with self.subTest(keys=sorted(session)):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                report = self.evaluate()
                self.assertEqual(report["assertions"]["session-value-free"], "failed")
                self.assertEqual(report["status"], "failed")
                self.assertIn("session-value-present", report["failureCategories"])
                self.assertNotIn("SESSION SECRET", json.dumps(report))

    def test_deep_and_large_session_documents_are_rejected(self):
        session = valid_session()
        nested = {}
        cursor = nested
        for _ in range(70):
            cursor["node"] = {}
            cursor = cursor["node"]
        session["pendingFields"][0]["details"] = nested
        session_path = self.store.sessions / "application-1.json"
        session_path.write_text(json.dumps(session), encoding="utf-8")
        with self.assertRaisesRegex(OracleError, "invalid session artifact"):
            self.evaluate()

        session_path.write_bytes(b" " * (1024 * 1024 + 1))
        with self.assertRaisesRegex(OracleError, "invalid session artifact"):
            self.evaluate()

    def test_session_file_count_is_bounded(self):
        for index in range(256):
            (self.store.sessions / f"extra-{index}.json").write_text(
                json.dumps(valid_session(f"extra-{index}")), encoding="utf-8"
            )
        with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
            self.evaluate()

    def test_session_entry_limit_counts_every_suffix_without_materializing_excess(self):
        for index in range(3):
            (self.store.sessions / f"ignored-{index}.txt").write_text(
                "SESSION SECRET", encoding="utf-8"
            )
        with mock.patch("qa.oracle.MAX_SESSION_ENTRIES", 3):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
                self.evaluate()

        (self.store.sessions / "ignored-2.txt").unlink()
        with mock.patch("qa.oracle.MAX_SESSION_ENTRIES", 3):
            self.assertEqual(self.evaluate()["status"], "passed")

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_session_entry_limit_counts_symlinks_and_special_entries(self):
        for path in self.store.sessions.iterdir():
            path.unlink()
        target = Path(self.temporary.name) / "outside"
        target.write_text("SESSION SECRET", encoding="utf-8")
        (self.store.sessions / "entry.json").symlink_to(target)
        (self.store.sessions / "special-directory").mkdir()
        with mock.patch("qa.oracle.MAX_SESSION_ENTRIES", 1):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
                self.evaluate()

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlinked_store_artifacts_and_root_are_rejected(self):
        outside = Path(self.temporary.name) / "outside.json"
        outside.write_text(
            json.dumps(history_event("started")) + "\n", encoding="utf-8"
        )
        history_path = self.store.root / "applications.jsonl"
        history_path.unlink()
        history_path.symlink_to(outside)
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

        history_path.unlink()
        self.store.write_history([history_event("started"), history_event("reviewed")])
        session_path = self.store.sessions / "application-1.json"
        session_path.unlink()
        session_path.symlink_to(outside)
        with self.assertRaisesRegex(OracleError, "invalid session artifact"):
            self.evaluate()

        alias = Path(self.temporary.name) / "store-alias"
        alias.symlink_to(self.store.root, target_is_directory=True)
        with self.assertRaisesRegex(OracleError, "invalid store root"):
            self.evaluate(store_root=alias)

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_broken_artifact_symlinks_are_rejected_not_treated_as_absent(self):
        missing_target = Path(self.temporary.name) / "missing-target"
        history_path = self.store.root / "applications.jsonl"
        history_path.unlink()
        history_path.symlink_to(missing_target)
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

        history_path.unlink()
        self.store.write_history([history_event("started"), history_event("reviewed")])
        for path in self.store.sessions.iterdir():
            path.unlink()
        self.store.sessions.rmdir()
        self.store.sessions.symlink_to(missing_target, target_is_directory=True)
        with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
            self.evaluate()

    def test_descriptor_traversal_is_required(self):
        with mock.patch("qa.oracle._DESCRIPTOR_TRAVERSAL_AVAILABLE", False):
            with self.assertRaisesRegex(OracleError, "invalid store root"):
                self.evaluate()

    def test_sessions_descriptor_is_closed_when_identity_check_fails(self):
        real_fstat = os.fstat
        calls = 0
        failed_descriptor = None

        def fail_sessions_fstat(descriptor):
            nonlocal calls, failed_descriptor
            calls += 1
            if calls == 3:
                failed_descriptor = descriptor
                raise OSError("synthetic failure")
            return real_fstat(descriptor)

        with mock.patch("qa.oracle.os.fstat", side_effect=fail_sessions_fstat):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
                self.evaluate()
        self.assertIsNotNone(failed_descriptor)
        with self.assertRaises(OSError):
            real_fstat(failed_descriptor)

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_root_swap_is_refused_without_reading_outside_store(self):
        outside = Path(self.temporary.name) / "outside-store"
        OracleStore(outside).make_valid()
        backup = Path(self.temporary.name) / "original-store"
        real_open = os.open
        swapped = False

        def swap_root(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal swapped
            if path == self.store.root and dir_fd is None and not swapped:
                swapped = True
                self.store.root.rename(backup)
                self.store.root.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("qa.oracle.os.open", side_effect=swap_root):
            with self.assertRaisesRegex(OracleError, "invalid store root") as caught:
                self.evaluate()
        self.assertTrue(swapped)
        self.assertNotIn(str(outside), str(caught.exception))

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_sessions_swap_is_refused_without_reading_outside_directory(self):
        outside = Path(self.temporary.name) / "outside-sessions"
        outside.mkdir()
        (outside / "application-1.json").write_text(
            json.dumps({**valid_session(), "value": "OUTSIDE SECRET"}),
            encoding="utf-8",
        )
        backup = self.store.root / "original-sessions"
        real_open = os.open
        swapped = False

        def swap_sessions(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal swapped
            if path == "sessions" and dir_fd is not None and not swapped:
                swapped = True
                self.store.sessions.rename(backup)
                self.store.sessions.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("qa.oracle.os.open", side_effect=swap_sessions):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts") as caught:
                self.evaluate()
        self.assertTrue(swapped)
        self.assertNotIn("OUTSIDE SECRET", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
