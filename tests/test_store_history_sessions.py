from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_history_is_minimal_parseable_and_rejects_answer_values(self):
        answer = self.store.put_answer(
            {"key": "work_authorization.us", "state": "missing"}
        )
        event = self.store.append_history(
            {
                "applicationId": "acme-role-1",
                "event": "started",
                "company": "Acme",
                "role": "Engineer",
                "answerKeys": ["work_authorization.us"],
            }
        )
        self.assertEqual(event["answerKeys"], [answer["key"]])
        parsed = self.store.read_history()
        self.assertEqual(len(parsed), 1)
        self.assertNotIn("value", parsed[0])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.append_history(
                {
                    "applicationId": "acme-role-1",
                    "event": "progressed",
                    "answerValue": "secret",
                }
            )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.append_history(
                {
                    "applicationId": "acme-role-1",
                    "event": "progressed",
                    "company": {"answerValue": "private"},
                }
            )

    def test_tampered_history_fails_closed(self):
        self.store.initialize()
        self.store.history_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "eventId": "event-1",
                    "applicationId": "acme-role-1",
                    "event": "started",
                    "answerKeys": [],
                    "company": {"value": "private"},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.read_history()

    def test_future_value_free_history_reads_without_mutation_but_writes_stay_strict(self):
        self.store.initialize()
        self.store.claim_status()
        future_event = {
            "schemaVersion": 1,
            "eventId": "future-event-1",
            "applicationId": "future-application",
            "event": "future-safe-event",
            "company": "Example",
            "role": "Engineer",
            "ats": "future-ats",
            "status": "future-status",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(future_event) + "\n", encoding="utf-8"
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        reopened = STORE_MODULE.Store(self.root, self.legacy)
        reopened.validate_workspace_startup()
        reopened.initialize()
        self.assertEqual(reopened.get_profile(), {})
        self.assertEqual(reopened.list_jobs(), [])
        self.assertIsNone(reopened.claim_status()["claim"])
        self.assertEqual(reopened.read_history(), [future_event])
        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "type is unsupported"):
            reopened.append_history(
                {
                    "applicationId": "future-application",
                    "event": "future-safe-event",
                    "answerKeys": [],
                }
            )

    def test_unknown_history_event_is_inert_for_replay_semantics(self):
        self.store.initialize()
        future_event = {
            "schemaVersion": 1,
            "eventId": "future-event-2",
            "applicationId": "qa-future-event",
            "event": "future-terminal-looking-event",
            "ats": "different-future-ats",
            "status": "completed",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(future_event) + "\n", encoding="utf-8"
        )

        result = self.store.record_replay_transition(
            "qa-future-event", "started", "greenhouse"
        )

        self.assertTrue(result["changed"])
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["future-terminal-looking-event", "started"],
        )

    def test_history_event_idempotence_requires_the_complete_exact_record(self):
        self.store.initialize()
        event = {
            "schemaVersion": 1,
            "eventId": "exact-known-event",
            "applicationId": "exact-application",
            "event": "reviewed",
            "status": "review",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(event, sort_keys=True) + "\n", encoding="utf-8"
        )
        before = self.store.history_path.read_bytes()

        self.store._append_history_event_idempotent_locked(dict(event))
        self.assertEqual(self.store.history_path.read_bytes(), before)

        for different in (
            {**event, "status": "completed"},
            {**event, "event": "started"},
        ):
            with self.subTest(different=different):
                with self.assertRaisesRegex(
                    STORE_MODULE.StoreError, "history event id collision"
                ):
                    self.store._append_history_event_idempotent_locked(different)
                self.assertEqual(self.store.history_path.read_bytes(), before)

    def test_unknown_event_id_collision_blocks_acquisition_before_any_mutation(self):
        ready = self._make_ready_job()
        self.store.claim_status()
        unknown = {
            "schemaVersion": 1,
            "eventId": "coordinator-operation-fixed",
            "applicationId": ready["id"],
            "event": "future-safe-event",
            "status": "future-status",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(unknown) + "\n", encoding="utf-8"
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        with mock.patch.object(
            STORE_MODULE.uuid,
            "uuid4",
            side_effect=["claim-fixed", "operation-fixed"],
        ):
            with self.assertRaisesRegex(
                STORE_MODULE.StoreError, "history event id collision"
            ):
                self.store.acquire_ready_job(
                    ready["id"], "collision-agent", ready["revision"]
                )

        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)
        self.assertEqual(self.store.get_job(ready["id"]), ready)
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_pending_coordinator_collision_fails_before_roll_forward_mutation(self):
        ready = self._make_ready_job()
        self.store.claim_status()
        self.store.save_session(
            "unrelated-session", {"status": "active", "step": "application"}
        )
        now = "2026-08-28T00:00:00Z"
        operation_id = "pending-collision"
        operation = {
            "kind": "acquire",
            "operationId": operation_id,
            "jobId": ready["id"],
            "sourceStatus": "ready",
            "targetStatus": "in_progress",
            "expectedRevision": ready["revision"],
            "at": now,
            "historyEvent": self.store._history_event_for_operation(
                operation_id, ready, "job-started", "in_progress", now
            ),
            "resultClaim": {
                "claimId": "pending-claim",
                "jobId": ready["id"],
                "ownerLabel": "collision-agent",
                "tokenHash": "a" * 64,
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": "2026-08-28T00:05:00Z",
            },
        }
        unknown = {
            "schemaVersion": 1,
            "eventId": operation["historyEvent"]["eventId"],
            "applicationId": ready["id"],
            "event": "future-safe-event",
            "status": "future-status",
            "answerKeys": [],
            "at": now,
        }
        self.store.history_path.write_text(
            json.dumps(unknown) + "\n", encoding="utf-8"
        )
        STORE_MODULE.atomic_write_json(
            self.store.coordinator_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        reopened = STORE_MODULE.Store(self.root, self.legacy)
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "history event id collision"
        ):
            reopened.initialize()

        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)

    def test_unknown_history_events_still_reject_unsafe_or_private_shapes(self):
        self.store.initialize()
        valid = {
            "schemaVersion": 1,
            "eventId": "future-event-3",
            "applicationId": "future-application",
            "event": "future-safe-event",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        invalid_cases = {
            "boolean schema": {**valid, "schemaVersion": True},
            "future schema": {**valid, "schemaVersion": 2},
            "extra credential": {**valid, "password": "private"},
            "nested private value": {**valid, "company": {"value": "private"}},
            "invalid answer references": {**valid, "answerKeys": [{"key": "private"}]},
            "missing event identity": {
                key: value for key, value in valid.items() if key != "eventId"
            },
            "empty event identity": {**valid, "eventId": ""},
            "missing audit timestamp": {
                key: value for key, value in valid.items() if key != "at"
            },
            "empty audit timestamp": {**valid, "at": ""},
            "missing answer references": {
                key: value for key, value in valid.items() if key != "answerKeys"
            },
            "uppercase identifier": {**valid, "event": "Future-Event"},
            "unicode identifier": {**valid, "event": "futuré-event"},
            "overlong identifier": {**valid, "event": "f" * 65},
        }
        for label, event in invalid_cases.items():
            with self.subTest(label=label):
                self.store.history_path.write_text(
                    json.dumps(event) + "\n", encoding="utf-8"
                )
                with self.assertRaises(STORE_MODULE.StoreError):
                    self.store.read_history()

    def test_replay_transitions_are_ordered_idempotent_and_value_free(self):
        application_id = "qa-run-20260815-1234abcd"
        started = self.store.record_replay_transition(
            application_id, "started", "greenhouse"
        )
        repeated = self.store.record_replay_transition(
            application_id, "started", "greenhouse"
        )
        reviewed = self.store.record_replay_transition(
            application_id, "reviewed", "greenhouse"
        )
        reviewed_again = self.store.record_replay_transition(
            application_id, "reviewed", "greenhouse"
        )

        self.assertTrue(started["changed"])
        self.assertFalse(repeated["changed"])
        self.assertTrue(reviewed["changed"])
        self.assertFalse(reviewed_again["changed"])
        history = self.store.read_history()
        self.assertEqual([event["event"] for event in history], ["started", "reviewed"])
        self.assertTrue(all(event["answerKeys"] == [] for event in history))
        session = self.store.load_session(application_id)
        self.assertEqual(session["status"], "review")
        self.assertEqual(session["step"], "review")
        serialized = json.dumps({"history": history, "session": session})
        for forbidden in ("http://", "https://", "routeToken", "resumePath", "value"):
            self.assertNotIn(forbidden, serialized)

    def test_ashby_replay_transitions_are_supported_and_value_free(self):
        application_id = "qa-run-20260815-5678abcd"
        self.store.record_replay_transition(application_id, "started", "ashby")
        self.store.record_replay_transition(application_id, "reviewed", "ashby")
        history = self.store.read_history()
        session = self.store.load_session(application_id)
        self.assertEqual([event["ats"] for event in history], ["ashby", "ashby"])
        self.assertEqual((session["ats"], session["status"]), ("ashby", "review"))
        self.assertNotIn("value", json.dumps({"history": history, "session": session}))

    def test_lever_replay_transitions_are_supported_and_value_free(self):
        application_id = "qa-run-20260816-5678abcd"
        self.store.record_replay_transition(application_id, "started", "lever")
        self.store.record_replay_transition(application_id, "reviewed", "lever")
        history = self.store.read_history()
        session = self.store.load_session(application_id)
        self.assertEqual([event["ats"] for event in history], ["lever", "lever"])
        self.assertEqual((session["ats"], session["status"]), ("lever", "review"))
        serialized = json.dumps({"history": history, "session": session})
        self.assertNotIn("value", serialized)
        self.assertNotIn("http", serialized)

    def test_replay_review_requires_started_and_rejects_terminal_or_mismatched_ats(self):
        application_id = "qa-run-20260815-1234abcd"
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "has not started"):
            self.store.record_replay_transition(
                application_id, "reviewed", "linkedin-easy-apply"
            )

        self.store.record_replay_transition(
            application_id, "started", "linkedin-easy-apply"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "ATS does not match"):
            self.store.record_replay_transition(
                application_id, "reviewed", "greenhouse"
            )
        self.store.append_history(
            {
                "applicationId": application_id,
                "event": "abandoned",
                "ats": "linkedin-easy-apply",
                "answerKeys": [],
            }
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "terminal"):
            self.store.record_replay_transition(
                application_id, "reviewed", "linkedin-easy-apply"
            )

    def test_session_round_trip_rejects_values_and_path_traversal(self):
        session = self.store.save_session(
            "acme-role-1",
            {
                "status": "active",
                "ats": "greenhouse",
                "step": "questions",
                "answerKeys": ["work_authorization.us"],
                "pendingFields": [
                    {
                        "question": "Salary expectation?",
                        "state": "sensitive",
                        "answerKey": "salary.expectation",
                        "sensitive": True,
                    }
                ],
            },
        )
        loaded = self.store.load_session("acme-role-1")
        self.assertEqual(loaded["updatedAt"], session["updatedAt"])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.save_session(
                "acme-role-2",
                {
                    "pendingFields": [
                        {"question": "Salary?", "state": "sensitive", "value": "250K"}
                    ]
                },
            )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.load_session("../profile")

    def test_tampered_session_fails_closed(self):
        self.store.initialize()
        path = self.store.sessions_path / "acme-role-1.json"
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "applicationId": "acme-role-1",
                    "status": "active",
                    "answerKeys": [],
                    "pendingFields": [],
                    "company": {"value": "private"},
                    "createdAt": "2026-07-18T00:00:00Z",
                    "updatedAt": "2026-07-18T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.load_session("acme-role-1")
