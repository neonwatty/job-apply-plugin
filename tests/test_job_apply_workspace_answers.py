from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
    def test_answer_api_redaction_review_conflict_reveal_and_history_guard(self):
        status, _headers, observed = self.request(
            "POST", "/api/answers/observe",
            {"answer": {"question": "Observed browser question?", "state": "missing", "scope": {"ats": "test"}}},
        )
        self.assertEqual((status, observed["reviewStatus"]), (200, "pending"))
        status, _headers, inbox = self.request(
            "POST", "/api/answers/query", {"reviewStatus": "pending"}
        )
        self.assertEqual((status, inbox["total"], inbox["items"][0]["key"]), (200, 1, observed["key"]))
        self.assertNotIn("value", inbox["items"][0])
        status, _headers, accepted = self.request(
            "POST", f"/api/answers/{observed['key']}/accept",
            {"expectedRevision": observed["revision"], "patch": {"state": "confirmed", "value": "Yes"}},
        )
        self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))
        status, _headers, conflict = self.request(
            "PATCH", f"/api/answers/{observed['key']}",
            {"expectedRevision": observed["revision"], "patch": {"aliases": ["old"]}},
        )
        self.assertEqual((status, conflict["error"]["code"]), (409, "revision_conflict"))

        status, _headers, sensitive = self.request(
            "POST", "/api/answers",
            {"answer": {"question": "Private answer?", "state": "sensitive", "value": "browser secret", "sensitivity": "high"}, "rememberSensitive": True},
        )
        self.assertEqual(status, 200, sensitive)
        status, _headers, library = self.request("GET", "/api/answers", origin=False)
        self.assertEqual(status, 200)
        self.assertNotIn("browser secret", json.dumps(library))
        self.assertTrue(all("value" not in item for item in library["items"]))
        status, _headers, detail = self.request("GET", f"/api/answers/{sensitive['key']}", origin=False)
        self.assertEqual(status, 200)
        self.assertNotIn("value", detail)
        status, _headers, revealed = self.request("POST", f"/api/answers/{sensitive['key']}/reveal", {})
        self.assertEqual((status, revealed["value"]), (200, "browser secret"))
        status, _headers, rejected = self.request(
            "PATCH", f"/api/answers/{sensitive['key']}",
            {"expectedRevision": sensitive["revision"], "patch": {"value": "changed secret"}},
        )
        self.assertEqual(status, 400, rejected)

        self.server.store.append_history({"applicationId": "browser-answer", "event": "reviewed", "answerKeys": [accepted["key"]]})
        status, _headers, trashed = self.request("POST", f"/api/answers/{accepted['key']}/trash", {"expectedRevision": accepted["revision"]})
        self.assertEqual(status, 200)
        status, _headers, blocked = self.request("POST", f"/api/answers/{accepted['key']}/delete", {"expectedRevision": trashed["revision"]})
        self.assertEqual((status, blocked["error"]["code"]), (409, "history_reference_blocked"))
        self.assertEqual(
            (blocked["error"]["recordType"], blocked["error"]["operation"], blocked["error"]["counts"]),
            ("answer", "delete", {"sessions": 0, "history": 1}),
        )
        self.assertNotIn("Yes", json.dumps(blocked))

    def test_semantic_lookup_and_cleanup_api_are_value_free_preview_then_explicit_approval(self):
        status, _headers, winner = self.request(
            "POST", "/api/answers",
            {"answer": {
                "question": "Does the applicant have permission to work in this jurisdiction?",
                "state": "confirmed", "value": "PRIVATE WORKSPACE ANSWER",
                "scope": {},
            }},
        )
        self.assertEqual(status, 200)
        status, _headers, duplicate = self.request(
            "POST", "/api/answers/observe",
            {"answer": {
                "question": "Is employment authorization available in the country?",
                "state": "missing", "scope": {},
            }},
        )
        self.assertEqual(status, 200)
        status, _headers, lookup = self.request(
            "POST", "/api/answers/semantic",
            {
                "question": "Is employment authorization available in the country?",
                "scope": {}, "fieldClass": "general", "sensitivity": "none",
                "mode": "strict", "useAuthority": "accepted_record", "limit": 5,
            },
        )
        self.assertEqual(status, 200)
        self.assertTrue(lookup["candidates"])
        self.assertNotIn("PRIVATE WORKSPACE ANSWER", json.dumps(lookup))

        status, _headers, preview = self.request(
            "GET", "/api/answers/cleanup-preview", origin=False
        )
        self.assertEqual((status, len(preview["proposals"])), (200, 1))
        proposal = preview["proposals"][0]
        approval = {
            "previewToken": preview["previewToken"],
            "winnerKey": proposal["winnerKey"],
            "duplicateKey": proposal["duplicateKey"],
            "winnerRevision": proposal["winnerRevision"],
            "duplicateRevision": proposal["duplicateRevision"],
        }
        status, _headers, _rejected = self.request(
            "POST", "/api/answers/cleanup-approve",
            {"approval": approval, "ownerConfirmed": False},
        )
        self.assertEqual(status, 400)
        status, _headers, approved = self.request(
            "POST", "/api/answers/cleanup-approve",
            {"approval": approval, "ownerConfirmed": True},
        )
        self.assertEqual((status, approved["approved"]), (200, True))
        redirected = self.server.store.get_answer(duplicate["key"])
        self.assertEqual(redirected["key"], winner["key"])

    def test_encoded_answer_routes_round_trip_dot_only_keys_without_weakening_guards(self):
        answer = self.server.store.put_answer({"key": "..", "state": "missing"})
        encoded = base64.urlsafe_b64encode(answer["key"].encode()).decode().rstrip("=")
        route = f"/api/answers/by-key/{encoded}"

        status, _headers, detail = self.request("GET", route, origin=False)
        self.assertEqual((status, detail["key"]), (200, ".."))
        status, _headers, unauthorized = self.request(
            "GET", route, token=False, origin=False
        )
        self.assertEqual((status, unauthorized["error"]["code"]), (401, "token_rejected"))
        status, _headers, rejected = self.request(
            "PATCH",
            route,
            {"patch": {"aliases": ["dot key"]}, "expectedRevision": answer["revision"]},
            origin=False,
        )
        self.assertEqual((status, rejected["error"]["code"]), (403, "origin_rejected"))
        status, _headers, updated = self.request(
            "PATCH",
            route,
            {"patch": {"aliases": ["dot key"]}, "expectedRevision": answer["revision"]},
        )
        self.assertEqual((status, updated["key"], updated["aliases"]), (200, "..", ["dot key"]))
        status, _headers, trashed = self.request(
            "POST", f"{route}/trash", {"expectedRevision": updated["revision"]}
        )
        self.assertEqual((status, trashed["key"]), (200, ".."))
        status, _headers, restored = self.request(
            "POST", f"{route}/restore", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual((status, restored["key"], restored["deletedAt"]), (200, "..", None))
        status, _headers, malformed = self.request(
            "GET", "/api/answers/by-key/not%2Fa%2Fsegment", origin=False
        )
        self.assertEqual(status, 400, malformed)
        self.assertIn("invalid", malformed["error"]["message"])

    def test_answer_api_rejects_non_string_review_status_with_safe_error(self):
        status, _headers, body = self.request(
            "POST", "/api/answers/query", {"reviewStatus": []}
        )

        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "store_rejected")
        self.assertIn("review status is unsupported", body["error"]["message"])

        status, _headers, body = self.request(
            "POST", "/api/answers/query", {"state": []}
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(body["error"]["code"], "store_rejected")
        self.assertIn("state is unsupported", body["error"]["message"])

    def test_answer_api_accepts_draft_with_consent_and_filters_trash_before_pagination(self):
        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "Sensitive pending draft?", "state": "missing"}},
        )
        self.assertEqual(status, 200)
        secret = "accepted-private-draft"
        status, _headers, accepted = self.request(
            "POST",
            f"/api/answers/{pending['key']}/accept",
            {
                "expectedRevision": pending["revision"],
                "patch": {"state": "sensitive", "sensitivity": "high", "value": secret},
                "rememberSensitive": True,
            },
        )
        self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))
        self.assertNotIn(secret, json.dumps(accepted))
        self.assertEqual(self.server.store.reveal_answer(pending["key"])["value"], secret)

        trashed_keys = []
        for index in range(3):
            status, _headers, created = self.request(
                "POST",
                "/api/answers",
                {"answer": {"question": f"Trash page {index}?", "state": "confirmed", "value": str(index)}},
            )
            self.assertEqual(status, 200)
            status, _headers, trashed = self.request(
                "POST",
                f"/api/answers/{created['key']}/trash",
                {"expectedRevision": created["revision"]},
            )
            self.assertEqual(status, 200)
            trashed_keys.append(trashed["key"])
        status, _headers, first = self.request(
            "POST",
            "/api/answers/query",
            {"reviewStatus": None, "includeTrashed": True, "trashedOnly": True, "offset": 0, "limit": 2},
        )
        status2, _headers, second = self.request(
            "POST",
            "/api/answers/query",
            {"reviewStatus": None, "includeTrashed": True, "trashedOnly": True, "offset": 2, "limit": 2},
        )
        self.assertEqual((status, status2, first["total"], first["hasMore"], second["hasMore"]), (200, 200, 3, True, False))
        self.assertEqual([item["key"] for item in first["items"] + second["items"]], trashed_keys)

    def test_answer_api_merge_is_explicit_redacted_revision_safe_and_resolves_history(self):
        status, _headers, winner = self.request(
            "POST", "/api/answers",
            {"answer": {"question": "Canonical private answer?", "state": "sensitive", "value": "api-winner-secret", "sensitivity": "high", "scope": {"ats": "test"}}, "rememberSensitive": True},
        )
        self.assertEqual(status, 200)
        status, _headers, source = self.request(
            "POST", "/api/answers",
            {"answer": {"question": "Duplicate private answer?", "state": "confirmed", "value": "api-source-discarded", "scope": {"ats": "test"}}},
        )
        self.assertEqual(status, 200)
        self.server.store.append_history({"applicationId": "api-merge", "event": "reviewed", "answerKeys": [source["key"]]})
        status, _headers, stale = self.request(
            "POST", f"/api/answers/{source['key']}/merge",
            {"winnerKey": winner["key"], "expectedWinnerRevision": winner["revision"] + 1, "expectedSourceRevision": source["revision"]},
        )
        self.assertEqual((status, stale["error"]["code"]), (409, "revision_conflict"))
        self.assertIsNotNone(self.server.store.get_answer(source["key"]))
        status, _headers, merged = self.request(
            "POST", f"/api/answers/{source['key']}/merge",
            {"winnerKey": winner["key"], "expectedWinnerRevision": winner["revision"], "expectedSourceRevision": source["revision"]},
        )
        self.assertEqual(status, 200)
        self.assertEqual((merged["key"], merged["mergedFrom"]), (winner["key"], source["key"]))
        serialized = json.dumps(merged)
        self.assertNotIn("api-winner-secret", serialized)
        self.assertNotIn("api-source-discarded", serialized)
        self.assertNotIn("value", merged)
        self.assertEqual(merged["referenceCounts"], {"sessions": 0, "history": 1, "total": 1})
        status, _headers, redirected = self.request("GET", f"/api/answers/{source['key']}", origin=False)
        self.assertEqual((status, redirected["key"], redirected["redirectedFrom"]), (200, winner["key"], source["key"]))

    def test_answer_api_requires_strict_boolean_remember_consent(self):
        status, _headers, body = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {"question": "Strict create consent?", "state": "sensitive", "value": "secret"},
                "rememberSensitive": 1,
            },
        )
        self.assertEqual(status, 400, body)

        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "Strict mutation consent?", "state": "missing"}},
        )
        self.assertEqual(status, 200, pending)
        encoded = quote(pending["key"], safe="")
        status, _headers, body = self.request(
            "PATCH",
            f"/api/answers/{encoded}",
            {
                "patch": {"aliases": ["strict patch"]},
                "expectedRevision": pending["revision"],
                "rememberSensitive": 0,
            },
        )
        self.assertEqual(status, 400, body)
        status, _headers, body = self.request(
            "POST",
            f"/api/answers/{encoded}/accept",
            {
                "expectedRevision": pending["revision"],
                "rememberSensitive": "false",
            },
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(self.server.store.get_answer(pending["key"])["reviewStatus"], "pending")

    def test_answer_api_crud_decodes_every_encoded_explicit_key_character(self):
        explicit_key = "explicit /?#% ü .. \\ key"
        encoded = quote(explicit_key, safe="")
        status, _headers, created = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {
                    "key": explicit_key,
                    "question": "Encoded explicit key?",
                    "state": "confirmed",
                    "value": "available",
                }
            },
        )
        self.assertEqual((status, created["key"]), (200, explicit_key), created)
        status, _headers, detail = self.request(
            "GET", f"/api/answers/{encoded}", origin=False
        )
        self.assertEqual((status, detail["key"]), (200, explicit_key), detail)
        status, _headers, updated = self.request(
            "PATCH",
            f"/api/answers/{encoded}",
            {"patch": {"aliases": ["encoded alias"]}, "expectedRevision": created["revision"]},
        )
        self.assertEqual((status, updated["revision"]), (200, 2), updated)
        status, _headers, revealed = self.request(
            "POST", f"/api/answers/{encoded}/reveal", {}
        )
        self.assertEqual((status, revealed["value"]), (200, "available"), revealed)
        status, _headers, trashed = self.request(
            "POST", f"/api/answers/{encoded}/trash", {"expectedRevision": updated["revision"]}
        )
        self.assertEqual(status, 200, trashed)
        status, _headers, restored = self.request(
            "POST", f"/api/answers/{encoded}/restore", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual(status, 200, restored)
        status, _headers, trashed = self.request(
            "POST", f"/api/answers/{encoded}/trash", {"expectedRevision": restored["revision"]}
        )
        self.assertEqual(status, 200, trashed)
        status, _headers, deleted = self.request(
            "POST", f"/api/answers/{encoded}/delete", {"expectedRevision": trashed["revision"]}
        )
        self.assertEqual((status, deleted), (200, {"deleted": True, "key": explicit_key}), deleted)

    def test_answer_api_reserved_list_names_are_valid_detail_and_mutation_keys(self):
        for explicit_key in ("observed", "trash"):
            with self.subTest(key=explicit_key):
                status, _headers, created = self.request(
                    "POST",
                    "/api/answers",
                    {
                        "answer": {
                            "key": explicit_key,
                            "question": f"Reserved route key {explicit_key}?",
                            "state": "confirmed",
                            "value": "available",
                        }
                    },
                )
                self.assertEqual((status, created["key"]), (200, explicit_key), created)
                status, _headers, detail = self.request(
                    "GET", f"/api/answers/{explicit_key}", origin=False
                )
                self.assertEqual((status, detail["key"]), (200, explicit_key), detail)
                status, _headers, updated = self.request(
                    "PATCH",
                    f"/api/answers/{explicit_key}",
                    {
                        "patch": {"aliases": [f"{explicit_key} route alias"]},
                        "expectedRevision": created["revision"],
                    },
                )
                self.assertEqual((status, updated["revision"]), (200, 2), updated)
                status, _headers, trashed = self.request(
                    "POST",
                    f"/api/answers/{explicit_key}/trash",
                    {"expectedRevision": updated["revision"]},
                )
                self.assertEqual(status, 200, trashed)
                status, _headers, restored = self.request(
                    "POST",
                    f"/api/answers/{explicit_key}/restore",
                    {"expectedRevision": trashed["revision"]},
                )
                self.assertEqual(status, 200, restored)

    def test_answer_patch_cannot_transition_review_status(self):
        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "Dedicated review route?", "state": "missing"}},
        )
        encoded = quote(pending["key"], safe="")
        status, _headers, body = self.request(
            "PATCH",
            f"/api/answers/{encoded}",
            {"patch": {"reviewStatus": "accepted"}, "expectedRevision": pending["revision"]},
        )
        self.assertEqual(status, 400, body)
        self.assertEqual(self.server.store.get_answer(pending["key"])["reviewStatus"], "pending")

    def test_answer_api_upsert_cannot_transition_existing_review_status(self):
        status, _headers, pending = self.request(
            "POST",
            "/api/answers/observe",
            {"answer": {"question": "API upsert review boundary?", "state": "missing"}},
        )
        self.assertEqual((status, pending["reviewStatus"]), (200, "pending"))
        status, _headers, pending_upserted = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {
                    "key": pending["key"],
                    "question": pending["question"],
                    "state": "confirmed",
                    "value": "draft",
                    "reviewStatus": "accepted",
                },
                "expectedRevision": pending["revision"],
            },
        )
        self.assertEqual(
            (status, pending_upserted["reviewStatus"], pending_upserted["revision"]),
            (200, "pending", pending["revision"] + 1),
        )

        status, _headers, accepted = self.request(
            "POST",
            "/api/answers",
            {
                "answer": {
                    "question": "Accepted API upsert review boundary?",
                    "state": "confirmed",
                    "value": "canonical",
                }
            },
        )
        self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))
        for attempted_status in ("declined", "pending"):
            status, _headers, accepted = self.request(
                "POST",
                "/api/answers",
                {
                    "answer": {
                        "key": accepted["key"],
                        "question": accepted["question"],
                        "state": "confirmed",
                        "value": attempted_status,
                        "reviewStatus": attempted_status,
                    },
                    "expectedRevision": accepted["revision"],
                },
            )
            self.assertEqual((status, accepted["reviewStatus"]), (200, "accepted"))

            status, _headers, rejected = self.request(
                "POST",
                "/api/answers",
                {
                    "answer": {
                        "question": f"New API {attempted_status} answer?",
                        "state": "missing",
                        "reviewStatus": attempted_status,
                    }
                },
            )
            self.assertEqual(status, 400, rejected)
            self.assertIn("created through put must have accepted", rejected["error"]["message"])
