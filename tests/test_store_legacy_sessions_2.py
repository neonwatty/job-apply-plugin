from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_legacy_1_2_sensitive_grouped_approval_normalizes_coordinator_session(self):
        ready = self._make_ready_job(ats="greenhouse")
        answer = self.store.put_answer(
            {
                "question": "Sensitive legacy choice?",
                "state": "confirmed",
                "value": "private choice",
                "scope": {"ats": "greenhouse"},
                "sensitivity": "high",
            },
            remember_sensitive=True,
        )
        acquired = self.store.acquire_ready_job(
            ready["id"], "legacy-sensitive", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"],
            acquired["token"],
            "needs_info",
            {
                "status": "active",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [
                    {
                        "question": "Sensitive legacy choice?",
                        "state": "sensitive",
                        "answerKey": answer["key"],
                        "sensitive": True,
                    }
                ],
            },
            acquired["job"]["revision"],
        )
        legacy = self.legacy_1_2_session(
            ready["id"],
            [
                {
                    "question": "Sensitive legacy choice?",
                    "state": "sensitive",
                    "answerKey": answer["key"],
                    "sensitive": True,
                }
            ],
        )
        legacy.update({
            "company": "Legacy Company Copy",
            "role": "Legacy Role Copy",
            "url": "https://legacy.example/jobs/copy",
        })
        path = self.store._session_path(ready["id"])
        path.write_text(json.dumps(legacy), encoding="utf-8")
        legacy_bytes = path.read_bytes()
        activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(path.read_bytes(), legacy_bytes)
        pending = activity["session"]["pendingInformation"][0]
        self.assertIn("matchConfidence", pending)
        decisions = [
            {
                "reference": pending["reference"],
                "answerKey": answer["key"],
                "currentUse": True,
                "remember": False,
                "policyMode": "strict",
                "useAuthority": "per_use",
                "allowedSensitiveFieldClasses": ["general"],
            }
        ]
        preview = self.store.preview_grouped_approval(
            ready["id"],
            handed["job"]["revision"],
            activity["session"]["revision"],
            decisions,
        )
        self.assertTrue(preview["approvals"][0]["eligible"])
        self.assertNotIn(
            "scope_mismatch", preview["approvals"][0]["reasonCodes"]
        )
        self.assertEqual(path.read_bytes(), legacy_bytes)
        approved = self.store.approve_grouped_approval(
            ready["id"],
            handed["job"]["revision"],
            activity["session"]["revision"],
            decisions,
            preview["previewToken"],
            owner_confirmed=True,
        )
        self.assertEqual(approved["approvals"][0]["reference"], pending["reference"])
        persisted = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(
            persisted["pendingFields"][0]["reference"], pending["reference"]
        )
        self.assertEqual(persisted["ats"], "greenhouse")
        self.assertEqual(
            persisted["pendingFields"][0]["scopeFingerprint"],
            STORE_MODULE._scope_fingerprint({"ats": "greenhouse"}),
        )
        self.assertIn(
            "scope_match", persisted["pendingFields"][0]["matchReasonCodes"]
        )
        self.assertNotIn("question", persisted["pendingFields"][0])
        for legacy_job_field in ("company", "role", "url"):
            self.assertNotIn(legacy_job_field, persisted)

    def test_session_explicit_ats_clear_does_not_inherit_scope_or_match_evidence(self):
        answer = self.store.put_answer({
            "question": "Authorized?", "state": "confirmed", "value": "private",
            "scope": {"ats": "greenhouse"}, "fieldClass": "authorization",
        })
        pending = [{
            "question": "Authorized?", "state": "missing",
            "answerKey": answer["key"], "sensitive": False,
            "fieldClass": "authorization",
        }]
        greenhouse_scope = STORE_MODULE._scope_fingerprint({"ats": "greenhouse"})

        for label, cleared_ats in (("null", None), ("empty", "")):
            with self.subTest(label=label):
                application_id = f"explicit-ats-{label}"
                initial = self.store.save_session(application_id, {
                    "status": "active", "ats": "greenhouse",
                    "pendingFields": pending,
                })
                self.assertEqual(
                    initial["pendingFields"][0]["scopeFingerprint"], greenhouse_scope
                )
                updated = self.store.save_session(application_id, {
                    "status": "active", "ats": cleared_ats,
                    "pendingFields": pending,
                })
                field = updated["pendingFields"][0]
                self.assertEqual(updated["ats"], cleared_ats)
                self.assertNotIn("scopeFingerprint", field)
                self.assertEqual(field["matchConfidence"], "none")
                self.assertIn("scope_mismatch", field["matchReasonCodes"])
                self.assertNotIn("scope_match", field["matchReasonCodes"])
                persisted = json.loads(
                    self.store._session_path(application_id).read_text(encoding="utf-8")
                )
                self.assertEqual(persisted, updated)
                serialized = json.dumps(persisted, sort_keys=True)
                self.assertNotIn("private", serialized)
                self.assertNotIn("Authorized?", serialized)

    def test_canonical_ats_clear_overrides_legacy_scope_before_grouped_approval(self):
        answer = self.store.put_answer({
            "question": "Sensitive legacy choice?", "state": "confirmed",
            "value": "private", "scope": {"ats": "greenhouse"},
            "sensitivity": "high",
        }, remember_sensitive=True)
        for label, cleared_ats in (("null", None), ("empty", "")):
            with self.subTest(label=label):
                job_id = f"canonical-clear-{label}"
                job = self.store.create_job({
                    "id": job_id, "url": f"https://example.com/jobs/{job_id}",
                    "role": "Engineer", "company": "Example", "ats": "greenhouse",
                })
                job = self.store.transition_job(job_id, "needs_info", job["revision"])
                legacy = self.legacy_1_2_session(job_id, [{
                    "question": "Sensitive legacy choice?", "state": "sensitive",
                    "answerKey": answer["key"], "sensitive": True,
                }])
                legacy.update({
                    "ats": "greenhouse", "company": "Legacy Company Copy",
                    "role": "Legacy Role Copy",
                    "url": "https://legacy.example/jobs/copy",
                })
                path = self.store._session_path(job_id)
                path.write_text(json.dumps(legacy), encoding="utf-8")
                cleared = self.store.update_job(
                    job_id, {"ats": cleared_ats}, job["revision"]
                )
                activity = self.store.get_job_activity(job_id)
                pending = activity["session"]["pendingInformation"][0]
                self.assertEqual(pending["matchConfidence"], "none")
                self.assertIn("scope_mismatch", pending["matchReasonCodes"])
                self.assertNotIn("scope_match", pending["matchReasonCodes"])
                decision = {
                    "reference": pending["reference"], "answerKey": answer["key"],
                    "currentUse": True, "remember": False, "policyMode": "strict",
                    "useAuthority": "per_use",
                    "allowedSensitiveFieldClasses": ["general"],
                }
                preview = self.store.preview_grouped_approval(
                    job_id, cleared["revision"], activity["session"]["revision"],
                    [decision],
                )
                self.assertFalse(preview["approvals"][0]["eligible"])
                self.assertIn(
                    "scope_mismatch", preview["approvals"][0]["reasonCodes"]
                )
                self.store.approve_grouped_approval(
                    job_id, cleared["revision"], activity["session"]["revision"],
                    [decision], preview["previewToken"], owner_confirmed=True,
                )
                persisted = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(persisted["ats"], cleared_ats)
                field = persisted["pendingFields"][0]
                self.assertNotIn("scopeFingerprint", field)
                self.assertEqual(field["matchConfidence"], "none")
                self.assertIn("scope_mismatch", field["matchReasonCodes"])
                self.assertNotIn("question", field)
                for legacy_job_field in ("company", "role", "url"):
                    self.assertNotIn(legacy_job_field, persisted)

    def test_session_omitted_ats_retains_existing_scope_and_match_evidence(self):
        answer = self.store.put_answer({
            "question": "Authorized?", "state": "confirmed", "value": "private",
            "scope": {"ats": "greenhouse"}, "fieldClass": "authorization",
        })
        pending = [{
            "question": "Authorized?", "state": "missing",
            "answerKey": answer["key"], "sensitive": False,
            "fieldClass": "authorization",
        }]
        initial = self.store.save_session("omitted-ats", {
            "status": "active", "ats": "greenhouse", "pendingFields": pending,
        })
        updated = self.store.save_session("omitted-ats", {
            "status": "active", "pendingFields": pending,
        })
        field = updated["pendingFields"][0]
        self.assertEqual(updated["ats"], "greenhouse")
        self.assertEqual(
            field["scopeFingerprint"],
            STORE_MODULE._scope_fingerprint({"ats": "greenhouse"}),
        )
        self.assertIn("scope_match", field["matchReasonCodes"])
        self.assertNotIn("scope_mismatch", field["matchReasonCodes"])
        self.assertEqual(
            field["reference"], initial["pendingFields"][0]["reference"]
        )
