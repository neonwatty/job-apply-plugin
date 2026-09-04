from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_cleanup_requires_exact_preview_and_owner_approval_before_mutation(self):
        winner = self.store.put_answer({
            "question": "Does the applicant have permission to work in this jurisdiction?",
            "state": "confirmed", "value": "PRIVATE CLEANUP WINNER",
            "scope": {},
        })
        duplicate = self.store.observe_answer({
            "question": "Is employment authorization available in the country?",
            "state": "missing", "scope": {},
        })
        before = self.store.answers_path.read_bytes()
        preview = self.store.preview_answer_cleanup()
        self.assertEqual(len(preview["proposals"]), 1)
        self.assertEqual(self.store.answers_path.read_bytes(), before)
        proposal = preview["proposals"][0]
        self.assertEqual(proposal["winnerQuestion"], winner["question"])
        self.assertEqual(proposal["duplicateQuestion"], duplicate["question"])
        self.assertNotIn("PRIVATE CLEANUP WINNER", json.dumps(preview))
        approval = {
            "previewToken": preview["previewToken"],
            "winnerKey": proposal["winnerKey"],
            "duplicateKey": proposal["duplicateKey"],
            "winnerRevision": proposal["winnerRevision"],
            "duplicateRevision": proposal["duplicateRevision"],
        }
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "explicit owner approval"
        ):
            self.store.approve_answer_cleanup(
                {**approval, "previewToken": 1}, owner_confirmed=True
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "explicit owner approval"):
            self.store.approve_answer_cleanup(approval)
        self.assertEqual(self.store.answers_path.read_bytes(), before)
        result = self.store.approve_answer_cleanup(approval, owner_confirmed=True)
        self.assertTrue(result["approved"])
        self.assertEqual(result["result"]["key"], winner["key"])
        self.assertEqual(
            self.store.get_answer(duplicate["key"])["redirectedFrom"],
            duplicate["key"],
        )

    def test_partial_grouped_approval_preserves_other_field_decisions(self):
        ready = self._make_ready_job()
        answers = [
            self.store.put_answer({
                "question": f"Stored field {index}?", "state": "confirmed",
                "value": f"PRIVATE VALUE {index}", "fieldClass": "general",
            })
            for index in (1, 2)
        ]
        acquired = self.store.acquire_ready_job(
            ready["id"], "partial-approval", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info",
            {
                "status": "active", "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [
                    {
                        "question": f"Field {index}?", "state": "missing",
                        "answerKey": answer["key"], "sensitive": False,
                        "fieldClass": "general", "matchConfidence": "exact",
                    }
                    for index, answer in enumerate(answers, 1)
                ],
            },
            acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        references = [
            item["reference"]
            for item in activity["session"]["pendingInformation"]
        ]

        for reference, answer in zip(references, answers):
            decision = [{
                "reference": reference, "answerKey": answer["key"],
                "currentUse": False, "remember": False,
                "policyMode": "strict", "useAuthority": "none",
                "allowedSensitiveFieldClasses": [],
            }]
            preview = self.store.preview_grouped_approval(
                ready["id"], handed["job"]["revision"],
                activity["session"]["revision"], decision,
            )
            self.store.approve_grouped_approval(
                ready["id"], handed["job"]["revision"],
                activity["session"]["revision"], decision,
                preview["previewToken"], owner_confirmed=True,
            )
            activity = self.store.get_job_activity(ready["id"])

        self.assertEqual(
            {item["reference"] for item in activity["session"]["approvals"]},
            set(references),
        )

    def test_same_attempt_pending_reorder_cannot_transfer_field_approval(self):
        ready = self._make_ready_job()
        answer = self.store.put_answer({
            "question": "Shared stored answer?", "state": "confirmed",
            "value": "PRIVATE VALUE", "fieldClass": "general",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "reorder-approval", ready["revision"]
        )
        fields = [
            {
                "question": "First field?", "state": "missing",
                "answerKey": answer["key"], "sensitive": False,
                "fieldClass": "general", "matchConfidence": "exact",
            },
            {
                "question": "Second field?", "state": "missing",
                "answerKey": answer["key"], "sensitive": True,
                "fieldClass": "identity", "matchConfidence": "uncertain",
            },
        ]
        first = self.store.save_claim_progress(
            ready["id"], acquired["token"], {
                "status": "active", "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": fields,
            },
        )
        approved_reference = first["pendingFields"][0]["reference"]
        decision = [{
            "reference": approved_reference, "answerKey": answer["key"],
            "currentUse": False, "remember": False,
            "policyMode": "strict", "useAuthority": "none",
            "allowedSensitiveFieldClasses": [],
        }]
        preview = self.store.preview_grouped_approval(
            ready["id"], acquired["job"]["revision"],
            self.store._session_revision(first), decision,
        )
        self.store.approve_grouped_approval(
            ready["id"], acquired["job"]["revision"],
            self.store._session_revision(first), decision,
            preview["previewToken"], owner_confirmed=True,
        )

        reordered = self.store.save_claim_progress(
            ready["id"], acquired["token"], {
                "status": "active", "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": list(reversed(fields)),
            },
        )
        by_class = {
            field["fieldClass"]: field for field in reordered["pendingFields"]
        }
        self.assertEqual(by_class["general"]["reference"], approved_reference)
        self.assertNotEqual(
            by_class["identity"]["reference"], approved_reference
        )
        self.assertEqual(
            [approval["reference"] for approval in reordered["approvals"]],
            [approved_reference],
        )

        changed_question = self.store.save_claim_progress(
            ready["id"], acquired["token"], {
                "status": "active", "step": "questions",
                "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    **fields[0], "question": "A different visible question?",
                }],
            },
        )
        self.assertNotEqual(
            changed_question["pendingFields"][0]["reference"], approved_reference
        )
        self.assertEqual(changed_question["approvals"], [])

    def test_cleanup_preview_validation_and_merge_share_one_lock(self):
        winner = self.store.put_answer({
            "question": "Does the applicant have permission to work in this jurisdiction?",
            "state": "confirmed", "value": "PRIVATE WINNER",
        })
        duplicate = self.store.observe_answer({
            "question": "Is employment authorization available in the country?",
            "state": "missing",
        })
        preview = self.store.preview_answer_cleanup()
        proposal = preview["proposals"][0]
        packet = {
            "previewToken": preview["previewToken"],
            "winnerKey": proposal["winnerKey"],
            "duplicateKey": proposal["duplicateKey"],
            "winnerRevision": proposal["winnerRevision"],
            "duplicateRevision": proposal["duplicateRevision"],
        }
        entered = threading.Event()
        release = threading.Event()
        original = self.store._preview_answer_cleanup_document

        def paused_preview(document):
            result = original(document)
            entered.set()
            self.assertTrue(release.wait(timeout=3))
            return result

        with mock.patch.object(
            self.store, "_preview_answer_cleanup_document",
            side_effect=paused_preview,
        ), ThreadPoolExecutor(max_workers=2) as pool:
            approval = pool.submit(
                self.store.approve_answer_cleanup, packet, owner_confirmed=True
            )
            self.assertTrue(entered.wait(timeout=3))
            concurrent = pool.submit(
                self.store.put_answer,
                {
                    "question": "Does the applicant have work authorization in this jurisdiction?",
                    "state": "confirmed", "value": "PRIVATE THIRD",
                },
            )
            time.sleep(0.05)
            self.assertFalse(concurrent.done())
            release.set()
            self.assertTrue(approval.result(timeout=3)["approved"])
            self.assertIsNotNone(concurrent.result(timeout=3))
        self.assertEqual(
            self.store.get_answer(duplicate["key"])["redirectedFrom"],
            duplicate["key"],
        )
        self.assertIsNotNone(self.store.get_answer(winner["key"]))
