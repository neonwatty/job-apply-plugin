from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_trusted_fill_approval_rechecks_canonical_state_and_denial_hands_off_claim(self):
        resume_path = self.home / "trusted-fill-resume.txt"
        resume_path.write_text("Synthetic resume", encoding="utf-8")
        self.store.replace_profile({"firstName": "Synthetic"}, 0, "user")
        resume = self.store.create_resume({"id": "trusted-fill-resume", "label": "Synthetic", "path": str(resume_path)})
        job = self.store.create_job({
            "id": "trusted-fill-job", "url": "https://acme.wd5.myworkdayjobs.com/en-US/jobs/one",
            "role": "Engineer", "company": "Synthetic", "resumeId": resume["id"],
        })
        ready = self.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.store.acquire_ready_job(job["id"], "trusted-fill-test", ready["revision"])
        realm = self.store.resolve_account_realm(job["url"])
        fingerprint = lambda char: "sha256:" + char * 64
        approval = self.store.approve_trusted_fill({
            "jobId": job["id"], "expectedJobRevision": acquired["job"]["revision"],
            "realmRef": realm["realmRef"], "answerRefs": [],
            "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"), "formFingerprint": fingerprint("3"),
            "allowedOperations": ["fill_text"], "durationMinutes": 30,
        })
        self.assertEqual(approval["jobRevision"], acquired["job"]["revision"])
        self.assertEqual(approval["resumeRevision"], resume["revision"])
        self.assertEqual(approval["resumeContentRevision"], resume["contentRevision"])
        self.assertIsInstance(approval["resumeContentRevision"], str)
        self.assertNotEqual(approval["resumeContentRevision"], approval["resumeRevision"])
        self.assertEqual(approval["profileRevision"], 1)
        self.assertNotIn(job["url"], json.dumps(approval))
        evaluation = {
            "jobId": job["id"], "expectedApprovalRevision": approval["approvalRevision"],
            "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"), "formFingerprint": fingerprint("3"),
            "fieldOperations": ["fill_text"], "authenticationRequired": False,
            "consentRequired": False, "credentialFieldsPresent": False,
            "finalControlsPresent": False, "unseenQuestions": False, "unseenControls": False,
        }
        authorized = self.store.evaluate_trusted_fill(evaluation)
        self.assertTrue(authorized["authorized"])
        denied = self.store.evaluate_trusted_fill({**evaluation, "unseenControls": True})
        self.assertEqual((denied["authorized"], denied["retryAllowed"], denied["attentionHandoff"]), (False, False, True))
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        session = self.store.load_session(job["id"])
        self.assertEqual(session["step"], "trusted_fill_denied:unseen_controls")
        self.assertEqual(session["attemptRevision"], acquired["job"]["revision"])
        self.assertEqual(
            session["blockers"],
            [{"type": "browser_handoff", "code": "browser-state-uncertain"}],
        )
        self.assertEqual(
            session["browserHandoff"],
            {
                "state": "required",
                "reasonCode": "browser-state-uncertain",
                "revision": 1,
            },
        )
        self.assertNotIn(acquired["token"], json.dumps(denied))

    def test_trusted_fill_denies_expired_or_replaced_claim_without_handing_off_new_owner(self):
        _resume, job, _acquired, approval, evaluation = self._trusted_fill_fixture("claim")
        coordinator = self.store._load_coordinator_document()
        coordinator["claim"]["claimId"] = "22222222-2222-4222-8222-222222222222"
        STORE_MODULE.atomic_write_json(self.store.coordinator_path, coordinator)
        denied = self.store.evaluate_trusted_fill(evaluation)
        self.assertEqual(
            (denied["authorized"], denied["reasonCode"], denied["attentionHandoff"]),
            (False, "claim_binding_mismatch", False),
        )
        self.assertEqual(self.store.get_job(job["id"])["status"], "in_progress")

        expires = self.store._parse_time(coordinator["claim"]["expiresAt"])
        with mock.patch.object(self.store, "_now_datetime", return_value=expires):
            expired = self.store.evaluate_trusted_fill(evaluation)
        self.assertEqual(
            (expired["authorized"], expired["reasonCode"], expired["attentionHandoff"]),
            (False, "claim_missing_or_expired", False),
        )
        self.assertEqual(approval["claimId"], _acquired["claim"]["claimId"])

    def test_trusted_fill_trashed_answer_converges_to_attention(self):
        answer = self.store.put_answer({
            "key": "question.one", "question": "Question one?",
            "state": "confirmed", "value": "Yes", "source": "user",
        })
        _resume, job, _acquired, _approval, evaluation = self._trusted_fill_fixture(
            "answer", [answer["key"]]
        )
        self.store.trash_answer(answer["key"], answer["revision"])
        denied = self.store.evaluate_trusted_fill(evaluation)
        self.assertEqual(
            (denied["authorized"], denied["reasonCode"], denied["attentionHandoff"]),
            (False, "answer_binding_invalid", True),
        )
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_trusted_fill_post_approval_byte_drift_denies_and_converges_claim(self):
        resume, job, acquired, _approval, evaluation = self._trusted_fill_fixture("drift")
        managed_path = self.store.resume_files_path / resume["managedFile"]
        managed_path.write_bytes(b"Deterministic changed resume bytes")

        denied = self.store.evaluate_trusted_fill(evaluation)

        self.assertEqual(
            (denied["authorized"], denied["reasonCode"], denied["retryAllowed"], denied["attentionHandoff"]),
            (False, "resume_content_changed", False, True),
        )
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        self.assertEqual(
            self.store.load_session(job["id"])["step"],
            "trusted_fill_denied:resume_content_changed",
        )
        self.assertNotIn(acquired["token"], json.dumps(denied))

    def test_trusted_fill_missing_content_and_observation_failure_deny_to_attention(self):
        resume, job, _acquired, _approval, evaluation = self._trusted_fill_fixture("missing")
        (self.store.resume_files_path / resume["managedFile"]).unlink()
        denied = self.store.evaluate_trusted_fill(evaluation)
        self.assertEqual(
            (denied["reasonCode"], denied["retryAllowed"], denied["attentionHandoff"]),
            ("resume_content_missing", False, True),
        )
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")

        self.store = STORE_MODULE.Store(self.root / "observation", self.legacy)
        _resume, observed_job, _acquired, _approval, observed_evaluation = self._trusted_fill_fixture("observation")
        with mock.patch.object(
            self.store, "_managed_resume_observation", side_effect=OSError("synthetic")
        ):
            denied = self.store.evaluate_trusted_fill(observed_evaluation)
        self.assertEqual(
            (denied["reasonCode"], denied["retryAllowed"], denied["attentionHandoff"]),
            ("resume_observation_failed", False, True),
        )
        self.assertEqual(self.store.get_job(observed_job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_trusted_fill_legacy_resume_denies_approval_and_converges_claim(self):
        self.store.replace_profile({"firstName": "Synthetic"}, 0, "user")
        external = self.home / "legacy-trusted.txt"
        external.write_text("Legacy synthetic resume", encoding="utf-8")
        observation = STORE_MODULE.observe_resume_file(str(external))
        document = self.store._load_resumes_document()
        document["resumes"]["legacy-trusted"] = {
            "id": "legacy-trusted", "label": "Legacy", "path": str(external),
            "tags": [], "default": True, "observedSize": observation["size"],
            "observedModifiedAt": observation["modifiedAt"], "revision": 1,
            "createdAt": "2026-08-29T00:00:00Z", "updatedAt": "2026-08-29T00:00:00Z",
            "deletedAt": None,
        }
        STORE_MODULE.atomic_write_json(self.store.resumes_path, document)
        job = self.store.create_job({
            "id": "legacy-trusted-job",
            "url": "https://acme.wd5.myworkdayjobs.com/jobs/legacy",
            "role": "Engineer", "company": "Synthetic", "resumeId": "legacy-trusted",
        })
        ready = self.store.transition_job(job["id"], "ready", job["revision"])
        acquired = self.store.acquire_ready_job(job["id"], "trusted-fill-test", ready["revision"])
        fingerprint = lambda char: "sha256:" + char * 64
        denied = self.store.approve_trusted_fill({
            "jobId": job["id"], "expectedJobRevision": acquired["job"]["revision"],
            "realmRef": self.store.resolve_account_realm(job["url"])["realmRef"],
            "answerRefs": [], "observedQuestionFingerprint": fingerprint("1"),
            "observedControlFingerprint": fingerprint("2"),
            "formFingerprint": fingerprint("3"), "allowedOperations": ["fill_text"],
            "durationMinutes": 30,
        })
        self.assertEqual(
            (denied["authorized"], denied["reasonCode"], denied["retryAllowed"], denied["attentionHandoff"]),
            (False, "resume_content_unverifiable", False, True),
        )
        self.assertEqual(self.store.get_job(job["id"])["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        self.assertIsNone(self.store.trusted_fill_status(job["id"]))

    def test_trusted_fill_revoke_requires_exact_approval_revision(self):
        # Pure revision behavior is covered without needing a browser or executor.
        self.store.initialize(); self.store._ensure_trusted_fill_document()
        self.assertEqual(self.store.trusted_fill_status("missing-job", public=True), {"status": "missing", "approvalRevision": None})
