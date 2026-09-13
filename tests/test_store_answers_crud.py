from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_answer_key_normalization_alias_lookup_and_confirmed_reuse(self):
        first = STORE_MODULE.answer_key(
            "Are you AUTHORIZED to work in the U.S.?", {"country": "US"}
        )
        second = STORE_MODULE.answer_key(
            "  are you authorized—to work in the u.s.  ", {"country": "US"}
        )
        self.assertEqual(first, second)
        answer = self.store.put_answer(
            {
                "question": "Are you authorized to work in the U.S.?",
                "aliases": ["US work authorization"],
                "value": "Yes",
                "state": "confirmed",
                "source": "user",
                "scope": {"country": "US"},
                "sensitivity": "none",
            }
        )
        self.assertEqual(answer["state"], "confirmed")
        found = self.store.find_answer(
            "US work authorization", {"country": "US"}
        )
        self.assertEqual(found["value"], "Yes")
        self.assertIsNotNone(found["confirmedAt"])

    def test_all_answer_states_and_sensitive_consent(self):
        self.store.put_answer(
            {"question": "Preferred start date?", "state": "inferred", "value": "June"}
        )
        self.store.put_answer(
            {"question": "Security clearance?", "state": "missing", "value": None}
        )
        placeholder = self.store.put_answer(
            {"question": "Disability disclosure?", "state": "sensitive", "value": None}
        )
        self.assertNotIn("value", placeholder)
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.put_answer(
                {
                    "question": "Disability disclosure?",
                    "state": "sensitive",
                    "value": "Prefer not to answer",
                }
            )
        remembered = self.store.put_answer(
            {
                "question": "Disability disclosure?",
                "state": "sensitive",
                "value": "Prefer not to answer",
            },
            remember_sensitive=True,
            expected_revision=placeholder["revision"],
        )
        self.assertIn("rememberedWithConsentAt", remembered)
        self.assertNotIn("value", remembered)

    def test_answer_list_update_revisions_and_recoverable_delete(self):
        answer = self.store.put_answer(
            {
                "question": "Preferred start date?",
                "state": "confirmed",
                "value": "June",
                "aliases": ["Start date"],
            }
        )
        self.assertEqual(answer["revision"], 1)
        listed = self.store.list_answers()
        self.assertEqual([item["key"] for item in listed], [answer["key"]])
        self.assertNotIn("value", listed[0])
        self.assertTrue(listed[0]["hasValue"])
        updated = self.store.update_answer(
            answer["key"],
            {"value": "July", "aliases": ["Start date", "START DATE"]},
            expected_revision=answer["revision"],
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["value"], "July")
        self.assertEqual(updated["aliases"], ["start date"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_answer(
                answer["key"], {"value": "August"}, expected_revision=1
            )

        trashed = self.store.trash_answer(
            answer["key"], expected_revision=updated["revision"]
        )
        self.assertIsNone(self.store.get_answer(answer["key"]))
        self.assertEqual(
            self.store.get_answer(answer["key"], include_trashed=True), trashed
        )
        self.assertIsNone(self.store.find_answer("Preferred start date?", {}))
        restored = self.store.restore_answer(
            answer["key"], expected_revision=trashed["revision"]
        )
        trashed_again = self.store.trash_answer(
            answer["key"], expected_revision=restored["revision"]
        )
        self.assertEqual(
            self.store.delete_answer(
                answer["key"], expected_revision=trashed_again["revision"]
            ),
            {"deleted": True, "key": answer["key"]},
        )

    def test_answer_sensitive_update_requires_new_remember_consent(self):
        answer = self.store.put_answer(
            {
                "question": "Salary expectation?",
                "state": "sensitive",
                "value": "200K",
                "sensitivity": "high",
            },
            remember_sensitive=True,
        )
        unchanged = self.store.update_answer(
            answer["key"],
            {"aliases": ["Expected salary"]},
            expected_revision=answer["revision"],
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "remember consent"):
            self.store.update_answer(
                answer["key"],
                {"value": "250K"},
                expected_revision=unchanged["revision"],
            )
        changed = self.store.update_answer(
            answer["key"],
            {"value": "250K"},
            expected_revision=unchanged["revision"],
            remember_sensitive=True,
        )
        self.assertNotIn("value", changed)
        self.assertEqual(self.store.reveal_answer(answer["key"])["value"], "250K")
        self.assertIn("rememberedWithConsentAt", changed)

    def test_answer_permanent_delete_rejects_live_session_reference(self):
        answer = self.store.put_answer(
            {"question": "Portfolio?", "state": "confirmed", "value": "Yes"}
        )
        self.store.save_session(
            "active-job",
            {"status": "active", "answerKeys": [answer["key"]]},
        )
        trashed = self.store.trash_answer(
            answer["key"], expected_revision=answer["revision"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "active session"):
            self.store.delete_answer(
                answer["key"], expected_revision=trashed["revision"]
            )
        self.store.delete_session("active-job")
        self.assertTrue(
            self.store.delete_answer(
                answer["key"], expected_revision=trashed["revision"]
            )["deleted"]
        )

    def test_observed_answer_review_dedup_collision_and_legacy_status(self):
        observed = self.store.observe_answer(
            {"question": "Will you relocate?", "state": "missing", "scope": {"role": "engineering"}}
        )
        self.assertEqual((observed["reviewStatus"], observed["observationCount"]), ("pending", 1))
        repeated = self.store.observe_answer(
            {"question": "Will you relocate!", "state": "missing", "scope": {"role": "engineering"}}
        )
        self.assertEqual((repeated["key"], repeated["observationCount"]), (observed["key"], 2))
        declined = self.store.review_answer(observed["key"], "declined", repeated["revision"])
        deduplicated = self.store.observe_answer(
            {"question": "Will you relocate?", "state": "missing", "scope": {"role": "engineering"}}
        )
        self.assertEqual((deduplicated["reviewStatus"], deduplicated["observationCount"]), ("declined", 3))
        self.assertEqual(self.store.list_answers(), [])
        self.assertEqual(self.store.list_answers(review_status="declined")[0]["key"], declined["key"])

        other = self.store.put_answer(
            {"question": "Preferred location?", "aliases": ["Where do you want to work?"], "state": "missing"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "collides within scope"):
            self.store.put_answer(
                {"question": "Another question?", "aliases": ["WHERE DO YOU WANT TO WORK"], "state": "missing"}
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "expected revision"):
            self.store.put_answer(
                {"question": "Preferred location?", "state": "missing", "key": other["key"]}
            )

        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        document["answers"][other["key"]].pop("reviewStatus", None)
        self.store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        legacy = self.store.get_answer(other["key"])
        self.assertEqual((legacy["reviewStatus"], legacy["key"], legacy["scope"]), ("accepted", other["key"], {}))

    def test_observation_resolves_retired_computed_key_without_resurrection(self):
        winner = self.store.put_answer(
            {"question": "Canonical relocation answer?", "state": "confirmed", "value": "Yes"}
        )
        source = self.store.put_answer(
            {"question": "Can you relocate?", "state": "missing"}
        )
        merged = self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )

        # Remove the transferred source identity so only the immutable redirect,
        # rather than the normal candidate scan, can resolve this observation.
        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        document["answers"][winner["key"]]["aliases"] = []
        self.store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        self.assertNotIn(
            STORE_MODULE.normalize_question("Can you relocate?"),
            self.store._answer_candidates(document["answers"][winner["key"]]),
        )
        found = self.store.find_answer("Can you relocate?")
        self.assertEqual(
            (found["key"], found["redirectedFrom"]),
            (winner["key"], source["key"]),
        )

        observed = self.store.observe_answer(
            {"question": "Can you relocate?", "state": "missing"}
        )

        self.assertEqual(observed["key"], winner["key"])
        self.assertEqual(observed["observationCount"], merged["observationCount"] + 1)
        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        self.assertNotIn(source["key"], document["answers"])
        self.assertEqual(document["redirects"][source["key"]]["targetKey"], winner["key"])

    def test_retired_computed_identity_cannot_be_reclaimed_by_explicit_key(self):
        winner = self.store.put_answer(
            {"question": "Canonical relocation answer?", "state": "confirmed", "value": "Yes"}
        )
        source = self.store.put_answer(
            {"question": "Can you relocate?", "state": "missing"}
        )
        merged = self.store.merge_answers(
            winner["key"], source["key"], winner["revision"], source["revision"]
        )
        updated = self.store.update_answer(
            winner["key"], {"aliases": []}, merged["revision"]
        )

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "retired redirect identity"):
            self.store.put_answer(
                {
                    "key": "explicit.relocation",
                    "question": "Can you relocate?",
                    "state": "missing",
                }
            )

        found = self.store.find_answer("Can you relocate?")
        self.assertEqual((found["key"], found["redirectedFrom"]), (winner["key"], source["key"]))
        self.assertEqual(self.store.get_answer(winner["key"])["revision"], updated["revision"])

    def test_boolean_and_number_scopes_are_distinct_for_answers_and_merge(self):
        boolean = self.store.put_answer(
            {"question": "Scope identity?", "scope": {"flag": True}, "state": "missing"}
        )
        number = self.store.put_answer(
            {"question": "Scope identity?", "scope": {"flag": 1}, "state": "missing"}
        )

        self.assertNotEqual(boolean["key"], number["key"])
        self.assertEqual(self.store.find_answer("Scope identity?", {"flag": True})["key"], boolean["key"])
        self.assertEqual(self.store.find_answer("Scope identity?", {"flag": 1})["key"], number["key"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "exact matching scope"):
            self.store.merge_answers(
                boolean["key"], number["key"], boolean["revision"], number["revision"]
            )

    def test_existing_put_cannot_rewrite_observation_or_review_metadata(self):
        observed = self.store.observe_answer(
            {"question": "Have you used Python?", "state": "missing"}
        )
        updated = self.store.put_answer(
            {
                "key": observed["key"],
                "question": observed["question"],
                "state": "missing",
                "observationCount": 999,
                "observedAt": "1900-01-01T00:00:00Z",
                "lastObservedAt": "2999-01-01T00:00:00Z",
                "reviewedAt": "1900-01-01T00:00:00Z",
            },
            expected_revision=observed["revision"],
        )

        self.assertEqual(updated["observationCount"], observed["observationCount"])
        self.assertEqual(updated["observedAt"], observed["observedAt"])
        self.assertEqual(updated["lastObservedAt"], observed["lastObservedAt"])
        self.assertNotIn("reviewedAt", updated)

    def test_legacy_blank_questions_are_ignored_during_candidate_scans(self):
        legacy = self.store.put_answer(
            {"key": "legacy.questionless", "question": "   ", "state": "missing"}
        )

        created = self.store.put_answer(
            {"question": "Current candidate?", "state": "missing"}
        )
        observed = self.store.observe_answer(
            {"question": "Another current candidate?", "state": "missing"}
        )

        self.assertEqual(self.store.get_answer(legacy["key"])["question"], "   ")
        self.assertEqual(self.store.find_answer("Current candidate?")["key"], created["key"])
        self.assertEqual(observed["reviewStatus"], "pending")

    def test_non_string_review_statuses_raise_safe_store_errors(self):
        answer = self.store.put_answer(
            {"question": "Review status validation?", "state": "missing"}
        )

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "review status is unsupported"):
            self.store.query_answers(review_status=[])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "state is unsupported"):
            self.store.query_answers(state=[])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "decision must be accepted or declined"):
            self.store.review_answer(answer["key"], {}, answer["revision"])

        document = json.loads(self.store.answers_path.read_text(encoding="utf-8"))
        document["answers"][answer["key"]]["reviewStatus"] = []
        self.store.answers_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "review status is unsupported"):
            self.store.list_answers()

    def test_answer_put_preserves_existing_review_status_with_exact_revision(self):
        pending = self.store.observe_answer(
            {"question": "Put review boundary?", "state": "missing"}
        )
        pending_updated = self.store.put_answer(
            {
                "key": pending["key"],
                "question": pending["question"],
                "state": "confirmed",
                "value": "draft",
                "reviewStatus": "accepted",
            },
            expected_revision=pending["revision"],
        )
        self.assertEqual(
            (
                pending_updated["reviewStatus"],
                pending_updated["revision"],
                pending_updated["observationCount"],
                pending_updated["observedAt"],
            ),
            ("pending", pending["revision"] + 1, 1, pending["observedAt"]),
        )

        accepted = self.store.put_answer(
            {
                "question": "Accepted put review boundary?",
                "state": "confirmed",
                "value": "canonical",
            }
        )
        for attempted_status, value in (
            ("declined", "decline attempt"),
            ("pending", "pending attempt"),
        ):
            accepted = self.store.put_answer(
                {
                    "key": accepted["key"],
                    "question": accepted["question"],
                    "state": "confirmed",
                    "value": value,
                    "reviewStatus": attempted_status,
                },
                expected_revision=accepted["revision"],
            )
            self.assertEqual(accepted["reviewStatus"], "accepted")

        for attempted_status in ("declined", "pending"):
            with self.assertRaisesRegex(
                STORE_MODULE.StoreError, "created through put must have accepted"
            ):
                self.store.put_answer(
                    {
                        "question": f"New {attempted_status} put behavior?",
                        "state": "missing",
                        "reviewStatus": attempted_status,
                    }
                )
