from tests.support.workspace_case import *


class WorkspaceServerTests(WorkspaceCase):
    def test_profile_preparedness_api_matches_store(self):
        source = Path(self.temporary.name) / "preparedness-api-private.txt"
        source.write_text("preparedness api private bytes", encoding="utf-8")
        resume = self.server.store.create_resume({
            "id": "preparedness-api", "label": "Preparedness API Private", "path": str(source)
        })
        profile = self.server.store.patch_profile({
            "firstName": "Private First", "lastName": "Private Last",
            "email": "private-api@example.invalid", "phone": "Private Phone",
        }, 1, "user")
        self.server.store.create_resume_extraction_request(resume["id"], resume["revision"])
        expected = self.server.store.profile_preparedness()
        status, _headers, actual = self.request("GET", "/api/profile-preparedness", origin=False)
        self.assertEqual((status, actual), (200, expected))
        status, _headers, rejected = self.request(
            "GET", "/api/profile-preparedness", token=False, origin=False
        )
        self.assertEqual((status, rejected["error"]["code"]), (401, "token_rejected"))
        serialized = json.dumps(actual).lower()
        for forbidden in (
            "score", "percent", "employability", "job_ready", "private first",
            "private last", "private-api@example.invalid", "private phone",
            source.name.lower(), str(source).lower(), resume["digest"],
            "preparedness api private bytes", "preparedness api private",
        ):
            self.assertNotIn(forbidden, serialized)
        self.assertEqual(profile["profile"]["firstName"], "Private First")

    def test_profile_api_inspects_and_forces_browser_user_provenance(self):
        seeded = self.server.store.patch_profile(
            {
                "firstName": "Ada",
                "location": {"city": "Phoenix", "country": "US"},
                "futureFact": {"enabled": True},
            },
            expected_revision=1,
            source="resume",
        )
        status, _headers, inspected = self.request("GET", "/api/profile", origin=False)
        self.assertEqual((status, inspected["revision"]), (200, seeded["revision"]))
        status, _headers, updated = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"location": {"city": "Tempe"}},
                "expectedRevision": inspected["revision"],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(updated["profile"]["location"], {"city": "Tempe", "country": "US"})
        self.assertEqual(updated["profile"]["futureFact"], {"enabled": True})
        self.assertEqual(updated["factProvenance"]["/location/city"]["source"], "user")

    def test_profile_api_atomically_replaces_additional_facts_and_separates_deletion(self):
        seeded = self.server.store.patch_profile(
            {"futureFact": {"enabled": True, "keep": "old"}}, 1, "resume"
        )
        status, _headers, replaced = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"futureFact": {"enabled": False}},
                "expectedRevision": seeded["revision"],
                "atomicPaths": ["/futureFact"],
                "deletedPaths": [],
            },
        )
        self.assertEqual(status, 200)
        self.assertEqual(replaced["profile"]["futureFact"], {"enabled": False})

        status, _headers, stored_null = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"futureFact": None},
                "expectedRevision": replaced["revision"],
                "atomicPaths": ["/futureFact"],
                "deletedPaths": [],
            },
        )
        self.assertEqual(status, 200)
        self.assertIn("futureFact", stored_null["profile"])
        self.assertIsNone(stored_null["profile"]["futureFact"])

        status, _headers, deleted = self.request(
            "PATCH",
            "/api/profile",
            {
                "patch": {"futureFact": None},
                "expectedRevision": stored_null["revision"],
                "atomicPaths": ["/futureFact"],
                "deletedPaths": ["/futureFact"],
            },
        )
        self.assertEqual(status, 200)
        self.assertNotIn("futureFact", deleted["profile"])

    def test_profile_api_rejects_bad_shape_stale_revision_and_wrong_origin(self):
        current = self.server.store.inspect_profile()
        probes = (
            ({"patch": {}, "expectedRevision": current["revision"]}, True, 400),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": True}, True, 400),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": current["revision"], "source": "agent"}, True, 400),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": current["revision"]}, False, 403),
            ({"patch": {"firstName": "Ada"}, "expectedRevision": current["revision"], "atomicPaths": ["/firstName"]}, True, 400),
            ({"patch": {"futureFact": None}, "expectedRevision": current["revision"], "deletedPaths": ["/futureFact"]}, True, 400),
        )
        for payload, origin, expected_status in probes:
            with self.subTest(payload=set(payload), origin=origin):
                status, _headers, _body = self.request("PATCH", "/api/profile", payload, origin=origin)
                self.assertEqual(status, expected_status)
        advanced = self.server.store.patch_profile(
            {"firstName": "Grace"}, current["revision"], "agent"
        )
        status, _headers, body = self.request(
            "PATCH",
            "/api/profile",
            {"patch": {"lastName": "Hopper"}, "expectedRevision": current["revision"]},
        )
        self.assertEqual((status, body["error"]["code"]), (409, "revision_conflict"))
        self.assertEqual(self.server.store.inspect_profile()["revision"], advanced["revision"])

    def test_fact_group_api_has_browser_cli_crud_parity_without_mutating_profile(self):
        profile = self.server.store.patch_profile(
            {"firstName": "Synthetic", "skills": ["Python"]}, 1, "user"
        )
        status, _headers, created = self.request(
            "POST",
            "/api/fact-groups",
            {"group": {"label": "Core facts", "paths": ["/firstName", "/skills"], "order": 10}},
        )
        self.assertEqual(status, 200, created)
        status, _headers, listing = self.request("GET", "/api/fact-groups", origin=False)
        self.assertEqual((status, listing["groups"]), (200, [created]))
        self.assertEqual(self.server.store.get_fact_group(created["id"]), created)

        status, _headers, updated = self.request(
            "PATCH",
            f"/api/fact-groups/{created['id']}",
            {"patch": {"label": "Focused facts", "paths": ["/skills"], "order": 20}, "expectedRevision": created["revision"]},
        )
        self.assertEqual((status, updated["revision"]), (200, 2))
        status, _headers, conflict = self.request(
            "PATCH",
            f"/api/fact-groups/{created['id']}",
            {"patch": {"label": "Stale"}, "expectedRevision": created["revision"]},
        )
        self.assertEqual((status, conflict["error"]["code"]), (409, "revision_conflict"))
        status, _headers, deleted = self.request(
            "POST",
            f"/api/fact-groups/{created['id']}/delete",
            {"expectedRevision": updated["revision"]},
        )
        self.assertEqual((status, deleted), (200, {"deleted": True, "id": created["id"]}))
        self.assertEqual(self.server.store.inspect_profile(), profile)
