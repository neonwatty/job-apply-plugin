from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_migrates_legacy_profile_once_and_preserves_unknown_fields(self):
        legacy = {
            "firstName": "Ada",
            "preferences": {"remotePreference": "remote only"},
            "futureCustomField": {"keep": True},
        }
        self.legacy.write_text(json.dumps(legacy), encoding="utf-8")

        first = self.store.initialize()
        self.assertTrue(first["migratedLegacyProfile"])
        self.assertEqual(self.store.get_profile(), legacy)

        self.legacy.write_text(json.dumps({"firstName": "Changed"}), encoding="utf-8")
        second = self.store.initialize()
        self.assertFalse(second["migratedLegacyProfile"])
        self.assertEqual(self.store.get_profile(), legacy)

    def test_preferences_merge_preserves_profile_and_existing_preferences(self):
        self.store.initialize()
        self.store.replace_profile(
            {
                "firstName": "Ada",
                "preferences": {"targetTitles": ["Engineer"], "salary": "200K"},
            },
            expected_revision=1,
            source="resume",
        )
        updated = self.store.set_preferences(
            {"salary": "250K"}, expected_revision=2, source="user"
        )
        self.assertEqual(
            updated["profile"]["preferences"],
            {"targetTitles": ["Engineer"], "salary": "250K"},
        )
        self.assertEqual(self.store.get_profile()["firstName"], "Ada")

    def test_profile_patch_edits_nested_facts_with_revision_and_provenance(self):
        self.store.initialize()
        self.store.replace_profile(
            {
                "firstName": "Ada",
                "location": {"city": "London", "country": "UK"},
                "skills": ["Python"],
                "portfolioUrl": "https://example.com",
            },
            expected_revision=1,
            source="resume",
        )
        before = self.store.inspect_profile()
        updated = self.store.patch_profile(
            {
                "location": {"city": "Phoenix"},
                "skills": ["Python", "Rust"],
                "portfolioUrl": None,
            },
            expected_revision=before["revision"],
            source="user",
        )
        self.assertEqual(updated["profile"]["location"], {"city": "Phoenix", "country": "UK"})
        self.assertEqual(updated["profile"]["skills"], ["Python", "Rust"])
        self.assertNotIn("portfolioUrl", updated["profile"])
        self.assertEqual(updated["revision"], before["revision"] + 1)
        self.assertEqual(
            set(updated["factProvenance"]),
            {
                "/firstName",
                "/location/city",
                "/location/country",
                "/skills",
                "/portfolioUrl",
            },
        )
        self.assertTrue(
            all(
                updated["factProvenance"][path]["source"] == "user"
                for path in ("/location/city", "/skills", "/portfolioUrl")
            )
        )
        self.assertEqual(
            updated["factProvenance"]["/location/country"]["source"], "resume"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.patch_profile(
                {"firstName": "Grace"},
                expected_revision=before["revision"],
                source="user",
            )

    def test_atomic_profile_patch_replaces_whole_value_and_distinguishes_null_from_delete(self):
        seeded = self.store.patch_profile(
            {"futureConfig": {"enabled": True, "nested": {"keep": True}}},
            expected_revision=1,
            source="resume",
        )
        replaced = self.store.patch_profile(
            {"futureConfig": {"enabled": False}},
            seeded["revision"],
            "user",
            atomic_paths=["/futureConfig"],
        )
        self.assertEqual(replaced["profile"]["futureConfig"], {"enabled": False})
        self.assertEqual(replaced["factProvenance"]["/futureConfig"]["source"], "user")

        stored_null = self.store.patch_profile(
            {"futureConfig": None},
            replaced["revision"],
            "user",
            atomic_paths=["/futureConfig"],
        )
        self.assertIn("futureConfig", stored_null["profile"])
        self.assertIsNone(stored_null["profile"]["futureConfig"])

        deleted = self.store.patch_profile(
            {"futureConfig": None},
            stored_null["revision"],
            "user",
            atomic_paths=["/futureConfig"],
            deleted_paths=["/futureConfig"],
        )
        self.assertNotIn("futureConfig", deleted["profile"])

    def test_profile_patch_replaces_parent_provenance_with_specific_changes(self):
        self.store.initialize()
        first = self.store.patch_profile(
            {"location": {"city": "Phoenix", "country": "US"}},
            expected_revision=1,
            source="resume",
        )
        second = self.store.patch_profile(
            {"location": {"city": "Tempe"}},
            expected_revision=first["revision"],
            source="user",
        )
        self.assertEqual(second["factProvenance"]["/location/city"]["source"], "user")
        self.assertEqual(
            second["factProvenance"]["/location/country"]["source"], "resume"
        )

    def test_profile_patch_preserves_user_authority_on_unchanged_nested_siblings(self):
        seeded = self.store.replace_profile(
            {"location": {"city": "Phoenix", "country": "US"}}, 0, "user"
        )
        self.assertEqual(seeded["factProvenance"]["/location"]["source"], "user")

        updated = self.store.patch_profile(
            {"location": {"city": "Tempe"}}, seeded["revision"], "user"
        )

        self.assertEqual(updated["factProvenance"]["/location/city"]["source"], "user")
        self.assertEqual(
            updated["factProvenance"]["/location/country"]["source"], "user"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "user-provenanced"):
            self.store.patch_profile(
                {"location": {"country": "CA"}}, updated["revision"], "agent"
            )

        replacement_store = STORE_MODULE.Store(
            self.root / "replacement-store", self.root / "replacement-legacy.json"
        )
        replacement_seed = replacement_store.replace_profile(
            {"location": {"city": "Phoenix", "country": "US"}}, 0, "user"
        )
        replacement = replacement_store.replace_profile(
            {"location": {"city": "Tempe", "country": "US"}},
            replacement_seed["revision"],
            "user",
        )
        self.assertEqual(
            replacement["factProvenance"]["/location/country"]["source"], "user"
        )

    def test_existing_v1_profile_without_revision_upgrades_on_first_patch(self):
        self.root.mkdir(parents=True)
        self.store.profile_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "profile": {"firstName": "Ada"},
                    "metadata": {
                        "createdAt": "2026-01-01T00:00:00Z",
                        "updatedAt": "2026-01-01T00:00:00Z",
                    },
                }
            ),
            encoding="utf-8",
        )
        self.store.initialize()
        inspected = self.store.inspect_profile()
        self.assertEqual(inspected["revision"], 1)
        updated = self.store.patch_profile(
            {"firstName": "Grace"}, expected_revision=1, source="user"
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["profile"]["firstName"], "Grace")

    def test_user_provenance_blocks_lower_authority_patch_and_replace(self):
        initialized = self.store.replace_profile(
            {"firstName": "Ada", "location": {"city": "Phoenix"}},
            expected_revision=0,
            source="resume",
        )
        human = self.store.patch_profile(
            {"location": {"city": "Tempe"}}, initialized["revision"], "user"
        )
        for patch in ({"location": {"city": "Mesa"}}, {"location": None}):
            with self.subTest(patch=patch):
                with self.assertRaisesRegex(STORE_MODULE.StoreError, "user-provenanced"):
                    self.store.patch_profile(patch, human["revision"], "agent")
        allowed = self.store.patch_profile(
            {"firstName": "Grace"}, human["revision"], "agent"
        )
        self.assertEqual(allowed["profile"]["location"]["city"], "Tempe")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "user-provenanced"):
            self.store.replace_profile(
                {"firstName": "Grace", "location": {"city": "Mesa"}},
                allowed["revision"],
                "migration",
            )

    def test_profile_replace_is_revisioned_provenance_aware_and_initializes_at_zero(self):
        first = self.store.replace_profile(
            {"firstName": "Ada", "skills": ["Python"]}, 0, "resume"
        )
        self.assertEqual(first["revision"], 1)
        self.assertEqual(first["factProvenance"]["/skills"]["source"], "resume")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.replace_profile({"firstName": "Grace"}, 0, "user")
        replaced = self.store.replace_profile(
            {"firstName": "Grace", "skills": ["Python"]}, 1, "user"
        )
        self.assertEqual(replaced["revision"], 2)
        self.assertEqual(replaced["factProvenance"]["/firstName"]["source"], "user")

    def test_first_replacement_writes_only_its_final_revision_one_profile(self):
        writes = []
        original = STORE_MODULE.atomic_write_json

        def recording_write(path, payload):
            if path == self.store.profile_path:
                writes.append(json.loads(json.dumps(payload)))
            return original(path, payload)

        with mock.patch.object(STORE_MODULE, "atomic_write_json", recording_write):
            result = self.store.replace_profile({"firstName": "Ada"}, 0, "resume")

        self.assertEqual(result["revision"], 1)
        self.assertEqual(
            [(item["metadata"]["revision"], item["profile"]) for item in writes],
            [(1, {"firstName": "Ada"})],
        )

    def test_first_replacement_validates_existing_store_before_creating_profile(self):
        sibling_paths = (
            "answers.json",
            "jobs.json",
            "resumes.json",
            "applications.jsonl",
            "coordinator.json",
            "coordinator-journal.json",
        )
        for index, filename in enumerate(sibling_paths):
            with self.subTest(filename=filename):
                root = self.home / f"invalid-sibling-{index}"
                root.mkdir()
                sibling = root / filename
                sibling.write_text("not json\n", encoding="utf-8")
                store = STORE_MODULE.Store(root, self.home / f"legacy-{index}.json")

                with self.assertRaises(STORE_MODULE.StoreError):
                    store.replace_profile({"firstName": "Ada"}, 0, "resume")

                self.assertFalse(store.profile_path.exists())
                self.assertEqual(sibling.read_text(encoding="utf-8"), "not json\n")

        legacy = self.home / "invalid-legacy.json"
        legacy.write_text("not json\n", encoding="utf-8")
        legacy_store = STORE_MODULE.Store(self.home / "invalid-legacy-store", legacy)
        with self.assertRaises(STORE_MODULE.StoreError):
            legacy_store.replace_profile({"firstName": "Ada"}, 0, "resume")
        self.assertFalse(legacy_store.profile_path.exists())
        self.assertEqual(legacy.read_text(encoding="utf-8"), "not json\n")

    def test_revision_zero_cannot_replace_migrated_legacy_profile(self):
        self.legacy.write_text(json.dumps({"firstName": "Legacy"}), encoding="utf-8")

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.replace_profile({"firstName": "Replacement"}, 0, "resume")

        inspected = self.store.inspect_profile()
        self.assertEqual(inspected["revision"], 1)
        self.assertEqual(inspected["profile"], {"firstName": "Legacy"})
        replaced = self.store.replace_profile(
            {"firstName": "Replacement"}, inspected["revision"], "resume"
        )
        self.assertEqual(replaced["revision"], 2)

    def test_revision_zero_no_op_replacement_claims_initialization(self):
        claimed = self.store.replace_profile({}, 0, "resume")
        self.assertEqual(claimed["revision"], 1)
        self.assertEqual(claimed["profile"], {})
        self.assertEqual(claimed["factProvenance"], {})

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.replace_profile({"firstName": "Ada"}, 0, "resume")

        updated = self.store.replace_profile(
            {"firstName": "Ada"}, claimed["revision"], "resume"
        )
        self.assertEqual(updated["revision"], 2)

    def test_only_one_concurrent_revision_zero_profile_replacement_succeeds(self):
        stores = [
            STORE_MODULE.Store(self.root, self.legacy),
            STORE_MODULE.Store(self.root, self.legacy),
        ]
        def replace(store, profile):
            try:
                return store.replace_profile(profile, 0, "resume")
            except STORE_MODULE.StoreError as error:
                return error

        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(
                executor.map(replace, stores, ({}, {"firstName": "Grace"}))
            )

        successes = [item for item in outcomes if isinstance(item, dict)]
        conflicts = [item for item in outcomes if isinstance(item, STORE_MODULE.StoreError)]
        self.assertEqual(len(successes), 1)
        self.assertEqual(len(conflicts), 1)
        self.assertRegex(str(conflicts[0]), "revision conflict")
        self.assertEqual(self.store.inspect_profile()["profile"], successes[0]["profile"])

    def test_preferences_set_is_selective_revisioned_and_stamps_source(self):
        seeded = self.store.patch_profile(
            {"preferences": {"targetTitles": ["Engineer"], "remotePreference": "remote"}},
            1,
            "resume",
        )
        updated = self.store.set_preferences(
            {"remotePreference": "hybrid"}, seeded["revision"], "user"
        )
        self.assertEqual(updated["profile"]["preferences"]["targetTitles"], ["Engineer"])
        self.assertEqual(
            updated["factProvenance"]["/preferences/remotePreference"]["source"],
            "user",
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.set_preferences({"defaultTimeRange": "week"}, seeded["revision"], "user")

    def test_preferences_replace_replaces_nested_values_in_one_revision(self):
        seeded = self.store.patch_profile(
            {
                "firstName": "Ada",
                "preferences": {
                    "filters": {"locations": ["Phoenix"], "seniority": "staff"},
                    "remotePreference": "remote",
                },
            },
            1,
            "resume",
        )
        updated = self.store.set_preferences(
            {"filters": {"locations": ["Tempe"]}},
            seeded["revision"],
            "user",
            replace=True,
        )

        self.assertEqual(
            updated["profile"],
            {
                "firstName": "Ada",
                "preferences": {"filters": {"locations": ["Tempe"]}},
            },
        )
        self.assertEqual(updated["revision"], seeded["revision"] + 1)
        self.assertEqual(
            updated["factProvenance"]["/preferences/filters/locations"]["source"],
            "user",
        )
