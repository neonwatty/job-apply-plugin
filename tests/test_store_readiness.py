from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_awaiting_review_requires_fresh_readiness_input_on_handoff(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job(
            "ready-job", "codex", ready["revision"]
        )
        progress = self.review_session(acquired["job"]["revision"])
        progress["status"] = "active"
        self.store.save_claim_progress(
            "ready-job", acquired["token"], progress
        )
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "requires fresh current live readiness input"
        ):
            self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "awaiting_review",
                {
                    "status": "review", "step": "review",
                    "attemptRevision": acquired["job"]["revision"],
                    "pendingFields": [],
                },
                acquired["job"]["revision"],
            )
        self.assertEqual(self.store.get_job("ready-job")["status"], "in_progress")
        self.assertIsNotNone(self.store.claim_status()["claim"])

    def test_awaiting_review_rejects_readiness_fixture_for_another_ats(self):
        ready = self._make_ready_job(ats="lever")
        acquired = self.store.acquire_ready_job(
            ready["id"], "wrong-ats-readiness", ready["revision"]
        )
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "readiness evidence is invalid"
        ):
            self.store.handoff_claimed_job(
                ready["id"], acquired["token"], "awaiting_review",
                self.review_session(acquired["job"]["revision"]),
                acquired["job"]["revision"],
            )
        self.assertEqual(self.store.get_job(ready["id"])["status"], "in_progress")
        self.assertIsNotNone(self.store.claim_status()["claim"])

    def test_advertised_workday_and_rippling_have_matching_readiness_handoffs(self):
        for ats in ("workday", "rippling"):
            with self.subTest(ats=ats):
                self.store = STORE_MODULE.Store(
                    self.root / ats, self.home / f"{ats}-legacy.json"
                )
                ready = self._make_ready_job(job_id=f"{ats}-job", ats=ats)
                acquired = self.store.acquire_ready_job(
                    ready["id"], f"{ats}-readiness", ready["revision"]
                )
                handed = self.store.handoff_claimed_job(
                    ready["id"], acquired["token"], "awaiting_review",
                    self.review_session(
                        acquired["job"]["revision"],
                        fixture_id=f"{ats}-form-readiness-v1",
                    ),
                    acquired["job"]["revision"],
                )
                self.assertEqual(handed["job"]["status"], "awaiting_review")
                self.assertIsNone(self.store.claim_status()["claim"])

    def test_readiness_rejects_fixture_without_any_observed_required_control(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job(
            ready["id"], "optional-fixture", ready["revision"]
        )
        review = self.review_session(acquired["job"]["revision"])
        for step in review["readinessInput"]["fixture"]["steps"]:
            for control in step.get("controls", []):
                control["required"] = False
        review["readinessInput"]["observation"]["controls"] = []
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "readiness evidence is invalid"
        ):
            self.store.handoff_claimed_job(
                ready["id"], acquired["token"], "awaiting_review", review,
                acquired["job"]["revision"],
            )
        self.assertEqual(self.store.get_job(ready["id"])["status"], "in_progress")
        self.assertIsNotNone(self.store.claim_status()["claim"])

    def test_readiness_rejects_manifest_from_a_larger_same_ats_form(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job(
            ready["id"], "undercovered-form", ready["revision"]
        )
        review = self.review_session(acquired["job"]["revision"])
        larger_fixture = json.loads((
            ROOT / "qa" / "fixtures" / "greenhouse-single-page-2026-08-v1"
            / "fixture.json"
        ).read_text(encoding="utf-8"))
        review["readinessInput"]["formManifest"] = (
            STORE_MODULE.FORM_READINESS_MODULE.make_form_manifest(
                larger_fixture, observation_revision=11
            )
        )
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "readiness evidence is invalid"
        ):
            self.store.handoff_claimed_job(
                ready["id"], acquired["token"], "awaiting_review", review,
                acquired["job"]["revision"],
            )
        self.assertEqual(self.store.get_job(ready["id"])["status"], "in_progress")
        self.assertIsNotNone(self.store.claim_status()["claim"])

        unresolved = self.review_session(acquired["job"]["revision"])
        unresolved["pendingFields"] = [{
            "question": "Still unresolved?", "state": "missing",
            "sensitive": False,
        }]
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError,
            "requires complete current agent-attested readiness",
        ):
            self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "awaiting_review", unresolved,
                acquired["job"]["revision"],
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "session blocker is invalid"):
            self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "needs_info",
                {
                    "status": "active", "step": "blocked",
                    "attemptRevision": acquired["job"]["revision"],
                    "pendingFields": [],
                    "blockers": [{
                        "type": "information", "code": "PRIVATE USER VALUE",
                    }],
                },
                acquired["job"]["revision"],
            )
        self.assertIsNotNone(self.store.claim_status()["claim"])

    def test_inaccessible_readiness_requires_browser_handoff(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job(
            ready["id"], "inaccessible-readiness", ready["revision"]
        )
        session = self.review_session(acquired["job"]["revision"])
        session["status"] = "active"
        session["readinessInput"]["observation"]["adapterState"] = "inaccessible"
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", session,
            acquired["job"]["revision"],
        )
        self.assertEqual(handed["job"]["status"], "needs_info")
        self.assertEqual(handed["session"]["browserHandoff"], {
            "state": "required",
            "reasonCode": "form-observation-inaccessible",
            "revision": 1,
        })

    def test_acquisition_and_handoff_roll_forward_at_each_failure_boundary(self):
        original_write = STORE_MODULE.atomic_write_json

        def ready_store(case):
            root = self.home / "boundaries" / case
            store = STORE_MODULE.Store(root, self.legacy)
            store.replace_profile(
                {"firstName": "Ada"},
                expected_revision=store.inspect_profile()["revision"],
                source="user",
            )
            resume_path = root / "resume.pdf"
            resume_path.write_bytes(b"%PDF-1.7\nresume")
            store.create_resume({"id": "resume", "label": "Resume", "path": str(resume_path)})
            job = store.create_job({"id": "job", "url": f"https://example.com/{case}"})
            ready = store.transition_job("job", "ready", job["revision"])
            store.claim_status()
            return store, ready

        acquisition_boundaries = {
            "journal-write": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is not None,
            "jobs": lambda store, path, payload: path == store.jobs_path,
            "history": None,
            "coordinator": lambda store, path, payload: path == store.coordinator_path and payload.get("claim") is not None,
            "journal-clear": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is None,
        }
        for name, predicate in acquisition_boundaries.items():
            with self.subTest(operation="acquire", boundary=name):
                store, ready = ready_store(f"acquire-{name}")
                if name == "history":
                    patcher = mock.patch.object(
                        store, "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                else:
                    failed = {"done": False}
                    def fail_once(path, payload, predicate=predicate, store=store):
                        if predicate(store, path, payload) and not failed["done"]:
                            failed["done"] = True
                            raise OSError("simulated crash")
                        return original_write(path, payload)
                    patcher = mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_once)
                with patcher, self.assertRaises(OSError):
                    store.acquire_ready_job("job", "agent", ready["revision"])
                repaired = STORE_MODULE.Store(store.root, self.legacy)
                if name == "journal-write":
                    self.assertIsNone(repaired.claim_status()["claim"])
                    self.assertEqual(repaired.get_job("job")["status"], "ready")
                    self.assertEqual(repaired.read_history(), [])
                    continue
                self.assertIsNotNone(repaired.claim_status()["claim"])
                self.assertEqual(repaired.get_job("job")["status"], "in_progress")
                self.assertEqual([event["event"] for event in repaired.read_history()], ["job-started"])

        handoff_boundaries = {
            "journal-write": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is not None,
            "jobs": lambda store, path, payload: path == store.jobs_path,
            "session": lambda store, path, payload: path == store._session_path("job"),
            "history": None,
            "coordinator": lambda store, path, payload: path == store.coordinator_path and payload.get("claim") is None,
            "journal-clear": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is None,
        }
        for name, predicate in handoff_boundaries.items():
            with self.subTest(operation="handoff", boundary=name):
                store, ready = ready_store(f"handoff-{name}")
                acquired = store.acquire_ready_job("job", "agent", ready["revision"])
                if name == "history":
                    patcher = mock.patch.object(
                        store, "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                else:
                    failed = {"done": False}
                    def fail_once(path, payload, predicate=predicate, store=store):
                        if predicate(store, path, payload) and not failed["done"]:
                            failed["done"] = True
                            raise OSError("simulated crash")
                        return original_write(path, payload)
                    patcher = mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_once)
                with patcher, self.assertRaises(OSError):
                    store.handoff_claimed_job(
                        "job", acquired["token"], "awaiting_review",
                        self.review_session(acquired["job"]["revision"]),
                        acquired["job"]["revision"],
                    )
                repaired = STORE_MODULE.Store(store.root, self.legacy)
                if name == "journal-write":
                    self.assertIsNotNone(repaired.claim_status()["claim"])
                    self.assertEqual(repaired.get_job("job")["status"], "in_progress")
                    self.assertFalse(repaired._session_path("job").exists())
                    self.assertEqual(
                        [event["event"] for event in repaired.read_history()],
                        ["job-started"],
                    )
                    continue
                self.assertIsNone(repaired.claim_status()["claim"])
                self.assertEqual(repaired.get_job("job")["status"], "awaiting_review")
                self.assertEqual(repaired.load_session("job")["status"], "review")
                self.assertEqual(
                    [event["event"] for event in repaired.read_history()],
                    ["job-started", "reviewed"],
                )

    def test_persisted_readiness_validation_rejects_inconsistent_or_open_state(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job(
            ready["id"], "readiness-validation", ready["revision"]
        )
        progress = self.review_session(acquired["job"]["revision"])
        progress["status"] = "active"
        session = self.store.save_claim_progress(
            ready["id"], acquired["token"],
            progress,
        )
        path = self.store._session_path(ready["id"])
        cases = {
            "failed-ready": lambda value: value["readiness"]["assertions"].update(
                {"validation-clear": "failed"}
            ),
            "unknown-assertion": lambda value: value["readiness"]["assertions"].update(
                {"private-check": "passed"}
            ),
            "unknown-blocker": lambda value: value["readiness"]["blockerCodes"].append(
                "private-blocker"
            ),
            "unknown-fallback": lambda value: value["readiness"].update(
                {"fallbackCode": "private-fallback"}
            ),
            "invalid-control-set-fingerprint": lambda value: value[
                "readiness"
            ].update({"controlSetFingerprint": "sha256:short"}),
            "invalid-required-control-count": lambda value: value[
                "readiness"
            ].update({"requiredControlCount": True}),
            "non-string-approval-answer-key": lambda value: value[
                "approvals"
            ].append({
                "reference": "pending_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "answerKey": 123,
                "currentUse": True,
                "remember": False,
                "policyMode": "bounded_loose",
                "useAuthority": "per_use",
                "eligible": True,
                "confidenceBand": "exact",
                "reasonCodes": ["match_exact_question"],
                "answerRevision": 1,
            }),
        }
        for case, mutate in cases.items():
            malformed = copy.deepcopy(session)
            mutate(malformed)
            STORE_MODULE.atomic_write_json(path, malformed)
            with self.subTest(case=case), self.assertRaises(STORE_MODULE.StoreError):
                self.store.get_job_activity(ready["id"])
        STORE_MODULE.atomic_write_json(path, session)
