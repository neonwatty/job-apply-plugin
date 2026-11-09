from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_semantic_lookup_and_grouped_approval_are_current_value_free_and_field_specific(self):
        ready = self._make_ready_job()
        answer = self.store.put_answer({
            "question": "Does the applicant have permission to work in this jurisdiction?",
            "state": "confirmed", "value": "PRIVATE CURRENT USE VALUE",
            "scope": {"ats": "greenhouse"}, "fieldClass": "authorization",
        })
        incompatible = self.store.semantic_answer_lookup({
            "question": "Does the applicant have permission to work in this jurisdiction?",
            "scope": {"ats": "greenhouse"}, "fieldClass": "relocation",
            "sensitivity": "none", "mode": "strict",
            "useAuthority": "accepted_record", "limit": 5,
        })
        self.assertNotIn(
            "reuse_eligible", incompatible["candidates"][0]["reasonCodes"]
        )
        lookup = self.store.semantic_answer_lookup({
            "question": "Is employment authorization available in the country?",
            "scope": {"ats": "greenhouse"}, "fieldClass": "authorization",
            "sensitivity": "none", "mode": "strict",
            "useAuthority": "accepted_record", "limit": 5,
        })
        self.assertTrue(lookup["candidates"])
        self.assertIn("reuse_eligible", lookup["candidates"][0]["reasonCodes"])
        self.assertNotIn("PRIVATE CURRENT USE VALUE", json.dumps(lookup))

        acquired = self.store.acquire_ready_job(
            ready["id"], "grouped-owner", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info",
            {
                "status": "active", "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Is employment authorization available in the country?",
                    "state": "missing", "answerKey": answer["key"],
                    "sensitive": False, "fieldClass": "authorization",
                    "scope": {"ats": "greenhouse"},
                    "matchConfidence": "high",
                    "matchReasonCodes": [
                        "match_semantic_high", "scope_match",
                        "field_class_match", "sensitivity_match",
                    ],
                }],
            },
            acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        reference = activity["session"]["pendingInformation"][0]["reference"]
        decisions = [{
            "reference": reference, "answerKey": answer["key"],
            "currentUse": True, "remember": False, "policyMode": "strict",
            "useAuthority": "accepted_record",
            "allowedSensitiveFieldClasses": [],
        }]
        unrelated = self.store.put_answer({
            "question": "Is relocation available?", "state": "confirmed",
            "value": "PRIVATE UNRELATED VALUE", "scope": {"ats": "greenhouse"},
            "fieldClass": "relocation",
        })
        mismatched = [{**decisions[0], "answerKey": unrelated["key"]}]
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "does not match pending field"
        ):
            self.store.preview_grouped_approval(
                ready["id"], handed["job"]["revision"],
                activity["session"]["revision"], mismatched,
            )
        answers_before = self.store.answers_path.read_bytes()
        preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], decisions,
        )
        self.assertTrue(preview["approvals"][0]["eligible"])
        self.assertEqual(
            (preview["approvals"][0]["currentUse"], preview["approvals"][0]["remember"], preview["approvals"][0]["policyMode"]),
            (True, False, "strict"),
        )
        approved = self.store.approve_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], decisions,
            preview["previewToken"], owner_confirmed=True,
        )
        self.assertTrue(approved["approved"])
        self.assertEqual(self.store.answers_path.read_bytes(), answers_before)
        serialized = self.store._session_path(ready["id"]).read_text(encoding="utf-8")
        self.assertNotIn(
            "Is employment authorization available in the country?", serialized
        )
        self.assertNotIn("PRIVATE CURRENT USE VALUE", serialized)
        self.assertNotIn("PRIVATE UNRELATED VALUE", serialized)

        approved_activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(
            approved_activity["session"]["approvals"][0]["answerKey"],
            answer["key"],
        )
        attention_row = next(
            item for item in self.store.list_needs_attention()["items"]
            if item["jobId"] == ready["id"]
        )
        self.assertNotIn("approvals", attention_row["session"])
        self.assertNotIn("answerKey", json.dumps(attention_row))
        current_preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            approved_activity["session"]["revision"], decisions,
        )
        original_preview = self.store.preview_grouped_approval

        def preview_then_change_answer(*args, **kwargs):
            result = original_preview(*args, **kwargs)
            current = self.store.get_answer(answer["key"])
            self.store.update_answer(
                answer["key"], {"aliases": ["authorization eligibility"]},
                expected_revision=current["revision"],
            )
            return result

        with mock.patch.object(
            self.store, "preview_grouped_approval",
            side_effect=preview_then_change_answer,
        ), self.assertRaisesRegex(
            STORE_MODULE.StoreError, "grouped approval state changed"
        ):
            self.store.approve_grouped_approval(
                ready["id"], handed["job"]["revision"],
                approved_activity["session"]["revision"], decisions,
                current_preview["previewToken"], owner_confirmed=True,
            )
        self.assertNotEqual(self.store.answers_path.read_bytes(), answers_before)
        self.assertEqual(
            self.store.get_job_activity(ready["id"])["session"]["approvals"],
            [],
        )
        attention_row = next(
            item for item in self.store.list_needs_attention()["items"]
            if item["jobId"] == ready["id"]
        )
        self.assertNotIn("approvals", attention_row["session"])
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "semantic match is stale"
        ):
            self.store.preview_grouped_approval(
                ready["id"], handed["job"]["revision"],
                approved_activity["session"]["revision"], decisions,
            )
        approved_activity = self.store.get_job_activity(ready["id"])
        current_answer = self.store.get_answer(answer["key"])
        resolved = self.store.resolve_pending_answer(
            ready["id"], reference, handed["job"]["revision"],
            approved_activity["session"]["revision"], current_answer["revision"],
            owner_confirmed=True,
        )
        self.assertTrue(resolved["ready"])
        resolved_activity = self.store.get_job_activity(ready["id"])
        self.assertFalse(any(
            blocker.get("reference") == reference
            for blocker in resolved_activity["session"]["blockers"]
        ))
        reacquired = self.store.acquire_ready_job(
            ready["id"], "next-attempt", resolved["job"]["revision"]
        )
        new_session = self.store.save_claim_progress(
            ready["id"], reacquired["token"],
            {
                "status": "active", "step": "form", "pendingFields": [],
                "attemptRevision": reacquired["job"]["revision"],
            },
        )
        self.assertEqual(new_session["approvals"], [])

    def test_grouped_approval_remains_current_for_redirected_pending_answer_key(self):
        winner = self.store.put_answer({
            "key": "authorization.winner", "question": "Are you authorized to work?",
            "state": "confirmed", "value": "yes", "fieldClass": "authorization",
        })
        source = self.store.put_answer({
            "key": "authorization.source", "question": "Do you have work authorization?",
            "state": "confirmed", "value": "yes", "fieldClass": "authorization",
        })
        merged = self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job(
            ready["id"], "redirected-approval", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Do you have work authorization?", "state": "missing",
                    "answerKey": source["key"], "sensitive": False,
                    "fieldClass": "authorization",
                }],
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        decision = {
            "reference": activity["session"]["pendingInformation"][0]["reference"],
            "answerKey": source["key"], "currentUse": True, "remember": False,
            "policyMode": "strict", "useAuthority": "accepted_record",
            "allowedSensitiveFieldClasses": [],
        }
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "answer key is invalid"
        ):
            self.store.preview_grouped_approval(
                ready["id"], handed["job"]["revision"],
                activity["session"]["revision"], [{**decision, "answerKey": {}}],
            )
        preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], [decision],
        )
        approved = self.store.approve_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], [decision],
            preview["previewToken"], owner_confirmed=True,
        )
        self.assertEqual(approved["approvals"][0]["answerKey"], merged["key"])
        self.assertEqual(
            self.store.get_job_activity(ready["id"])["session"]["approvals"],
            approved["approvals"],
        )

    def test_grouped_approval_denies_answer_from_incompatible_field_scope(self):
        ready = self._make_ready_job()
        answer = self.store.put_answer({
            "question": "Authorized?", "state": "confirmed", "value": "yes",
            "scope": {"ats": "greenhouse"}, "fieldClass": "authorization",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "scope-approval", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "ats": "lever",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Authorized?", "state": "missing",
                    "answerKey": answer["key"], "sensitive": False,
                    "fieldClass": "authorization",
                    "scope": {"ats": "lever", "email": "PRIVATE@example.com"},
                }],
            }, acquired["job"]["revision"],
        )
        serialized = self.store._session_path(ready["id"]).read_text(
            encoding="utf-8"
        )
        self.assertNotIn("PRIVATE@example.com", serialized)
        self.assertNotIn('"email"', serialized)
        self.assertIn("scopeFingerprint", serialized)
        activity = self.store.get_job_activity(ready["id"])
        preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], [{
                "reference": activity["session"]["pendingInformation"][0]["reference"],
                "answerKey": answer["key"], "currentUse": True,
                "remember": False, "policyMode": "strict",
                "useAuthority": "accepted_record",
                "allowedSensitiveFieldClasses": [],
            }],
        )
        self.assertFalse(preview["approvals"][0]["eligible"])
        self.assertIn("scope_mismatch", preview["approvals"][0]["reasonCodes"])

    def test_pending_field_omitted_scope_uses_canonical_job_ats(self):
        ready = self._make_ready_job(ats="greenhouse")
        answer = self.store.put_answer({
            "question": "Authorized?", "state": "confirmed", "value": "yes",
            "scope": {"ats": "greenhouse"}, "fieldClass": "authorization",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "canonical-ats-scope", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Authorized?", "state": "missing",
                    "answerKey": answer["key"], "sensitive": False,
                    "fieldClass": "authorization",
                }],
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        persisted = json.loads(
            self.store._session_path(ready["id"]).read_text(encoding="utf-8")
        )
        self.assertEqual(persisted["ats"], "greenhouse")
        self.assertEqual(
            persisted["pendingFields"][0]["scopeFingerprint"],
            STORE_MODULE._scope_fingerprint({"ats": "greenhouse"}),
        )
        pending = activity["session"]["pendingInformation"][0]
        preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], [{
                "reference": pending["reference"], "answerKey": answer["key"],
                "currentUse": True, "remember": False,
                "policyMode": "strict", "useAuthority": "accepted_record",
                "allowedSensitiveFieldClasses": [],
            }],
        )
        self.assertTrue(preview["approvals"][0]["eligible"])
        self.assertNotIn("scope_mismatch", preview["approvals"][0]["reasonCodes"])

    def test_semantic_paths_ignore_empty_normalized_aliases(self):
        answer = self.store.put_answer({
            "question": "Can the applicant work here?", "aliases": ["???"],
            "state": "confirmed", "value": "yes", "fieldClass": "authorization",
        })
        self.assertEqual(answer["aliases"], [])
        lookup = self.store.semantic_answer_lookup({
            "question": "Can the applicant work here?", "scope": {},
            "fieldClass": "authorization", "sensitivity": "none",
            "mode": "strict", "useAuthority": "accepted_record",
        })
        self.assertEqual(lookup["candidates"][0]["answerKey"], answer["key"])
        self.assertEqual(self.store.preview_answer_cleanup()["proposals"], [])

    def test_grouped_approval_preserves_personal_sensitivity(self):
        ready = self._make_ready_job()
        answer = self.store.put_answer({
            "question": "Personal contact preference?", "state": "confirmed",
            "value": "email", "fieldClass": "identity", "sensitivity": "personal",
        }, remember_sensitive=True)
        acquired = self.store.acquire_ready_job(
            ready["id"], "personal-sensitive", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Personal contact preference?", "state": "sensitive",
                    "answerKey": answer["key"], "sensitive": True,
                    "fieldClass": "identity",
                }],
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        decision = [{
            "reference": activity["session"]["pendingInformation"][0]["reference"],
            "answerKey": answer["key"], "currentUse": True, "remember": False,
            "policyMode": "strict", "useAuthority": "per_use",
            "allowedSensitiveFieldClasses": [],
        }]
        preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], decision,
        )
        self.assertTrue(preview["approvals"][0]["eligible"])
        self.assertIn("sensitivity_match", preview["approvals"][0]["reasonCodes"])
        approved = self.store.approve_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], decision,
            preview["previewToken"], owner_confirmed=True,
        )
        self.assertEqual(approved["approvals"][0]["useAuthority"], "per_use")
        ready_again = self.store.transition_job(
            ready["id"], "ready", handed["job"]["revision"]
        )
        acquired_again = self.store.acquire_ready_job(
            ready["id"], "new-sensitive-attempt", ready_again["revision"]
        )
        self.assertEqual(
            self.store.get_job_activity(ready["id"])["session"]["approvals"], []
        )
        self.assertEqual(acquired_again["job"]["status"], "in_progress")

    def test_semantic_reuse_and_attention_projection_include_explicit_keys(self):
        ready = self._make_ready_job()
        answer = self.store.put_answer({
            "key": "source.discovery",
            "question": "How did you hear about this opportunity?",
            "state": "confirmed", "value": "Referral", "fieldClass": "source",
        })
        lookup = self.store.semantic_answer_lookup({
            "question": "How did you hear about this opportunity?", "scope": {},
            "fieldClass": "source", "sensitivity": "none", "mode": "strict",
            "useAuthority": "accepted_record",
        })
        self.assertEqual(lookup["candidates"][0]["answerKey"], answer["key"])
        acquired = self.store.acquire_ready_job(
            ready["id"], "explicit-key", ready["revision"]
        )
        self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "How did you hear about this opportunity?",
                    "state": "missing", "answerKey": answer["key"],
                    "sensitive": False, "fieldClass": "source",
                }],
            }, acquired["job"]["revision"],
        )
        pending = self.store.get_job_activity(ready["id"])["session"][
            "pendingInformation"
        ][0]
        self.assertEqual(pending["answerKey"], "source.discovery")

    def test_grouped_approval_recomputes_match_instead_of_trusting_agent_metadata(self):
        ready = self._make_ready_job()
        answer = self.store.put_answer({
            "question": "Are you authorized to work?", "state": "confirmed",
            "value": "yes", "fieldClass": "general",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "unrelated-match", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "What is your favorite color?", "state": "missing",
                    "answerKey": answer["key"], "sensitive": False,
                    "fieldClass": "general", "matchConfidence": "exact",
                    "matchReasonCodes": [
                        "match_exact_question", "scope_match",
                        "field_class_match", "sensitivity_match",
                    ],
                }],
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        pending = activity["session"]["pendingInformation"][0]
        self.assertEqual(pending["matchConfidence"], "none")
        preview = self.store.preview_grouped_approval(
            ready["id"], handed["job"]["revision"],
            activity["session"]["revision"], [{
                "reference": pending["reference"], "answerKey": answer["key"],
                "currentUse": True, "remember": False,
                "policyMode": "strict", "useAuthority": "accepted_record",
                "allowedSensitiveFieldClasses": [],
            }],
        )
        self.assertFalse(preview["approvals"][0]["eligible"])
        self.assertNotIn(
            "reuse_eligible", preview["approvals"][0]["reasonCodes"]
        )
