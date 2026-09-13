from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_default_lookup_is_accepted_only_and_sensitive_non_reveal_paths_are_strict(self):
        pending = self.store.observe_answer(
            {"question": "Pending lookup?", "state": "inferred", "value": "draft"}
        )
        self.assertIsNone(self.store.find_answer("Pending lookup?", {}))
        declined = self.store.review_answer(
            pending["key"], "declined", pending["revision"]
        )
        self.assertIsNone(self.store.find_answer("Pending lookup?", {}))
        self.assertEqual(declined["reviewStatus"], "declined")

        secret = "strictly-private-answer"
        created = self.store.put_answer(
            {
                "question": "Sensitive lookup?",
                "state": "sensitive",
                "value": secret,
                "sensitivity": "high",
            },
            remember_sensitive=True,
        )
        for result in (
            created,
            self.store.get_answer(created["key"]),
            self.store.find_answer("Sensitive lookup?", {}),
            self.store.list_answers(),
        ):
            self.assertNotIn(secret, json.dumps(result))
        self.assertEqual(self.store.reveal_answer(created["key"])["value"], secret)

    def test_derived_key_resolution_never_crosses_current_exact_scope(self):
        direct = self.store.put_answer(
            {
                "question": "Scope-edited direct identity?",
                "state": "confirmed",
                "value": "direct",
                "scope": {"country": "US"},
            }
        )
        direct = self.store.update_answer(
            direct["key"], {"scope": {"country": "CA"}}, direct["revision"]
        )
        self.assertIsNone(
            self.store.find_answer(
                "Scope-edited direct identity?", {"country": "US"}
            )
        )
        before_direct_observe = self.store.answers_path.read_bytes()
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "derived key is occupied by a different scope"
        ):
            self.store.observe_answer(
                {
                    "question": "Scope-edited direct identity?",
                    "state": "missing",
                    "scope": {"country": "US"},
                }
            )
        self.assertEqual(self.store.answers_path.read_bytes(), before_direct_observe)
        self.assertEqual(
            self.store.get_answer(direct["key"])["scope"], {"country": "CA"}
        )

        winner = self.store.put_answer(
            {
                "question": "Scope-edited redirect winner?",
                "state": "confirmed",
                "value": "winner",
                "scope": {"country": "US"},
            }
        )
        source = self.store.put_answer(
            {
                "question": "Scope-edited redirect source?",
                "state": "missing",
                "scope": {"country": "US"},
            }
        )
        winner = self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )
        winner = self.store.update_answer(
            winner["key"], {"scope": {"country": "GB"}}, winner["revision"]
        )
        self.assertIsNone(
            self.store.find_answer(
                "Scope-edited redirect source?", {"country": "US"}
            )
        )
        before_redirect_observe = self.store.answers_path.read_bytes()
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "derived key is occupied by a different scope"
        ):
            self.store.observe_answer(
                {
                    "question": "Scope-edited redirect source?",
                    "state": "missing",
                    "scope": {"country": "US"},
                }
            )
        self.assertEqual(self.store.answers_path.read_bytes(), before_redirect_observe)
        self.assertEqual(
            self.store.get_answer(winner["key"])["scope"], {"country": "GB"}
        )

    def test_concurrent_observation_ingestion_is_additive_and_preserves_canonical_fields(self):
        accepted = self.store.put_answer(
            {
                "question": "Concurrent observation?",
                "state": "confirmed",
                "value": "canonical",
                "source": "user",
            }
        )

        def observe(_index):
            return STORE_MODULE.Store(self.root, self.legacy).observe_answer(
                {
                    "question": "Concurrent observation!",
                    "state": "missing",
                    "source": "agent",
                }
            )

        with ThreadPoolExecutor(max_workers=8) as executor:
            results = list(executor.map(observe, range(16)))
        final = self.store.get_answer(accepted["key"])
        self.assertEqual(final["observationCount"], 16)
        self.assertEqual((final["state"], final["value"], final["source"]), ("confirmed", "canonical", "user"))
        self.assertEqual(len({item["revision"] for item in results}), 16)

    def test_answer_query_filters_trashed_records_before_stable_pagination(self):
        answers = [
            self.store.put_answer(
                {"question": f"Paged answer {index}?", "state": "confirmed", "value": str(index)}
            )
            for index in range(5)
        ]
        for answer in answers[1:4]:
            self.store.trash_answer(answer["key"], answer["revision"])
        first = self.store.query_answers(
            review_status=None, include_trashed=True, trashed_only=True, offset=0, limit=2
        )
        second = self.store.query_answers(
            review_status=None, include_trashed=True, trashed_only=True, offset=2, limit=2
        )
        self.assertEqual((first["total"], first["hasMore"], second["hasMore"]), (3, True, False))
        self.assertEqual(
            [item["key"] for item in first["items"] + second["items"]],
            [answer["key"] for answer in answers[1:4]],
        )

    def test_answer_projection_redacts_values_counts_references_and_history_blocks_delete(self):
        answer = self.store.put_answer(
            {"question": "Compensation?", "state": "sensitive", "value": "private salary", "sensitivity": "high"},
            remember_sensitive=True,
        )
        self.store.save_session("answer-session", {"status": "active", "answerKeys": [answer["key"]]})
        self.store.append_history({"applicationId": "answer-history", "event": "reviewed", "answerKeys": [answer["key"]]})
        projection = self.store.query_answers()
        self.assertNotIn("private salary", json.dumps(projection))
        self.assertEqual(projection["items"][0]["referenceCounts"], {"sessions": 1, "history": 1, "total": 2})
        self.assertEqual(self.store.reveal_answer(answer["key"])["value"], "private salary")
        trashed = self.store.trash_answer(answer["key"], answer["revision"])
        self.store.delete_session("answer-session")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "application history"):
            self.store.delete_answer(answer["key"], trashed["revision"])

    def test_history_append_and_permanent_answer_delete_are_serialized(self):
        append_first = self.store.put_answer(
            {"question": "Append wins deletion race?", "state": "missing"}
        )
        append_first = self.store.trash_answer(
            append_first["key"], append_first["revision"]
        )
        append_entered = threading.Event()
        allow_append = threading.Event()
        original_append = self.store._append_history_event_idempotent_locked

        def paused_append(event):
            append_entered.set()
            self.assertTrue(allow_append.wait(timeout=2))
            original_append(event)

        with mock.patch.object(
            self.store,
            "_append_history_event_idempotent_locked",
            side_effect=paused_append,
        ):
            with ThreadPoolExecutor(max_workers=2) as executor:
                append_future = executor.submit(
                    self.store.append_history,
                    {
                        "applicationId": "append-wins",
                        "event": "reviewed",
                        "answerKeys": [append_first["key"]],
                    },
                )
                self.assertTrue(append_entered.wait(timeout=2))
                delete_future = executor.submit(
                    self.store.delete_answer,
                    append_first["key"],
                    append_first["revision"],
                )
                time.sleep(0.05)
                self.assertFalse(delete_future.done())
                allow_append.set()
                self.assertEqual(append_future.result()["answerKeys"], [append_first["key"]])
                with self.assertRaisesRegex(STORE_MODULE.StoreError, "application history"):
                    delete_future.result()

        delete_first = self.store.put_answer(
            {"question": "Deletion wins append race?", "state": "missing"}
        )
        delete_first = self.store.trash_answer(
            delete_first["key"], delete_first["revision"]
        )
        self.assertTrue(
            self.store.delete_answer(delete_first["key"], delete_first["revision"])["deleted"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "existing answer"):
            self.store.append_history(
                {
                    "applicationId": "delete-wins",
                    "event": "reviewed",
                    "answerKeys": [delete_first["key"]],
                }
            )
