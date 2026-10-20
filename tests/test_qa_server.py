from tests.support.oracle_fixtures import *
from tests.support.running_replay_server import *


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
