from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_review_restart_is_explicit_atomic_and_preserves_prior_session(self):
        reviewed = self._make_reviewed_job()
        session_path = self.store._session_path(reviewed["id"])
        session_before = session_path.read_bytes()

        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "explicit owner confirmation"
        ):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"]
            )

        restarted = self.store.restart_reviewed_job(
            reviewed["id"],
            "restart-agent",
            reviewed["revision"],
            owner_confirmed_not_submitted=True,
        )
        self.assertEqual(restarted["job"]["status"], "in_progress")
        self.assertEqual(restarted["job"]["revision"], reviewed["revision"] + 1)
        self.assertEqual(restarted["claim"]["jobId"], reviewed["id"])
        self.assertEqual(
            self.store._parse_time(restarted["claim"]["expiresAt"])
            - self.store._parse_time(restarted["claim"]["acquiredAt"]),
            timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS),
        )
        self.assertEqual(session_path.read_bytes(), session_before)
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["job-started", "reviewed", "job-restarted"],
        )
        persisted = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (
                self.store.coordinator_path,
                self.store.coordinator_journal_path,
                self.store.history_path,
                session_path,
            )
        )
        self.assertNotIn(restarted["token"], persisted)

        progress = {
            "status": "active",
            "step": "form",
            "attemptRevision": restarted["job"]["revision"],
            "pendingFields": [],
        }
        self.store.save_claim_progress(
            reviewed["id"], restarted["token"], progress
        )
        self.assertNotEqual(session_path.read_bytes(), session_before)

    def test_legacy_review_restart_requires_exact_absence_and_fresh_rebuild(self):
        reviewed = self._make_reviewed_job()
        session_path = self._replace_with_legacy_review_session(reviewed)
        session_before = session_path.read_bytes()

        restarted = self.store.restart_reviewed_job(
            reviewed["id"], "legacy-rebuild-agent", reviewed["revision"], True
        )
        self.assertEqual(
            (restarted["job"]["id"], restarted["job"]["status"], restarted["job"]["revision"]),
            (reviewed["id"], "in_progress", reviewed["revision"] + 1),
        )
        self.assertEqual(session_path.read_bytes(), session_before)
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["job-started", "reviewed", "legacy-review-rebuild"],
        )

        stale = self.review_session(reviewed["revision"] - 1)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "current attempt"):
            self.store.handoff_claimed_job(
                reviewed["id"], restarted["token"], "awaiting_review",
                stale, restarted["job"]["revision"],
            )
        without_readiness = {
            "status": "review", "step": "final_review", "pendingFields": [],
            "attemptRevision": restarted["job"]["revision"],
        }
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "fresh current"):
            self.store.handoff_claimed_job(
                reviewed["id"], restarted["token"], "awaiting_review",
                without_readiness, restarted["job"]["revision"],
            )
        self.assertEqual(
            self.store.get_job(reviewed["id"])["status"], "in_progress"
        )
        self.assertIsNotNone(self.store.claim_status()["claim"])

        fresh = self.review_session(
            restarted["job"]["revision"], step="final_review"
        )
        handed = self.store.handoff_claimed_job(
            reviewed["id"], restarted["token"], "awaiting_review",
            fresh, restarted["job"]["revision"],
        )
        self.assertEqual(handed["job"]["status"], "awaiting_review")
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_legacy_review_restart_rejects_partial_null_and_contradictory_envelopes(self):
        variants = {
            "explicit null": {"attemptRevision": None},
            "partial valid": {"attemptRevision": 2},
            "malformed readiness": {"readiness": []},
            "contradictory handoff": {
                "browserHandoff": {
                    "state": "required", "reasonCode": "login-required",
                    "revision": 1,
                },
            },
            "wrong step": {"step": "review"},
            "pending work": {
                "pendingFields": [{
                    "state": "missing", "answerKey": "answer.missing",
                    "sensitive": False,
                }],
            },
        }
        for label, overrides in variants.items():
            with self.subTest(label=label):
                self.store = STORE_MODULE.Store(
                    self.root / hashlib.sha256(label.encode()).hexdigest()[:12],
                    self.legacy,
                )
                reviewed = self._make_reviewed_job()
                session_path = self._replace_with_legacy_review_session(
                    reviewed, **overrides
                )
                before = {
                    path: path.read_bytes()
                    for path in (
                        self.store.jobs_path,
                        self.store.coordinator_path,
                        self.store.coordinator_journal_path,
                        self.store.history_path,
                        session_path,
                    )
                }
                with self.assertRaises(STORE_MODULE.StoreError):
                    self.store.restart_reviewed_job(
                        reviewed["id"], "legacy-agent", reviewed["revision"], True
                    )
                self.assertEqual(
                    {path: path.read_bytes() for path in before}, before
                )

    def test_legacy_review_restart_rejects_newer_history_and_prior_restart(self):
        reviewed = self._make_reviewed_job()
        self._replace_with_legacy_review_session(reviewed)
        self.store.append_history({
            "applicationId": reviewed["id"], "event": "progressed",
            "status": "awaiting_review", "answerKeys": [],
        })
        before = self.store.jobs_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reviewed history"):
            self.store.restart_reviewed_job(
                reviewed["id"], "legacy-agent", reviewed["revision"], True
            )
        self.assertEqual(self.store.jobs_path.read_bytes(), before)

        self.store = STORE_MODULE.Store(self.root / "prior-restart", self.legacy)
        reviewed = self._make_reviewed_job()
        first = self.store.restart_reviewed_job(
            reviewed["id"], "modern-agent", reviewed["revision"], True
        )
        reviewed_again = self.store.handoff_claimed_job(
            reviewed["id"], first["token"], "awaiting_review",
            self.review_session(first["job"]["revision"], step="final_review"),
            first["job"]["revision"],
        )["job"]
        session_path = self._replace_with_legacy_review_session(reviewed_again)
        session_before = session_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already used"):
            self.store.restart_reviewed_job(
                reviewed_again["id"], "legacy-agent",
                reviewed_again["revision"], True,
            )
        self.assertEqual(session_path.read_bytes(), session_before)

    def test_review_restart_failure_matrix_is_side_effect_free(self):
        reviewed = self._make_reviewed_job()

        def snapshot():
            return {
                path: path.read_bytes()
                for path in (
                    self.store.jobs_path,
                    self.store.coordinator_path,
                    self.store.coordinator_journal_path,
                    self.store.history_path,
                    self.store._session_path(reviewed["id"]),
                )
            }

        before = snapshot()
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "explicit owner confirmation"
        ):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"], 1
            )
        self.assertEqual(snapshot(), before)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"] - 1, True
            )
        self.assertEqual(snapshot(), before)

        history = self.store.history_path.read_bytes()
        self.store.history_path.write_bytes(b"")
        no_history = snapshot()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reviewed history"):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"], True
            )
        self.assertEqual(snapshot(), no_history)
        self.store.history_path.write_bytes(history)

        session_path = self.store._session_path(reviewed["id"])
        session_bytes = session_path.read_bytes()
        session = json.loads(session_bytes)
        session["blockers"] = [
            {"type": "browser_handoff", "code": "login-required"}
        ]
        session["browserHandoff"] = {
            "state": "required", "reasonCode": "login-required", "revision": 1,
        }
        STORE_MODULE.atomic_write_json(session_path, session)
        pending_work = snapshot()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "review evidence"):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"], True
            )
        self.assertEqual(snapshot(), pending_work)
        session_path.write_bytes(session_bytes)

        resume = self.store.get_resume("default-resume")
        managed = self.store.resume_files_path / resume["managedFile"]
        managed.write_bytes(b"changed managed resume")
        changed_resume = snapshot()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "current managed resume"):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"], True
            )
        self.assertEqual(snapshot(), changed_resume)

    def test_review_restart_refuses_any_global_claim_without_stealing_it(self):
        reviewed = self._make_reviewed_job()
        other = self.store.create_job(
            {"id": "other-job", "url": "https://example.com/jobs/other"}
        )
        other = self.store.transition_job(
            other["id"], "ready", other["revision"]
        )
        other_claim = self.store.acquire_ready_job(
            other["id"], "other-agent", other["revision"]
        )
        before_job = self.store.get_job(reviewed["id"])
        before_claim = self.store.claim_status()["claim"]

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "live job claim"):
            self.store.restart_reviewed_job(
                reviewed["id"], "restart-agent", reviewed["revision"], True
            )
        self.assertEqual(self.store.get_job(reviewed["id"]), before_job)
        self.assertEqual(self.store.claim_status()["claim"], before_claim)
        self.assertEqual(before_claim["claimId"], other_claim["claim"]["claimId"])
        self.assertNotEqual(before_claim["jobId"], reviewed["id"])

    def test_review_restart_has_one_concurrent_winner(self):
        reviewed = self._make_reviewed_job()
        gate = threading.Barrier(2)

        def restart(owner):
            gate.wait()
            try:
                return self.store.restart_reviewed_job(
                    reviewed["id"], owner, reviewed["revision"], True
                )
            except STORE_MODULE.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(restart, ("agent-one", "agent-two")))
        winners = [item for item in outcomes if isinstance(item, dict)]
        losers = [item for item in outcomes if isinstance(item, str)]
        self.assertEqual((len(winners), len(losers)), (1, 1))
        self.assertEqual(self.store.get_job(reviewed["id"])["revision"], reviewed["revision"] + 1)
        self.assertEqual(
            [event["event"] for event in self.store.read_history()].count(
                "job-restarted"
            ),
            1,
        )

    def test_legacy_review_restart_has_one_concurrent_winner(self):
        reviewed = self._make_reviewed_job()
        session_path = self._replace_with_legacy_review_session(reviewed)
        session_before = session_path.read_bytes()
        gate = threading.Barrier(2)

        def restart(owner):
            gate.wait()
            try:
                return self.store.restart_reviewed_job(
                    reviewed["id"], owner, reviewed["revision"], True
                )
            except STORE_MODULE.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(restart, ("agent-one", "agent-two")))
        self.assertEqual(
            (sum(isinstance(item, dict) for item in outcomes),
             sum(isinstance(item, str) for item in outcomes)),
            (1, 1),
        )
        self.assertEqual(session_path.read_bytes(), session_before)
        self.assertEqual(
            [event["event"] for event in self.store.read_history()].count(
                "legacy-review-rebuild"
            ),
            1,
        )

    def test_legacy_review_restart_rolls_forward_without_rewriting_session(self):
        original_write = STORE_MODULE.atomic_write_json
        for boundary in ("jobs", "history", "coordinator", "journal-clear"):
            with self.subTest(boundary=boundary):
                self.store = STORE_MODULE.Store(
                    self.root / f"legacy-review-restart-{boundary}", self.legacy
                )
                reviewed = self._make_reviewed_job()
                session_path = self._replace_with_legacy_review_session(reviewed)
                session_before = session_path.read_bytes()
                failed = {"done": False}

                def fail_once(path, payload):
                    matches = (
                        boundary == "jobs" and path == self.store.jobs_path
                        or boundary == "coordinator"
                        and path == self.store.coordinator_path
                        and payload.get("claim") is not None
                        or boundary == "journal-clear"
                        and path == self.store.coordinator_journal_path
                        and payload.get("operation") is None
                    )
                    if matches and not failed["done"]:
                        failed["done"] = True
                        raise OSError("simulated crash")
                    return original_write(path, payload)

                patcher = (
                    mock.patch.object(
                        self.store,
                        "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                    if boundary == "history"
                    else mock.patch.object(
                        STORE_MODULE, "atomic_write_json", side_effect=fail_once
                    )
                )
                with patcher, self.assertRaises(OSError):
                    self.store.restart_reviewed_job(
                        reviewed["id"], "legacy-agent", reviewed["revision"], True
                    )
                repaired = STORE_MODULE.Store(self.store.root, self.legacy)
                self.assertEqual(
                    repaired.claim_status()["claim"]["jobId"], reviewed["id"]
                )
                self.assertEqual(
                    repaired.get_job(reviewed["id"])["status"], "in_progress"
                )
                self.assertEqual(session_path.read_bytes(), session_before)
                self.assertEqual(
                    [event["event"] for event in repaired.read_history()].count(
                        "legacy-review-rebuild"
                    ),
                    1,
                )

    def test_review_restart_rolls_forward_without_rewriting_session(self):
        original_write = STORE_MODULE.atomic_write_json
        for boundary in ("jobs", "history", "coordinator", "journal-clear"):
            with self.subTest(boundary=boundary):
                self.store = STORE_MODULE.Store(
                    self.root / f"review-restart-{boundary}", self.legacy
                )
                reviewed = self._make_reviewed_job()
                session_path = self.store._session_path(reviewed["id"])
                session_before = session_path.read_bytes()
                failed = {"done": False}

                def fail_once(path, payload):
                    matches = (
                        boundary == "jobs" and path == self.store.jobs_path
                        or boundary == "coordinator"
                        and path == self.store.coordinator_path
                        and payload.get("claim") is not None
                        or boundary == "journal-clear"
                        and path == self.store.coordinator_journal_path
                        and payload.get("operation") is None
                    )
                    if matches and not failed["done"]:
                        failed["done"] = True
                        raise OSError("simulated crash")
                    return original_write(path, payload)

                patcher = (
                    mock.patch.object(
                        self.store,
                        "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                    if boundary == "history"
                    else mock.patch.object(
                        STORE_MODULE, "atomic_write_json", side_effect=fail_once
                    )
                )
                with patcher, self.assertRaises(OSError):
                    self.store.restart_reviewed_job(
                        reviewed["id"], "restart-agent", reviewed["revision"], True
                    )
                repaired = STORE_MODULE.Store(self.store.root, self.legacy)
                self.assertEqual(repaired.claim_status()["claim"]["jobId"], reviewed["id"])
                self.assertEqual(repaired.get_job(reviewed["id"])["status"], "in_progress")
                self.assertEqual(session_path.read_bytes(), session_before)
                self.assertEqual(
                    [event["event"] for event in repaired.read_history()].count(
                        "job-restarted"
                    ),
                    1,
                )

    def test_pending_coordinator_operation_repairs_partial_history_tail(self):
        ready = self._make_ready_job()

        def append_partial_then_crash(event):
            encoded = (
                json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            descriptor = os.open(
                self.store.history_path,
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
            self.store,
            "_append_history_event_idempotent_locked",
            side_effect=append_partial_then_crash,
        ):
            with self.assertRaisesRegex(OSError, "partial append"):
                self.store.acquire_ready_job("ready-job", "codex", ready["revision"])

        self.assertFalse(self.store.history_path.read_bytes().endswith(b"\n"))
        repaired = STORE_MODULE.Store(self.root, self.legacy)
        self.assertIsNotNone(repaired.claim_status()["claim"])
        self.assertEqual(repaired.get_job("ready-job")["status"], "in_progress")
        self.assertEqual(
            [event["event"] for event in repaired.read_history()], ["job-started"]
        )
        self.assertIsNone(repaired._load_coordinator_journal()["operation"])
