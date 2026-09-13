from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_partial_proposal_rebases_own_sibling_ancestors_but_rejects_external_drift(self):
        resume = self.store.create_resume_bytes(
            {"id": "sibling-review", "label": "Sibling review"},
            "resume.txt",
            b"synthetic",
        )
        profile = self.store.patch_profile({"details": {}}, 1, "user")
        proposal = self.store.create_resume_proposal(
            resume["id"],
            {"details": {"a": "A", "b": "B", "c": "C"}},
            resume["revision"],
            profile["revision"],
        )
        self.assertEqual(proposal["pendingPaths"], ["/details/a", "/details/b", "/details/c"])
        first = self.store.review_resume_proposal(
            proposal["id"], {"decisions": {"/details/a": "use_extracted"}},
            proposal["revision"], proposal["resultProfileRevision"],
        )
        second = self.store.review_resume_proposal(
            proposal["id"], {"decisions": {"/details/b": "use_extracted"}},
            first["revision"], first["resultProfileRevision"],
        )
        self.assertEqual(self.store.inspect_profile()["profile"]["details"], {"a": "A", "b": "B"})
        externally_changed = self.store.patch_profile(
            {"details": {"c": "external"}}, second["resultProfileRevision"], "user"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "baseline changed"):
            self.store.review_resume_proposal(
                proposal["id"], {"decisions": {"/details/c": "use_extracted"}},
                second["revision"], externally_changed["revision"],
            )
        self.assertEqual(self.store.inspect_profile()["profile"]["details"]["c"], "external")

    def test_proposal_baselines_distinguish_booleans_from_numbers_recursively(self):
        selected_resume = self.store.create_resume_bytes(
            {"id": "strict-selected", "label": "Strict selected"},
            "selected.txt",
            b"selected proposal",
        )
        intervening_resume = self.store.create_resume_bytes(
            {"id": "strict-intervening", "label": "Strict intervening"},
            "intervening.txt",
            b"intervening proposal",
        )
        profile = self.store.patch_profile(
            {"selectedFlag": True, "replacementFlag": False}, 1, "user"
        )
        selected = self.store.create_resume_proposal(
            selected_resume["id"],
            {
                "selectedFlag": "candidate",
                "replacementFlag": {"child": "candidate"},
            },
            selected_resume["revision"],
            profile["revision"],
        )
        intervening = self.store.create_resume_proposal(
            intervening_resume["id"],
            {"selectedFlag": 1, "replacementFlag": 0},
            intervening_resume["revision"],
            profile["revision"],
        )
        changed = self.store.review_resume_proposal(
            intervening["id"],
            {
                "decisions": {
                    "/selectedFlag": "use_extracted",
                    "/replacementFlag": "use_extracted",
                }
            },
            intervening["revision"],
            profile["revision"],
        )
        self.assertEqual(
            self.store.inspect_profile()["profile"],
            {"selectedFlag": 1, "replacementFlag": 0},
        )
        for decisions in (
            {"decisions": {"/selectedFlag": "use_extracted"}},
            {
                "decisions": {"/replacementFlag/child": "use_extracted"},
                "replacementConfirmations": {
                    "/replacementFlag/child": "/replacementFlag"
                },
            },
        ):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "baseline changed"):
                self.store.review_resume_proposal(
                    selected["id"],
                    decisions,
                    selected["revision"],
                    changed["resultProfileRevision"],
                )

    def test_child_proposal_requires_exact_scalar_and_array_replacement_confirmation(self):
        resume = self.store.create_resume_bytes(
            {"id": "ancestor-review", "label": "Ancestor review"},
            "resume.txt",
            b"synthetic",
        )
        profile = self.store.patch_profile(
            {"contact": "canonical scalar", "history": ["canonical array"]}, 1, "user"
        )
        proposal = self.store.create_resume_proposal(
            resume["id"],
            {"contact": {"email": "synthetic@example.invalid"}, "history": {"latest": "Synthetic"}},
            resume["revision"],
            profile["revision"],
        )
        decisions = {
            "/contact/email": "use_extracted",
            "/history/latest": "use_extracted",
        }
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "replacement confirmation"):
            self.store.review_resume_proposal(
                proposal["id"], {"decisions": decisions}, proposal["revision"], profile["revision"]
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "replacement confirmation"):
            self.store.review_resume_proposal(
                proposal["id"],
                {"decisions": decisions, "replacementConfirmations": {"/contact/email": "/wrong"}},
                proposal["revision"],
                profile["revision"],
            )
        self.assertEqual(
            self.store.inspect_profile()["profile"],
            {"contact": "canonical scalar", "history": ["canonical array"]},
        )
        reviewed = self.store.review_resume_proposal(
            proposal["id"],
            {
                "decisions": decisions,
                "replacementConfirmations": {
                    "/contact/email": "/contact",
                    "/history/latest": "/history",
                },
            },
            proposal["revision"],
            profile["revision"],
        )
        self.assertEqual(reviewed["status"], "completed")
        self.assertEqual(
            self.store.inspect_profile()["profile"],
            {
                "contact": {"email": "synthetic@example.invalid"},
                "history": {"latest": "Synthetic"},
            },
        )

    def test_profile_preparedness_is_value_free_and_deterministic(self):
        empty = self.store.profile_preparedness()
        self.assertEqual(
            set(empty), {"essentialSetup", "commonCoverage", "reviewHealth"}
        )
        self.assertEqual(
            [item["id"] for item in empty["essentialSetup"]],
            ["first_name", "last_name", "email", "default_resume"],
        )
        self.assertEqual(
            [item["id"] for item in empty["commonCoverage"]],
            ["phone", "location", "work_history", "education", "skills", "professional_links"],
        )
        source = self.home / "preparedness-private-name.txt"
        source.write_text("preparedness private resume bytes", encoding="utf-8")
        resume = self.store.create_resume({
            "id": "preparedness-resume", "label": "Private Preparedness Label",
            "path": str(source),
        })
        profile = self.store.replace_profile({
            "firstName": "  ", "lastName": "Private Last", "email": "private@example.invalid",
            "phone": "Private Phone", "location": {"city": "Private City"},
            "workHistory": [{"company": "Private Company"}],
            "education": [{"school": "Private School"}], "skills": ["Private Skill"],
            "portfolioUrl": "https://private.example.invalid", "blankObject": {"value": "   "},
        }, 1, "user")
        projection = self.store.profile_preparedness()
        essentials = {item["id"]: item for item in projection["essentialSetup"]}
        coverage = {item["id"]: item for item in projection["commonCoverage"]}
        self.assertEqual(essentials["first_name"]["state"], "blocked")
        self.assertEqual(essentials["last_name"]["state"], "present")
        self.assertEqual(essentials["default_resume"]["state"], "present")
        self.assertTrue(all(item["state"] == "present" for item in coverage.values()))
        serialized = json.dumps(projection, sort_keys=True).lower()
        for forbidden in (
            "score", "percent", "employability", "job_ready", "private last",
            "private phone", "private city", "private company", "private school",
            "private skill", "private.example", source.name, str(source).lower(),
            resume["digest"], "preparedness private resume bytes",
        ):
            self.assertNotIn(forbidden, serialized)

        managed = self.root / "resume-files" / resume["managedFile"]
        managed.write_text("changed private bytes", encoding="utf-8")
        changed = {item["id"]: item for item in self.store.profile_preparedness()["essentialSetup"]}
        self.assertEqual(changed["default_resume"]["reasonCode"], "default_resume_changed")
        managed.unlink()
        unreadable = {item["id"]: item for item in self.store.profile_preparedness()["essentialSetup"]}
        self.assertEqual(unreadable["default_resume"]["reasonCode"], "default_resume_unreadable")
        self.assertEqual(profile["profile"]["lastName"], "Private Last")

    def test_profile_preparedness_reports_review_health(self):
        source = self.home / "health.txt"
        source.write_text("health resume", encoding="utf-8")
        resume = self.store.create_resume({
            "id": "health-resume", "label": "Health", "path": str(source)
        })
        request = self.store.create_resume_extraction_request(resume["id"], resume["revision"])
        requested = self.store.profile_preparedness()["reviewHealth"]
        self.assertEqual(requested[0]["reasonCode"], "extraction_requested")
        self.assertEqual(requested[0]["requestId"], request["requestId"])
        failed = self.store.fail_resume_extraction_request(
            request["requestId"], "interrupted", request["revision"]
        )
        profile = self.store.patch_profile({"firstName": "Human Private"}, 1, "user")
        proposal = self.store.create_resume_proposal(
            resume["id"], {"firstName": "Candidate Private"},
            resume["revision"], profile["revision"],
        )
        health = self.store.profile_preparedness()["reviewHealth"]
        self.assertEqual(
            {item["reasonCode"] for item in health},
            {"extraction_failed", "unresolved_conflicts", "human_protected_facts_retained"},
        )
        self.assertTrue(any(item.get("failureReason") == "interrupted" for item in health))
        self.assertTrue(any(item.get("proposalId") == proposal["id"] for item in health))
        serialized = json.dumps(health)
        self.assertNotIn("Human Private", serialized)
        self.assertNotIn("Candidate Private", serialized)
        self.assertEqual(failed["status"], "failed")

    def test_resume_proposal_autofill_review_and_stale_baselines(self):
        source = self.home / "proposal.txt"
        source.write_text("synthetic proposal resume", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "proposal-resume", "label": "Proposal", "path": str(source)}
        )
        self.assertFalse(self.store.resume_extractions_path.exists())
        seeded = self.store.replace_profile(
            {"portfolioUrl": None, "emptyParent": {}, "workHistory": []},
            1,
            "resume",
        )
        human = self.store.patch_profile(
            {"firstName": "Human", "phone": "synthetic-phone", "blank": ""},
            seeded["revision"],
            "user",
        )
        cleared = self.store.patch_profile(
            {"phone": None}, human["revision"], "user"
        )
        candidate = {
            "firstName": "Extracted",
            "phone": "extracted-phone",
            "blank": "extracted-blank",
            "portfolioUrl": "https://synthetic.invalid",
            "email": "synthetic@example.invalid",
            "location": {"city": "Synthetic City"},
            "skills": ["Synthetic Skill"],
            "emptyObject": {},
            "emptyParent": {"child": "extracted-child"},
            "workHistory": [{"company": "Synthetic Company"}],
        }
        proposal = self.store.create_resume_proposal(
            resume["id"], candidate, resume["revision"], cleared["revision"]
        )
        self.assertTrue(self.store.resume_extractions_path.exists())
        self.assertTrue(self.store.resume_extraction_journal_path.exists())
        if os.name != "nt":
            self.assertEqual(
                stat.S_IMODE(self.store.resume_extractions_path.stat().st_mode), 0o600
            )
            self.assertEqual(
                stat.S_IMODE(self.store.resume_extraction_journal_path.stat().st_mode),
                0o600,
            )
        self.assertEqual(proposal["candidate"], candidate)
        self.assertEqual(
            set(proposal["pendingPaths"]),
            {
                "/firstName",
                "/phone",
                "/blank",
                "/emptyParent/child",
                "/workHistory",
            },
        )
        self.assertEqual(
            set(proposal["autoFilledPaths"]),
            {"/portfolioUrl", "/email", "/location/city", "/skills", "/emptyObject"},
        )
        profile = self.store.inspect_profile()
        self.assertEqual(profile["profile"]["firstName"], "Human")
        self.assertNotIn("phone", profile["profile"])
        self.assertEqual(profile["profile"]["location"]["city"], "Synthetic City")
        for path in proposal["autoFilledPaths"]:
            self.assertEqual(profile["factProvenance"][path]["source"], "resume")

        reviewed = self.store.review_resume_proposal(
            proposal["id"],
            {
                "decisions": {
                    "/firstName": "keep_current",
                    "/blank": "use_extracted",
                    "/emptyParent/child": "keep_current",
                    "/workHistory": "keep_current",
                }
            },
            proposal["revision"],
            profile["revision"],
        )
        self.assertEqual(reviewed["pendingPaths"], ["/phone"])
        after_review = self.store.inspect_profile()
        self.assertEqual(after_review["profile"]["blank"], "extracted-blank")
        self.assertEqual(after_review["factProvenance"]["/blank"]["source"], "user")

        changed = self.store.patch_profile(
            {"phone": "new-human-phone"}, after_review["revision"], "user"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "baseline changed"):
            self.store.review_resume_proposal(
                proposal["id"],
                {"decisions": {"/phone": "use_extracted"}},
                reviewed["revision"],
                changed["revision"],
            )

    def test_resume_proposal_supersession_staleness_and_journal_recovery(self):
        source = self.home / "journal.txt"
        source.write_text("synthetic journal resume", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "journal-resume", "label": "Journal", "path": str(source)}
        )
        profile = self.store.patch_profile(
            {"firstName": "Human"}, 1, "user"
        )
        proposal = self.store.create_resume_proposal(
            resume["id"],
            {"firstName": "Candidate"},
            resume["revision"],
            profile["revision"],
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "supersession"):
            self.store.create_resume_proposal(
                resume["id"],
                {"firstName": "New Candidate"},
                resume["revision"],
                profile["revision"],
            )
        newer = self.store.create_resume_proposal(
            resume["id"],
            {"firstName": "New Candidate"},
            resume["revision"],
            profile["revision"],
            supersedes=proposal["id"],
        )
        self.assertEqual(
            self.store.get_resume_proposal(proposal["id"])["status"], "superseded"
        )

        replacement = self.home / "changed.txt"
        replacement.write_text("changed synthetic resume", encoding="utf-8")
        changed_resume = self.store.update_resume(
            resume["id"], {"path": str(replacement)}, resume["revision"]
        )
        stale = self.store.get_resume_proposal(newer["id"])
        self.assertTrue(stale["stale"])
        self.assertIn("resume_revision_changed", stale["staleReasons"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "stale"):
            self.store.review_resume_proposal(
                newer["id"],
                {"decisions": {"/firstName": "keep_current"}},
                newer["revision"],
                profile["revision"],
            )

        recovery_source = self.home / "recovery.txt"
        recovery_source.write_text("synthetic recovery resume", encoding="utf-8")
        recovery_resume = self.store.create_resume(
            {"id": "recovery-resume", "label": "Recovery", "path": str(recovery_source)}
        )
        original_write = STORE_MODULE.atomic_write_json
        failed = False

        def fail_proposals_once(path, payload):
            nonlocal failed
            if path == self.store.resume_extractions_path and not failed:
                failed = True
                raise OSError("synthetic proposal write failure")
            return original_write(path, payload)

        current_profile = self.store.inspect_profile()
        with mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_proposals_once):
            with self.assertRaises(OSError):
                self.store.create_resume_proposal(
                    recovery_resume["id"],
                    {"email": "recovery@example.invalid"},
                    recovery_resume["revision"],
                    current_profile["revision"],
                )
        repaired = STORE_MODULE.Store(self.root, self.legacy)
        repaired.initialize()
        recovered = repaired.list_resume_proposals(resume_id=recovery_resume["id"])
        self.assertEqual(len(recovered), 1)
        self.assertEqual(
            repaired.inspect_profile()["profile"]["email"],
            "recovery@example.invalid",
        )
        journal = json.loads(
            repaired.resume_extraction_journal_path.read_text(encoding="utf-8")
        )
        self.assertIsNone(journal["operation"])
