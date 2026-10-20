from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_answer_merge_preserves_winner_redirects_history_and_recovers_sessions(self):
        winner = self.store.put_answer(
            {
                "question": "Canonical compensation preference?",
                "aliases": ["preferred compensation"],
                "state": "sensitive",
                "value": "winner-private-value",
                "sensitivity": "high",
                "scope": {"country": "US"},
                "source": "user",
                "observationCount": 2,
                "observedAt": "2026-08-20T00:00:00Z",
                "lastObservedAt": "2026-08-22T00:00:00Z",
            },
            remember_sensitive=True,
        )
        source = self.store.put_answer(
            {
                "question": "What compensation do you expect?",
                "aliases": ["salary expectation"],
                "state": "confirmed",
                "value": "discarded-source-value",
                "scope": {"country": "US"},
                "source": "agent",
                "observationCount": 3,
                "observedAt": "2026-08-18T00:00:00Z",
                "lastObservedAt": "2026-08-24T00:00:00Z",
            }
        )
        winner_before = self.store.reveal_answer(winner["key"])
        self.store.save_session(
            "merge-session",
            {
                "status": "active",
                "answerKeys": [source["key"], winner["key"], source["key"]],
                "pendingFields": [
                    {"question": "Compensation?", "answerKey": source["key"]}
                ],
            },
        )
        self.store.append_history(
            {
                "applicationId": "merge-history",
                "event": "reviewed",
                "answerKeys": [source["key"]],
            }
        )

        real_atomic_write = STORE_MODULE.atomic_write_json
        interrupted = False

        def interrupt_session_write(path, payload):
            nonlocal interrupted
            if path == self.store._session_path("merge-session") and not interrupted:
                interrupted = True
                raise OSError("simulated merge interruption")
            return real_atomic_write(path, payload)

        with mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=interrupt_session_write):
            with self.assertRaisesRegex(OSError, "simulated merge interruption"):
                self.store.merge_answers(
                    winner["key"], source["key"], winner["revision"], source["revision"]
                )

        journal_text = self.store.coordinator_journal_path.read_text(encoding="utf-8")
        self.assertNotIn("winner-private-value", journal_text)
        self.assertNotIn("discarded-source-value", journal_text)
        recovered = STORE_MODULE.Store(self.root, self.legacy)
        recovered.initialize()
        merged = recovered.get_answer(winner["key"])
        self.assertEqual((merged["revision"], merged["observationCount"]), (2, 5))
        self.assertEqual((merged["observedAt"], merged["lastObservedAt"]), (
            "2026-08-18T00:00:00Z", "2026-08-24T00:00:00Z"
        ))
        self.assertEqual(recovered.reveal_answer(winner["key"])["value"], "winner-private-value")
        self.assertEqual(recovered.reveal_answer(winner["key"])["source"], winner_before["source"])
        self.assertEqual(
            recovered.reveal_answer(winner["key"])["rememberedWithConsentAt"],
            winner_before["rememberedWithConsentAt"],
        )
        self.assertNotIn("discarded-source-value", recovered.answers_path.read_text(encoding="utf-8"))
        redirected = recovered.get_answer(source["key"])
        self.assertEqual((redirected["key"], redirected["redirectedFrom"]), (winner["key"], source["key"]))
        self.assertIn("what compensation do you expect", merged["aliases"])
        session = recovered.load_session("merge-session")
        self.assertEqual(session["answerKeys"], [winner["key"]])
        self.assertEqual(session["pendingFields"][0]["answerKey"], winner["key"])
        self.assertEqual(merged["referenceCounts"], {"sessions": 1, "history": 1, "total": 2})
        self.assertEqual(recovered.read_history()[0]["answerKeys"], [source["key"]])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "immutable redirect"):
            recovered.trash_answer(winner["key"], merged["revision"])
        self.assertIsNone(recovered.get_answer(winner["key"])["deletedAt"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "cannot be resurrected"):
            recovered.put_answer(
                {"key": source["key"], "question": "Resurrect?", "state": "confirmed", "value": "No"}
            )
        invalid = json.loads(recovered.answers_path.read_text(encoding="utf-8"))
        invalid["answers"][winner["key"]]["deletedAt"] = "2026-08-25T00:00:00Z"
        recovered.answers_path.write_text(json.dumps(invalid), encoding="utf-8")
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "flattened to an active answer"
        ):
            recovered.get_answer(winner["key"], include_trashed=True)

    def test_answer_merge_acknowledges_from_precommit_projection_without_winner_reread(self):
        winner = self.store.put_answer(
            {"question": "Merge acknowledgment winner?", "state": "confirmed", "value": "winner"}
        )
        source = self.store.put_answer(
            {"question": "Merge acknowledgment source?", "state": "missing"}
        )

        with mock.patch.object(
            self.store,
            "_get_answer_record",
            side_effect=OSError("synthetic post-commit winner reread failure"),
        ):
            merged = self.store.merge_answers(
                winner["key"], source["key"], winner["revision"], source["revision"]
            )

        self.assertEqual((merged["key"], merged["mergedFrom"]), (winner["key"], source["key"]))
        self.assertEqual(merged["revision"], winner["revision"] + 1)

    def test_get_answer_resolves_redirect_and_detail_from_one_document_snapshot(self):
        winner = self.store.put_answer(
            {"question": "Snapshot winner?", "state": "confirmed", "value": "winner"}
        )
        source = self.store.put_answer(
            {"question": "Snapshot source?", "state": "confirmed", "value": "source"}
        )
        before_merge = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )
        after_merge = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        snapshots = [after_merge, before_merge]

        with (
            mock.patch.object(self.store, "initialize"),
            mock.patch.object(
                self.store,
                "_load_answers_document",
                side_effect=lambda: snapshots.pop(0),
            ) as load_document,
        ):
            detail = self.store.get_answer(source["key"])

        self.assertEqual(load_document.call_count, 1)
        self.assertEqual(
            (detail["key"], detail["redirectedFrom"], detail["value"]),
            (winner["key"], source["key"], "winner"),
        )

    def test_answer_reveal_find_and_collections_use_one_answers_snapshot_during_merge(self):
        winner = self.store.put_answer(
            {
                "question": "Concurrent snapshot winner?",
                "state": "sensitive",
                "value": "winner-private-snapshot",
                "sensitivity": "high",
            },
            remember_sensitive=True,
        )
        source = self.store.put_answer(
            {"question": "Concurrent snapshot source?", "state": "missing"}
        )
        self.store.append_history(
            {
                "applicationId": "concurrent-snapshot-history",
                "event": "reviewed",
                "answerKeys": [source["key"]],
            }
        )
        before_merge = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )
        after_merge = json.loads(self.store.answers_path.read_text(encoding="utf-8"))

        def from_concurrent_snapshots(operation):
            snapshots = [after_merge, before_merge]
            with (
                mock.patch.object(self.store, "initialize"),
                mock.patch.object(
                    self.store,
                    "_load_answers_document",
                    side_effect=lambda: snapshots.pop(0),
                ) as load_document,
            ):
                projected = operation()
            self.assertEqual(load_document.call_count, 1)
            return projected

        revealed = from_concurrent_snapshots(
            lambda: self.store.reveal_answer(source["key"])
        )
        self.assertEqual(
            (revealed["key"], revealed["redirectedFrom"], revealed["value"]),
            (winner["key"], source["key"], "winner-private-snapshot"),
        )
        self.assertEqual(
            revealed["referenceCounts"], {"sessions": 0, "history": 1, "total": 1}
        )

        found = from_concurrent_snapshots(
            lambda: self.store.find_answer("Concurrent snapshot source?", {})
        )
        self.assertEqual(found["key"], winner["key"])
        self.assertEqual(
            found["referenceCounts"], {"sessions": 0, "history": 1, "total": 1}
        )
        self.assertNotIn("value", found)

        listed = from_concurrent_snapshots(lambda: self.store.list_answers())
        self.assertEqual([item["key"] for item in listed], [winner["key"]])
        self.assertEqual(
            listed[0]["referenceCounts"], {"sessions": 0, "history": 1, "total": 1}
        )

        queried = from_concurrent_snapshots(lambda: self.store.query_answers())
        self.assertEqual([item["key"] for item in queried["items"]], [winner["key"]])
        self.assertEqual(
            queried["items"][0]["referenceCounts"],
            {"sessions": 0, "history": 1, "total": 1},
        )

    def test_answer_merge_rejects_scope_stale_and_third_record_collision_before_mutation(self):
        winner = self.store.put_answer(
            {"question": "Winner?", "state": "confirmed", "value": "winner", "scope": {"x": 1}}
        )
        source = self.store.put_answer(
            {"question": "Source?", "state": "confirmed", "value": "source", "scope": {"x": 1}}
        )
        other_scope = self.store.put_answer(
            {"question": "Other scope?", "state": "confirmed", "value": "other", "scope": {"x": 2}}
        )
        before = self.store.answers_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "exact matching scope"):
            self.store.merge_answers(winner["key"], other_scope["key"], winner["revision"], other_scope["revision"])
        self.assertEqual(self.store.answers_path.read_bytes(), before)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.merge_answers(winner["key"], source["key"], winner["revision"] + 1, source["revision"])
        self.assertEqual(self.store.answers_path.read_bytes(), before)

        third = self.store.put_answer(
            {"question": "Third?", "state": "confirmed", "value": "third", "scope": {"x": 1}}
        )
        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        document["answers"][third["key"]]["aliases"] = ["Source?"]
        self.store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        collision_before = self.store.answers_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "collides within scope"):
            self.store.merge_answers(winner["key"], source["key"], winner["revision"], source["revision"])
        self.assertEqual(self.store.answers_path.read_bytes(), collision_before)

    def test_repeated_answer_merges_flatten_every_inbound_redirect(self):
        first = self.store.put_answer(
            {"question": "First duplicate?", "state": "confirmed", "value": "first"}
        )
        second = self.store.put_answer(
            {"question": "Second duplicate?", "state": "confirmed", "value": "second"}
        )
        final = self.store.put_answer(
            {"question": "Final canonical?", "state": "confirmed", "value": "final"}
        )
        self.store.save_session(
            "flattened-redirect-session",
            {"status": "active", "answerKeys": [first["key"]]},
        )
        self.store.append_history(
            {
                "applicationId": "flattened-redirect-history",
                "event": "reviewed",
                "answerKeys": [first["key"]],
            }
        )

        second = self.store.merge_answers(
            second["key"], first["key"], second["revision"], first["revision"]
        )
        final = self.store.merge_answers(
            final["key"], second["key"], final["revision"], second["revision"]
        )

        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        self.assertEqual(
            {key: redirect["targetKey"] for key, redirect in document["redirects"].items()},
            {first["key"]: final["key"], second["key"]: final["key"]},
        )
        self.assertEqual(self.store.get_answer(first["key"])["key"], final["key"])
        self.assertEqual(self.store.load_session("flattened-redirect-session")["answerKeys"], [final["key"]])
        self.assertEqual(final["referenceCounts"], {"sessions": 1, "history": 1, "total": 2})

    def test_generic_answer_update_cannot_change_review_status(self):
        pending = self.store.observe_answer(
            {"question": "Review transition only?", "state": "missing"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unsupported fields"):
            self.store.update_answer(
                pending["key"],
                {"reviewStatus": "accepted"},
                pending["revision"],
            )
        accepted = self.store.review_answer(
            pending["key"], "accepted", pending["revision"]
        )
        self.assertEqual(accepted["reviewStatus"], "accepted")

    def test_answer_mutation_projection_scans_references_before_commit(self):
        answer = self.store.put_answer(
            {
                "question": "Precommit reference projection?",
                "state": "sensitive",
                "value": "private-reference-value",
                "sensitivity": "high",
            },
            remember_sensitive=True,
        )
        self.store.save_session(
            "precommit-projection-session",
            {"status": "active", "answerKeys": [answer["key"]]},
        )
        self.store.append_history(
            {
                "applicationId": "precommit-projection-history",
                "event": "reviewed",
                "answerKeys": [answer["key"]],
            }
        )
        original_counts = self.store._answer_reference_counts

        def reject_postcommit_scan(*args, **kwargs):
            persisted = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
            if persisted["answers"][answer["key"]].get("revision", 1) > answer["revision"]:
                raise OSError("synthetic post-commit reference failure")
            return original_counts(*args, **kwargs)

        with mock.patch.object(
            self.store, "_answer_reference_counts", side_effect=reject_postcommit_scan
        ):
            updated = self.store.update_answer(
                answer["key"], {"aliases": ["Projection alias"]}, answer["revision"]
            )
        self.assertEqual(updated["referenceCounts"], {"sessions": 1, "history": 1, "total": 2})
        self.assertTrue(updated["valueRedacted"])
        self.assertNotIn("value", updated)

    def test_profile_noop_and_answer_delete_do_not_reenter_coordinator_lock(self):
        self.store.replace_profile(
            {"firstName": "Ada"}, expected_revision=0, source="user"
        )
        self.store.claim_status()
        before = self.store.inspect_profile()
        unchanged = self.store.patch_profile(
            {"firstName": "Ada"}, before["revision"], "user"
        )
        self.assertEqual(unchanged, before)

        answer = self.store.put_answer(
            {"question": "Portfolio?", "state": "confirmed", "value": "Yes"}
        )
        trashed = self.store.trash_answer(answer["key"], answer["revision"])
        self.assertTrue(
            self.store.delete_answer(answer["key"], trashed["revision"])["deleted"]
        )

    def test_tampered_sensitive_answer_without_consent_fails_closed(self):
        self.store.initialize()
        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        document["answers"]["sensitive.example"] = {
            "key": "sensitive.example",
            "question": "Sensitive question?",
            "aliases": [],
            "value": "private",
            "state": "sensitive",
            "source": "user",
            "scope": {},
            "sensitivity": "high",
            "confirmedAt": None,
            "updatedAt": "2026-07-18T00:00:00Z",
        }
        self.store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.get_answer("sensitive.example")

    def test_answer_merge_cannot_transfer_source_approval_on_revision_collision(self):
        ready = self._make_ready_job()
        winner = self.store.put_answer({
            "question": "Preferred winner?", "state": "confirmed",
            "value": "WINNER PRIVATE VALUE",
        })
        source = self.store.put_answer({
            "question": "Source answer?", "state": "confirmed",
            "value": "SOURCE PRIVATE VALUE",
        })
        source = self.store.update_answer(
            source["key"], {"aliases": ["source alias"]}, source["revision"]
        )
        self.assertEqual(source["revision"], winner["revision"] + 1)
        acquired = self.store.acquire_ready_job(
            ready["id"], "merge-approval", ready["revision"]
        )
        handed = self.store.handoff_claimed_job(
            ready["id"], acquired["token"], "needs_info", {
                "status": "active", "attemptRevision": acquired["job"]["revision"],
                "pendingFields": [{
                    "question": "Source answer?", "state": "missing",
                    "answerKey": source["key"], "sensitive": False,
                    "fieldClass": "general",
                }],
            }, acquired["job"]["revision"],
        )
        activity = self.store.get_job_activity(ready["id"])
        decision = [{
            "reference": activity["session"]["pendingInformation"][0]["reference"],
            "answerKey": source["key"], "currentUse": True, "remember": False,
            "policyMode": "strict", "useAuthority": "accepted_record",
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
        self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )
        merged_activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(merged_activity["session"]["approvals"], [])
        self.assertEqual(
            merged_activity["session"]["pendingInformation"][0]["answerKey"],
            winner["key"],
        )
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "semantic match is stale"
        ):
            self.store.preview_grouped_approval(
                ready["id"], handed["job"]["revision"],
                merged_activity["session"]["revision"], [{
                    **decision[0], "answerKey": winner["key"],
                }],
            )
