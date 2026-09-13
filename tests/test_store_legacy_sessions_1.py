from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_workspace_startup_validates_sessions_without_mutation(self):
        self.store.initialize()
        session_path = self.store.sessions_path / "startup-session.json"
        corrupt = b'{"schemaVersion": 1, "private": "unchanged"'
        session_path.write_bytes(corrupt)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "valid session JSON"):
            self.store.validate_workspace_startup()
        self.assertEqual(session_path.read_bytes(), corrupt)

        future = {
            "schemaVersion": 99,
            "applicationId": "startup-session",
            "status": "active",
            "answerKeys": [],
            "pendingFields": [],
        }
        session_path.write_text(json.dumps(future), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "future schemaVersion 99"):
            self.store.validate_workspace_startup()
        self.assertEqual(json.loads(session_path.read_text(encoding="utf-8")), future)

        if os.name != "nt":
            outside = self.root.parent / "outside-session.json"
            outside.write_text(json.dumps(future), encoding="utf-8")
            session_path.unlink()
            session_path.symlink_to(outside)
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "regular file"):
                self.store.validate_workspace_startup()
            self.assertEqual(json.loads(outside.read_text(encoding="utf-8")), future)

    def test_workspace_startup_session_validation_uses_windows_capability_path(self):
        self.store.initialize()
        session = self.store.save_session(
            "windows-session",
            {"status": "active", "answerKeys": [], "pendingFields": []},
        )
        real_open = STORE_MODULE.os.open
        calls = []

        def portable_open(path, flags, *args, **kwargs):
            calls.append((path, kwargs.copy()))
            if "dir_fd" in kwargs:
                raise AssertionError("Windows fallback used dir_fd")
            return real_open(path, flags, *args, **kwargs)

        with mock.patch.object(STORE_MODULE.os, "name", "nt"), mock.patch.object(
            STORE_MODULE.os, "open", side_effect=portable_open
        ):
            self.store.validate_workspace_startup()
        self.assertTrue(calls)
        self.assertEqual(self.store.load_session("windows-session"), session)

    def test_legacy_1_2_session_reads_are_stable_value_free_and_byte_preserving(self):
        self.store.initialize()
        job = self.store.create_job({
            "id": "legacy-attention",
            "url": "https://example.com/jobs/legacy-attention",
            "role": "Engineer",
            "company": "Example",
            "ats": "greenhouse",
        })
        self.store.transition_job(job["id"], "needs_info", job["revision"])
        path = self.store._session_path(job["id"])
        legacy = self.legacy_1_2_session(job["id"])
        legacy.update({
            "company": "Legacy Company Copy",
            "role": "Legacy Role Copy",
            "url": "https://legacy.example/jobs/copy",
        })
        path.write_text(json.dumps(legacy, separators=(",", ":")), encoding="utf-8")
        before = path.read_bytes()

        projections = []
        for _ in range(2):
            fresh = STORE_MODULE.Store(self.root, self.legacy)
            fresh.initialize()
            projections.append({
                "load": fresh.load_session(job["id"]),
                "list": fresh.list_sessions(),
                "activity": fresh.get_job_activity(job["id"]),
                "attention": fresh.list_needs_attention(),
            })
            self.assertEqual(path.read_bytes(), before)

        self.assertEqual(projections[0], projections[1])
        serialized = json.dumps(projections[0], sort_keys=True)
        self.assertNotIn("authorized to work", serialized)
        self.assertNotIn("require sponsorship", serialized)
        self.assertNotIn("Legacy Company Copy", serialized)
        self.assertNotIn("Legacy Role Copy", serialized)
        self.assertNotIn("https://legacy.example/jobs/copy", serialized)
        fields = projections[0]["load"]["pendingFields"]
        attention_row = next(
            item
            for item in projections[0]["attention"]["items"]
            if item["jobId"] == job["id"]
        )
        self.assertEqual(
            self.store._session_revision(projections[0]["load"]),
            projections[0]["activity"]["session"]["revision"],
        )
        self.assertEqual(
            attention_row["sessionRevision"],
            projections[0]["activity"]["session"]["revision"],
        )
        for legacy_job_field in ("company", "role", "url"):
            self.assertNotIn(legacy_job_field, projections[0]["load"])
        self.assertEqual(len(fields), 2)
        self.assertEqual(
            [(field["state"], field["answerKey"], field["sensitive"]) for field in fields],
            [
                ("missing", "answer.work_authorization", True),
                ("inferred", "answer.sponsorship", False),
            ],
        )
        for field in fields:
            self.assertRegex(field["reference"], r"^pending_[a-f0-9]{32}$")
            self.assertRegex(field["questionFingerprint"], r"^[a-f0-9]{64}$")

    def test_legacy_1_2_next_session_and_coordinator_writes_normalize_in_place(self):
        self.store.initialize()
        generic_path = self.store._session_path("legacy-session")
        legacy = self.legacy_1_2_session()
        legacy["ats"] = "greenhouse"
        generic_path.write_text(json.dumps(legacy), encoding="utf-8")
        projected = self.store.load_session("legacy-session")
        saved = self.store.save_session(
            "legacy-session",
            {
                "status": "active",
                "step": "questions",
                "answerKeys": legacy["answerKeys"],
                "pendingFields": legacy["pendingFields"],
            },
        )
        self.assertEqual(
            [field["reference"] for field in saved["pendingFields"]],
            [field["reference"] for field in projected["pendingFields"]],
        )
        self.assertEqual(saved["ats"], "greenhouse")
        persisted = json.loads(generic_path.read_text(encoding="utf-8"))
        self.assertEqual(persisted, saved)
        self.assertTrue(all("question" not in field for field in persisted["pendingFields"]))

        ready = self._make_ready_job(ats="greenhouse")
        acquired = self.store.acquire_ready_job(
            ready["id"], "legacy-normalizer", ready["revision"]
        )
        coordinator_path = self.store._session_path(ready["id"])
        coordinator_legacy = self.legacy_1_2_session(ready["id"])
        coordinator_path.write_text(json.dumps(coordinator_legacy), encoding="utf-8")
        coordinator_projection = self.store.load_session(ready["id"])
        progressed = self.store.save_claim_progress(
            ready["id"],
            acquired["token"],
            {
                "status": "active",
                "step": "questions",
                "answerKeys": coordinator_legacy["answerKeys"],
                "pendingFields": coordinator_legacy["pendingFields"],
            },
        )
        self.assertEqual(
            [field["reference"] for field in progressed["pendingFields"]],
            [field["reference"] for field in coordinator_projection["pendingFields"]],
        )
        self.assertEqual(
            json.loads(coordinator_path.read_text(encoding="utf-8")), progressed
        )
        self.assertTrue(
            all(
                "question" not in field
                for field in progressed["pendingFields"]
            )
        )

    def test_legacy_1_2_compatibility_rejects_broader_or_colliding_shapes(self):
        self.store.initialize()
        path = self.store._session_path("legacy-session")
        valid = self.legacy_1_2_session()
        invalid_fields = {
            "malformed explicit reference": [{"state": "missing", "reference": "pending_bad"}],
            "reference-less modern metadata": [{"state": "missing", "fieldClass": "general"}],
            "private value": [{"state": "missing", "value": "secret"}],
            "duplicate legacy fields": [valid["pendingFields"][0], valid["pendingFields"][0]],
            "duplicate explicit references": [
                {"state": "missing", "reference": "pending_" + "a" * 32},
                {"state": "inferred", "reference": "pending_" + "a" * 32},
            ],
            "mixed legacy and modern fields": [
                valid["pendingFields"][0],
                {"state": "missing", "reference": "pending_" + "b" * 32},
            ],
        }
        for label, fields in invalid_fields.items():
            with self.subTest(label=label):
                document = self.legacy_1_2_session(pending_fields=copy.deepcopy(fields))
                path.write_text(json.dumps(document), encoding="utf-8")
                before = path.read_bytes()
                with self.assertRaises(STORE_MODULE.StoreError):
                    STORE_MODULE.Store(self.root, self.legacy).validate_workspace_startup()
                self.assertEqual(path.read_bytes(), before)

        for field, value in {
            "company": {"private": "secret"},
            "role": ["nested"],
            "url": 42,
        }.items():
            with self.subTest(label=f"invalid legacy {field}"):
                document = self.legacy_1_2_session()
                document[field] = value
                path.write_text(json.dumps(document), encoding="utf-8")
                before = path.read_bytes()
                with self.assertRaises(STORE_MODULE.StoreError):
                    STORE_MODULE.Store(self.root, self.legacy).validate_workspace_startup()
                self.assertEqual(path.read_bytes(), before)

        invalid_document = self.legacy_1_2_session()
        invalid_document["pendingFields"] = None
        path.write_text(json.dumps(invalid_document), encoding="utf-8")
        before = path.read_bytes()
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "session pendingFields must be a list"
        ):
            self.store.load_session("legacy-session")
        self.assertEqual(path.read_bytes(), before)

    def test_legacy_1_2_non_sensitive_resolution_uses_canonical_job_ats(self):
        ready = self._make_ready_job(ats="greenhouse")
        answer = self.store.put_answer({
            "question": "Authorized?",
            "state": "confirmed",
            "value": "yes",
            "scope": {"ats": "greenhouse"},
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "legacy-resolution", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Authorized?",
                    "state": "missing",
                    "answerKey": answer["key"],
                    "sensitive": False,
                }],
            }, acquired["job"]["revision"],
        )
        legacy = self.legacy_1_2_session(ready["id"], [{
            "question": "Authorized?",
            "state": "missing",
            "answerKey": answer["key"],
            "sensitive": False,
        }])
        legacy.update({
            "company": "Legacy Company Copy",
            "role": "Legacy Role Copy",
            "url": "https://legacy.example/jobs/copy",
        })
        path = self.store._session_path(ready["id"])
        path.write_text(json.dumps(legacy), encoding="utf-8")
        activity = self.store.get_job_activity(ready["id"])
        pending = activity["session"]["pendingInformation"][0]
        resolved = self.store.resolve_pending_answer(
            ready["id"], pending["reference"], handed["job"]["revision"],
            activity["session"]["revision"], answer["revision"],
            owner_confirmed=True,
        )
        self.assertTrue(resolved["ready"])
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(persisted["pendingFields"], [])
        self.assertEqual(persisted["ats"], "greenhouse")
        for legacy_job_field in ("company", "role", "url"):
            self.assertNotIn(legacy_job_field, persisted)
