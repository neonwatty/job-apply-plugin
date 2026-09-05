from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
    def test_automation_api_is_authenticated_editable_revisioned_and_fail_closed(self):
        status, _headers, rejected = self.request("GET", "/api/automation", token=False, origin=False)
        self.assertEqual((status, rejected["error"]["code"]), (401, "token_rejected"))
        status, _headers, projection = self.request("GET", "/api/automation", origin=False)
        self.assertEqual(status, 200)
        self.assertFalse(projection["capability"]["credentialOperationsReady"])
        account_flow = projection["capability"]["accountFlowAutomation"]
        expected_macos = sys.platform.startswith("darwin")
        self.assertEqual(account_flow["productionSeamReady"], expected_macos)
        self.assertFalse(account_flow["liveExecutionEnabled"])
        self.assertEqual(account_flow["workdayPasswordAccountReady"], expected_macos)
        self.assertEqual(account_flow["greenhouseAccountlessClassificationReady"], expected_macos)
        self.assertNotIn("signupEmail", projection["settings"])

        status, _headers, updated = self.request(
            "PATCH", "/api/automation/settings",
            {"patch": {"enabled": True, "signupEmail": "owner@example.com"}, "expectedRevision": 1},
        )
        self.assertEqual(status, 200)
        self.assertTrue(updated["signupEmailConfigured"])
        self.assertNotIn("signupEmail", updated)
        status, _headers, conflict = self.request(
            "PATCH", "/api/automation/settings",
            {"patch": {"enabled": False}, "expectedRevision": 1},
        )
        self.assertEqual((status, conflict["error"]["code"]), (409, "revision_conflict"))

        status, _headers, unresolved = self.request(
            "POST", "/api/automation/realm-resolve", {"url": "https://jobs.example.com/acme/1"}
        )
        self.assertEqual((status, unresolved["status"]), (200, "unresolved"))
        for rejected_url in (
            "https://person@acme.wd5.myworkdayjobs.com/jobs/one",
            "https://acme.wd5.myworkdayjobs.com/jobs/one?access_token=",
            "https://wd5.myworkday.com/wday/authgwy/acme/login.htmld",
        ):
            status, _headers, rejected_realm = self.request(
                "POST", "/api/automation/realm-resolve", {"url": rejected_url}
            )
            self.assertEqual((status, rejected_realm["status"]), (200, "unresolved"))
        status, _headers, rejected = self.request(
            "POST", "/api/employer-accounts", {"url": "https://jobs.example.com/acme/1"}
        )
        self.assertEqual(status, 400)
        self.assertNotIn("jobs.example.com", json.dumps(rejected))

        status, _headers, account = self.request(
            "POST", "/api/employer-accounts",
            {"url": "https://acme.wd5.myworkdayjobs.com/en-US/jobs/one", "signupEmailOverride": "realm@example.com"},
        )
        self.assertEqual(status, 200)
        self.assertNotIn("descriptor", account)
        self.assertNotIn("signupEmailOverride", account)
        self.assertNotIn("credentialRef", account)
        self.assertFalse(account["providerAssigned"])
        status, _headers, changed = self.request(
            "PATCH", f"/api/employer-accounts/{account['realmRef']}",
            {"patch": {"signupEmailOverride": "replacement@example.com"}, "expectedRevision": account["revision"]},
        )
        self.assertEqual((status, changed["revision"], changed["signupEmailOverrideConfigured"]), (200, 2, True))
        self.assertNotIn("replacement@example.com", json.dumps(changed))
        status, _headers, stale = self.request(
            "PATCH", f"/api/employer-accounts/{account['realmRef']}",
            {"patch": {"signupEmailOverride": None}, "expectedRevision": account["revision"]},
        )
        self.assertEqual((status, stale["error"]["code"]), (409, "revision_conflict"))
        status, _headers, refreshed = self.request("GET", "/api/automation", origin=False)
        self.assertEqual(len(refreshed["accounts"]), 1)
        self.assertTrue(refreshed["settings"]["signupEmailConfigured"])
        self.assertNotIn("signupEmail", refreshed["settings"])
        self.assertNotIn("signupEmailOverride", refreshed["accounts"][0])
        self.assertTrue(refreshed["accounts"][0]["signupEmailOverrideConfigured"])
        self.assertNotIn("replacement@example.com", json.dumps(refreshed))
        self.assertNotIn("credentialRef", json.dumps(refreshed))

    def test_automation_mutations_reject_credential_shaped_fields(self):
        for payload in (
            {"patch": {"token": None}, "expectedRevision": 1},
            {"patch": {"credentialRef": None}, "expectedRevision": 1},
        ):
            status, _headers, body = self.request("PATCH", "/api/automation/settings", payload)
            self.assertEqual(status, 400)
            self.assertNotIn("value", json.dumps(body))

    def test_automation_can_copy_profile_email_once_without_returning_it(self):
        self.server.store.replace_profile({"email": "private@example.invalid"}, 1, "user")
        status, _headers, projection = self.request("GET", "/api/automation", origin=False)
        self.assertEqual(status, 200)
        status, _headers, copied = self.request(
            "POST", "/api/automation/settings/copy-profile-email",
            {"expectedProfileRevision": projection["profileRevision"],
             "expectedSettingsRevision": projection["settings"]["revision"]},
        )
        self.assertEqual(status, 200)
        self.assertTrue(copied["signupEmailConfigured"])
        self.assertNotIn("signupEmail", copied)
        self.assertNotIn("private", json.dumps(copied))
        status, _headers, conflict = self.request(
            "POST", "/api/automation/settings/copy-profile-email",
            {"expectedProfileRevision": projection["profileRevision"],
             "expectedSettingsRevision": projection["settings"]["revision"]},
        )
        self.assertEqual((status, conflict["error"]["code"]), (409, "revision_conflict"))
        status, _headers, body = self.request(
            "POST", "/api/employer-accounts",
            {"url": "https://acme.wd5.myworkdayjobs.com/jobs/one", "credential": None},
        )
        self.assertEqual(status, 400)
        self.assertNotIn("credential", json.dumps(body))

    def test_account_operation_status_and_recovery_are_redacted_and_revision_safe(self):
        status, _headers, idle = self.request("GET", "/api/account-operation", origin=False)
        self.assertEqual((status, idle), (200, {"status": "idle", "operation": None}))
        status, _headers, recovered = self.request("POST", "/api/account-operation/recover", {})
        self.assertEqual((status, recovered), (200, {"status": "idle", "recovered": False}))
        status, _headers, rejected = self.request(
            "POST", "/api/account-operation/recover", {"credential": None}
        )
        self.assertEqual(status, 400)
        self.assertNotIn("credential", json.dumps(rejected))

    def test_trusted_fill_api_is_redacted_revisioned_and_denies_to_attention(self):
        resume_path = Path(self.temporary.name) / "trusted-fill.txt"
        resume_path.write_text("Synthetic resume", encoding="utf-8")
        self.server.store.replace_profile({"firstName": "Synthetic"}, 1, "user")
        resume = self.server.store.create_resume({"id": "api-trusted-resume", "label": "Synthetic", "path": str(resume_path)})
        job = self.server.store.create_job({
            "id": "api-trusted-job", "url": "https://acme.wd5.myworkdayjobs.com/jobs/one",
            "role": "Engineer", "company": "Synthetic", "resumeId": resume["id"],
        })
        ready = self.server.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.server.store.acquire_ready_job(job["id"], "workspace-test", ready["revision"])
        realm = self.server.store.resolve_account_realm(job["url"])
        fingerprint = lambda char: "sha256:" + char * 64
        packet = {
            "jobId": job["id"], "expectedJobRevision": acquired["job"]["revision"],
            "realmRef": realm["realmRef"], "answerRefs": [],
            "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"), "formFingerprint": fingerprint("3"),
            "allowedOperations": ["fill_text"], "durationMinutes": 30,
        }
        status, _headers, approval = self.request("POST", "/api/trusted-fill/approve", packet)
        self.assertEqual((status, approval["status"], approval["approvalRevision"]), (200, "active", 1))
        self.assertNotIn(job["url"], json.dumps(approval))
        status, _headers, loaded = self.request("GET", f"/api/trusted-fill/{job['id']}", origin=False)
        self.assertEqual((status, loaded), (200, approval))
        canonical_resume = self.server.store.get_resume(resume["id"])
        self.assertNotIn("contentRevision", json.dumps(approval))
        (self.server.store.resume_files_path / canonical_resume["managedFile"]).write_bytes(
            b"Deterministic workspace resume drift"
        )
        evaluation = {
            "jobId": job["id"], "expectedApprovalRevision": 1,
            "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"), "formFingerprint": fingerprint("3"),
            "fieldOperations": ["fill_text"], "authenticationRequired": False,
            "consentRequired": False, "credentialFieldsPresent": False,
            "finalControlsPresent": False, "unseenQuestions": False, "unseenControls": False,
        }
        status, _headers, denied = self.request("POST", "/api/trusted-fill/evaluate", evaluation)
        self.assertEqual((status, denied["authorized"], denied["reasonCode"], denied["attentionHandoff"]), (200, False, "resume_content_changed", True))
        self.assertNotIn(acquired["token"], json.dumps(denied))
        status, _headers, attention = self.request("GET", "/api/attention", origin=False)
        self.assertEqual((status, attention["items"][0]["jobId"]), (200, job["id"]))

    def test_trusted_fill_revoke_api_uses_exact_approval_revision(self):
        status, _headers, missing = self.request("GET", "/api/trusted-fill/missing-job", origin=False)
        self.assertEqual((status, missing), (200, {"status": "missing", "approvalRevision": None}))
