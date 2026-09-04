from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
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
        self.assertEqual(activity["session"]["pendingInformation"][0] | {"reference": "opaque"}, {
            "state": "missing", "sensitive": True,
            "reference": "opaque", "resolutionEligible": False,
        })
        self.assertRegex(
            activity["session"]["pendingInformation"][0]["reference"],
            r"^pending_[a-f0-9]{32}$",
        )
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

    def test_pending_answer_route_uses_opaque_durable_reference_not_question_text(self):
        self.server.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.server.store.inspect_profile()["revision"],
            source="user",
        )
        resume_path = Path(self.temporary.name) / "pending-answer.pdf"
        resume_path.write_bytes(b"%PDF-1.7\npending-answer")
        self.server.store.create_resume(
            {"id": "pending-answer-resume", "label": "Pending", "path": str(resume_path)}
        )
        job = self.create_job(
            "https://example.com/jobs/pending-answer", role="Pending", company="Acme"
        )
        ready = self.server.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.server.store.acquire_ready_job(job["id"], "owner", ready["revision"])
        pending = {
            "status": "active", "step": "questions", "answerKeys": [],
            "pendingFields": [{
                "question": "Same visible wording?", "state": "missing",
                "answerKey": "durable.target", "sensitive": False,
            }],
        }
        self.server.store.save_claim_progress(job["id"], acquired["token"], pending)
        self.server.store.handoff_claimed_job(
            job["id"], acquired["token"], "needs_info", pending,
            acquired["job"]["revision"],
        )
        self.server.store.put_answer({
            "key": "durable.decoy", "question": "Same visible wording?",
            "scope": {"decoy": True}, "state": "confirmed", "value": "wrong",
        })
        target = self.server.store.put_answer({
            "key": "durable.target", "question": "Canonical target wording",
            "state": "missing",
        })
        activity = self.server.store.get_job_activity(job["id"])
        reference = activity["session"]["pendingInformation"][0]["reference"]
        self.assertNotIn("durable", reference)
        route = f"/api/jobs/{job['id']}/pending-answers/{quote(reference, safe='')}"
        status, _headers, detail = self.request("GET", route, origin=False)
        self.assertEqual((status, detail["key"], detail["revision"]), (200, target["key"], target["revision"]))
        status, _headers, unauthorized = self.request(
            "GET", route, token=False, origin=False
        )
        self.assertEqual((status, unauthorized["error"]["code"]), (401, "token_rejected"))
        status, _headers, stale = self.request(
            "GET", f"/api/jobs/{job['id']}/pending-answers/pending_{'0' * 32}",
            origin=False,
        )
        self.assertEqual((status, stale["error"]["code"]), (409, "stale_conflict"))

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
            "jobId", "status", "revision", "priority",
            "reasonCode", "reasonLabel", "attentionAt", "guidance",
            "missingInformationCount", "sessionRevision", "session",
        })
        self.assertNotIn("role", row)
        self.assertNotIn("company", row)
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
