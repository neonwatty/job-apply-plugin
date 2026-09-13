from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
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

    def test_resume_extraction_request_api_is_redacted_and_bounded(self):
        status, _headers, unauthorized = self.request(
            "GET", "/api/resume-extraction-requests", token=False, origin=False
        )
        self.assertEqual((status, unauthorized["error"]["code"]), (401, "token_rejected"))
        resume = self.server.store.create_resume_bytes(
            {"id": "api-request", "label": "API Private Label"},
            "api-private-name.txt", b"api private resume bytes",
        )
        payload = {"resumeId": resume["id"], "expectedResumeRevision": resume["revision"]}
        status, _headers, no_origin = self.request(
            "POST", "/api/resume-extraction-requests", payload, origin=False
        )
        self.assertEqual((status, no_origin["error"]["code"]), (403, "origin_rejected"))
        status, _headers, request = self.request(
            "POST", "/api/resume-extraction-requests", payload
        )
        self.assertEqual((status, request["status"]), (200, "requested"))
        self.assertNotIn("resumeContentRevision", request)
        status, _headers, listing = self.request(
            "GET", "/api/resume-extraction-requests", origin=False
        )
        self.assertEqual((status, listing["requests"]), (200, [request]))
        status, _headers, resumes = self.request("GET", "/api/resumes", origin=False)
        self.assertEqual((status, resumes["resumes"][0]["extractionRequest"]), (200, request))

        for bad in (
            {**payload, "candidate": {"email": "candidate-private@example.invalid"}},
            {**payload, "expectedProfileRevision": 1},
            {"resumeId": resume["id"], "expectedResumeRevision": True},
        ):
            rejected_status, _headers, _body = self.request(
                "POST", "/api/resume-extraction-requests", bad
            )
            self.assertEqual(rejected_status, 400)
        for action in ("complete", "fail", "candidate"):
            rejected_status, _headers, _body = self.request(
                "POST", f"/api/resume-extraction-requests/{request['requestId']}/{action}",
                {"expectedRevision": request["revision"], "candidate": {"secret": "private"}},
            )
            self.assertEqual(rejected_status, 404)
        self.assertEqual(
            self.server.store.get_resume_extraction_request(request["requestId"])["status"],
            "requested",
        )

        status, _headers, cancelled = self.request(
            "POST", f"/api/resume-extraction-requests/{request['requestId']}/cancel",
            {"expectedRevision": request["revision"]},
        )
        self.assertEqual((status, cancelled["status"]), (200, "cancelled"))
        failed_request = self.server.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        failed = self.server.store.fail_resume_extraction_request(
            failed_request["requestId"], "interrupted", failed_request["revision"]
        )
        status, _headers, retried = self.request(
            "POST", f"/api/resume-extraction-requests/{failed['requestId']}/retry",
            {"expectedRevision": failed["revision"], "expectedResumeRevision": resume["revision"]},
        )
        self.assertEqual((status, retried["status"], retried["supersedesRequestId"]),
                         (200, "requested", failed["requestId"]))
        serialized = json.dumps({"listing": listing, "request": request, "retried": retried})
        for forbidden in (
            "api-private-name.txt", "api private resume bytes", "API Private Label",
            resume["digest"], resume["contentRevision"], "candidate-private@example.invalid",
        ):
            self.assertNotIn(forbidden, serialized)

    def test_resume_projection_prefers_same_second_retry_causality(self):
        resume = self.server.store.create_resume_bytes(
            {"id": "same-second-api", "label": "Private Same Second"},
            "private-same-second.txt", b"private same second bytes",
        )
        with (
            mock.patch.object(
                WORKSPACE.STORE_MODULE, "utc_now", return_value="2026-09-03T12:00:00Z"
            ),
            mock.patch.object(
                WORKSPACE.STORE_MODULE.uuid, "uuid4",
                side_effect=["zzzz", "operation-1", "operation-2", "aaaa", "operation-3"],
            ),
        ):
            original = self.server.store.create_resume_extraction_request(
                resume["id"], resume["revision"]
            )
            failed = self.server.store.fail_resume_extraction_request(
                original["requestId"], "interrupted", original["revision"]
            )
            status, _headers, retried = self.request(
                "POST", f"/api/resume-extraction-requests/{failed['requestId']}/retry",
                {"expectedRevision": failed["revision"],
                 "expectedResumeRevision": resume["revision"]},
            )

        self.assertEqual(status, 200)
        self.assertLess(retried["requestId"], failed["requestId"])
        status, _headers, projection = self.request(
            "GET", f"/api/resumes/{resume['id']}", origin=False
        )
        self.assertEqual(status, 200)
        self.assertEqual(projection["extractionRequest"], retried)
        serialized = json.dumps(projection)
        for forbidden in (
            "private-same-second.txt", "private same second bytes", resume["digest"],
            resume["contentRevision"],
        ):
            self.assertNotIn(forbidden, serialized)

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
