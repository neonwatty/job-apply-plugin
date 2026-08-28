import base64
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
from unittest import mock
from urllib.parse import quote


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

    def upload(self, filename, content, metadata):
        return {"metadata": metadata, "filename": filename, "content": base64.b64encode(content).decode("ascii")}

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

    def test_owner_beta_boot_and_overview_are_authenticated_and_value_free(self):
        status, _headers, body = self.request("GET", "/api/boot", token=False, origin=False)
        self.assertEqual((status, body["error"]["code"]), (401, "token_rejected"))
        status, _headers, boot = self.request("GET", "/api/boot", origin=False)
        self.assertEqual((status, boot), (200, {"status": "ready", "code": "ready"}))
        status, _headers, overview = self.request("GET", "/api/overview", origin=False)
        self.assertEqual(status, 200)
        self.assertEqual((overview["nextAction"], overview["targetWorkspace"]), ("import_resume", "resumes"))
        self.assertEqual(set(overview), {"setup", "counts", "nextAction", "targetWorkspace"})

    def test_owner_beta_degraded_startup_serves_static_recovery_and_blocks_store_access(self):
        degraded_root = Path(self.temporary.name) / "degraded-store"
        degraded_root.mkdir()
        private_marker = "owner-private-path-and-value"
        (degraded_root / "jobs.json").write_text(private_marker, encoding="utf-8")
        server = WORKSPACE.WorkspaceServer(degraded_root, 0, token="degraded-token")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            old_server = self.server
            self.server = server
            status, _headers, asset = self.request("GET", "/", token=False, origin=False)
            self.assertEqual(status, 200)
            self.assertIn(b"STORE RECOVERY", asset)
            status, _headers, boot = self.request("GET", "/api/boot", origin=False)
            self.assertEqual((status, boot["status"], boot["code"]), (200, "degraded", "corrupt_store"))
            self.assertNotIn(private_marker, json.dumps(boot))
            status, _headers, error = self.request("GET", "/api/overview", origin=False)
            self.assertEqual((status, error["error"]["code"]), (503, "store_unavailable"))
            status, _headers, error = self.request("POST", "/api/jobs", {"job": {"url": "https://example.invalid"}})
            self.assertEqual((status, error["error"]["code"]), (503, "store_unavailable"))
            self.assertEqual((degraded_root / "jobs.json").read_text(encoding="utf-8"), private_marker)
            self.assertEqual(WORKSPACE.degraded_boot_status(WORKSPACE.STORE_MODULE.StoreError("uses unsupported future schemaVersion 2"))["code"], "future_store")
            self.server = old_server
        finally:
            self.server = old_server
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_owner_beta_invalid_utf8_enters_sanitized_degraded_recovery(self):
        degraded_root = Path(self.temporary.name) / "invalid-utf8-store"
        degraded_root.mkdir()
        private_bytes = b"\xff\xfeowner-private-invalid-utf8"
        (degraded_root / "jobs.json").write_bytes(private_bytes)

        server = WORKSPACE.WorkspaceServer(
            degraded_root, 0, token="invalid-utf8-token"
        )
        try:
            self.assertEqual(
                (server.boot_status["status"], server.boot_status["code"]),
                ("degraded", "corrupt_store"),
            )
            serialized = json.dumps(server.boot_status)
            self.assertNotIn("owner-private-invalid-utf8", serialized)
            self.assertNotIn(str(degraded_root), serialized)
            self.assertEqual((degraded_root / "jobs.json").read_bytes(), private_bytes)
        finally:
            server.server_close()

    def test_owner_beta_invalid_utf8_history_enters_sanitized_degraded_recovery(self):
        degraded_root = Path(self.temporary.name) / "invalid-utf8-history-store"
        degraded_root.mkdir()
        private_bytes = b"\xff\xfeowner-private-invalid-history"
        (degraded_root / "applications.jsonl").write_bytes(private_bytes)

        server = WORKSPACE.WorkspaceServer(
            degraded_root, 0, token="invalid-history-token"
        )
        try:
            self.assertEqual(
                (server.boot_status["status"], server.boot_status["code"]),
                ("degraded", "corrupt_store"),
            )
            serialized = json.dumps(server.boot_status)
            self.assertNotIn("owner-private-invalid-history", serialized)
            self.assertNotIn(str(degraded_root), serialized)
            self.assertEqual(
                (degraded_root / "applications.jsonl").read_bytes(), private_bytes
            )
        finally:
            server.server_close()

    def test_owner_beta_safe_future_history_starts_ready_without_mutation(self):
        compatibility_root = Path(self.temporary.name) / "future-history-store"
        store = WORKSPACE.STORE_MODULE.Store(compatibility_root)
        store.initialize()
        store.claim_status()
        future_event = {
            "schemaVersion": 1,
            "eventId": "future-workspace-event",
            "applicationId": "future-workspace-job",
            "event": "future-safe-event",
            "status": "future-status",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        store.history_path.write_text(
            json.dumps(future_event) + "\n", encoding="utf-8"
        )
        before = {
            path.relative_to(compatibility_root): path.read_bytes()
            for path in compatibility_root.rglob("*")
            if path.is_file()
        }

        server = WORKSPACE.WorkspaceServer(
            compatibility_root, 0, token="future-history-token"
        )
        try:
            self.assertEqual(server.boot_status, {"status": "ready", "code": "ready"})
            self.assertEqual(server.store.read_history(), [future_event])
            after = {
                path.relative_to(compatibility_root): path.read_bytes()
                for path in compatibility_root.rglob("*")
                if path.is_file()
            }
            self.assertEqual(after, before)
        finally:
            server.server_close()

    def test_owner_beta_startup_rejects_semantically_invalid_claim_timestamps_without_mutation(self):
        base_claim = {
            "claimId": "claim-one",
            "jobId": "owner-job",
            "ownerLabel": "owner",
            "tokenHash": "a" * 64,
            "acquiredAt": "2026-08-27T09:00:00-07:00",
            "heartbeatAt": "2026-08-27T16:01:00Z",
            "expiresAt": "2026-08-27T16:06:00+00:00",
        }
        invalid_cases = {
            "malformed-acquisition": {"acquiredAt": "2026-02-30T16:00:00Z"},
            "timezone-naive": {"heartbeatAt": "2026-08-27T16:01:00"},
            "malformed-expiry": {"expiresAt": "not-a-time"},
        }
        for label, patch in invalid_cases.items():
            with self.subTest(label=label):
                root = Path(self.temporary.name) / f"invalid-claim-{label}"
                root.mkdir()
                coordinator = root / "coordinator.json"
                coordinator.write_text(json.dumps({
                    "schemaVersion": 1,
                    "claim": {**base_claim, **patch},
                }), encoding="utf-8")
                before = coordinator.read_bytes()
                server = WORKSPACE.WorkspaceServer(root, 0, token="claim-token")
                try:
                    self.assertEqual(
                        (server.boot_status["status"], server.boot_status["code"]),
                        ("degraded", "corrupt_store"),
                    )
                    self.assertEqual(coordinator.read_bytes(), before)
                    self.assertEqual(sorted(path.name for path in root.iterdir()), ["coordinator.json"])
                finally:
                    server.server_close()

        valid_root = Path(self.temporary.name) / "valid-offset-claim"
        valid_root.mkdir()
        (valid_root / "coordinator.json").write_text(json.dumps({
            "schemaVersion": 1,
            "claim": base_claim,
        }), encoding="utf-8")
        server = WORKSPACE.WorkspaceServer(valid_root, 0, token="valid-claim-token")
        try:
            self.assertEqual(server.boot_status, {"status": "ready", "code": "ready"})
        finally:
            server.server_close()

    def test_owner_beta_corrupt_and_future_sessions_enter_sanitized_degraded_recovery(self):
        for label, payload, expected_code in (
            ("corrupt", b'{"private":"owner-session-value"', "corrupt_store"),
            (
                "future",
                json.dumps({
                    "schemaVersion": 99,
                    "applicationId": "owner-session",
                    "status": "active",
                    "answerKeys": [],
                    "pendingFields": [],
                }).encode(),
                "future_store",
            ),
        ):
            with self.subTest(label=label):
                degraded_root = Path(self.temporary.name) / f"{label}-session-store"
                sessions = degraded_root / "sessions"
                sessions.mkdir(parents=True)
                session_path = sessions / "owner-session.json"
                session_path.write_bytes(payload)
                server = WORKSPACE.WorkspaceServer(
                    degraded_root, 0, token=f"{label}-session-token"
                )
                try:
                    self.assertEqual(
                        (server.boot_status["status"], server.boot_status["code"]),
                        ("degraded", expected_code),
                    )
                    serialized = json.dumps(server.boot_status)
                    self.assertNotIn("owner-session-value", serialized)
                    self.assertNotIn(str(degraded_root), serialized)
                    self.assertEqual(session_path.read_bytes(), payload)
                finally:
                    server.server_close()

    def test_owner_beta_initialization_failure_aborts_instead_of_claiming_degraded_safety(self):
        root = Path(self.temporary.name) / "partial-initialization"
        marker = root / "initialization-started"

        def fail_after_mutation(_store):
            root.mkdir()
            marker.write_text("partial", encoding="utf-8")
            raise WORKSPACE.STORE_MODULE.StoreError("simulated initialization failure")

        with mock.patch.object(
            WORKSPACE.STORE_MODULE.Store, "initialize", fail_after_mutation
        ):
            with self.assertRaisesRegex(
                WORKSPACE.STORE_MODULE.StoreError,
                "simulated initialization failure",
            ):
                WORKSPACE.WorkspaceServer(root, 0, token="must-not-serve")
        self.assertTrue(marker.is_file())

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

    def test_job_activity_endpoint_is_selected_job_only_and_redacted(self):
        self.server.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.server.store.inspect_profile()["revision"],
            source="user",
        )
        resume_path = Path(self.temporary.name) / "activity-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nactivity")
        self.server.store.create_resume(
            {"id": "activity-resume", "label": "Activity", "path": str(resume_path)}
        )
        job = self.create_job(
            "https://example.com/jobs/activity",
            role="Engineer", company="Acme",
        )
        ready = self.server.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.server.store.acquire_ready_job(
            job["id"], "private-api-owner", ready["revision"]
        )
        self.server.store.save_claim_progress(job["id"], acquired["token"], {
            "status": "active", "step": "questions",
            "answerKeys": ["private.api.answer"],
            "pendingFields": [{
                "question": "Do you need sponsorship?", "state": "missing",
                "answerKey": "private.api.answer", "sensitive": True,
            }],
        })
        unrelated = self.create_job(
            "https://example.com/jobs/unrelated", role="Unrelated", company="Elsewhere"
        )

        status, _headers, activity = self.request(
            "GET", f"/api/jobs/{job['id']}/activity", origin=False
        )
        self.assertEqual(status, 200)
        self.assertEqual(activity["job"]["status"], "in_progress")
        self.assertEqual(activity["claim"]["state"], "active")
        self.assertEqual(activity["session"]["pendingInformation"], [{
            "question": "Do you need sponsorship?", "state": "missing", "sensitive": True,
        }])
        serialized = json.dumps(activity)
        for forbidden in (
            acquired["token"], "private-api-owner", "private.api.answer",
            "tokenHash", "claimId", "ownerLabel", "answerKey", "answerKeys",
            "operationId", "browserState",
        ):
            self.assertNotIn(forbidden, serialized)

        status, _headers, unrelated_activity = self.request(
            "GET", f"/api/jobs/{unrelated['id']}/activity", origin=False
        )
        self.assertEqual(status, 200)
        self.assertEqual(unrelated_activity["claim"], {"state": "none"})
        self.assertNotIn(job["id"], json.dumps(unrelated_activity))

        status, _headers, missing = self.request(
            "GET", "/api/jobs/does-not-exist/activity", origin=False
        )
        self.assertEqual((status, missing["error"]["code"]), (404, "not_found"))

    def test_unified_trash_is_redacted_deterministic_and_closes_job_lifecycle_parity(self):
        job = self.create_job(
            "https://private.example/jobs/secret",
            role="Engineer",
            company="Acme",
            notes="private job note",
        )
        job = self.server.store.trash_job(job["id"], job["revision"])
        source = Path(self.temporary.name) / "private-resume-name.txt"
        source.write_text("private resume content", encoding="utf-8")
        resume = self.server.store.create_resume(
            {"id": "trash-resume", "label": "Primary", "path": str(source)}
        )
        resume = self.server.store.trash_resume(resume["id"], resume["revision"])
        answer = self.server.store.put_answer(
            {
                "question": "Private reusable answer?",
                "state": "sensitive",
                "sensitivity": "high",
                "value": "private answer value",
            },
            remember_sensitive=True,
        )
        answer = self.server.store.trash_answer(answer["key"], answer["revision"])

        status, _headers, trash = self.request("GET", "/api/trash", origin=False)
        self.assertEqual((status, trash["counts"], trash["total"]), (200, {"job": 1, "resume": 1, "answer": 1}, 3))
        self.assertEqual(
            [(item["type"], item["id"]) for item in trash["items"]],
            sorted((item["type"], item["id"]) for item in trash["items"]),
        )
        serialized = json.dumps(trash)
        for private in (
            "https://private.example/jobs/secret",
            "private job note",
            str(source),
            source.name,
            "private resume content",
            "private answer value",
        ):
            self.assertNotIn(private, serialized)
        status, _headers, hidden_detail = self.request(
            "GET", f"/api/jobs/{job['id']}", origin=False
        )
        self.assertEqual((status, hidden_detail["error"]["code"]), (404, "not_found"))
        self.assertNotIn("private.example", json.dumps(hidden_detail))

        status, _headers, restored = self.request(
            "POST", f"/api/jobs/{job['id']}/restore", {"expectedRevision": job["revision"]}
        )
        self.assertEqual((status, restored["deletedAt"]), (200, None))
        status, _headers, stale = self.request(
            "POST", f"/api/jobs/{job['id']}/trash", {"expectedRevision": job["revision"]}
        )
        self.assertEqual((status, stale["error"]["code"]), (409, "revision_conflict"))
        self.assertEqual(
            (stale["error"]["recordType"], stale["error"]["operation"], stale["error"]["counts"]),
            ("job", "trash", {}),
        )
        trashed = self.server.store.trash_job(restored["id"], restored["revision"])
        status, _headers, deleted = self.request(
            "POST", f"/api/jobs/{job['id']}/delete", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual((status, deleted), (200, {"deleted": True, "id": job["id"]}))

    def test_job_delete_api_fails_closed_with_redacted_nonterminal_session_code(self):
        self.server.store.save_session(
            "protected-job",
            {"status": "review", "answerKeys": [], "pendingFields": []},
        )
        job = self.create_job(
            "https://private.example/jobs/protected", id="protected-job"
        )
        job = self.server.store.trash_job(job["id"], job["revision"])
        status, _headers, blocked = self.request(
            "POST", f"/api/jobs/{job['id']}/delete", {"expectedRevision": job["revision"]}
        )
        self.assertEqual((status, blocked["error"]["code"]), (409, "session_reference_blocked"))
        self.assertEqual(
            (blocked["error"]["recordType"], blocked["error"]["operation"], blocked["error"]["counts"]),
            ("job", "delete", {"nonterminalSessions": 1}),
        )
        self.assertNotIn("protected-job", json.dumps(blocked))
        self.assertIsNotNone(self.server.store.get_job(job["id"], include_trashed=True))

    def test_restore_blockers_are_operation_aware_and_redacted(self):
        first = self.server.store.create_resume_bytes(
            {"id": "first-restore", "label": "First"}, "first.txt", b"first bytes"
        )
        second = self.server.store.create_resume_bytes(
            {"id": "second-restore", "label": "Second"}, "second.txt", b"second bytes"
        )
        job = self.create_job(
            "https://private.example/jobs/restore-blocked",
            resumeId=second["id"],
        )
        job = self.server.store.trash_job(job["id"], job["revision"])
        second = self.server.store.trash_resume(second["id"], second["revision"])
        status, _headers, blocked_job = self.request(
            "POST", f"/api/jobs/{job['id']}/restore", {"expectedRevision": job["revision"]}
        )
        self.assertEqual(
            (
                status,
                blocked_job["error"]["code"],
                blocked_job["error"]["recordType"],
                blocked_job["error"]["operation"],
                blocked_job["error"]["counts"],
            ),
            (409, "assigned_resume_blocked", "job", "restore", {"unavailableAssignedResumes": 1}),
        )
        self.assertNotIn("second-restore", json.dumps(blocked_job))

        with mock.patch.object(
            self.server.store,
            "restore_resume",
            side_effect=WORKSPACE.STORE_MODULE.StoreError(
                "active resume file already exists"
            ),
        ):
            status, _headers, blocked_resume = self.request(
                "POST", f"/api/resumes/{second['id']}/restore", {"expectedRevision": second["revision"]}
            )
        self.assertEqual(
            (
                status,
                blocked_resume["error"]["code"],
                blocked_resume["error"]["recordType"],
                blocked_resume["error"]["operation"],
                blocked_resume["error"]["counts"],
            ),
            (409, "duplicate_active_blocked", "resume", "restore", {"duplicateActiveRecords": 1}),
        )
        self.assertNotIn("first-restore", json.dumps(blocked_resume))

    def test_answer_api_redaction_review_conflict_reveal_and_history_guard(self):
        status, _headers, observed = self.request(
            "POST", "/api/answers/observe",
            {"answer": {"question": "Observed browser question?", "state": "missing", "scope": {"ats": "test"}}},
        )
        self.assertEqual((status, observed["reviewStatus"]), (200, "pending"))
        status, _headers, inbox = self.request(
            "POST", "/api/answers/query", {"reviewStatus": "pending"}
        )
        self.assertEqual((status, inbox["total"], inbox["items"][0]["key"]), (200, 1, observed["key"]))
        self.assertNotIn("value", inbox["items"][0])
        status, _headers, accepted = self.request(
            "POST", f"/api/answers/{observed['key']}/accept",
            {"expectedRevision": observed["revision"], "patch": {"state": "confirmed", "value": "Yes"}},
        )
        self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))
        status, _headers, conflict = self.request(
            "PATCH", f"/api/answers/{observed['key']}",
            {"expectedRevision": observed["revision"], "patch": {"aliases": ["old"]}},
        )
        self.assertEqual((status, conflict["error"]["code"]), (409, "revision_conflict"))

        status, _headers, sensitive = self.request(
            "POST", "/api/answers",
            {"answer": {"question": "Private answer?", "state": "sensitive", "value": "browser secret", "sensitivity": "high"}, "rememberSensitive": True},
        )
        self.assertEqual(status, 200, sensitive)
        status, _headers, library = self.request("GET", "/api/answers", origin=False)
        self.assertEqual(status, 200)
        self.assertNotIn("browser secret", json.dumps(library))
        self.assertTrue(all("value" not in item for item in library["items"]))
        status, _headers, detail = self.request("GET", f"/api/answers/{sensitive['key']}", origin=False)
        self.assertEqual(status, 200)
        self.assertNotIn("value", detail)
        status, _headers, revealed = self.request("POST", f"/api/answers/{sensitive['key']}/reveal", {})
        self.assertEqual((status, revealed["value"]), (200, "browser secret"))
        status, _headers, rejected = self.request(
            "PATCH", f"/api/answers/{sensitive['key']}",
            {"expectedRevision": sensitive["revision"], "patch": {"value": "changed secret"}},
        )
        self.assertEqual(status, 400, rejected)

        self.server.store.append_history({"applicationId": "browser-answer", "event": "reviewed", "answerKeys": [accepted["key"]]})
        status, _headers, trashed = self.request("POST", f"/api/answers/{accepted['key']}/trash", {"expectedRevision": accepted["revision"]})
        self.assertEqual(status, 200)
        status, _headers, blocked = self.request("POST", f"/api/answers/{accepted['key']}/delete", {"expectedRevision": trashed["revision"]})
        self.assertEqual((status, blocked["error"]["code"]), (409, "history_reference_blocked"))
        self.assertEqual(
            (blocked["error"]["recordType"], blocked["error"]["operation"], blocked["error"]["counts"]),
            ("answer", "delete", {"sessions": 0, "history": 1}),
        )
        self.assertNotIn("Yes", json.dumps(blocked))

    def test_encoded_answer_routes_round_trip_dot_only_keys_without_weakening_guards(self):
        answer = self.server.store.put_answer({"key": "..", "state": "missing"})
        encoded = base64.urlsafe_b64encode(answer["key"].encode()).decode().rstrip("=")
        route = f"/api/answers/by-key/{encoded}"

        status, _headers, detail = self.request("GET", route, origin=False)
        self.assertEqual((status, detail["key"]), (200, ".."))
        status, _headers, unauthorized = self.request(
            "GET", route, token=False, origin=False
        )
        self.assertEqual((status, unauthorized["error"]["code"]), (401, "token_rejected"))
        status, _headers, rejected = self.request(
            "PATCH",
            route,
            {"patch": {"aliases": ["dot key"]}, "expectedRevision": answer["revision"]},
            origin=False,
        )
        self.assertEqual((status, rejected["error"]["code"]), (403, "origin_rejected"))
        status, _headers, updated = self.request(
            "PATCH",
            route,
            {"patch": {"aliases": ["dot key"]}, "expectedRevision": answer["revision"]},
        )
        self.assertEqual((status, updated["key"], updated["aliases"]), (200, "..", ["dot key"]))
        status, _headers, trashed = self.request(
            "POST", f"{route}/trash", {"expectedRevision": updated["revision"]}
        )
        self.assertEqual((status, trashed["key"]), (200, ".."))
        status, _headers, restored = self.request(
            "POST", f"{route}/restore", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual((status, restored["key"], restored["deletedAt"]), (200, "..", None))
        status, _headers, malformed = self.request(
            "GET", "/api/answers/by-key/not%2Fa%2Fsegment", origin=False
        )
        self.assertEqual(status, 400, malformed)
        self.assertIn("invalid", malformed["error"]["message"])

    def test_answer_api_rejects_non_string_review_status_with_safe_error(self):
        status, _headers, body = self.request(
            "POST", "/api/answers/query", {"reviewStatus": []}
        )

        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "store_rejected")
        self.assertIn("review status is unsupported", body["error"]["message"])

        status, _headers, body = self.request(
            "POST", "/api/answers/query", {"state": []}
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "store_rejected")
        self.assertIn("state is unsupported", body["error"]["message"])

    def test_answer_api_accepts_draft_with_consent_and_filters_trash_before_pagination(self):
        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "Sensitive pending draft?", "state": "missing"}},
        )
        self.assertEqual(status, 200)
        secret = "accepted-private-draft"
        status, _headers, accepted = self.request(
            "POST",
            f"/api/answers/{pending['key']}/accept",
            {
                "expectedRevision": pending["revision"],
                "patch": {"state": "sensitive", "sensitivity": "high", "value": secret},
                "rememberSensitive": True,
            },
        )
        self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))
        self.assertNotIn(secret, json.dumps(accepted))
        self.assertEqual(self.server.store.reveal_answer(pending["key"])["value"], secret)

        trashed_keys = []
        for index in range(3):
            status, _headers, created = self.request(
                "POST",
                "/api/answers",
                {"answer": {"question": f"Trash page {index}?", "state": "confirmed", "value": str(index)}},
            )
            self.assertEqual(status, 200)
            status, _headers, trashed = self.request(
                "POST",
                f"/api/answers/{created['key']}/trash",
                {"expectedRevision": created["revision"]},
            )
            self.assertEqual(status, 200)
            trashed_keys.append(trashed["key"])
        status, _headers, first = self.request(
            "POST",
            "/api/answers/query",
            {"reviewStatus": None, "includeTrashed": True, "trashedOnly": True, "offset": 0, "limit": 2},
        )
        status2, _headers, second = self.request(
            "POST",
            "/api/answers/query",
            {"reviewStatus": None, "includeTrashed": True, "trashedOnly": True, "offset": 2, "limit": 2},
        )
        self.assertEqual((status, status2, first["total"], first["hasMore"], second["hasMore"]), (200, 200, 3, True, False))
        self.assertEqual([item["key"] for item in first["items"] + second["items"]], trashed_keys)

    def test_answer_api_merge_is_explicit_redacted_revision_safe_and_resolves_history(self):
        status, _headers, winner = self.request(
            "POST", "/api/answers",
            {"answer": {"question": "Canonical private answer?", "state": "sensitive", "value": "api-winner-secret", "sensitivity": "high", "scope": {"ats": "test"}}, "rememberSensitive": True},
        )
        self.assertEqual(status, 200)
        status, _headers, source = self.request(
            "POST", "/api/answers",
            {"answer": {"question": "Duplicate private answer?", "state": "confirmed", "value": "api-source-discarded", "scope": {"ats": "test"}}},
        )
        self.assertEqual(status, 200)
        self.server.store.append_history({"applicationId": "api-merge", "event": "reviewed", "answerKeys": [source["key"]]})
        status, _headers, stale = self.request(
            "POST", f"/api/answers/{source['key']}/merge",
            {"winnerKey": winner["key"], "expectedWinnerRevision": winner["revision"] + 1, "expectedSourceRevision": source["revision"]},
        )
        self.assertEqual((status, stale["error"]["code"]), (409, "revision_conflict"))
        self.assertIsNotNone(self.server.store.get_answer(source["key"]))
        status, _headers, merged = self.request(
            "POST", f"/api/answers/{source['key']}/merge",
            {"winnerKey": winner["key"], "expectedWinnerRevision": winner["revision"], "expectedSourceRevision": source["revision"]},
        )
        self.assertEqual(status, 200)
        self.assertEqual((merged["key"], merged["mergedFrom"]), (winner["key"], source["key"]))
        serialized = json.dumps(merged)
        self.assertNotIn("api-winner-secret", serialized)
        self.assertNotIn("api-source-discarded", serialized)
        self.assertNotIn("value", merged)
        self.assertEqual(merged["referenceCounts"], {"sessions": 0, "history": 1, "total": 1})
        status, _headers, redirected = self.request("GET", f"/api/answers/{source['key']}", origin=False)
        self.assertEqual((status, redirected["key"], redirected["redirectedFrom"]), (200, winner["key"], source["key"]))

    def test_answer_api_requires_strict_boolean_remember_consent(self):
        status, _headers, body = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {"question": "Strict create consent?", "state": "sensitive", "value": "secret"},
                "rememberSensitive": 1,
            },
        )
        self.assertEqual(status, 400, body)

        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "Strict mutation consent?", "state": "missing"}},
        )
        self.assertEqual(status, 200, pending)
        encoded = quote(pending["key"], safe="")
        status, _headers, body = self.request(
            "PATCH",
            f"/api/answers/{encoded}",
            {
                "patch": {"aliases": ["strict patch"]},
                "expectedRevision": pending["revision"],
                "rememberSensitive": 0,
            },
        )
        self.assertEqual(status, 400, body)
        status, _headers, body = self.request(
            "POST",
            f"/api/answers/{encoded}/accept",
            {
                "expectedRevision": pending["revision"],
                "rememberSensitive": "false",
            },
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(self.server.store.get_answer(pending["key"])["reviewStatus"], "pending")

    def test_answer_api_crud_decodes_every_encoded_explicit_key_character(self):
        explicit_key = "explicit /?#% ü .. \\ key"
        encoded = quote(explicit_key, safe="")
        status, _headers, created = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {
                    "key": explicit_key,
                    "question": "Encoded explicit key?",
                    "state": "confirmed",
                    "value": "available",
                }
            },
        )
        self.assertEqual((status, created["key"]), (200, explicit_key), created)
        status, _headers, detail = self.request(
            "GET", f"/api/answers/{encoded}", origin=False
        )
        self.assertEqual((status, detail["key"]), (200, explicit_key), detail)
        status, _headers, updated = self.request(
            "PATCH",
            f"/api/answers/{encoded}",
            {"patch": {"aliases": ["encoded alias"]}, "expectedRevision": created["revision"]},
        )
        self.assertEqual((status, updated["revision"]), (200, 2), updated)
        status, _headers, revealed = self.request(
            "POST", f"/api/answers/{encoded}/reveal", {}
        )
        self.assertEqual((status, revealed["value"]), (200, "available"), revealed)
        status, _headers, trashed = self.request(
            "POST", f"/api/answers/{encoded}/trash", {"expectedRevision": updated["revision"]}
        )
        self.assertEqual(status, 200, trashed)
        status, _headers, restored = self.request(
            "POST", f"/api/answers/{encoded}/restore", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual(status, 200, restored)
        status, _headers, trashed = self.request(
            "POST", f"/api/answers/{encoded}/trash", {"expectedRevision": restored["revision"]}
        )
        self.assertEqual(status, 200, trashed)
        status, _headers, deleted = self.request(
            "POST", f"/api/answers/{encoded}/delete", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual((status, deleted), (200, {"deleted": True, "key": explicit_key}), deleted)

    def test_answer_api_reserved_list_names_are_valid_detail_and_mutation_keys(self):
        for explicit_key in ("observed", "trash"):
            with self.subTest(key=explicit_key):
                status, _headers, created = self.request(
                    "POST",
                    "/api/answers",
                    {
                        "answer": {
                            "key": explicit_key,
                            "question": f"Reserved route key {explicit_key}?",
                            "state": "confirmed",
                            "value": "available",
                        }
                    },
                )
                self.assertEqual((status, created["key"]), (200, explicit_key), created)
                status, _headers, detail = self.request(
                    "GET", f"/api/answers/{explicit_key}", origin=False
                )
                self.assertEqual((status, detail["key"]), (200, explicit_key), detail)
                status, _headers, updated = self.request(
                    "PATCH",
                    f"/api/answers/{explicit_key}",
                    {
                        "patch": {"aliases": [f"{explicit_key} route alias"]},
                        "expectedRevision": created["revision"],
                    },
                )
                self.assertEqual((status, updated["revision"]), (200, 2), updated)
                status, _headers, trashed = self.request(
                    "POST",
                    f"/api/answers/{explicit_key}/trash",
                    {"expectedRevision": updated["revision"]},
                )
                self.assertEqual(status, 200, trashed)
                status, _headers, restored = self.request(
                    "POST",
                    f"/api/answers/{explicit_key}/restore",
                    {"expectedRevision": trashed["revision"]},
                )
                self.assertEqual(status, 200, restored)

    def test_answer_patch_cannot_transition_review_status(self):
        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "Dedicated review route?", "state": "missing"}},
        )
        encoded = quote(pending["key"], safe="")
        status, _headers, body = self.request(
            "PATCH",
            f"/api/answers/{encoded}",
            {"patch": {"reviewStatus": "accepted"}, "expectedRevision": pending["revision"]},
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(self.server.store.get_answer(pending["key"])["reviewStatus"], "pending")

    def test_answer_api_upsert_cannot_transition_existing_review_status(self):
        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "API upsert review boundary?", "state": "missing"}},
        )
        self.assertEqual((status, pending["reviewStatus"]), (200, "pending"))
        status, _headers, pending_upserted = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {
                    "key": pending["key"],
                    "question": pending["question"],
                    "state": "confirmed",
                    "value": "draft",
                    "reviewStatus": "accepted",
                },
                "expectedRevision": pending["revision"],
            },
        )
        self.assertEqual(
            (status, pending_upserted["reviewStatus"], pending_upserted["revision"]),
            (200, "pending", pending["revision"] + 1),
        )

        status, _headers, accepted = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {
                    "question": "Accepted API upsert review boundary?",
                    "state": "confirmed",
                    "value": "canonical",
                }
            },
        )
        self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))
        for attempted_status in ("declined", "pending"):
            status, _headers, accepted = self.request(
                "POST",
                "/api/answers",
                {
                    "answer": {
                        "key": accepted["key"],
                        "question": accepted["question"],
                        "state": "confirmed",
                        "value": attempted_status,
                        "reviewStatus": attempted_status,
                    },
                    "expectedRevision": accepted["revision"],
                },
            )
            self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))

            status, _headers, rejected = self.request(
                "POST",
                "/api/answers",
                {
                    "answer": {
                        "question": f"New API {attempted_status} answer?",
                        "state": "missing",
                        "reviewStatus": attempted_status,
                    }
                },
            )
            self.assertEqual(status, 400, rejected)
            self.assertIn("created through put must have accepted", rejected["error"]["message"])

    def test_resume_projection_redacts_private_file_identity(self):
        source = Path(self.temporary.name) / "private-name.txt"
        source.write_text("private resume content", encoding="utf-8")
        resume = self.server.store.create_resume(
            {"id": "private-resume", "label": "Private", "path": str(source)}
        )
        status, _headers, result = self.request("GET", "/api/resumes", origin=False)
        self.assertEqual(status, 200)
        projected = result["resumes"][0]
        self.assertEqual(projected["id"], resume["id"])
        self.assertEqual(projected["storageKind"], "managed")
        for private_field in ("path", "managedFile", "originalFilename", "digest"):
            self.assertNotIn(private_field, projected)
        serialized = json.dumps(result)
        self.assertNotIn(str(source), serialized)
        self.assertNotIn(source.name, serialized)
        self.assertNotIn("private resume content", serialized)

    def test_resume_upload_lifecycle_content_and_guards_share_canonical_store(self):
        status, _headers, created = self.request(
            "POST", "/api/resumes/import",
            self.upload("browser-private-name.txt", b"browser resume", {"id": "browser-resume", "label": "Browser", "tags": ["primary"]}),
        )
        self.assertEqual(status, 200, created)
        canonical = self.server.store.get_resume("browser-resume")
        self.assertEqual(canonical["storageKind"], "managed")
        self.assertNotEqual(canonical["originalFilename"], "browser-private-name.txt")
        status, headers, content = self.request("GET", "/api/resumes/browser-resume/content", origin=False)
        self.assertEqual((status, content), (200, b"browser resume"))
        header_map = dict(headers)
        self.assertEqual(header_map["Content-Type"], "text/plain; charset=utf-8")
        self.assertEqual(header_map["Cache-Control"], "no-store")
        self.assertEqual(header_map["X-Content-Type-Options"], "nosniff")
        self.assertEqual(header_map["Content-Disposition"], 'inline; filename="resume-browser-resume.txt"')

        status, _headers, patched = self.request("PATCH", "/api/resumes/browser-resume", {"patch": {"label": "Edited", "tags": ["new"]}, "expectedRevision": created["revision"]})
        self.assertEqual((status, patched["label"]), (200, "Edited"))
        status, _headers, body = self.request("PATCH", "/api/resumes/browser-resume", {"patch": {"path": "/tmp/secret.pdf"}, "expectedRevision": patched["revision"]})
        self.assertEqual(status, 400, body)
        status, _headers, replaced = self.request("POST", "/api/resumes/browser-resume/replace", self.upload("replacement.pdf", b"%PDF-1.7\nreplacement", {"expectedRevision": patched["revision"]}))
        self.assertEqual((status, replaced["revision"], replaced["mediaType"]), (200, patched["revision"] + 1, "application/pdf"))
        status, headers, content = self.request("GET", "/api/resumes/browser-resume/content", origin=False)
        self.assertEqual((status, content), (200, b"%PDF-1.7\nreplacement"))
        self.assertTrue(dict(headers)["Content-Disposition"].startswith("inline;"))

        job = self.create_job(resumeId="browser-resume")
        status, _headers, library = self.request("GET", "/api/resumes", origin=False)
        projected = next(item for item in library["resumes"] if item["id"] == "browser-resume")
        self.assertEqual((status, projected["assignedJobCount"], projected["implicitJobCount"]), (200, 1, 0))
        job = self.server.store.update_job(job["id"], {"resumeId": None}, job["revision"])
        status, _headers, detail = self.request("GET", "/api/resumes/browser-resume", origin=False)
        self.assertEqual((status, detail["assignedJobCount"], detail["implicitJobCount"]), (200, 0, 1))
        job = self.server.store.update_job(
            job["id"], {"resumeId": "browser-resume"}, job["revision"]
        )
        status, _headers, body = self.request("POST", "/api/resumes/browser-resume/trash", {"expectedRevision": replaced["revision"]})
        self.assertEqual((status, body["error"]["code"]), (409, "job_reference_blocked"))
        self.server.store.trash_job(job["id"], job["revision"])
        status, _headers, trashed = self.request("POST", "/api/resumes/browser-resume/trash", {"expectedRevision": replaced["revision"]})
        self.assertEqual(status, 200, trashed)
        status, _headers, _body = self.request("GET", "/api/resumes/browser-resume/content", origin=False)
        self.assertEqual(status, 404)
        status, _headers, body = self.request("POST", "/api/resumes/browser-resume/delete", {"expectedRevision": trashed["revision"]})
        self.assertEqual((status, body["error"]["code"]), (409, "job_reference_blocked"))  # trashed job still retains a reference
        self.assertEqual(
            (body["error"]["recordType"], body["error"]["operation"], body["error"]["counts"]),
            ("resume", "delete", {"jobReferences": 1}),
        )
        self.server.store.delete_job(job["id"], job["revision"] + 1)
        status, _headers, restored = self.request("POST", "/api/resumes/browser-resume/restore", {"expectedRevision": trashed["revision"]})
        self.assertEqual(status, 200, restored)

    def test_resume_upload_bounds_strict_base64_auth_and_fail_clean(self):
        invalid = {"metadata": {"label": "Bad"}, "filename": "bad.txt", "content": "%%%"}
        status, _headers, _body = self.request("POST", "/api/resumes/import", invalid)
        self.assertEqual(status, 400)
        status, _headers, _body = self.request("POST", "/api/resumes/import", self.upload("secret.txt", b"secret", {"label": "No auth"}), token=False)
        self.assertEqual(status, 401)
        status, _headers, _body = self.request("POST", "/api/resumes/import", self.upload("secret.txt", b"secret", {"label": "No origin"}), origin=False)
        self.assertEqual(status, 403)
        self.assertEqual(self.server.store.list_resumes(), [])

    def test_post_commit_browser_source_cleanup_failure_still_returns_success(self):
        original_unlink = Path.unlink

        def fail_browser_cleanup(path, *args, **kwargs):
            if path.name.startswith(".browser-upload."):
                raise PermissionError("synthetic cleanup failure")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_browser_cleanup):
            status, _headers, result = self.request(
                "POST", "/api/resumes/import",
                self.upload("private.txt", b"committed", {"id": "cleanup-http", "label": "Cleanup HTTP"}),
            )
        self.assertEqual(status, 200, result)
        self.assertEqual(self.server.store.get_resume("cleanup-http")["id"], "cleanup-http")

    def test_proposal_routes_redact_aggregate_values_and_review_without_retry(self):
        created = self.server.store.create_resume_bytes({"id": "proposal-resume", "label": "Proposal"}, "resume.txt", b"resume")
        profile = self.server.store.patch_profile(
            {"firstName": "Grace", "location": {"city": "Tempe"}}, 1, "user"
        )
        proposal = self.server.store.create_resume_proposal(
            created["id"], {"firstName": "Ada", "location": {"city": "Phoenix"}}, created["revision"], profile["revision"]
        )
        status, _headers, summaries = self.request("GET", "/api/resume-proposals", origin=False)
        self.assertEqual(status, 200)
        serialized = json.dumps(summaries)
        self.assertNotIn("Ada", serialized); self.assertNotIn("Phoenix", serialized); self.assertNotIn("baselines", serialized)
        unrelated = self.server.store.patch_profile(
            {"lastName": "Unrelated"}, proposal["resultProfileRevision"], "user"
        )
        status, _headers, detail = self.request("GET", f"/api/resume-proposals/{proposal['id']}", origin=False)
        self.assertEqual(status, 200)
        self.assertEqual(detail["candidate"]["firstName"], "Ada")
        self.assertEqual(detail["liveProfileRevision"], unrelated["revision"])
        self.assertNotIn("baselines", detail); self.assertNotIn("resumeDigest", detail)
        status, _headers, reviewed = self.request("POST", f"/api/resume-proposals/{proposal['id']}/review", {"decisions": {"/firstName": "use_extracted"}, "expectedRevision": proposal["revision"], "expectedProfileRevision": detail["liveProfileRevision"]})
        self.assertEqual(status, 200, reviewed)
        self.assertEqual(self.server.store.inspect_profile()["profile"]["firstName"], "Ada")
        status, _headers, body = self.request("POST", f"/api/resume-proposals/{proposal['id']}/review", {"decisions": {"/location/city": "use_extracted"}, "expectedRevision": proposal["revision"], "expectedProfileRevision": proposal["profileRevision"]})
        self.assertEqual(status, 409, body)

    def test_proposal_detail_discloses_and_review_confirms_replaced_ancestor(self):
        created = self.server.store.create_resume_bytes(
            {"id": "ancestor-proposal", "label": "Ancestor proposal"}, "resume.txt", b"resume"
        )
        profile = self.server.store.patch_profile({"contact": "canonical scalar"}, 1, "user")
        proposal = self.server.store.create_resume_proposal(
            created["id"],
            {"contact": {"email": "synthetic@example.invalid"}},
            created["revision"],
            profile["revision"],
        )
        status, _headers, detail = self.request(
            "GET", f"/api/resume-proposals/{proposal['id']}", origin=False
        )
        self.assertEqual(status, 200)
        self.assertEqual(
            detail["replacementScopes"]["/contact/email"],
            {"path": "/contact", "value": "canonical scalar"},
        )
        review = {
            "decisions": {"/contact/email": "use_extracted"},
            "expectedRevision": proposal["revision"],
            "expectedProfileRevision": profile["revision"],
        }
        status, _headers, refused = self.request(
            "POST", f"/api/resume-proposals/{proposal['id']}/review", review
        )
        self.assertEqual(status, 400, refused)
        self.assertEqual(self.server.store.inspect_profile()["profile"]["contact"], "canonical scalar")
        review["replacementConfirmations"] = {"/contact/email": "/contact"}
        status, _headers, accepted = self.request(
            "POST", f"/api/resume-proposals/{proposal['id']}/review", review
        )
        self.assertEqual(status, 200, accepted)
        self.assertEqual(
            self.server.store.inspect_profile()["profile"]["contact"],
            {"email": "synthetic@example.invalid"},
        )

    def test_profile_api_inspects_and_forces_browser_user_provenance(self):
        seeded = self.server.store.patch_profile(
            {
                "firstName": "Ada",
                "location": {"city": "Phoenix", "country": "US"},
                "futureFact": {"enabled": True},
            },
            expected_revision=1,
            source="resume",
        )
        status, _headers, inspected = self.request("GET", "/api/profile", origin=False)
        self.assertEqual((status, inspected["revision"]), (200, seeded["revision"]))
        status, _headers, updated = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"location": {"city": "Tempe"}},
                "expectedRevision": inspected["revision"],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(updated["profile"]["location"], {"city": "Tempe", "country": "US"})
        self.assertEqual(updated["profile"]["futureFact"], {"enabled": True})
        self.assertEqual(updated["factProvenance"]["/location/city"]["source"], "user")

    def test_profile_api_atomically_replaces_additional_facts_and_separates_deletion(self):
        seeded = self.server.store.patch_profile(
            {"futureFact": {"enabled": True, "keep": "old"}}, 1, "resume"
        )
        status, _headers, replaced = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"futureFact": {"enabled": False}},
                "expectedRevision": seeded["revision"],
                "atomicPaths": ["/futureFact"],
                "deletedPaths": [],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(replaced["profile"]["futureFact"], {"enabled": False})

        status, _headers, stored_null = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"futureFact": None},
                "expectedRevision": replaced["revision"],
                "atomicPaths": ["/futureFact"],
                "deletedPaths": [],
            },
        )
        self.assertEqual(status, 200)
        self.assertIn("futureFact", stored_null["profile"])
        self.assertIsNone(stored_null["profile"]["futureFact"])

        status, _headers, deleted = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"futureFact": None},
                "expectedRevision": stored_null["revision"],
                "atomicPaths": ["/futureFact"],
                "deletedPaths": ["/futureFact"],
            },
        )
        self.assertEqual(status, 200)
        self.assertNotIn("futureFact", deleted["profile"])

    def test_profile_api_rejects_bad_shape_stale_revision_and_wrong_origin(self):
        current = self.server.store.inspect_profile()
        probes = (
            ({"patch": {}, "expectedRevision": current["revision"]}, True, 400),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": True}, True, 400),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": current["revision"], "source": "agent"}, True, 400),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": current["revision"]}, False, 403),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": current["revision"], "atomicPaths": ["/firstName"]}, True, 400),
            ({"patch": {"futureFact": None}, "expectedRevision": current["revision"], "deletedPaths": ["/futureFact"]}, True, 400),
        )
        for payload, origin, expected_status in probes:
            with self.subTest(payload=set(payload), origin=origin):
                status, _headers, _body = self.request("PATCH", "/api/profile", payload, origin=origin)
                self.assertEqual(status, expected_status)
        advanced = self.server.store.patch_profile(
            {"firstName": "Grace"}, current["revision"], "agent"
        )
        status, _headers, body = self.request(
            "PATCH",
            "/api/profile",
            {"patch": {"lastName": "Hopper"}, "expectedRevision": current["revision"]},
        )
        self.assertEqual((status, body["error"]["code"]), (409, "revision_conflict"))
        self.assertEqual(self.server.store.inspect_profile()["revision"], advanced["revision"])

    def test_fact_group_api_has_browser_cli_crud_parity_without_mutating_profile(self):
        profile = self.server.store.patch_profile(
            {"firstName": "Synthetic", "skills": ["Python"]}, 1, "user"
        )
        status, _headers, created = self.request(
            "POST",
            "/api/fact-groups",
            {"group": {"label": "Core facts", "paths": ["/firstName", "/skills"], "order": 10}},
        )
        self.assertEqual(status, 200, created)
        status, _headers, listing = self.request("GET", "/api/fact-groups", origin=False)
        self.assertEqual((status, listing["groups"]), (200, [created]))
        self.assertEqual(self.server.store.get_fact_group(created["id"]), created)

        status, _headers, updated = self.request(
            "PATCH",
            f"/api/fact-groups/{created['id']}",
            {"patch": {"label": "Focused facts", "paths": ["/skills"], "order": 20}, "expectedRevision": created["revision"]},
        )
        self.assertEqual((status, updated["revision"]), (200, 2))
        status, _headers, conflict = self.request(
            "PATCH",
            f"/api/fact-groups/{created['id']}",
            {"patch": {"label": "Stale"}, "expectedRevision": created["revision"]},
        )
        self.assertEqual((status, conflict["error"]["code"]), (409, "revision_conflict"))
        status, _headers, deleted = self.request(
            "POST",
            f"/api/fact-groups/{created['id']}/delete",
            {"expectedRevision": updated["revision"]},
        )
        self.assertEqual((status, deleted), (200, {"deleted": True, "id": created["id"]}))
        self.assertEqual(self.server.store.inspect_profile(), profile)

    def test_revision_conflict_is_409_and_never_overwrites_canonical_data(self):
        job = self.create_job(role="Original")
        cli = self.server.store.update_job(job["id"], {"role": "CLI edit"}, job["revision"])
        status, _headers, body = self.request("PATCH", f"/api/jobs/{job['id']}", {"patch": {"role": "stale UI edit"}, "expectedRevision": job["revision"]})
        self.assertEqual((status, body["error"]["code"]), (409, "revision_conflict"))
        self.assertEqual(self.server.store.get_job(job["id"])["role"], "CLI edit")
        self.assertEqual(self.server.store.get_job(job["id"])["revision"], cli["revision"])

    def test_mutations_reject_invalid_revision_and_transition_types(self):
        job = self.create_job(role="Original")
        probes = (
            ("PATCH", f"/api/jobs/{job['id']}", {"patch": {"role": "bad"}, "expectedRevision": True}),
            ("POST", f"/api/jobs/{job['id']}/transition", {"status": [], "expectedRevision": 1}),
            ("POST", f"/api/jobs/{job['id']}/transition", {"status": "closed", "expectedRevision": 1, "closedOutcome": []}),
            ("POST", f"/api/jobs/{job['id']}/transition", {"status": "needs_info", "expectedRevision": 1.0}),
            ("POST", f"/api/jobs/{job['id']}/trash", {"expectedRevision": 1.0}),
        )
        for method, path, payload in probes:
            with self.subTest(method=method, path=path, payload=payload):
                status, _headers, body = self.request(method, path, payload)
                self.assertEqual(status, 400)
                self.assertEqual(body["error"]["code"], "request_error")
        canonical = self.server.store.get_job(job["id"])
        self.assertEqual((canonical["role"], canonical["status"], canonical["revision"]), ("Original", "saved", 1))

    def test_bulk_capture_keeps_valid_items_and_reports_each_failure(self):
        urls = ["https://example.com/good", "not a url", "https://example.com/good"]
        status, _headers, body = self.request("POST", "/api/jobs/bulk", {"urls": urls})
        self.assertEqual(status, 200)
        self.assertEqual([item["ok"] for item in body["results"]], [True, False, False])
        self.assertEqual(len(self.server.store.list_jobs()), 1)

    def test_preflight_resume_assignment_ready_handoff_and_guarded_applied(self):
        self.server.store.replace_profile(
            {"firstName": "Ada"}, expected_revision=1, source="user"
        )
        resume_path = Path(self.temporary.name) / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
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
        status, _headers, closed = self.request("POST", f"/api/jobs/{job['id']}/transition", {"status": "closed", "closedOutcome": "withdrawn", "expectedRevision": ready["revision"]})
        self.assertEqual((status, closed["status"], closed["closedOutcome"]), (200, "closed", "withdrawn"))

    def test_attention_api_is_authenticated_canonical_and_privacy_minimized(self):
        job = self.create_job(
            url="https://example.com/jobs/attention-api",
            id="attention-api",
            role="Platform Engineer",
            company="Acme",
            priority=4,
        )
        needs = self.server.store.transition_job(
            job["id"], "needs_info", job["revision"]
        )
        status, _headers, body = self.request(
            "GET", "/api/attention", token=False, origin=False
        )
        self.assertEqual((status, body["error"]["code"]), (401, "token_rejected"))
        status, _headers, projection = self.request(
            "GET", "/api/attention", origin=False
        )
        self.assertEqual(status, 200)
        self.assertRegex(projection["snapshotSignature"], r"^[0-9a-f]{64}$")
        self.assertEqual(len(projection["items"]), 1)
        row = projection["items"][0]
        self.assertEqual(
            (row["jobId"], row["reasonCode"], row["revision"]),
            (needs["id"], "needs_information", needs["revision"]),
        )
        self.assertEqual(set(row), {
            "jobId", "role", "company", "status", "revision", "priority",
            "reasonCode", "reasonLabel", "attentionAt", "guidance",
            "missingInformationCount",
        })
        self.server.store.transition_job(job["id"], "saved", needs["revision"])
        status, _headers, resolved = self.request(
            "GET", "/api/attention", origin=False
        )
        self.assertEqual((status, resolved["items"]), (200, []))
        self.assertNotEqual(
            projection["snapshotSignature"], resolved["snapshotSignature"]
        )

    def test_job_trash_restore_and_delete_routes_share_exact_revisions(self):
        job = self.create_job()
        status, _headers, trashed = self.request("POST", f"/api/jobs/{job['id']}/trash", {"expectedRevision": job["revision"]})
        self.assertEqual(status, 200)
        self.assertIsNotNone(trashed["deletedAt"])
        self.assertIsNone(self.server.store.get_job(job["id"]))
        status, _headers, restored = self.request("POST", f"/api/jobs/{job['id']}/restore", {"expectedRevision": trashed["revision"]})
        self.assertEqual((status, restored["deletedAt"]), (200, None))
        status, _headers, stale = self.request("POST", f"/api/jobs/{job['id']}/trash", {"expectedRevision": trashed["revision"]})
        self.assertEqual((status, stale["error"]["code"]), (409, "revision_conflict"))
        status, _headers, trashed = self.request("POST", f"/api/jobs/{job['id']}/trash", {"expectedRevision": restored["revision"]})
        self.assertEqual(status, 200)
        status, _headers, deleted = self.request("POST", f"/api/jobs/{job['id']}/delete", {"expectedRevision": trashed["revision"]})
        self.assertEqual((status, deleted), (200, {"deleted": True, "id": job["id"]}))


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

    def test_launcher_uses_canonical_store_environment_variable(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary) / "home"
            store = Path(temporary) / "configured-store"
            home.mkdir()
            environment = os.environ.copy()
            environment["HOME"] = str(home)
            environment[WORKSPACE.STORE_MODULE.STORE_ENV] = str(store)
            environment.pop("JOB_APPLY_STORE", None)
            process = subprocess.Popen(
                [sys.executable, str(ROOT / "scripts" / "job-apply-workspace.py"), "--port", "0", "--no-open", "--json"],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=environment,
                creationflags=(subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0),
            )
            try:
                details = json.loads(process.stdout.readline())
                self.assertEqual(details["host"], "127.0.0.1")
                self.assertTrue((store / "jobs.json").is_file())
                self.assertFalse((home / ".job-apply").exists())
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
