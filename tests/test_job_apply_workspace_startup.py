from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
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

    def test_owner_beta_incomplete_future_history_enters_degraded_recovery_without_mutation(self):
        valid = {
            "schemaVersion": 1,
            "eventId": "future-workspace-event",
            "applicationId": "future-workspace-job",
            "event": "future-safe-event",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        invalid_events = (
            {**valid, "schemaVersion": True},
            {key: value for key, value in valid.items() if key != "eventId"},
            {**valid, "eventId": ""},
            {key: value for key, value in valid.items() if key != "at"},
            {**valid, "at": ""},
            {key: value for key, value in valid.items() if key != "answerKeys"},
        )

        for index, event in enumerate(invalid_events):
            with self.subTest(event=event):
                degraded_root = Path(self.temporary.name) / f"incomplete-history-{index}"
                store = WORKSPACE.STORE_MODULE.Store(degraded_root)
                store.initialize()
                store.claim_status()
                history_path = store.history_path
                history_path.write_text(json.dumps(event) + "\n", encoding="utf-8")
                before = {
                    path.relative_to(degraded_root): path.read_bytes()
                    for path in degraded_root.rglob("*")
                    if path.is_file()
                }

                server = WORKSPACE.WorkspaceServer(
                    degraded_root, 0, token=f"incomplete-history-token-{index}"
                )
                try:
                    self.assertEqual(
                        (server.boot_status["status"], server.boot_status["code"]),
                        ("degraded", "corrupt_store"),
                    )
                    after = {
                        path.relative_to(degraded_root): path.read_bytes()
                        for path in degraded_root.rglob("*")
                        if path.is_file()
                    }
                    self.assertEqual(after, before)
                finally:
                    server.server_close()

    def test_owner_beta_pending_coordinator_history_repair_starts_ready(self):
        recovery_root = Path(self.temporary.name) / "pending-history-recovery"
        store = WORKSPACE.STORE_MODULE.Store(recovery_root)
        store.initialize()
        store.replace_profile(
            {"firstName": "Ada"}, expected_revision=1, source="user"
        )
        resume_path = Path(self.temporary.name) / "recovery-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nrecovery")
        resume = store.create_resume(
            {"id": "recovery", "label": "Recovery", "path": str(resume_path)}
        )
        job = store.create_job({
            "id": "recovery-job",
            "url": "https://example.com/jobs/recovery",
            "resumeId": resume["id"],
        })
        ready = store.transition_job(job["id"], "ready", job["revision"])

        def append_partial_then_crash(event):
            encoded = (
                json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            descriptor = os.open(
                store.history_path,
                os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                0o600,
            )
            try:
                os.write(descriptor, encoded[: len(encoded) // 2])
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            raise OSError("simulated process crash after partial append")

        with mock.patch.object(
            store,
            "_append_history_event_idempotent_locked",
            side_effect=append_partial_then_crash,
        ):
            with self.assertRaisesRegex(OSError, "partial append"):
                store.acquire_ready_job(job["id"], "codex", ready["revision"])

        self.assertFalse(store.history_path.read_bytes().endswith(b"\n"))
        server = WORKSPACE.WorkspaceServer(
            recovery_root, 0, token="pending-history-recovery-token"
        )
        try:
            self.assertEqual(server.boot_status, {"status": "ready", "code": "ready"})
            self.assertEqual(server.store.get_job(job["id"])["status"], "in_progress")
            self.assertEqual(
                [event["event"] for event in server.store.read_history()],
                ["job-started"],
            )
            self.assertIsNone(
                server.store._load_coordinator_journal()["operation"]
            )
        finally:
            server.server_close()

    def test_owner_beta_pending_answer_merge_with_malformed_history_degrades_without_mutation(self):
        recovery_root = Path(self.temporary.name) / "pending-answer-merge"
        store = WORKSPACE.STORE_MODULE.Store(recovery_root)
        store.initialize()
        store.claim_status()
        winner = store.put_answer({
            "question": "Canonical availability?",
            "state": "confirmed",
            "value": "Yes",
        })
        source = store.put_answer({
            "question": "When can you start?",
            "state": "missing",
        })

        real_atomic_write = WORKSPACE.STORE_MODULE.atomic_write_json

        def interrupt_answer_write(path, payload):
            if path == store.answers_path:
                raise OSError("simulated interrupted answer merge")
            return real_atomic_write(path, payload)

        with mock.patch.object(
            WORKSPACE.STORE_MODULE,
            "atomic_write_json",
            side_effect=interrupt_answer_write,
        ):
            with self.assertRaisesRegex(OSError, "interrupted answer merge"):
                store.merge_answers(
                    winner["key"],
                    source["key"],
                    winner["revision"],
                    source["revision"],
                )

        self.assertEqual(
            store._load_coordinator_journal()["operation"]["kind"],
            "answer_merge",
        )
        store.history_path.write_text('{"schemaVersion":1\n', encoding="utf-8")
        before = {
            path.relative_to(recovery_root): path.read_bytes()
            for path in recovery_root.rglob("*")
            if path.is_file()
        }

        server = WORKSPACE.WorkspaceServer(
            recovery_root, 0, token="pending-answer-merge-token"
        )
        try:
            self.assertEqual(
                (server.boot_status["status"], server.boot_status["code"]),
                ("degraded", "corrupt_store"),
            )
            after = {
                path.relative_to(recovery_root): path.read_bytes()
                for path in recovery_root.rglob("*")
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
