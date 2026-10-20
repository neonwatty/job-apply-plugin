from concurrent.futures import ThreadPoolExecutor

from tests.support.store_case import *


class ApplicationAuthorityTests(StoreTestCase):
    StoreError = STORE_MODULE.StoreError

    def another_ready_job(self, job_id):
        job = self.store.create_job({
            "id": job_id, "url": f"https://example.com/jobs/{job_id}",
            "role": "Engineer", "company": "Acme",
        })
        return self.store.transition_job(job_id, "ready", job["revision"])

    def interrupts(self, **overrides):
        values = {
            "missingOrUncertainData": False, "captcha": False, "mfa": False,
            "emailVerification": False, "providerLegalConsent": False,
            "unsupportedControls": False, "unexpectedDestination": False,
            "ambiguity": False, "finalAction": False,
        }
        values.update(overrides)
        return values

    def evaluation(self, job_id, worker="worker-one", path="later-page", **overrides):
        value = {
            "jobId": job_id, "workerId": worker,
            "destinationUrl": f"https://example.com/{path}",
            "operations": [
                "fill_canonical_profile", "upload_managed_resume",
                "fill_confirmed_answer", "repair_cleared_field",
                "navigate_non_final",
            ],
            "answerRefs": [], "sensitiveAnswerUses": [],
            "interrupts": self.interrupts(),
        }
        value.update(overrides)
        return value

    def set_fill(self, job_id, worker="worker-one", classes=None):
        return self.store.set_application_authority({
            "mode": "fill_to_review", "jobIds": [job_id],
            "workerIds": [worker], "sensitiveFieldClasses": classes or [],
            "durationMinutes": 120,
        }, self.store.application_authority_status(public=True)["revision"], public=True)

    def test_missing_document_migrates_to_durable_guided_default(self):
        status = self.store.application_authority_status(public=True)
        self.assertEqual(
            status,
            {"mode": "guided", "status": "active", "revision": 0,
             "authorizationId": None, "expiresAt": None, "jobIds": [],
             "workerIds": [], "sensitiveFieldClasses": []},
        )
        document = json.loads(self.store.application_authority_path.read_text())
        self.assertIsNone(document["activeAuthorityId"])
        self.assertEqual(document["metadata"]["revision"], 0)

    def test_fill_to_review_covers_later_pages_repairs_and_non_final_navigation(self):
        ready = self._make_ready_job("fill-job")
        status = self.set_fill(ready["id"])
        acquired = self.store.acquire_ready_job(ready["id"], "worker-one", ready["revision"])
        decision = self.store.evaluate_application_authority(
            self.evaluation(ready["id"], path="jobs/fill-job/application/page-3"),
            public=True,
        )
        self.assertTrue(decision["authorized"])
        self.assertEqual(decision["mode"], "fill_to_review")
        self.assertEqual(decision["authorizationId"], status["authorizationId"])
        self.assertNotIn("url", json.dumps(self.store.application_authority_status()))
        self.assertNotIn(acquired["token"], json.dumps(decision))

    def test_every_interrupt_and_final_action_fail_closed(self):
        ready = self._make_ready_job("interrupt-job")
        self.set_fill(ready["id"])
        self.store.acquire_ready_job(ready["id"], "worker-one", ready["revision"])
        for field, reason in {
            "missingOrUncertainData": "missing_or_uncertain_data", "captcha": "captcha",
            "mfa": "mfa", "emailVerification": "email_verification",
            "providerLegalConsent": "provider_legal_consent",
            "unsupportedControls": "unsupported_controls",
            "unexpectedDestination": "unexpected_destination", "ambiguity": "ambiguity",
            "finalAction": "final_action_manual",
        }.items():
            packet = self.evaluation(ready["id"], interrupts=self.interrupts(**{field: True}))
            self.assertEqual(
                self.store.evaluate_application_authority(packet)["reasonCode"], reason
            )
        with self.assertRaisesRegex(self.StoreError, "unsupported values"):
            self.store.evaluate_application_authority({
                **self.evaluation(ready["id"]), "operations": ["submit"],
            })

    def test_campaign_is_bounded_by_selected_jobs_workers_and_sensitive_classes(self):
        first = self._make_ready_job("campaign-one")
        second = self.another_ready_job("campaign-two")
        sensitive = self.store.put_answer({
            "question": "Voluntary demographic response", "value": "Private",
            "state": "confirmed", "sensitivity": "personal", "source": "user",
        }, remember_sensitive=True)
        before = self.store.answers_path.read_bytes()
        status = self.store.set_application_authority({
            "mode": "campaign", "jobIds": [first["id"], second["id"]],
            "workerIds": ["worker-one", "worker-two"],
            "sensitiveFieldClasses": ["demographic"], "durationMinutes": 60,
        }, 0, public=True)
        self.assertEqual(status["mode"], "campaign")
        self.store.acquire_ready_job(first["id"], "worker-one", first["revision"])
        allowed = self.store.evaluate_application_authority({
            **self.evaluation(first["id"]),
            "sensitiveAnswerUses": [{"answerRef": sensitive["key"], "fieldClass": "demographic"}],
        })
        self.assertTrue(allowed["authorized"])
        self.assertEqual(self.store.answers_path.read_bytes(), before)
        with self.assertRaisesRegex(self.StoreError, "another live job claim already exists"):
            self.store.acquire_ready_job(second["id"], "worker-two", second["revision"])
        denied_worker = self.store.evaluate_application_authority(
            self.evaluation(first["id"], worker="worker-three")
        )
        self.assertEqual(denied_worker["reasonCode"], "worker_out_of_scope")
        denied_class = self.store.evaluate_application_authority({
            **self.evaluation(first["id"]),
            "sensitiveAnswerUses": [{"answerRef": sensitive["key"], "fieldClass": "disability"}],
        })
        self.assertEqual(denied_class["reasonCode"], "sensitive_current_use_not_approved")
        with self.assertRaisesRegex(self.StoreError, "bounded job and worker sets"):
            self.store.set_application_authority({
                "mode": "campaign", "jobIds": [second["id"]],
                "workerIds": [f"worker-{index}" for index in range(51)],
                "sensitiveFieldClasses": [], "durationMinutes": 60,
            }, status["revision"])

    def test_scope_changes_are_revisioned_and_one_concurrent_writer_wins(self):
        first = self._make_ready_job("race-one")
        second = self.another_ready_job("race-two")
        packet = lambda job: {
            "mode": "fill_to_review", "jobIds": [job["id"]],
            "workerIds": ["worker-one"], "sensitiveFieldClasses": [],
            "durationMinutes": 30,
        }
        def write(job):
            try:
                return self.store.set_application_authority(packet(job), 0, public=True)["jobIds"]
            except self.StoreError as error:
                return str(error)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(write, (first, second)))
        self.assertEqual(sum(isinstance(result, list) for result in results), 1)
        self.assertIn("application authority revision conflict", results)

    def test_revocation_restores_guided_and_fill_is_consumed_at_review(self):
        ready = self._make_ready_job("lifecycle-job", ats="greenhouse")
        active = self.set_fill(ready["id"])
        guided = self.store.revoke_application_authority(active["revision"], public=True)
        self.assertEqual((guided["mode"], guided["revision"]), ("guided", 2))
        active = self.set_fill(ready["id"])
        acquired = self.store.acquire_ready_job(ready["id"], "worker-one", ready["revision"])
        self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "awaiting_review",
            self.review_session(acquired["job"]["revision"]),
            acquired["job"]["revision"],
        )
        consumed = self.store.application_authority_status(public=True)
        self.assertEqual((consumed["mode"], consumed["revision"]), ("guided", active["revision"] + 1))

    def test_expiry_is_visible_and_effectively_guided(self):
        ready = self._make_ready_job("expired-job")
        active = self.set_fill(ready["id"])
        after_expiry = self.store._parse_time(active["expiresAt"]) + timedelta(seconds=1)
        with mock.patch.object(self.store, "_now_datetime", return_value=after_expiry):
            status = self.store.application_authority_status(public=True)
        self.assertEqual((status["mode"], status["status"]), ("guided", "expired"))

    def test_cli_exposes_redacted_status_set_and_revoke(self):
        ready = self._make_ready_job("cli-job")
        packet = self.home / "authority.json"
        packet.write_text(json.dumps({
            "mode": "fill_to_review", "jobIds": [ready["id"]],
            "workerIds": ["cli-worker"], "sensitiveFieldClasses": [],
            "durationMinutes": 30,
        }), encoding="utf-8")
        script = ROOT / "scripts" / "job-apply-store.py"
        def command(*args):
            result = subprocess.run(
                [sys.executable, str(script), "--root", str(self.root), *args],
                text=True, capture_output=True, check=True,
            )
            return json.loads(result.stdout)
        active = command(
            "application-authority-set", "--input", str(packet),
            "--expected-revision", "0",
        )
        self.assertEqual((active["mode"], active["jobIds"]), ("fill_to_review", [ready["id"]]))
        self.assertNotIn("destination", json.dumps(active))
        guided = command(
            "application-authority-revoke", "--expected-revision", str(active["revision"])
        )
        self.assertEqual(guided["mode"], "guided")
