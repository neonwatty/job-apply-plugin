import hashlib
import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"
SPEC = importlib.util.spec_from_file_location("job_apply_store", SCRIPT)
STORE_MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(STORE_MODULE)


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.home = Path(self.temporary.name)
        self.root = self.home / ".job-apply"
        self.legacy = self.home / ".claude-job-profile.json"
        self.store = STORE_MODULE.Store(self.root, self.legacy)

    def tearDown(self):
        self.temporary.cleanup()

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

    def test_atomic_write_failure_keeps_previous_document_and_cleans_temp(self):
        self.store.initialize()
        before = self.store.profile_path.read_text(encoding="utf-8")
        with mock.patch.object(STORE_MODULE.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                self.store.replace_profile(
                    {"firstName": "Grace"}, expected_revision=1, source="user"
                )
        self.assertEqual(self.store.profile_path.read_text(encoding="utf-8"), before)
        self.assertEqual(list(self.root.glob(".profile.json.*.tmp")), [])

    @unittest.skipIf(os.name == "nt", "POSIX permissions only")
    def test_private_permissions(self):
        self.store.initialize()
        self.store.claim_status()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.store.sessions_path.stat().st_mode), 0o700)
        for path in (
            self.store.profile_path,
            self.store.answers_path,
            self.store.jobs_path,
            self.store.resumes_path,
            self.store.history_path,
            self.store.coordinator_path,
            self.store.coordinator_journal_path,
        ):
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_corrupt_and_future_documents_fail_closed(self):
        self.root.mkdir(parents=True)
        self.store.profile_path.write_text("not json", encoding="utf-8")
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.initialize()
        self.assertEqual(self.store.profile_path.read_text(encoding="utf-8"), "not json")

        self.store.profile_path.write_text(
            json.dumps(
                {"schemaVersion": 99, "profile": {}, "metadata": {}}
            ),
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.initialize()
        self.assertEqual(json.loads(self.store.profile_path.read_text())["schemaVersion"], 99)

    def test_workspace_startup_validates_sessions_without_mutation(self):
        self.store.initialize()
        session_path = self.store.sessions_path / "startup-session.json"
        corrupt = b'{"schemaVersion": 1, "private": "unchanged"'
        session_path.write_bytes(corrupt)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "valid session JSON"):
            self.store.validate_workspace_startup()
        self.assertEqual(session_path.read_bytes(), corrupt)

        future = {
            "schemaVersion": 99,
            "applicationId": "startup-session",
            "status": "active",
            "answerKeys": [],
            "pendingFields": [],
        }
        session_path.write_text(json.dumps(future), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "future schemaVersion 99"):
            self.store.validate_workspace_startup()
        self.assertEqual(json.loads(session_path.read_text(encoding="utf-8")), future)

        if os.name != "nt":
            outside = self.root.parent / "outside-session.json"
            outside.write_text(json.dumps(future), encoding="utf-8")
            session_path.unlink()
            session_path.symlink_to(outside)
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "regular file"):
                self.store.validate_workspace_startup()
            self.assertEqual(json.loads(outside.read_text(encoding="utf-8")), future)

    def test_workspace_startup_session_validation_uses_windows_capability_path(self):
        self.store.initialize()
        session = self.store.save_session(
            "windows-session",
            {"status": "active", "answerKeys": [], "pendingFields": []},
        )
        real_open = STORE_MODULE.os.open
        calls = []

        def portable_open(path, flags, *args, **kwargs):
            calls.append((path, kwargs.copy()))
            if "dir_fd" in kwargs:
                raise AssertionError("Windows fallback used dir_fd")
            return real_open(path, flags, *args, **kwargs)

        with mock.patch.object(STORE_MODULE.os, "name", "nt"), mock.patch.object(
            STORE_MODULE.os, "open", side_effect=portable_open
        ):
            self.store.validate_workspace_startup()
        self.assertTrue(calls)
        self.assertEqual(self.store.load_session("windows-session"), session)

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

    def test_job_crud_normalizes_urls_rejects_duplicates_and_checks_revisions(self):
        created = self.store.create_job(
            {
                "id": "acme-engineer",
                "url": "HTTPS://Jobs.Example.com:443/roles/1#apply",
                "source": "manual",
                "role": "Engineer",
                "company": "Acme",
                "priority": 4,
            }
        )
        self.assertEqual(created["normalizedUrl"], "https://jobs.example.com/roles/1")
        self.assertEqual(created["status"], "saved")
        self.assertEqual(created["revision"], 1)
        self.assertEqual(self.store.get_job("acme-engineer"), created)
        self.assertEqual(self.store.list_jobs(), [created])

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already exists"):
            self.store.create_job(
                {
                    "id": "duplicate",
                    "url": "https://jobs.example.com/roles/1",
                }
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "credentials"):
            self.store.create_job(
                {
                    "id": "credential-url",
                    "url": "https://user:private@example.com/jobs/2",
                }
            )

        updated = self.store.update_job(
            "acme-engineer",
            {"notes": "Strong match", "priority": 5},
            expected_revision=1,
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["notes"], "Strong match")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_job(
                "acme-engineer", {"role": "Staff Engineer"}, expected_revision=1
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unsupported fields"):
            self.store.update_job(
                "acme-engineer", {"status": "applied"}, expected_revision=2
            )

    def test_job_update_human_can_clear_optional_fields(self):
        job = self.store.create_job(
            {
                "id": "human-clears",
                "url": "https://example.com/jobs/human-clears",
                "role": "Engineer",
                "description": "Original description",
                "notes": "Original notes",
            }
        )
        cleared = self.store.update_job(
            job["id"],
            {"role": "", "description": "", "notes": None},
            expected_revision=job["revision"],
        )
        self.assertEqual(cleared["revision"], job["revision"] + 1)
        self.assertEqual(cleared["role"], "")
        self.assertEqual(cleared["description"], "")
        self.assertIsNone(cleared["notes"])
        for field in ("role", "description", "notes"):
            self.assertEqual(cleared["provenance"][f"/{field}"]["origin"], "human")

        ignored = self.store.update_job(
            job["id"],
            {"role": "", "description": None, "notes": ""},
            expected_revision=cleared["revision"],
            origin="agent",
        )
        self.assertEqual(ignored, cleared)

    def test_job_update_human_preserves_validation_and_string_values(self):
        job = self.store.create_job(
            {
                "id": "human-update-values",
                "url": "https://example.com/jobs/original",
                "role": "Engineer",
                "provenance": {"legacy": {"keep": True}},
            }
        )
        updated = self.store.update_job(
            job["id"],
            {
                "url": " HTTPS://Jobs.Example.com:443/new#apply ",
                "role": "  Principal Engineer  ",
                "company": "",
                "provenance": {"custom": {"version": 1}},
            },
            expected_revision=job["revision"],
        )
        self.assertEqual(updated["url"], "HTTPS://Jobs.Example.com:443/new#apply")
        self.assertEqual(updated["normalizedUrl"], "https://jobs.example.com/new")
        self.assertEqual(updated["role"], "  Principal Engineer  ")
        self.assertEqual(updated["company"], "")
        self.assertIn("custom", updated["provenance"])
        self.assertNotIn("legacy", updated["provenance"])
        for field in ("url", "role", "company"):
            self.assertEqual(updated["provenance"][f"/{field}"]["origin"], "human")

        agent = self.store.update_job(
            job["id"],
            {
                "company": "Agent Company",
                "location": "Remote",
                "provenance": {"/role": {"origin": "agent"}, "hijack": True},
            },
            expected_revision=updated["revision"],
            origin="agent",
        )
        self.assertEqual(agent["company"], "")
        self.assertEqual(agent["location"], "Remote")
        self.assertEqual(agent["provenance"]["/company"]["origin"], "human")
        self.assertEqual(agent["provenance"]["/location"]["origin"], "agent")
        self.assertEqual(agent["provenance"]["/role"]["origin"], "human")
        self.assertIn("custom", agent["provenance"])
        self.assertNotIn("hijack", agent["provenance"])

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "HTTP or HTTPS"):
            self.store.update_job(
                job["id"],
                {"url": "not-a-url"},
                expected_revision=agent["revision"],
            )

    def test_agent_cannot_refill_human_cleared_fields(self):
        job = self.store.create_job(
            {
                "id": "human-cleared-precedence",
                "url": "https://example.com/jobs/human-cleared-precedence",
                "role": "Original Role",
            }
        )
        cleared = self.store.update_job(
            job["id"], {"role": ""}, expected_revision=job["revision"]
        )

        direct = self.store.update_job(
            job["id"],
            {"role": "Agent Role", "company": "Acme"},
            expected_revision=cleared["revision"],
            origin="agent",
        )
        self.assertEqual(direct["role"], "")
        self.assertEqual(direct["company"], "Acme")
        self.assertEqual(direct["provenance"]["/role"]["origin"], "human")

        payload = {
            "jobs": [
                {
                    "url": job["url"],
                    "role": "Agent Retry",
                    "description": "Agent supplied",
                }
            ]
        }
        preview = self.store.preview_job_upsert(payload, "agent")
        self.assertEqual(preview["decisions"][0]["fields"], ["description"])
        self.store.commit_job_upsert(payload, "agent", preview["token"])
        record = self.store.get_job(job["id"])
        self.assertEqual(record["role"], "")
        self.assertEqual(record["description"], "Agent supplied")
        self.assertEqual(record["provenance"]["/role"]["origin"], "human")

    def test_job_upsert_token_rejects_source_case_plan_drift(self):
        job = self.store.create_job(
            {
                "id": "source-case-drift",
                "url": "https://example.com/jobs/source-case-drift",
                "source": "LinkedIn",
            }
        )
        preview_input = {
            "jobs": [{"url": job["url"], "source": "LinkedIn"}]
        }
        preview = self.store.preview_job_upsert(preview_input, "human")
        self.assertEqual(preview["decisions"][0]["action"], "noop")

        altered_input = {
            "jobs": [{"url": job["url"], "source": "linkedin"}]
        }
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
            self.store.commit_job_upsert(altered_input, "human", preview["token"])
        self.assertEqual(self.store.get_job(job["id"]), job)

    def test_agent_ignores_protected_invalid_resume_before_validation(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
        resume = self.store.create_resume(
            {"id": "protected-resume", "label": "Protected", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {
                "id": "protected-resume-job",
                "url": "https://example.com/jobs/protected-resume",
                "resumeId": resume["id"],
            }
        )

        updated = self.store.update_job(
            job["id"],
            {"resumeId": "missing-resume", "company": "Acme"},
            expected_revision=job["revision"],
            origin="agent",
        )
        self.assertEqual(updated["resumeId"], resume["id"])
        self.assertEqual(updated["company"], "Acme")

    def test_job_upsert_preview_commit_cli_walkthrough(self):
        subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "init"],
            check=True,
            capture_output=True,
            text=True,
        )
        input_path = self.home / "upsert.json"
        input_path.write_text(
            json.dumps(
                {
                    "jobs": [
                        {
                            "url": "HTTPS://Jobs.Example.com:443/openings/42#apply",
                            "source": "LinkedIn",
                            "sourceId": "42",
                            "role": "Staff Engineer",
                        }
                    ]
                }
            ),
            encoding="utf-8",
        )

        def command(name, *extra):
            completed = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--root",
                    str(self.root),
                    name,
                    "--input",
                    str(input_path),
                    "--origin",
                    "human",
                    *extra,
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            return json.loads(completed.stdout)

        preview = command("job-upsert-preview")
        self.assertEqual(preview["summary"]["create"], 1)
        job_id = preview["decisions"][0]["id"]
        committed = command("job-upsert-commit", "--token", preview["token"])
        self.assertTrue(committed["committed"])
        self.assertEqual(committed["decisions"][0]["id"], job_id)

        replay_preview = command("job-upsert-preview")
        self.assertEqual(replay_preview["summary"]["noop"], 1)
        before = self.store.jobs_path.read_bytes()
        replay = command(
            "job-upsert-commit", "--token", replay_preview["token"]
        )
        self.assertFalse(replay["committed"])
        self.assertEqual(self.store.jobs_path.read_bytes(), before)
        self.assertEqual(self.store.get_job(job_id)["status"], "saved")

    def test_job_upsert_identity_conflicts_are_deterministic(self):
        first = self.store.create_job(
            {
                "id": "first",
                "url": "https://example.com/jobs/first",
                "source": "LinkedIn",
                "sourceId": "first-id",
            }
        )
        second = self.store.create_job(
            {
                "id": "second",
                "url": "https://example.com/jobs/second",
                "source": "LinkedIn",
                "sourceId": "second-id",
            }
        )
        cross_identity = {
            "jobs": [
                {
                    "url": first["url"],
                    "source": "linkedin",
                    "sourceId": second["sourceId"],
                }
            ]
        }
        preview = self.store.preview_job_upsert(cross_identity, "agent")
        self.assertEqual(preview["decisions"][0]["action"], "conflict")

        duplicates = {
            "jobs": [
                {"url": "https://example.com/jobs/new", "role": "One"},
                {"url": "https://example.com/jobs/new", "role": "Two"},
            ]
        }
        one = self.store.preview_job_upsert(duplicates, "agent")
        two = self.store.preview_job_upsert(duplicates, "agent")
        self.assertEqual(one["decisions"], two["decisions"])
        self.assertEqual(
            [item["action"] for item in one["decisions"]],
            ["conflict", "conflict"],
        )

        identical = {
            "jobs": [
                {"url": "https://example.com/jobs/same", "role": "Same"},
                {"url": "https://example.com/jobs/same", "role": "Same"},
            ]
        }
        collapsed = self.store.preview_job_upsert(identical, "human")
        self.assertEqual(
            [item["action"] for item in collapsed["decisions"]],
            ["create", "noop"],
        )
        self.assertEqual(
            collapsed["decisions"][0]["id"], collapsed["decisions"][1]["id"]
        )

    def test_job_upsert_preserves_human_edits_and_records_provenance(self):
        self.store.initialize()
        human = {
            "jobs": [
                {
                    "url": "https://example.com/jobs/provenance",
                    "source": "LinkedIn",
                    "sourceId": "provenance",
                    "role": "Human Role",
                }
            ]
        }
        preview = self.store.preview_job_upsert(human, "human")
        self.store.commit_job_upsert(human, "human", preview["token"])
        job_id = preview["decisions"][0]["id"]

        agent = {
            "jobs": [
                {
                    "url": human["jobs"][0]["url"],
                    "source": "linkedin",
                    "sourceId": "provenance",
                    "role": "Agent Role",
                    "company": "Acme",
                    "description": "Agent supplied",
                }
            ]
        }
        agent_preview = self.store.preview_job_upsert(agent, "agent")
        self.assertEqual(agent_preview["decisions"][0]["fields"], ["company", "description"])
        self.store.commit_job_upsert(agent, "agent", agent_preview["token"])
        record = self.store.get_job(job_id)
        self.assertEqual(record["role"], "Human Role")
        self.assertEqual(record["company"], "Acme")
        self.assertEqual(record["description"], "Agent supplied")
        self.assertEqual(record["provenance"]["/role"]["origin"], "human")
        self.assertEqual(record["provenance"]["/company"]["origin"], "agent")
        self.assertEqual(
            record["provenance"]["/company"]["observationSource"], "linkedin"
        )

        edited = self.store.update_job(
            job_id, {"role": "Human Edited Role"}, record["revision"]
        )
        ignored = self.store.update_job(
            job_id,
            {"role": "Agent Retry", "company": "New Acme"},
            edited["revision"],
            origin="agent",
        )
        self.assertEqual(ignored["role"], "Human Edited Role")
        self.assertEqual(ignored["company"], "New Acme")
        self.assertEqual(ignored["provenance"]["/role"]["origin"], "human")
        self.assertEqual(ignored["provenance"]["/company"]["origin"], "agent")

    def test_job_upsert_preview_is_non_mutating_and_rejects_drift(self):
        self.store.initialize()
        before = {
            path.name: (path.stat().st_mtime_ns, path.read_bytes())
            for path in self.root.iterdir()
            if path.is_file()
        }
        payload = {"jobs": [{"url": "https://example.com/jobs/preview"}]}
        preview = self.store.preview_job_upsert(payload, "human")
        after = {
            path.name: (path.stat().st_mtime_ns, path.read_bytes())
            for path in self.root.iterdir()
            if path.is_file()
        }
        self.assertEqual(after, before)
        self.assertNotIn(".store.lock", after)

        self.store.create_job(
            {"id": "drift", "url": "https://example.com/jobs/drift"}
        )
        current = self.store.jobs_path.read_bytes()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
            self.store.commit_job_upsert(
                payload, "human", preview["token"]
            )
        self.assertEqual(self.store.jobs_path.read_bytes(), current)

    def test_job_upsert_partial_records_remain_saved(self):
        self.store.initialize()
        payload = {
            "jobs": [
                {"url": "https://example.com/jobs/url-only"},
                {"url": "https://example.com/jobs/invalid", "role": ["invalid"]},
            ]
        }
        preview = self.store.preview_job_upsert(payload, "agent")
        job_id = preview["decisions"][0]["id"]
        committed = self.store.commit_job_upsert(
            payload, "agent", preview["token"]
        )
        self.assertEqual(committed["summary"]["create"], 1)
        self.assertEqual(committed["summary"]["invalid"], 1)
        record = self.store.get_job(job_id)
        self.assertEqual(record["status"], "saved")
        self.assertNotIn("role", record)
        self.assertNotIn("company", record)
        self.assertEqual(record["provenance"]["/url"]["origin"], "agent")

    def _write_legacy_search_report(self, name="search-2026-08-24T12-00-00.md"):
        legacy_root = self.home / ".claude-job-searches"
        legacy_root.mkdir(exist_ok=True)
        path = legacy_root / name
        path.write_text(
            """# Job Search Results — 2026-08-24

## Results (ranked by score)

### 1. Staff Engineer — Acme Corp (Score: 92)
- **Source**: LinkedIn
- **Location**: Remote
- **Salary**: $250K
- **Description**: Build reliable systems.
- **Apply**: Easy Apply
- **URL**: https://example.com/jobs/staff#apply

### 2. Missing Link — Example Co (Score: 75)
- **Source**: Hacker News
- **Apply**: Ask the poster
""",
            encoding="utf-8",
        )
        return path

    def test_legacy_job_discovery_preview_is_deterministic_and_non_mutating(self):
        source = self._write_legacy_search_report()
        source_before = source.read_bytes()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            first = self.store.preview_legacy_jobs([])
            second = self.store.preview_legacy_jobs([])
        self.assertEqual(first, second)
        self.assertFalse(self.root.exists())
        self.assertNotIn("token", first)
        self.assertEqual([item["state"] for item in first["items"]], ["valid", "invalid"])
        self.assertEqual(first["items"][1]["reason"], "missing_url")
        self.assertEqual(source.read_bytes(), source_before)

    def test_legacy_job_selected_commit_absent_store_provenance_and_rerun(self):
        source = self._write_legacy_search_report()
        source_before = source.read_bytes()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            self.assertFalse(self.root.exists())
            self.assertEqual(preview["summary"]["create"], 1)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])
            replay_preview = self.store.preview_legacy_jobs(selected)
            before = self.store.jobs_path.read_bytes()
            replay = self.store.commit_legacy_jobs(selected, replay_preview["token"])
        self.assertTrue(committed["committed"])
        self.assertFalse(replay["committed"])
        self.assertEqual(self.store.jobs_path.read_bytes(), before)
        self.assertEqual(source.read_bytes(), source_before)
        job_id = committed["decisions"][0]["id"]
        record = self.store.get_job(job_id)
        self.assertEqual(record["role"], "Staff Engineer")
        self.assertEqual(record["company"], "Acme Corp")
        self.assertEqual(record["provenance"]["/role"]["origin"], "migration")
        self.assertEqual(record["legacySources"][0]["relativePath"], source.name)
        self.assertNotIn(str(self.home), json.dumps(record["legacySources"]))

    def test_legacy_job_commit_rejects_source_selection_and_store_drift(self):
        source = self._write_legacy_search_report()
        self.store.initialize()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            source.write_bytes(source.read_bytes() + b"\n")
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
                self.store.commit_legacy_jobs(selected, preview["token"])

            fresh_discovery = self.store.preview_legacy_jobs([])
            fresh_selected = [fresh_discovery["items"][0]["itemId"]]
            fresh = self.store.preview_legacy_jobs(fresh_selected)
            self.store.create_job({"id": "drift", "url": "https://example.com/drift"})
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "drifted"):
                self.store.commit_legacy_jobs(fresh_selected, fresh["token"])
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "unknown item"):
                self.store.preview_legacy_jobs(["legacy-item-000000000000000000000000"])

    def test_legacy_migration_never_overwrites_human_or_agent_fields(self):
        self._write_legacy_search_report()
        existing = self.store.create_job(
            {"url": "https://example.com/jobs/staff", "role": "Human Role"},
            origin="human",
        )
        agent = self.store.update_job(
            existing["id"], {"company": "Agent Company"}, existing["revision"], origin="agent"
        )
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])
        record = self.store.get_job(existing["id"])
        self.assertEqual(record["role"], "Human Role")
        self.assertEqual(record["company"], "Agent Company")
        self.assertEqual(committed["decisions"][0]["fields"], ["compensation", "description", "legacySources", "location", "source"])
        self.assertEqual(agent["revision"] + 1, record["revision"])

    def test_legacy_migration_fills_a_human_cleared_field(self):
        self._write_legacy_search_report()
        existing = self.store.create_job(
            {"url": "https://example.com/jobs/staff", "role": "Human Role"},
            origin="human",
        )
        cleared = self.store.update_job(
            existing["id"], {"role": ""}, existing["revision"], origin="human"
        )
        self.assertEqual(cleared["provenance"]["/role"]["origin"], "human")

        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])

        record = self.store.get_job(existing["id"])
        self.assertEqual(record["role"], "Staff Engineer")
        self.assertEqual(record["provenance"]["/role"]["origin"], "migration")
        self.assertIn("role", committed["decisions"][0]["fields"])

    def test_legacy_migration_refreshes_migration_authored_source(self):
        source = self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            created = self.store.commit_legacy_jobs(selected, preview["token"])

            original_digest = self.store.get_job(created["decisions"][0]["id"])[
                "legacySources"
            ][0]["sourceSha256"]
            source.write_text(
                source.read_text(encoding="utf-8").replace(
                    "**Source**: LinkedIn", "**Source**: Company site"
                ),
                encoding="utf-8",
            )
            refreshed_discovery = self.store.preview_legacy_jobs([])
            refreshed_selected = [refreshed_discovery["items"][0]["itemId"]]
            refreshed_preview = self.store.preview_legacy_jobs(refreshed_selected)
            refreshed = self.store.commit_legacy_jobs(
                refreshed_selected, refreshed_preview["token"]
            )

        record = self.store.get_job(created["decisions"][0]["id"])
        self.assertEqual(refreshed["decisions"][0]["action"], "update")
        self.assertEqual(record["source"], "Company site")
        self.assertEqual(record["provenance"]["/source"]["origin"], "migration")
        self.assertNotEqual(record["legacySources"][0]["sourceSha256"], original_digest)

    def test_legacy_migration_uses_stable_locator_to_refresh_url(self):
        source = self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            created = self.store.commit_legacy_jobs(selected, preview["token"])
            job_id = created["decisions"][0]["id"]

            source.write_text(
                source.read_text(encoding="utf-8").replace(
                    "https://example.com/jobs/staff",
                    "https://example.com/jobs/staff-corrected",
                ),
                encoding="utf-8",
            )
            refreshed_discovery = self.store.preview_legacy_jobs([])
            refreshed_selected = [refreshed_discovery["items"][0]["itemId"]]
            refreshed_preview = self.store.preview_legacy_jobs(refreshed_selected)
            refreshed = self.store.commit_legacy_jobs(
                refreshed_selected, refreshed_preview["token"]
            )

        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(
            jobs[0]["url"], "https://example.com/jobs/staff-corrected#apply"
        )
        self.assertEqual(
            jobs[0]["normalizedUrl"], "https://example.com/jobs/staff-corrected"
        )
        self.assertEqual(jobs[0]["provenance"]["/url"]["origin"], "migration")
        self.assertEqual(refreshed["decisions"][0]["action"], "update")
        self.assertIn("url", refreshed["decisions"][0]["fields"])

    def test_legacy_entry_locator_survives_report_reordering(self):
        source = self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            original_item = discovery["items"][0]
            selected = [original_item["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            created = self.store.commit_legacy_jobs(selected, preview["token"])
            job_id = created["decisions"][0]["id"]

            original = source.read_text(encoding="utf-8")
            reordered = original.replace(
                "### 1. Staff Engineer — Acme Corp (Score: 92)",
                "### 2. Staff Engineer — Acme Corp (Score: 92)",
            ).replace(
                "### 2. Missing Link — Example Co (Score: 75)",
                "### 3. Missing Link — Example Co (Score: 75)",
            )
            inserted = (
                "### 1. New Role — New Co (Score: 99)\n"
                "- **URL**: https://example.com/jobs/new\n\n"
            )
            source.write_text(
                reordered.replace("## Results (ranked by score)\n", "## Results (ranked by score)\n\n" + inserted),
                encoding="utf-8",
            )

            moved_discovery = self.store.preview_legacy_jobs([])
            moved_item = next(
                item
                for item in moved_discovery["items"]
                if item.get("job", {}).get("url")
                == "https://example.com/jobs/staff#apply"
            )
            self.assertEqual(moved_item["itemId"], original_item["itemId"])
            moved_preview = self.store.preview_legacy_jobs([moved_item["itemId"]])
            moved = self.store.commit_legacy_jobs(
                [moved_item["itemId"]], moved_preview["token"]
            )

        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(jobs[0]["role"], "Staff Engineer")
        self.assertEqual(moved["decisions"][0]["id"], job_id)

    def test_duplicate_legacy_headings_keep_content_bound_locators(self):
        reports = self.home / ".claude-job-searches"
        reports.mkdir(parents=True)
        source = reports / "search-duplicate-headings.md"

        def report(first_url, second_url):
            return (
                "## Results (ranked by score)\n\n"
                "### 1. Engineer — Acme (Score: 90)\n"
                f"- **URL**: {first_url}\n\n"
                "### 2. Engineer — Acme (Score: 90)\n"
                f"- **URL**: {second_url}\n"
            )

        first_url = "https://example.com/jobs/duplicate-a"
        second_url = "https://example.com/jobs/duplicate-b"
        source.write_text(report(first_url, second_url), encoding="utf-8")
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            first_item = next(
                item for item in discovery["items"] if item["job"]["url"] == first_url
            )
            preview = self.store.preview_legacy_jobs([first_item["itemId"]])
            created = self.store.commit_legacy_jobs(
                [first_item["itemId"]], preview["token"]
            )
            job_id = created["decisions"][0]["id"]

            source.write_text(report(second_url, first_url), encoding="utf-8")
            reordered = self.store.preview_legacy_jobs([])
            moved_first = next(
                item for item in reordered["items"] if item["job"]["url"] == first_url
            )
            self.assertEqual(moved_first["itemId"], first_item["itemId"])
            moved_preview = self.store.preview_legacy_jobs([moved_first["itemId"]])
            moved = self.store.commit_legacy_jobs(
                [moved_first["itemId"]], moved_preview["token"]
            )

        jobs = self.store.list_jobs()
        self.assertEqual(len(jobs), 1)
        self.assertEqual(jobs[0]["id"], job_id)
        self.assertEqual(jobs[0]["url"], first_url)
        self.assertEqual(moved["decisions"][0]["id"], job_id)

    def test_legacy_discovery_uses_path_fallback_on_windows(self):
        self._write_legacy_search_report()
        with (
            mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home),
            mock.patch.object(STORE_MODULE.os, "name", "nt"),
        ):
            discovery = self.store.preview_legacy_jobs([])
        self.assertEqual(discovery["items"][0]["state"], "valid")
        self.assertFalse(self.root.exists())

    def test_legacy_migration_skips_protected_source_and_fills_empty_fields(self):
        self._write_legacy_search_report()
        existing = self.store.create_job(
            {
                "url": "https://example.com/jobs/staff#apply",
                "source": "Company site",
            },
            origin="human",
        )

        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])

        record = self.store.get_job(existing["id"])
        self.assertEqual(record["source"], "Company site")
        self.assertEqual(record["provenance"]["/source"]["origin"], "human")
        self.assertEqual(record["role"], "Staff Engineer")
        self.assertEqual(record["company"], "Acme Corp")
        self.assertNotIn("source", committed["decisions"][0]["fields"])

    def test_migration_origin_is_private_to_guided_legacy_methods(self):
        self.store.initialize()
        existing = self.store.create_job(
            {"id": "authority-boundary", "url": "https://example.com/authority"}
        )
        payload = {"jobs": [{"url": "https://example.com/forged"}]}

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.create_job(payload["jobs"][0], origin="migration")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.update_job(
                existing["id"],
                {"role": "Forged"},
                existing["revision"],
                origin="migration",
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.preview_job_upsert(payload, "migration")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "human or agent"):
            self.store.commit_job_upsert(payload, "migration", "forged-token")
        self.assertIsNone(
            next(
                (
                    record
                    for record in self.store.list_jobs()
                    if record["normalizedUrl"] == "https://example.com/forged"
                ),
                None,
            )
        )

    def test_generic_job_cli_rejects_migration_origin(self):
        self.store.initialize()
        input_path = self.home / "forged-migration.json"
        input_path.write_text(
            json.dumps({"jobs": [{"url": "https://example.com/forged-cli"}]}),
            encoding="utf-8",
        )
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        commands = (
            ["job-create", "--input", str(input_path), "--origin", "migration"],
            ["job-upsert-preview", "--input", str(input_path), "--origin", "migration"],
            [
                "job-upsert-commit",
                "--input",
                str(input_path),
                "--origin",
                "migration",
                "--token",
                "forged-token",
            ],
            [
                "job-update",
                "--id",
                "missing",
                "--input",
                str(input_path),
                "--expected-revision",
                "1",
                "--origin",
                "migration",
            ],
        )
        for arguments in commands:
            completed = subprocess.run(
                [*base, *arguments], capture_output=True, text=True
            )
            self.assertEqual(completed.returncode, 2)
            self.assertIn("invalid choice", completed.stderr)
            self.assertNotIn("migration-authored", completed.stdout)

    def test_generic_methods_reject_forged_migration_provenance(self):
        forged = {
            "/forged": {
                "origin": "migration",
                "observationSource": "legacy",
                "updatedAt": "2026-08-24T00:00:00Z",
            }
        }
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.create_job(
                {
                    "url": "https://example.com/forged-create",
                    "provenance": forged,
                }
            )

        ordinary = self.store.create_job(
            {"id": "ordinary-provenance", "url": "https://example.com/ordinary"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.update_job(
                ordinary["id"],
                {"provenance": forged},
                ordinary["revision"],
            )

    def test_human_edits_preserve_but_cannot_alter_guided_migration_provenance(self):
        self._write_legacy_search_report()
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            discovery = self.store.preview_legacy_jobs([])
            selected = [discovery["items"][0]["itemId"]]
            preview = self.store.preview_legacy_jobs(selected)
            committed = self.store.commit_legacy_jobs(selected, preview["token"])
        job_id = committed["decisions"][0]["id"]
        guided = self.store.get_job(job_id)
        original_company = guided["provenance"]["/company"]

        altered = json.loads(json.dumps(guided["provenance"]))
        altered["/company"]["updatedAt"] = "2000-01-01T00:00:00Z"
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.update_job(
                job_id,
                {"provenance": altered},
                guided["revision"],
            )

        removed = json.loads(json.dumps(guided["provenance"]))
        del removed["/company"]
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "reserved"):
            self.store.update_job(
                job_id,
                {"provenance": removed},
                guided["revision"],
            )

        corrected = self.store.update_job(
            job_id,
            {"role": "Human Corrected Role", "provenance": guided["provenance"]},
            guided["revision"],
        )
        self.assertEqual(corrected["role"], "Human Corrected Role")
        self.assertEqual(corrected["provenance"]["/role"]["origin"], "human")
        self.assertEqual(corrected["provenance"]["/company"], original_company)

    def test_generic_cli_rejects_forged_migration_provenance(self):
        self.store.initialize()
        ordinary = self.store.create_job(
            {"id": "cli-provenance", "url": "https://example.com/cli-provenance"}
        )
        forged = {
            "/forged": {
                "origin": "migration",
                "observationSource": "legacy",
                "updatedAt": "2026-08-24T00:00:00Z",
            }
        }
        create_input = self.home / "forged-create.json"
        create_input.write_text(
            json.dumps(
                {
                    "url": "https://example.com/forged-cli-provenance",
                    "provenance": forged,
                }
            ),
            encoding="utf-8",
        )
        update_input = self.home / "forged-update.json"
        update_input.write_text(json.dumps({"provenance": forged}), encoding="utf-8")
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        commands = (
            ["job-create", "--input", str(create_input)],
            [
                "job-update",
                "--id",
                ordinary["id"],
                "--input",
                str(update_input),
                "--expected-revision",
                str(ordinary["revision"]),
            ],
        )
        for arguments in commands:
            completed = subprocess.run(
                [*base, *arguments], capture_output=True, text=True
            )
            self.assertEqual(completed.returncode, 2)
            self.assertIn("reserved for guided legacy imports", completed.stderr)
            self.assertEqual(completed.stdout, "")

    @unittest.skipIf(os.name == "nt", "symlink behavior is platform-specific")
    def test_legacy_discovery_rejects_symlinks_and_limits(self):
        legacy_root = self.home / ".claude-job-searches"
        legacy_root.mkdir()
        target = self.home / "outside.md"
        target.write_text("outside", encoding="utf-8")
        (legacy_root / "search-link.md").symlink_to(target)
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "regular files"):
                self.store.preview_legacy_jobs([])
        (legacy_root / "search-link.md").unlink()
        (legacy_root / "search-large.md").write_bytes(b"x" * (STORE_MODULE.LEGACY_SEARCH_MAX_FILE_BYTES + 1))
        with mock.patch.object(STORE_MODULE.Path, "home", return_value=self.home):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "per-file"):
                self.store.preview_legacy_jobs([])

    def test_legacy_job_cli_walkthrough_uses_fixed_home_root(self):
        self._write_legacy_search_report()
        environment = {
            **os.environ,
            "HOME": str(self.home),
            "USERPROFILE": str(self.home),
        }
        base = [sys.executable, str(SCRIPT), "--root", str(self.root)]
        discovered = subprocess.run(
            [*base, "legacy-jobs-preview"], check=True, capture_output=True, text=True, env=environment
        )
        item_id = json.loads(discovered.stdout)["items"][0]["itemId"]
        preview = subprocess.run(
            [*base, "legacy-jobs-preview", "--select", item_id], check=True,
            capture_output=True, text=True, env=environment,
        )
        token = json.loads(preview.stdout)["token"]
        committed = subprocess.run(
            [*base, "legacy-jobs-commit", "--select", item_id, "--confirm", token],
            check=True, capture_output=True, text=True, env=environment,
        )
        self.assertTrue(json.loads(committed.stdout)["committed"])

    def test_job_transitions_require_supported_flow_and_user_submission(self):
        self.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.store.inspect_profile()["revision"],
            source="user",
        )
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
        self.store.create_resume(
            {"id": "main-resume", "label": "Main", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {"id": "acme-role", "url": "https://example.com/jobs/1"}
        )
        preflight = self.store.preflight_job(job["id"])
        self.assertTrue(preflight["ready"])
        self.assertEqual(preflight["resumeId"], "main-resume")
        self.assertEqual(set(preflight["warnings"]), {"role_missing", "company_missing"})
        job = self.store.transition_job(
            job["id"], "ready", expected_revision=job["revision"]
        )
        acquired = self.store.acquire_ready_job(
            job["id"], "unit-test-agent", job["revision"]
        )
        job = acquired["job"]
        handoff = self.store.handoff_claimed_job(
            job["id"], acquired["token"], "awaiting_review",
            {"status": "review", "step": "review", "pendingFields": []},
            job["revision"],
        )
        job = handoff["job"]
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "user confirmation"):
            self.store.transition_job(
                job["id"], "applied", expected_revision=job["revision"]
            )
        job = self.store.transition_job(
            job["id"],
            "applied",
            expected_revision=job["revision"],
            user_confirmed=True,
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "requires a supported outcome"):
            self.store.transition_job(
                job["id"], "closed", expected_revision=job["revision"]
            )
        job = self.store.transition_job(
            job["id"],
            "closed",
            expected_revision=job["revision"],
            closed_outcome="rejected",
        )
        self.assertEqual((job["status"], job["closedOutcome"]), ("closed", "rejected"))

    def _make_ready_job(self, job_id="ready-job", assigned=False):
        self.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.store.inspect_profile()["revision"],
            source="user",
        )
        default_path = self.home / "default.pdf"
        default_path.write_bytes(b"%PDF-1.7\ndefault-resume")
        self.store.create_resume(
            {"id": "default-resume", "label": "Default", "path": str(default_path)}
        )
        resume_id = None
        if assigned:
            assigned_path = self.home / "assigned.pdf"
            assigned_path.write_bytes(b"%PDF-1.7\nassigned-resume")
            assigned_resume = self.store.create_resume(
                {"id": "assigned-resume", "label": "Assigned", "path": str(assigned_path)}
            )
            resume_id = assigned_resume["id"]
        job = self.store.create_job({
            "id": job_id, "url": f"https://example.com/jobs/{job_id}",
            "role": "Engineer", "company": "Acme", "resumeId": resume_id,
        })
        return self.store.transition_job(job_id, "ready", job["revision"])

    def test_ready_acquisition_is_exclusive_and_uses_assigned_resume(self):
        self._make_ready_job(assigned=True)
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        self.assertEqual(acquired["job"]["status"], "in_progress")
        self.assertEqual(acquired["resume"]["id"], "assigned-resume")
        self.assertNotIn("tokenHash", acquired["claim"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "live job claim"):
            self.store.acquire_ready_job("ready-job", "claude", ready["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "claim token"):
            self.store.save_claim_progress(
                "ready-job", "wrong-token", {"status": "active", "step": "form"}
            )
        protected = self.store.save_claim_progress(
            "ready-job", acquired["token"], {"status": "active", "step": "protected"}
        )
        for action in (
            lambda: self.store.save_session(
                "ready-job", {"status": "review", "step": "overwrite"}
            ),
            lambda: self.store.delete_session("ready-job"),
        ):
            with self.assertRaisesRegex(
                STORE_MODULE.StoreError, "coordinator operation"
            ):
                action()
        self.assertEqual(self.store.load_session("ready-job"), protected)
        events = self.store.read_history()
        self.assertEqual([event["event"] for event in events], ["job-started"])

    def test_ready_acquisition_rejects_tampered_managed_resume_without_side_effects(self):
        ready = self._make_ready_job(assigned=True)
        resume = self.store.get_resume("assigned-resume")
        managed_path = self.store.resume_files_path / resume["managedFile"]
        managed_path.write_bytes(b"%PDF-1.7\ntampered assigned resume")
        self.store._ensure_coordinator_files()
        before = {
            "jobs": self.store.jobs_path.read_bytes(),
            "coordinator": self.store.coordinator_path.read_bytes(),
            "journal": self.store.coordinator_journal_path.read_bytes(),
            "history": self.store.history_path.read_bytes(),
        }

        preflight = self.store.preflight_job("ready-job")
        self.assertFalse(preflight["ready"])
        self.assertIn("resume_file_changed", preflight["errors"])
        self.assertNotIn("resume_file_changed", preflight["warnings"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "job is not ready"):
            self.store.acquire_ready_job("ready-job", "codex", ready["revision"])

        self.assertEqual(self.store.get_job("ready-job"), ready)
        self.assertIsNone(self.store.claim_status()["claim"])
        self.assertEqual(self.store.jobs_path.read_bytes(), before["jobs"])
        self.assertEqual(self.store.coordinator_path.read_bytes(), before["coordinator"])
        self.assertEqual(self.store.coordinator_journal_path.read_bytes(), before["journal"])
        self.assertEqual(self.store.history_path.read_bytes(), before["history"])

    def test_ready_acquisition_preserves_changed_legacy_resume_warning(self):
        self.store.replace_profile(
            {"firstName": "Ada"},
            expected_revision=self.store.inspect_profile()["revision"],
            source="user",
        )
        external = self.home / "legacy.pdf"
        external.write_bytes(b"%PDF-1.7\nlegacy resume")
        now = "2026-08-25T00:00:00Z"
        document = self.store._load_resumes_document()
        document["resumes"]["legacy"] = {
            "id": "legacy",
            "label": "Legacy",
            "path": str(external),
            "tags": [],
            "default": True,
            "observedSize": external.stat().st_size,
            "observedModifiedAt": STORE_MODULE.observe_resume_file(str(external))["modifiedAt"],
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        STORE_MODULE.atomic_write_json(self.store.resumes_path, document)
        job = self.store.create_job(
            {
                "id": "legacy-job",
                "url": "https://example.com/jobs/legacy",
                "role": "Engineer",
                "company": "Acme",
            }
        )
        ready = self.store.transition_job("legacy-job", "ready", job["revision"])
        external.write_bytes(b"%PDF-1.7\nchanged legacy resume")

        preflight = self.store.preflight_job("legacy-job")
        self.assertTrue(preflight["ready"])
        self.assertNotIn("resume_file_changed", preflight["errors"])
        self.assertIn("resume_file_changed", preflight["warnings"])
        acquired = self.store.acquire_ready_job(
            "legacy-job", "codex", ready["revision"]
        )
        self.assertEqual(acquired["job"]["status"], "in_progress")
        self.assertEqual(acquired["resume"]["path"], str(external))

    def test_expired_claim_requires_explicit_same_job_recovery_and_rotates_token(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        instant[0] += timedelta(seconds=301)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "explicit same-job recovery"):
            self.store.acquire_ready_job("ready-job", "claude", ready["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "claimed job"):
            self.store.recover_claim("different-job", "claude")
        recovered = self.store.recover_claim("ready-job", "claude")
        self.assertNotEqual(recovered["token"], acquired["token"])
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["job-started", "claim-recovered"],
        )

    def test_job_activity_projection_tracks_lifecycle_and_strictly_redacts_secrets(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        ready = self._make_ready_job()
        other = self.store.create_job({
            "id": "other-job", "url": "https://example.com/jobs/other",
            "role": "Other role", "company": "Other company",
        })
        acquired = self.store.acquire_ready_job(
            ready["id"], "private-owner", ready["revision"]
        )
        progress = {
            "status": "active",
            "step": "questions",
            "answerKeys": ["private.answer.key"],
            "pendingFields": [{
                "question": "Are you authorized to work here?",
                "state": "missing",
                "answerKey": "private.answer.key",
                "sensitive": True,
            }],
        }
        self.store.save_claim_progress(ready["id"], acquired["token"], progress)

        activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(
            (activity["job"]["status"], activity["claim"]["state"]),
            ("in_progress", "active"),
        )
        self.assertEqual(activity["session"]["step"], "questions")
        self.assertEqual(activity["session"]["pendingInformation"], [{
            "question": "Are you authorized to work here?",
            "state": "missing",
            "sensitive": True,
        }])
        self.assertEqual(
            [event["event"] for event in activity["history"]], ["job-started"]
        )
        serialized = json.dumps(activity)
        for forbidden in (
            acquired["token"], "private-owner", "private.answer.key",
            "tokenHash", "claimId", "ownerLabel", "answerKey", "answerKeys",
            "operationId", "resultClaim", "browserState",
        ):
            self.assertNotIn(forbidden, serialized)

        unrelated = self.store.get_job_activity(other["id"])
        self.assertEqual(unrelated["claim"], {"state": "none"})
        self.assertNotIn(ready["id"], json.dumps(unrelated))

        coordinator = self.store._load_coordinator_document()
        STORE_MODULE.atomic_write_json(
            self.store.coordinator_path,
            {"schemaVersion": STORE_MODULE.SCHEMA_VERSION, "claim": None},
        )
        interrupted = self.store.get_job_activity(ready["id"])
        self.assertEqual(interrupted["claim"]["state"], "interrupted")
        self.assertIn("job-transition", interrupted["claim"]["recoveryGuidance"])
        self.assertIn("needs_info", interrupted["claim"]["recoveryGuidance"])
        self.assertNotIn("claim-recover", interrupted["claim"]["recoveryGuidance"])
        STORE_MODULE.atomic_write_json(self.store.coordinator_path, coordinator)

        instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS + 1)
        expired = self.store.get_job_activity(ready["id"])
        self.assertEqual(expired["claim"]["state"], "expired")
        self.assertIn("claim-recover", expired["claim"]["recoveryGuidance"])
        recovered = self.store.recover_claim(ready["id"], "replacement-owner")
        renewed = self.store.get_job_activity(ready["id"])
        self.assertEqual(renewed["claim"]["state"], "active")
        self.assertEqual(
            [event["event"] for event in renewed["history"]],
            ["job-started", "claim-recovered"],
        )
        self.assertNotIn(recovered["token"], json.dumps(renewed))

        handed = self.store.handoff_claimed_job(
            ready["id"], recovered["token"], "needs_info", progress,
            recovered["job"]["revision"],
        )
        handed_activity = self.store.get_job_activity(ready["id"])
        self.assertEqual(handed_activity["job"]["revision"], handed["job"]["revision"])
        self.assertEqual(handed_activity["claim"], {"state": "none"})
        self.assertEqual(
            [event["event"] for event in handed_activity["history"]],
            ["job-started", "claim-recovered", "job-blocked"],
        )

    def test_needs_attention_snapshot_is_complete_ordered_redacted_and_converges(self):
        instant = [datetime(2026, 8, 26, 12, 0, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        self.store.replace_profile(
            {"firstName": "Ada"}, expected_revision=0, source="user"
        )
        resume_path = self.home / "attention.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nattention")
        self.store.create_resume(
            {"id": "attention-resume", "label": "Attention", "path": str(resume_path)}
        )

        def ready(job_id, priority):
            created = self.store.create_job({
                "id": job_id,
                "url": f"https://example.com/jobs/{job_id}",
                "role": f"Role {job_id}",
                "company": f"Company {job_id}",
                "priority": priority,
            })
            return self.store.transition_job(job_id, "ready", created["revision"])

        review_ready = ready("review-job", 5)
        review_claim = self.store.acquire_ready_job(
            review_ready["id"], "private-review-owner", review_ready["revision"]
        )
        review = self.store.handoff_claimed_job(
            review_ready["id"], review_claim["token"], "awaiting_review",
            {"status": "review", "step": "review", "pendingFields": []},
            review_claim["job"]["revision"],
        )["job"]

        needs_ready = ready("needs-job", 4)
        needs_claim = self.store.acquire_ready_job(
            needs_ready["id"], "private-needs-owner", needs_ready["revision"]
        )
        needs = self.store.handoff_claimed_job(
            needs_ready["id"], needs_claim["token"], "needs_info",
            {
                "status": "active",
                "step": "questions",
                "answerKeys": ["secret.answer.key"],
                "pendingFields": [
                    {"question": "Private question?", "state": "missing", "answerKey": "secret.answer.key", "sensitive": True},
                    {"question": "Another private question?", "state": "missing", "answerKey": "other.secret", "sensitive": False},
                ],
            },
            needs_claim["job"]["revision"],
        )["job"]

        interrupted_ready = ready("interrupted-job", 3)
        self.store.acquire_ready_job(
            interrupted_ready["id"], "private-interrupted-owner", interrupted_ready["revision"]
        )
        STORE_MODULE.atomic_write_json(
            self.store.coordinator_path,
            {"schemaVersion": STORE_MODULE.SCHEMA_VERSION, "claim": None},
        )

        expired_ready = ready("expired-job", 1)
        expired_claim = self.store.acquire_ready_job(
            expired_ready["id"], "private-expired-owner", expired_ready["revision"]
        )
        instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS + 1)

        projection = self.store.list_needs_attention()
        self.assertEqual(
            [item["reasonCode"] for item in projection["items"]],
            [
                "expired_agent_attempt",
                "claimless_interrupted_attempt",
                "awaiting_human_review",
                "needs_information",
            ],
        )
        allowed = {
            "jobId", "role", "company", "status", "revision", "priority",
            "reasonCode", "reasonLabel", "attentionAt", "guidance",
            "missingInformationCount",
        }
        self.assertTrue(all(set(item) == allowed for item in projection["items"]))
        self.assertEqual(projection["items"][-1]["missingInformationCount"], 2)
        self.assertEqual(projection, self.store.list_needs_attention())
        serialized = json.dumps(projection)
        for forbidden in (
            expired_claim["token"], "private-expired-owner", "private-review-owner",
            "Private question?", "secret.answer.key", "answerKey", "sensitive",
            "tokenHash", "claimId", "ownerLabel", "operationId", "browserState",
        ):
            self.assertNotIn(forbidden, serialized)

        recovered = self.store.recover_claim("expired-job", "replacement-owner")
        handed = self.store.handoff_claimed_job(
            "expired-job", recovered["token"], "awaiting_review",
            {"status": "review", "step": "review", "pendingFields": []},
            recovered["job"]["revision"],
        )["job"]
        self.store.transition_job("expired-job", "applied", handed["revision"], user_confirmed=True)
        interrupted = self.store.get_job("interrupted-job")
        interrupted = self.store.transition_job("interrupted-job", "needs_info", interrupted["revision"])
        self.store.transition_job("interrupted-job", "saved", interrupted["revision"])
        self.store.transition_job("review-job", "applied", review["revision"], user_confirmed=True)
        self.store.transition_job("needs-job", "saved", needs["revision"])
        self.assertEqual(self.store.list_needs_attention()["items"], [])

    def test_acquire_and_recover_tokens_are_cli_safe_when_random_payload_leads_hyphen(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        ready = self._make_ready_job()

        with mock.patch.object(
            STORE_MODULE.secrets,
            "token_urlsafe",
            side_effect=["-acquire-payload", "-recovery-payload"],
        ):
            acquired = self.store.acquire_ready_job(
                "ready-job", "codex", ready["revision"]
            )
            self.assertEqual(acquired["token"], "claim_-acquire-payload")
            parsed = STORE_MODULE.build_parser().parse_args(
                [
                    "--root",
                    str(self.root),
                    "claim-heartbeat",
                    "--id",
                    "ready-job",
                    "--token",
                    acquired["token"],
                ]
            )
            self.assertEqual(parsed.token, acquired["token"])
            persisted = self.store.coordinator_path.read_text(encoding="utf-8")
            self.assertNotIn(acquired["token"], persisted)
            self.assertIn(self.store._token_hash(acquired["token"]), persisted)

            instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS + 1)
            recovered = self.store.recover_claim("ready-job", "recovery-agent")
            self.assertEqual(recovered["token"], "claim_-recovery-payload")
            parsed = STORE_MODULE.build_parser().parse_args(
                [
                    "--root",
                    str(self.root),
                    "claim-progress",
                    "--id",
                    "ready-job",
                    "--token",
                    recovered["token"],
                    "--input",
                    "progress.json",
                ]
            )
            self.assertEqual(parsed.token, recovered["token"])
            persisted = self.store.coordinator_path.read_text(encoding="utf-8")
            self.assertNotIn(recovered["token"], persisted)
            self.assertIn(self.store._token_hash(recovered["token"]), persisted)

    def test_claim_handoffs_are_atomic_value_free_and_release_ownership(self):
        self._make_ready_job()
        ready = self.store.get_job("ready-job")
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        pending = {
            "status": "active", "step": "questions", "answerKeys": ["question.safe"],
            "pendingFields": [{"question": "Authorization?", "state": "missing", "answerKey": "question.safe", "sensitive": False}],
        }
        self.store.save_claim_progress("ready-job", acquired["token"], pending)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unsupported fields"):
            self.store.save_claim_progress(
                "ready-job", acquired["token"],
                {"status": "active", "pendingFields": [{"question": "Salary?", "value": "250K"}]},
            )
        handoff = self.store.handoff_claimed_job(
            "ready-job", acquired["token"], "needs_info", pending,
            acquired["job"]["revision"],
        )
        self.assertEqual(handoff["job"]["status"], "needs_info")
        self.assertIsNone(self.store.claim_status()["claim"])
        stored = "\n".join(
            path.read_text(encoding="utf-8")
            for path in (self.store.coordinator_path, self.store.coordinator_journal_path,
                         self.store.history_path, self.store._session_path("ready-job"))
        )
        self.assertNotIn(acquired["token"], stored)
        self.assertNotIn("250K", stored)
        self.assertEqual([event["event"] for event in self.store.read_history()], ["job-started", "job-blocked"])

    def test_coordinator_journal_rolls_forward_after_partial_failure_without_duplicates(self):
        self._make_ready_job()
        original = STORE_MODULE.atomic_write_json
        failed = {"done": False}

        def fail_coordinator_once(path, payload):
            if path == self.store.coordinator_path and payload.get("claim") is not None and not failed["done"]:
                failed["done"] = True
                raise OSError("simulated crash")
            return original(path, payload)

        with mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_coordinator_once):
            with self.assertRaises(OSError):
                ready = self.store.get_job("ready-job")
                self.store.acquire_ready_job(
                    "ready-job", "codex", ready["revision"]
                )
        repaired = STORE_MODULE.Store(self.root, self.legacy)
        status = repaired.claim_status()
        self.assertIsNotNone(status["claim"])
        self.assertEqual(repaired.get_job("ready-job")["status"], "in_progress")
        self.assertEqual([event["event"] for event in repaired.read_history()], ["job-started"])
        self.assertIsNone(repaired._load_coordinator_journal()["operation"])

    def test_claimed_jobs_reject_generic_mutations_and_divergence_claim_actions(self):
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        revision = acquired["job"]["revision"]
        for action in (
            lambda: self.store.transition_job("ready-job", "awaiting_review", revision),
            lambda: self.store.trash_job("ready-job", revision),
            lambda: self.store.delete_job("ready-job", revision),
        ):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "coordinator operation"):
                action()

        document = json.loads(self.store.jobs_path.read_text(encoding="utf-8"))
        document["jobs"]["ready-job"]["status"] = "awaiting_review"
        document["jobs"]["ready-job"]["revision"] += 1
        self.store.jobs_path.write_text(json.dumps(document), encoding="utf-8")
        for action in (
            lambda: self.store.heartbeat_claim("ready-job", acquired["token"]),
            lambda: self.store.save_claim_progress(
                "ready-job", acquired["token"], {"status": "active", "step": "form"}
            ),
            lambda: self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "awaiting_review",
                {"status": "review", "step": "review"}, revision + 1,
            ),
            lambda: self.store.recover_claim("ready-job", "recovery-agent"),
        ):
            with self.assertRaisesRegex(STORE_MODULE.StoreError, "not in progress"):
                action()

    def test_lease_boundary_expires_exactly_at_expires_at(self):
        instant = [datetime(2026, 8, 24, tzinfo=timezone.utc)]
        self.store = STORE_MODULE.Store(self.root, self.legacy, clock=lambda: instant[0])
        ready = self._make_ready_job()
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        instant[0] += timedelta(seconds=STORE_MODULE.CLAIM_LEASE_SECONDS)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "claim has expired"):
            self.store.heartbeat_claim("ready-job", acquired["token"])
        recovered = self.store.recover_claim("ready-job", "recovery-agent")
        self.assertNotEqual(recovered["token"], acquired["token"])

    def test_expected_revisions_and_default_resume_are_enforced(self):
        ready = self._make_ready_job()
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.acquire_ready_job("ready-job", "codex", ready["revision"] - 1)
        acquired = self.store.acquire_ready_job("ready-job", "codex", ready["revision"])
        self.assertEqual(acquired["resume"]["id"], "default-resume")
        updated = self.store.update_job(
            "ready-job", {"notes": "human update"}, acquired["job"]["revision"]
        )
        review = {"status": "review", "step": "review", "pendingFields": []}
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.handoff_claimed_job(
                "ready-job", acquired["token"], "awaiting_review", review,
                acquired["job"]["revision"],
            )
        self.assertIsNotNone(self.store.claim_status()["claim"])
        handed = self.store.handoff_claimed_job(
            "ready-job", acquired["token"], "awaiting_review", review,
            updated["revision"],
        )
        self.assertEqual(handed["job"]["status"], "awaiting_review")

    def test_acquisition_and_handoff_roll_forward_at_each_failure_boundary(self):
        original_write = STORE_MODULE.atomic_write_json

        def ready_store(case):
            root = self.home / "boundaries" / case
            store = STORE_MODULE.Store(root, self.legacy)
            store.replace_profile(
                {"firstName": "Ada"},
                expected_revision=store.inspect_profile()["revision"],
                source="user",
            )
            resume_path = root / "resume.pdf"
            resume_path.write_bytes(b"%PDF-1.7\nresume")
            store.create_resume({"id": "resume", "label": "Resume", "path": str(resume_path)})
            job = store.create_job({"id": "job", "url": f"https://example.com/{case}"})
            ready = store.transition_job("job", "ready", job["revision"])
            store.claim_status()
            return store, ready

        acquisition_boundaries = {
            "journal-write": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is not None,
            "jobs": lambda store, path, payload: path == store.jobs_path,
            "history": None,
            "coordinator": lambda store, path, payload: path == store.coordinator_path and payload.get("claim") is not None,
            "journal-clear": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is None,
        }
        for name, predicate in acquisition_boundaries.items():
            with self.subTest(operation="acquire", boundary=name):
                store, ready = ready_store(f"acquire-{name}")
                if name == "history":
                    patcher = mock.patch.object(
                        store, "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                else:
                    failed = {"done": False}
                    def fail_once(path, payload, predicate=predicate, store=store):
                        if predicate(store, path, payload) and not failed["done"]:
                            failed["done"] = True
                            raise OSError("simulated crash")
                        return original_write(path, payload)
                    patcher = mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_once)
                with patcher, self.assertRaises(OSError):
                    store.acquire_ready_job("job", "agent", ready["revision"])
                repaired = STORE_MODULE.Store(store.root, self.legacy)
                if name == "journal-write":
                    self.assertIsNone(repaired.claim_status()["claim"])
                    self.assertEqual(repaired.get_job("job")["status"], "ready")
                    self.assertEqual(repaired.read_history(), [])
                    continue
                self.assertIsNotNone(repaired.claim_status()["claim"])
                self.assertEqual(repaired.get_job("job")["status"], "in_progress")
                self.assertEqual([event["event"] for event in repaired.read_history()], ["job-started"])

        handoff_boundaries = {
            "journal-write": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is not None,
            "jobs": lambda store, path, payload: path == store.jobs_path,
            "session": lambda store, path, payload: path == store._session_path("job"),
            "history": None,
            "coordinator": lambda store, path, payload: path == store.coordinator_path and payload.get("claim") is None,
            "journal-clear": lambda store, path, payload: path == store.coordinator_journal_path and payload.get("operation") is None,
        }
        for name, predicate in handoff_boundaries.items():
            with self.subTest(operation="handoff", boundary=name):
                store, ready = ready_store(f"handoff-{name}")
                acquired = store.acquire_ready_job("job", "agent", ready["revision"])
                if name == "history":
                    patcher = mock.patch.object(
                        store, "_append_history_event_idempotent_locked",
                        side_effect=OSError("simulated crash"),
                    )
                else:
                    failed = {"done": False}
                    def fail_once(path, payload, predicate=predicate, store=store):
                        if predicate(store, path, payload) and not failed["done"]:
                            failed["done"] = True
                            raise OSError("simulated crash")
                        return original_write(path, payload)
                    patcher = mock.patch.object(STORE_MODULE, "atomic_write_json", side_effect=fail_once)
                with patcher, self.assertRaises(OSError):
                    store.handoff_claimed_job(
                        "job", acquired["token"], "awaiting_review",
                        {"status": "review", "step": "review"},
                        acquired["job"]["revision"],
                    )
                repaired = STORE_MODULE.Store(store.root, self.legacy)
                if name == "journal-write":
                    self.assertIsNotNone(repaired.claim_status()["claim"])
                    self.assertEqual(repaired.get_job("job")["status"], "in_progress")
                    self.assertFalse(repaired._session_path("job").exists())
                    self.assertEqual(
                        [event["event"] for event in repaired.read_history()],
                        ["job-started"],
                    )
                    continue
                self.assertIsNone(repaired.claim_status()["claim"])
                self.assertEqual(repaired.get_job("job")["status"], "awaiting_review")
                self.assertEqual(repaired.load_session("job")["status"], "review")
                self.assertEqual(
                    [event["event"] for event in repaired.read_history()],
                    ["job-started", "reviewed"],
                )

    def test_pending_coordinator_operation_repairs_partial_history_tail(self):
        ready = self._make_ready_job()

        def append_partial_then_crash(event):
            encoded = (
                json.dumps(event, sort_keys=True, ensure_ascii=False) + "\n"
            ).encode("utf-8")
            descriptor = os.open(
                self.store.history_path,
                os.O_WRONLY | os.O_CREAT | os.O_APPEND,
                0o600,
            )
            try:
                os.write(descriptor, encoded[: len(encoded) // 2])
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
            raise OSError("simulated process crash after partial append")

        with mock.patch.object(
            self.store,
            "_append_history_event_idempotent_locked",
            side_effect=append_partial_then_crash,
        ):
            with self.assertRaisesRegex(OSError, "partial append"):
                self.store.acquire_ready_job("ready-job", "codex", ready["revision"])

        self.assertFalse(self.store.history_path.read_bytes().endswith(b"\n"))
        repaired = STORE_MODULE.Store(self.root, self.legacy)
        self.assertIsNotNone(repaired.claim_status()["claim"])
        self.assertEqual(repaired.get_job("ready-job")["status"], "in_progress")
        self.assertEqual(
            [event["event"] for event in repaired.read_history()], ["job-started"]
        )
        self.assertIsNone(repaired._load_coordinator_journal()["operation"])

    def test_ready_transition_fails_closed_without_profile_or_resume(self):
        job = self.store.create_job(
            {"id": "not-ready", "url": "https://example.com/jobs/not-ready"}
        )
        preflight = self.store.preflight_job(job["id"])
        self.assertFalse(preflight["ready"])
        self.assertEqual(
            set(preflight["errors"]), {"profile_empty", "resume_missing"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "not ready"):
            self.store.transition_job(
                job["id"], "ready", expected_revision=job["revision"]
            )

    def test_job_trash_restore_and_permanent_delete_are_guarded(self):
        job = self.store.create_job(
            {"id": "acme-role", "url": "https://example.com/jobs/1"}
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "must be trashed"):
            self.store.delete_job(job["id"], expected_revision=job["revision"])

        trashed = self.store.trash_job(job["id"], expected_revision=job["revision"])
        self.assertIsNotNone(trashed["deletedAt"])
        self.assertIsNone(self.store.get_job(job["id"]))
        self.assertEqual(
            self.store.get_job(job["id"], include_trashed=True), trashed
        )
        self.assertEqual(self.store.list_jobs(), [])

        restored = self.store.restore_job(
            job["id"], expected_revision=trashed["revision"]
        )
        self.assertIsNone(restored["deletedAt"])
        trashed_again = self.store.trash_job(
            job["id"], expected_revision=restored["revision"]
        )
        result = self.store.delete_job(
            job["id"], expected_revision=trashed_again["revision"]
        )
        self.assertEqual(result, {"deleted": True, "id": job["id"]})
        self.assertIsNone(self.store.get_job(job["id"], include_trashed=True))

    def test_trash_only_filters_are_symmetric_and_job_delete_blocks_nonterminal_session(self):
        self.store.save_session(
            "session-job",
            {"status": "active", "answerKeys": [], "pendingFields": []},
        )
        active_job = self.store.create_job(
            {"id": "active-job", "url": "https://example.com/jobs/active"}
        )
        session_job = self.store.create_job(
            {"id": "session-job", "url": "https://example.com/jobs/session"}
        )
        trashed_job = self.store.trash_job(
            session_job["id"], session_job["revision"]
        )
        self.assertEqual(
            [item["id"] for item in self.store.list_jobs(trashed_only=True)],
            ["session-job"],
        )
        self.assertEqual([item["id"] for item in self.store.list_jobs()], [active_job["id"]])
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "nonterminal application session"
        ):
            self.store.delete_job(trashed_job["id"], trashed_job["revision"])
        self.assertIsNotNone(
            self.store.get_job(trashed_job["id"], include_trashed=True)
        )

        first_path = self.home / "first-trash-filter.pdf"
        second_path = self.home / "second-trash-filter.pdf"
        first_path.write_bytes(b"%PDF-1.7\nfirst")
        second_path.write_bytes(b"%PDF-1.7\nsecond")
        first = self.store.create_resume(
            {"id": "active-resume", "label": "Active", "path": str(first_path)}
        )
        second = self.store.create_resume(
            {"id": "trash-resume", "label": "Trash", "path": str(second_path)}
        )
        second = self.store.trash_resume(second["id"], second["revision"])
        self.assertEqual(
            [item["id"] for item in self.store.list_resumes(trashed_only=True)],
            [second["id"]],
        )
        self.assertEqual(
            [item["id"] for item in self.store.list_resumes()], [first["id"]]
        )

    def test_tampered_job_store_fails_closed(self):
        self.store.initialize()
        document = json.loads(self.store.jobs_path.read_text(encoding="utf-8"))
        document["jobs"]["bad-job"] = {
            "id": "bad-job",
            "url": "https://example.com/job",
            "normalizedUrl": "https://different.example.com/job",
            "status": "saved",
            "priority": 0,
            "revision": 1,
            "provenance": {},
            "createdAt": "2026-08-24T00:00:00Z",
            "updatedAt": "2026-08-24T00:00:00Z",
            "deletedAt": None,
        }
        self.store.jobs_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "normalized URL"):
            self.store.list_jobs()

    def test_resume_registry_tracks_files_defaults_and_revisions(self):
        first_path = self.home / "resume-a.pdf"
        first_path.write_bytes(b"%PDF-1.7\nresume-a")
        first = self.store.create_resume(
            {
                "id": "resume-a",
                "label": "Engineering",
                "path": str(first_path),
                "tags": ["engineering"],
            }
        )
        self.assertTrue(first["default"])
        self.assertEqual(first["observedSize"], len(b"%PDF-1.7\nresume-a"))
        self.assertFalse(self.store.check_resume(first["id"])["changed"])

        missing_path = self.home / "resume-b.txt"
        missing_path.write_text("leadership resume", encoding="utf-8")
        second = self.store.create_resume(
            {
                "id": "resume-b",
                "label": "Leadership",
                "path": str(missing_path),
            }
        )
        self.assertFalse(second["default"])
        self.assertTrue(self.store.check_resume(second["id"])["exists"])
        second = self.store.set_default_resume(
            second["id"], expected_revision=second["revision"]
        )
        self.assertTrue(second["default"])
        refreshed_first = self.store.get_resume(first["id"])
        self.assertFalse(refreshed_first["default"])
        self.assertEqual(refreshed_first["revision"], first["revision"] + 1)

        first_path.write_bytes(b"changed source is no longer canonical")
        self.assertFalse(self.store.check_resume(first["id"])["changed"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_resume(
                first["id"], {"label": "Old"}, expected_revision=first["revision"]
            )
        updated = self.store.update_resume(
            first["id"],
            {"label": "Updated Engineering", "tags": ["staff"]},
            expected_revision=refreshed_first["revision"],
        )
        self.assertEqual(updated["label"], "Updated Engineering")
        self.assertEqual(self.store.list_resumes()[0]["id"], second["id"])

    def test_managed_resume_import_is_private_strict_and_source_independent(self):
        source = self.home / "resume.txt"
        source.write_text("Résumé text", encoding="utf-8")
        created = self.store.import_resume(
            {"id": "managed", "label": "Managed", "path": str(source)}
        )
        self.assertEqual(created["storageKind"], "managed")
        self.assertNotIn("path", created)
        stored = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        serialized = json.dumps(stored)
        self.assertNotIn(str(source), serialized)
        managed_path = self.store.resume_files_path / created["managedFile"]
        self.assertEqual(managed_path.read_text(encoding="utf-8"), "Résumé text")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(managed_path.stat().st_mode), 0o600)
            self.assertEqual(stat.S_IMODE(self.store.resume_files_path.stat().st_mode), 0o700)
        source.unlink()
        self.assertTrue(self.store.check_resume(created["id"])["exists"])

        docx = self.home / "resume.docx"
        with STORE_MODULE.zipfile.ZipFile(docx, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types />")
            archive.writestr("word/document.xml", "<document />")
        imported_docx = self.store.create_resume(
            {"id": "docx", "label": "DOCX", "path": str(docx)}
        )
        self.assertEqual(imported_docx["mediaType"], STORE_MODULE.RESUME_MEDIA_TYPES[".docx"])

        invalid = self.home / "invalid.pdf"
        invalid.write_bytes(b"not a pdf")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "does not match"):
            self.store.create_resume(
                {"id": "invalid", "label": "Invalid", "path": str(invalid)}
            )
        oversized = self.home / "oversized.txt"
        oversized.write_bytes(b"x" * (STORE_MODULE.RESUME_MAX_BYTES + 1))
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "10 MiB"):
            self.store.create_resume(
                {"id": "oversized", "label": "Oversized", "path": str(oversized)}
            )

    def test_owner_like_redacted_pdf_is_a_reproducible_managed_resume_fixture(self):
        source = ROOT / "qa" / "testdata" / "resumes" / "owner-like-redacted.pdf"
        content = source.read_bytes()
        expected_digest = (
            "aa5db02218f2eb40ab26521fb614b8bc"
            "86527fa11ee1c531b5555f6b54aad551"
        )

        self.assertEqual(hashlib.sha256(content).hexdigest(), expected_digest)
        created = self.store.import_resume(
            {"id": "owner-like", "label": "Owner-like redacted", "path": str(source)}
        )

        self.assertEqual(created["storageKind"], "managed")
        self.assertEqual(created["mediaType"], STORE_MODULE.RESUME_MEDIA_TYPES[".pdf"])
        self.assertEqual(created["digest"], expected_digest)
        self.assertNotIn("path", created)
        stored_record, stored_content = self.store.read_resume_content(created["id"])
        self.assertEqual(stored_record["digest"], expected_digest)
        self.assertEqual(stored_content, content)

    def test_failed_managed_staging_is_removed_immediately(self):
        source = self.home / "cleanup.txt"
        source.write_text("synthetic cleanup resume", encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "label"):
            self.store.create_resume(
                {"id": "bad-label", "label": "", "path": str(source)}
            )
        self.assertEqual(list(self.store.resume_files_path.glob(".*.tmp")), [])

        created = self.store.create_resume(
            {"id": "cleanup", "label": "Cleanup", "path": str(source)}
        )
        replacement = self.home / "replacement.pdf"
        replacement.write_bytes(b"%PDF-1.7\nsynthetic replacement")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "tags"):
            self.store.update_resume(
                created["id"],
                {"path": str(replacement), "tags": [""]},
                created["revision"],
            )
        self.assertEqual(list(self.store.resume_files_path.glob(".*.tmp")), [])
        self.assertEqual(self.store.get_resume(created["id"]), created)

    def test_managed_resume_bytes_share_validation_revisions_and_fail_clean_storage(self):
        created = self.store.create_resume_bytes(
            {"id": "browser-bytes", "label": "Browser bytes"},
            "private-browser-name.txt",
            b"synthetic browser resume",
        )
        self.assertNotEqual(created["originalFilename"], "private-browser-name.txt")
        record, content = self.store.read_resume_content(created["id"])
        self.assertEqual((record["id"], content), (created["id"], b"synthetic browser resume"))
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_resume_bytes(created["id"], "new.pdf", b"%PDF-1.7\nnew", 99)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "does not match"):
            self.store.update_resume_bytes(created["id"], "new.pdf", b"not pdf", created["revision"])
        self.assertEqual(self.store.get_resume(created["id"]), created)
        self.assertEqual(list(self.store.resume_files_path.glob(".*.tmp")), [])
        self.assertEqual(list(self.store.resume_files_path.glob(".browser-upload.*")), [])
        updated = self.store.update_resume_bytes(
            created["id"], "new.pdf", b"%PDF-1.7\nnew", created["revision"]
        )
        self.assertEqual((updated["id"], updated["revision"]), (created["id"], created["revision"] + 1))
        self.assertEqual(self.store.read_resume_content(created["id"])[1], b"%PDF-1.7\nnew")
        managed_path = self.store.resume_files_path / updated["managedFile"]
        managed_path.write_bytes(b"%PDF-1.7\ntampered")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unavailable"):
            self.store.read_resume_content(created["id"])

    def test_browser_source_cleanup_failure_does_not_reverse_commit_and_is_recoverable(self):
        original_unlink = Path.unlink

        def fail_browser_cleanup(path, *args, **kwargs):
            if path.name.startswith(".browser-upload."):
                raise PermissionError("synthetic cleanup failure")
            return original_unlink(path, *args, **kwargs)

        with mock.patch.object(Path, "unlink", fail_browser_cleanup):
            created = self.store.create_resume_bytes(
                {"id": "cleanup-success", "label": "Cleanup success"},
                "private.txt",
                b"committed bytes",
            )
        self.assertEqual(self.store.get_resume(created["id"])["id"], created["id"])
        orphans = list(self.store.resume_files_path.glob(".browser-upload.*"))
        self.assertEqual(len(orphans), 1)
        old = time.time() - STORE_MODULE.UPLOAD_RECOVERY_GRACE_SECONDS - 1
        os.utime(orphans[0], (old, old))
        self.store.initialize()
        self.assertFalse(orphans[0].exists())

    def test_resume_resolve_returns_only_a_verified_active_managed_path(self):
        created = self.store.create_resume_bytes(
            {"id": "resolved", "label": "Resolved"}, "source.txt", b"resolved bytes"
        )
        resolved = self.store.resolve_resume()
        self.assertEqual(set(resolved), {"id", "revision", "mediaType", "path"})
        self.assertEqual(Path(resolved["path"]).read_bytes(), b"resolved bytes")
        self.assertEqual(self.store.resolve_resume("resolved")["id"], created["id"])
        managed_path = Path(resolved["path"])
        managed_path.write_bytes(b"tampered")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "unavailable"):
            self.store.resolve_resume("resolved")

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

    def test_resume_proposal_journal_recovers_every_commit_boundary(self):
        for boundary in ("profile", "proposals", "clear"):
            with self.subTest(boundary=boundary):
                root = self.home / f"journal-{boundary}"
                store = STORE_MODULE.Store(root, self.legacy)
                source = self.home / f"journal-{boundary}.txt"
                source.write_text(f"synthetic {boundary} resume", encoding="utf-8")
                resume = store.create_resume(
                    {"id": f"resume-{boundary}", "label": "Synthetic", "path": str(source)}
                )
                original_write = STORE_MODULE.atomic_write_json
                journal_started = False
                failed = False

                def fail_boundary_once(path, payload):
                    nonlocal journal_started, failed
                    operation = payload.get("operation") if isinstance(payload, dict) else None
                    if path == store.resume_extraction_journal_path and operation is not None:
                        journal_started = True
                    should_fail = (
                        not failed
                        and journal_started
                        and (
                            (boundary == "profile" and path == store.profile_path)
                            or (
                                boundary == "proposals"
                                and path == store.resume_extractions_path
                            )
                            or (
                                boundary == "clear"
                                and path == store.resume_extraction_journal_path
                                and operation is None
                            )
                        )
                    )
                    if should_fail:
                        failed = True
                        raise OSError("synthetic journal boundary failure")
                    return original_write(path, payload)

                with mock.patch.object(
                    STORE_MODULE, "atomic_write_json", side_effect=fail_boundary_once
                ):
                    with self.assertRaises(OSError):
                        store.create_resume_proposal(
                            resume["id"],
                            {"email": f"{boundary}@example.invalid"},
                            resume["revision"],
                            1,
                        )
                repaired = STORE_MODULE.Store(root, self.legacy)
                repaired.initialize()
                self.assertEqual(
                    repaired.inspect_profile()["profile"]["email"],
                    f"{boundary}@example.invalid",
                )
                self.assertEqual(len(repaired.list_resume_proposals()), 1)
                journal = json.loads(
                    repaired.resume_extraction_journal_path.read_text(encoding="utf-8")
                )
                self.assertIsNone(journal["operation"])

    def test_resume_proposal_reports_missing_changed_trashed_and_deleted_resumes(self):
        for condition, expected_reason in (
            ("missing", "resume_file_missing"),
            ("changed", "resume_file_changed"),
            ("trashed", "resume_trashed"),
            ("deleted", "resume_deleted"),
        ):
            with self.subTest(condition=condition):
                root = self.home / f"stale-{condition}"
                store = STORE_MODULE.Store(root, self.legacy)
                source = self.home / f"stale-{condition}.txt"
                source.write_text(f"synthetic {condition} resume", encoding="utf-8")
                resume = store.create_resume(
                    {"id": f"stale-{condition}", "label": "Synthetic", "path": str(source)}
                )
                proposal = store.create_resume_proposal(
                    resume["id"],
                    {"email": f"{condition}@example.invalid"},
                    resume["revision"],
                    1,
                )
                managed_path = store.resume_files_path / resume["managedFile"]
                if condition == "missing":
                    managed_path.unlink()
                elif condition == "changed":
                    managed_path.write_text("changed synthetic bytes", encoding="utf-8")
                else:
                    trashed = store.trash_resume(resume["id"], resume["revision"])
                    if condition == "deleted":
                        store.delete_resume(resume["id"], trashed["revision"])
                stale = store.get_resume_proposal(proposal["id"])
                self.assertTrue(stale["stale"])
                self.assertIn(expected_reason, stale["staleReasons"])

    def test_managed_resume_duplicate_replace_and_rollback_are_deterministic(self):
        source = self.home / "original.pdf"
        source.write_bytes(b"%PDF-1.7\noriginal")
        created = self.store.create_resume(
            {"id": "stable", "label": "Stable", "path": str(source)}
        )
        duplicate = self.home / "duplicate.pdf"
        duplicate.write_bytes(source.read_bytes())
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already managed"):
            self.store.create_resume(
                {"id": "duplicate", "label": "Duplicate", "path": str(duplicate)}
            )
        trashed = self.store.trash_resume(created["id"], created["revision"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "already managed"):
            self.store.create_resume(
                {"id": "duplicate", "label": "Duplicate", "path": str(duplicate)}
            )
        created = self.store.restore_resume(created["id"], trashed["revision"])
        replacement = self.home / "replacement.txt"
        replacement.write_text("replacement", encoding="utf-8")
        updated = self.store.update_resume(
            created["id"], {"path": str(replacement)}, created["revision"]
        )
        self.assertEqual(updated["id"], created["id"])
        self.assertEqual(updated["revision"], created["revision"] + 1)
        self.assertNotEqual(updated["digest"], created["digest"])
        self.assertFalse((self.store.resume_files_path / created["managedFile"]).exists())

        failed_source = self.home / "failed.txt"
        failed_source.write_text("failed replacement", encoding="utf-8")
        canonical_path = self.store.resume_files_path / updated["managedFile"]
        canonical_bytes = canonical_path.read_bytes()
        with mock.patch.object(
            STORE_MODULE, "atomic_write_json", side_effect=OSError("synthetic")
        ):
            with self.assertRaises(OSError):
                self.store.update_resume(
                    updated["id"], {"path": str(failed_source)}, updated["revision"]
                )
        self.assertEqual(canonical_path.read_bytes(), canonical_bytes)
        self.assertEqual(self.store.get_resume(updated["id"]), updated)

        quarantine = self.store.resume_files_path / (
            f".{updated['managedFile']}.synthetic.quarantine"
        )
        os.replace(canonical_path, quarantine)
        self.store.initialize()
        self.assertTrue(canonical_path.exists())
        self.assertFalse(quarantine.exists())

    def test_legacy_resume_adoption_preserves_identity_and_rolls_back_delete(self):
        self.store.initialize()
        external = self.home / "legacy.pdf"
        external.write_bytes(b"%PDF-1.7\nlegacy")
        now = "2026-08-25T00:00:00Z"
        document = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        document["resumes"]["legacy"] = {
            "id": "legacy",
            "label": "Legacy",
            "path": str(external),
            "tags": [],
            "default": True,
            "observedSize": external.stat().st_size,
            "observedModifiedAt": STORE_MODULE.observe_resume_file(str(external))["modifiedAt"],
            "revision": 4,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        STORE_MODULE.atomic_write_json(self.store.resumes_path, document)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "adopted"):
            self.store.resolve_resume("legacy")
        adopted = self.store.adopt_resume("legacy", None, 4)
        self.assertEqual((adopted["id"], adopted["revision"]), ("legacy", 5))
        self.assertNotIn("path", adopted)
        external.unlink()
        trashed = self.store.trash_resume("legacy", adopted["revision"])
        managed_path = self.store.resume_files_path / adopted["managedFile"]
        with mock.patch.object(
            STORE_MODULE, "atomic_write_json", side_effect=OSError("synthetic")
        ):
            with self.assertRaises(OSError):
                self.store.delete_resume("legacy", trashed["revision"])
        self.assertTrue(managed_path.exists())
        self.assertEqual(
            self.store.get_resume("legacy", include_trashed=True)["revision"],
            trashed["revision"],
        )

    def test_resume_assignment_prevents_trash_until_job_is_reassigned(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
        resume = self.store.create_resume(
            {"id": "resume-main", "label": "Main", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {
                "id": "assigned-job",
                "url": "https://example.com/jobs/assigned",
                "resumeId": resume["id"],
            }
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "assigned"):
            self.store.trash_resume(
                resume["id"], expected_revision=resume["revision"]
            )
        job = self.store.update_job(
            job["id"], {"resumeId": None}, expected_revision=job["revision"]
        )
        self.assertIsNone(job["resumeId"])
        alternate_path = self.home / "alternate.txt"
        alternate_path.write_text("alternate resume", encoding="utf-8")
        alternate = self.store.create_resume(
            {"id": "resume-alternate", "label": "Alternate", "path": str(alternate_path)}
        )
        self.store.set_default_resume(alternate["id"], alternate["revision"])
        resume = self.store.get_resume(resume["id"])
        trashed = self.store.trash_resume(
            resume["id"], expected_revision=resume["revision"]
        )
        self.assertIsNotNone(trashed["deletedAt"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "does not exist"):
            self.store.update_job(
                job["id"],
                {"resumeId": resume["id"]},
                expected_revision=job["revision"],
            )
        restored = self.store.restore_resume(
            resume["id"], expected_revision=trashed["revision"]
        )
        trashed_again = self.store.trash_resume(
            resume["id"], expected_revision=restored["revision"]
        )
        self.assertEqual(
            self.store.delete_resume(
                resume["id"], expected_revision=trashed_again["revision"]
            ),
            {"deleted": True, "id": resume["id"]},
        )

    def test_tampered_resume_store_with_multiple_defaults_fails_closed(self):
        first_path = self.home / "first.pdf"
        second_path = self.home / "second.pdf"
        first_path.write_bytes(b"%PDF-1.7\nfirst")
        second_path.write_bytes(b"%PDF-1.7\nsecond")
        first = self.store.create_resume(
            {"id": "first", "label": "First", "path": str(first_path)}
        )
        second = self.store.create_resume(
            {"id": "second", "label": "Second", "path": str(second_path)}
        )
        document = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        document["resumes"][first["id"]]["default"] = True
        document["resumes"][second["id"]]["default"] = True
        self.store.resumes_path.write_text(json.dumps(document), encoding="utf-8")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "more than one"):
            self.store.list_resumes()

    def test_resume_permanent_delete_rejects_trashed_job_reference(self):
        resume_path = self.home / "resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nresume")
        resume = self.store.create_resume(
            {"id": "resume-main", "label": "Main", "path": str(resume_path)}
        )
        job = self.store.create_job(
            {
                "id": "job-main",
                "url": "https://example.com/jobs/main",
                "resumeId": resume["id"],
            }
        )
        job = self.store.trash_job(job["id"], expected_revision=job["revision"])
        resume = self.store.trash_resume(
            resume["id"], expected_revision=resume["revision"]
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "referenced"):
            self.store.delete_resume(
                resume["id"], expected_revision=resume["revision"]
            )
        self.store.delete_job(job["id"], expected_revision=job["revision"])
        self.assertEqual(
            self.store.delete_resume(
                resume["id"], expected_revision=resume["revision"]
            ),
            {"deleted": True, "id": resume["id"]},
        )

    def test_history_is_minimal_parseable_and_rejects_answer_values(self):
        answer = self.store.put_answer(
            {"key": "work_authorization.us", "state": "missing"}
        )
        event = self.store.append_history(
            {
                "applicationId": "acme-role-1",
                "event": "started",
                "company": "Acme",
                "role": "Engineer",
                "answerKeys": ["work_authorization.us"],
            }
        )
        self.assertEqual(event["answerKeys"], [answer["key"]])
        parsed = self.store.read_history()
        self.assertEqual(len(parsed), 1)
        self.assertNotIn("value", parsed[0])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.append_history(
                {
                    "applicationId": "acme-role-1",
                    "event": "progressed",
                    "answerValue": "secret",
                }
            )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.append_history(
                {
                    "applicationId": "acme-role-1",
                    "event": "progressed",
                    "company": {"answerValue": "private"},
                }
            )

    def test_tampered_history_fails_closed(self):
        self.store.initialize()
        self.store.history_path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "eventId": "event-1",
                    "applicationId": "acme-role-1",
                    "event": "started",
                    "answerKeys": [],
                    "company": {"value": "private"},
                }
            )
            + "\n",
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.read_history()

    def test_future_value_free_history_reads_without_mutation_but_writes_stay_strict(self):
        self.store.initialize()
        self.store.claim_status()
        future_event = {
            "schemaVersion": 1,
            "eventId": "future-event-1",
            "applicationId": "future-application",
            "event": "future-safe-event",
            "company": "Example",
            "role": "Engineer",
            "ats": "future-ats",
            "status": "future-status",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(future_event) + "\n", encoding="utf-8"
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        reopened = STORE_MODULE.Store(self.root, self.legacy)
        reopened.validate_workspace_startup()
        reopened.initialize()
        self.assertEqual(reopened.get_profile(), {})
        self.assertEqual(reopened.list_jobs(), [])
        self.assertIsNone(reopened.claim_status()["claim"])
        self.assertEqual(reopened.read_history(), [future_event])
        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "type is unsupported"):
            reopened.append_history(
                {
                    "applicationId": "future-application",
                    "event": "future-safe-event",
                    "answerKeys": [],
                }
            )

    def test_unknown_history_event_is_inert_for_replay_semantics(self):
        self.store.initialize()
        future_event = {
            "schemaVersion": 1,
            "eventId": "future-event-2",
            "applicationId": "qa-future-event",
            "event": "future-terminal-looking-event",
            "ats": "different-future-ats",
            "status": "completed",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(future_event) + "\n", encoding="utf-8"
        )

        result = self.store.record_replay_transition(
            "qa-future-event", "started", "greenhouse"
        )

        self.assertTrue(result["changed"])
        self.assertEqual(
            [event["event"] for event in self.store.read_history()],
            ["future-terminal-looking-event", "started"],
        )

    def test_history_event_idempotence_requires_the_complete_exact_record(self):
        self.store.initialize()
        event = {
            "schemaVersion": 1,
            "eventId": "exact-known-event",
            "applicationId": "exact-application",
            "event": "reviewed",
            "status": "review",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(event, sort_keys=True) + "\n", encoding="utf-8"
        )
        before = self.store.history_path.read_bytes()

        self.store._append_history_event_idempotent_locked(dict(event))
        self.assertEqual(self.store.history_path.read_bytes(), before)

        for different in (
            {**event, "status": "completed"},
            {**event, "event": "started"},
        ):
            with self.subTest(different=different):
                with self.assertRaisesRegex(
                    STORE_MODULE.StoreError, "history event id collision"
                ):
                    self.store._append_history_event_idempotent_locked(different)
                self.assertEqual(self.store.history_path.read_bytes(), before)

    def test_unknown_event_id_collision_blocks_acquisition_before_any_mutation(self):
        ready = self._make_ready_job()
        self.store.claim_status()
        unknown = {
            "schemaVersion": 1,
            "eventId": "coordinator-operation-fixed",
            "applicationId": ready["id"],
            "event": "future-safe-event",
            "status": "future-status",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        self.store.history_path.write_text(
            json.dumps(unknown) + "\n", encoding="utf-8"
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        with mock.patch.object(
            STORE_MODULE.uuid,
            "uuid4",
            side_effect=["claim-fixed", "operation-fixed"],
        ):
            with self.assertRaisesRegex(
                STORE_MODULE.StoreError, "history event id collision"
            ):
                self.store.acquire_ready_job(
                    ready["id"], "collision-agent", ready["revision"]
                )

        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)
        self.assertEqual(self.store.get_job(ready["id"]), ready)
        self.assertIsNone(self.store.claim_status()["claim"])

    def test_pending_coordinator_collision_fails_before_roll_forward_mutation(self):
        ready = self._make_ready_job()
        self.store.claim_status()
        self.store.save_session(
            "unrelated-session", {"status": "active", "step": "application"}
        )
        now = "2026-08-28T00:00:00Z"
        operation_id = "pending-collision"
        operation = {
            "kind": "acquire",
            "operationId": operation_id,
            "jobId": ready["id"],
            "sourceStatus": "ready",
            "targetStatus": "in_progress",
            "expectedRevision": ready["revision"],
            "at": now,
            "historyEvent": self.store._history_event_for_operation(
                operation_id, ready, "job-started", "in_progress", now
            ),
            "resultClaim": {
                "claimId": "pending-claim",
                "jobId": ready["id"],
                "ownerLabel": "collision-agent",
                "tokenHash": "a" * 64,
                "acquiredAt": now,
                "heartbeatAt": now,
                "expiresAt": "2026-08-28T00:05:00Z",
            },
        }
        unknown = {
            "schemaVersion": 1,
            "eventId": operation["historyEvent"]["eventId"],
            "applicationId": ready["id"],
            "event": "future-safe-event",
            "status": "future-status",
            "answerKeys": [],
            "at": now,
        }
        self.store.history_path.write_text(
            json.dumps(unknown) + "\n", encoding="utf-8"
        )
        STORE_MODULE.atomic_write_json(
            self.store.coordinator_journal_path,
            {"schemaVersion": 1, "operation": operation},
        )
        before = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }

        reopened = STORE_MODULE.Store(self.root, self.legacy)
        with self.assertRaisesRegex(
            STORE_MODULE.StoreError, "history event id collision"
        ):
            reopened.initialize()

        after = {
            path.relative_to(self.root): path.read_bytes()
            for path in self.root.rglob("*")
            if path.is_file()
        }
        self.assertEqual(after, before)

    def test_unknown_history_events_still_reject_unsafe_or_private_shapes(self):
        self.store.initialize()
        valid = {
            "schemaVersion": 1,
            "eventId": "future-event-3",
            "applicationId": "future-application",
            "event": "future-safe-event",
            "answerKeys": [],
            "at": "2026-08-28T00:00:00Z",
        }
        invalid_cases = {
            "future schema": {**valid, "schemaVersion": 2},
            "extra credential": {**valid, "password": "private"},
            "nested private value": {**valid, "company": {"value": "private"}},
            "invalid answer references": {**valid, "answerKeys": [{"key": "private"}]},
            "missing event identity": {
                key: value for key, value in valid.items() if key != "eventId"
            },
            "empty event identity": {**valid, "eventId": ""},
            "missing audit timestamp": {
                key: value for key, value in valid.items() if key != "at"
            },
            "empty audit timestamp": {**valid, "at": ""},
            "missing answer references": {
                key: value for key, value in valid.items() if key != "answerKeys"
            },
            "uppercase identifier": {**valid, "event": "Future-Event"},
            "unicode identifier": {**valid, "event": "futuré-event"},
            "overlong identifier": {**valid, "event": "f" * 65},
        }
        for label, event in invalid_cases.items():
            with self.subTest(label=label):
                self.store.history_path.write_text(
                    json.dumps(event) + "\n", encoding="utf-8"
                )
                with self.assertRaises(STORE_MODULE.StoreError):
                    self.store.read_history()

    def test_replay_transitions_are_ordered_idempotent_and_value_free(self):
        application_id = "qa-run-20260815-1234abcd"
        started = self.store.record_replay_transition(
            application_id, "started", "greenhouse"
        )
        repeated = self.store.record_replay_transition(
            application_id, "started", "greenhouse"
        )
        reviewed = self.store.record_replay_transition(
            application_id, "reviewed", "greenhouse"
        )
        reviewed_again = self.store.record_replay_transition(
            application_id, "reviewed", "greenhouse"
        )

        self.assertTrue(started["changed"])
        self.assertFalse(repeated["changed"])
        self.assertTrue(reviewed["changed"])
        self.assertFalse(reviewed_again["changed"])
        history = self.store.read_history()
        self.assertEqual([event["event"] for event in history], ["started", "reviewed"])
        self.assertTrue(all(event["answerKeys"] == [] for event in history))
        session = self.store.load_session(application_id)
        self.assertEqual(session["status"], "review")
        self.assertEqual(session["step"], "review")
        serialized = json.dumps({"history": history, "session": session})
        for forbidden in ("http://", "https://", "routeToken", "resumePath", "value"):
            self.assertNotIn(forbidden, serialized)

    def test_ashby_replay_transitions_are_supported_and_value_free(self):
        application_id = "qa-run-20260815-5678abcd"
        self.store.record_replay_transition(application_id, "started", "ashby")
        self.store.record_replay_transition(application_id, "reviewed", "ashby")
        history = self.store.read_history()
        session = self.store.load_session(application_id)
        self.assertEqual([event["ats"] for event in history], ["ashby", "ashby"])
        self.assertEqual((session["ats"], session["status"]), ("ashby", "review"))
        self.assertNotIn("value", json.dumps({"history": history, "session": session}))

    def test_lever_replay_transitions_are_supported_and_value_free(self):
        application_id = "qa-run-20260816-5678abcd"
        self.store.record_replay_transition(application_id, "started", "lever")
        self.store.record_replay_transition(application_id, "reviewed", "lever")
        history = self.store.read_history()
        session = self.store.load_session(application_id)
        self.assertEqual([event["ats"] for event in history], ["lever", "lever"])
        self.assertEqual((session["ats"], session["status"]), ("lever", "review"))
        serialized = json.dumps({"history": history, "session": session})
        self.assertNotIn("value", serialized)
        self.assertNotIn("http", serialized)

    def test_replay_review_requires_started_and_rejects_terminal_or_mismatched_ats(self):
        application_id = "qa-run-20260815-1234abcd"
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "has not started"):
            self.store.record_replay_transition(
                application_id, "reviewed", "linkedin-easy-apply"
            )

        self.store.record_replay_transition(
            application_id, "started", "linkedin-easy-apply"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "ATS does not match"):
            self.store.record_replay_transition(
                application_id, "reviewed", "greenhouse"
            )
        self.store.append_history(
            {
                "applicationId": application_id,
                "event": "abandoned",
                "ats": "linkedin-easy-apply",
                "answerKeys": [],
            }
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "terminal"):
            self.store.record_replay_transition(
                application_id, "reviewed", "linkedin-easy-apply"
            )

    def test_session_round_trip_rejects_values_and_path_traversal(self):
        session = self.store.save_session(
            "acme-role-1",
            {
                "status": "active",
                "ats": "greenhouse",
                "step": "questions",
                "answerKeys": ["work_authorization.us"],
                "pendingFields": [
                    {
                        "question": "Salary expectation?",
                        "state": "sensitive",
                        "answerKey": "salary.expectation",
                        "sensitive": True,
                    }
                ],
            },
        )
        loaded = self.store.load_session("acme-role-1")
        self.assertEqual(loaded["updatedAt"], session["updatedAt"])
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.save_session(
                "acme-role-2",
                {
                    "pendingFields": [
                        {"question": "Salary?", "state": "sensitive", "value": "250K"}
                    ]
                },
            )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.load_session("../profile")

    def test_tampered_session_fails_closed(self):
        self.store.initialize()
        path = self.store.sessions_path / "acme-role-1.json"
        path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "applicationId": "acme-role-1",
                    "status": "active",
                    "answerKeys": [],
                    "pendingFields": [],
                    "company": {"value": "private"},
                    "createdAt": "2026-07-18T00:00:00Z",
                    "updatedAt": "2026-07-18T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        with self.assertRaises(STORE_MODULE.StoreError):
            self.store.load_session("acme-role-1")

    def test_cli_uses_machine_readable_json_and_store_override(self):
        environment = dict(os.environ)
        environment["HOME"] = str(self.home)
        environment[STORE_MODULE.STORE_ENV] = str(self.root)
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "init"],
            check=True,
            capture_output=True,
            text=True,
            env=environment,
        )
        result = json.loads(completed.stdout)
        self.assertTrue(result["initialized"])
        self.assertEqual(result["root"], str(self.root))

    def test_job_cli_round_trip_uses_shared_json_contract(self):
        job_input = self.home / "job.json"
        job_input.write_text(
            json.dumps(
                {
                    "id": "cli-job",
                    "url": "https://example.com/jobs/cli",
                    "role": "Engineer",
                }
            ),
            encoding="utf-8",
        )
        created = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "job-create",
                "--input",
                str(job_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        record = json.loads(created.stdout)
        listed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "job-list",
                "--status",
                "saved",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(listed.stdout), [record])

    def test_profile_and_resume_cli_commands_use_shared_revisions(self):
        subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(self.root), "init"],
            check=True,
            capture_output=True,
            text=True,
        )
        patch_input = self.home / "profile-patch.json"
        patch_input.write_text(
            json.dumps({"firstName": "Ada", "skills": ["Python"]}),
            encoding="utf-8",
        )
        patched = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "profile-patch",
                "--input",
                str(patch_input),
                "--expected-revision",
                "1",
                "--source",
                "user",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(patched.stdout)["revision"], 2)

        preferences_input = self.home / "preferences.json"
        preferences_input.write_text(
            json.dumps({"remotePreference": "hybrid"}), encoding="utf-8"
        )
        preferences = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "preferences-set",
                "--input",
                str(preferences_input),
                "--expected-revision",
                "2",
                "--source",
                "user",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        preference_result = json.loads(preferences.stdout)
        self.assertEqual(preference_result["revision"], 3)
        self.assertEqual(
            preference_result["factProvenance"]["/preferences/remotePreference"]["source"],
            "user",
        )

        replacement_input = self.home / "profile-replacement.json"
        replacement_input.write_text(
            json.dumps({"firstName": "Grace", "preferences": {"remotePreference": "hybrid"}}),
            encoding="utf-8",
        )
        replaced = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "profile-replace",
                "--input",
                str(replacement_input),
                "--expected-revision",
                "3",
                "--source",
                "user",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(replaced.stdout)["revision"], 4)

        resume_file = self.home / "resume.pdf"
        resume_file.write_bytes(b"%PDF-1.7\nresume")
        resume_input = self.home / "resume.json"
        resume_input.write_text(
            json.dumps(
                {"id": "main-resume", "label": "Main", "path": str(resume_file)}
            ),
            encoding="utf-8",
        )
        created = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "resume-create",
                "--input",
                str(resume_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        listed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "resume-list",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        self.assertEqual(json.loads(listed.stdout), [json.loads(created.stdout)])
        resolved = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "resume-resolve",
                "--id",
                "main-resume",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        resolved_record = json.loads(resolved.stdout)
        self.assertEqual(resolved_record["id"], "main-resume")
        self.assertTrue(Path(resolved_record["path"]).is_file())

    def test_answer_library_cli_lists_and_updates_by_revision(self):
        answer_input = self.home / "answer.json"
        answer_input.write_text(
            json.dumps(
                {
                    "question": "Preferred start date?",
                    "state": "confirmed",
                    "value": "June",
                }
            ),
            encoding="utf-8",
        )
        created = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "answer-put",
                "--input",
                str(answer_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        record = json.loads(created.stdout)
        update_input = self.home / "answer-update.json"
        update_input.write_text(json.dumps({"value": "July"}), encoding="utf-8")
        updated = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "answer-update",
                "--key",
                record["key"],
                "--expected-revision",
                str(record["revision"]),
                "--input",
                str(update_input),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        listed = subprocess.run(
            [
                sys.executable,
                str(SCRIPT),
                "--root",
                str(self.root),
                "answer-list",
                "--state",
                "confirmed",
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        projection = json.loads(listed.stdout)
        self.assertEqual(projection["total"], 1)
        self.assertEqual(projection["items"][0]["key"], json.loads(updated.stdout)["key"])
        self.assertNotIn("value", projection["items"][0])

    def test_paths_exposes_separate_inert_policy_root_without_changing_v1_store(self):
        self.store.initialize()
        paths = self.store.paths()
        self.assertEqual(paths["schemaVersion"], 1)
        self.assertEqual(paths["factGroups"], str(self.root / "fact-groups.json"))
        self.assertEqual(paths["jobs"], str(self.root / "jobs.json"))
        self.assertEqual(paths["resumes"], str(self.root / "resumes.json"))
        self.assertEqual(paths["autoSubmitPolicy"], str(self.root / "auto-submit"))
        self.assertFalse((self.root / "auto-submit").exists())
        self.assertEqual(self.store.get_profile(), {})

    def test_fact_groups_are_revisioned_saved_views_and_never_own_profile_facts(self):
        self.store.initialize()
        profile = self.store.replace_profile(
            {"firstName": "Synthetic", "skills": ["Python"]}, 1, "user"
        )
        created = self.store.create_fact_group({
            "label": "Interview essentials",
            "paths": ["/firstName", "/skills"],
        })
        self.assertRegex(created["id"], r"^[a-f0-9]{32}$")
        self.assertEqual(created["revision"], 1)
        self.assertEqual(self.store.list_fact_groups(), [created])

        updated = self.store.update_fact_group(
            created["id"],
            {"label": "Core application", "paths": ["/firstName"], "order": 25},
            created["revision"],
        )
        self.assertEqual(updated["revision"], 2)
        self.assertEqual(updated["order"], 25)
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "revision conflict"):
            self.store.update_fact_group(
                created["id"], {"label": "Stale"}, created["revision"]
            )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "label already exists"):
            self.store.create_fact_group({
                "label": "core APPLICATION",
                "paths": ["/skills"],
            })
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "path is invalid"):
            self.store.create_fact_group({
                "label": "Invalid pointer",
                "paths": ["not-a-pointer"],
            })

        deleted = self.store.delete_fact_group(updated["id"], updated["revision"])
        self.assertEqual(deleted, {"deleted": True, "id": updated["id"]})
        self.assertEqual(self.store.list_fact_groups(), [])
        self.assertEqual(self.store.inspect_profile(), profile)

    def test_owner_beta_overview_is_value_free_and_derives_the_closed_next_action(self):
        self.store.initialize()
        clean = self.store.owner_beta_overview()
        self.assertEqual(clean, {
            "setup": {"hasProfileFacts": False, "hasResume": False},
            "counts": {"jobs": 0, "readyJobs": 0, "attentionJobs": 0, "resumes": 0, "answers": 0},
            "nextAction": "import_resume",
            "targetWorkspace": "resumes",
        })
        resume_path = self.home / "owner-private.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nowner-private")
        self.store.create_resume({"id": "owner-resume", "label": "Owner", "path": str(resume_path)})
        self.assertEqual(self.store.owner_beta_overview()["nextAction"], "review_facts")
        self.store.replace_profile({"email": "private@example.invalid"}, 1, "user")
        self.assertEqual(self.store.owner_beta_overview()["nextAction"], "capture_job")
        job = self.store.create_job({"id": "private-job", "url": "https://private.invalid/job"})
        job = self.store.transition_job(job["id"], "ready", job["revision"])
        projection = self.store.owner_beta_overview()
        self.assertEqual((projection["nextAction"], projection["targetWorkspace"]), ("handoff_ready_job", "jobs"))
        self.assertEqual(set(projection), {"setup", "counts", "nextAction", "targetWorkspace"})
        serialized = json.dumps(projection)
        for private in ("private@example.invalid", "owner-private", "private-job", str(resume_path)):
            self.assertNotIn(private, serialized)

    def test_owner_beta_overview_does_not_treat_search_preferences_as_application_facts(self):
        self.store.initialize()
        self.store.replace_profile(
            {"preferences": {"targetTitles": ["Engineer"]}}, 1, "user"
        )
        resume_path = self.home / "preferences-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\npreferences")
        self.store.create_resume(
            {"id": "preferences-resume", "label": "Preferences", "path": str(resume_path)}
        )
        projection = self.store.owner_beta_overview()
        self.assertFalse(projection["setup"]["hasProfileFacts"])
        self.assertEqual(
            (projection["nextAction"], projection["targetWorkspace"]),
            ("review_facts", "facts"),
        )
        profile = self.store.inspect_profile()
        self.store.patch_profile({"firstName": "Ada"}, profile["revision"], "user")
        self.assertTrue(self.store.owner_beta_overview()["setup"]["hasProfileFacts"])

    def test_owner_beta_overview_never_hands_off_a_ready_job_with_tampered_resume(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "tampered-ready-resume", "label": "Tampered"},
            "resume.pdf",
            b"%PDF-1.7\noriginal",
        )
        job = self.store.create_job(
            {"id": "tampered-ready-job", "url": "https://example.invalid/tampered"}
        )
        job = self.store.transition_job(job["id"], "ready", job["revision"])
        managed_path = self.store.resume_files_path / resume["managedFile"]
        managed_path.write_bytes(b"%PDF-1.7\ntampered")
        projection = self.store.owner_beta_overview()
        self.assertEqual(projection["counts"]["readyJobs"], 1)
        self.assertEqual(
            (projection["nextAction"], projection["targetWorkspace"]),
            ("prepare_job", "jobs"),
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "job is not ready"):
            self.store.acquire_ready_job(job["id"], "owner", job["revision"])

    def test_owner_beta_overview_respects_a_separate_live_global_claim(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume_path = self.home / "claimed-resume.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nclaim")
        self.store.create_resume(
            {"id": "claimed-resume", "label": "Claimed", "path": str(resume_path)}
        )
        first = self.store.create_job(
            {"id": "claimed-first", "url": "https://example.invalid/first"}
        )
        second = self.store.create_job(
            {"id": "claimed-second", "url": "https://example.invalid/second"}
        )
        first = self.store.transition_job(first["id"], "ready", first["revision"])
        second = self.store.transition_job(second["id"], "ready", second["revision"])
        self.store.acquire_ready_job(first["id"], "active-owner", first["revision"])
        projection = self.store.owner_beta_overview()
        self.assertEqual(projection["counts"]["readyJobs"], 1)
        self.assertEqual(projection["counts"]["attentionJobs"], 0)
        self.assertEqual(
            (projection["nextAction"], projection["targetWorkspace"]),
            ("prepare_job", "jobs"),
        )
        self.assertEqual(self.store.get_job(second["id"])["status"], "ready")

    def test_owner_beta_overview_reuses_loaded_documents_and_resume_observations(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "shared-ready-resume", "label": "Shared"},
            "resume.pdf",
            b"%PDF-1.7\nshared-ready-resume",
        )
        for suffix in ("first", "second"):
            job = self.store.create_job({
                "id": f"shared-ready-{suffix}",
                "url": f"https://example.invalid/{suffix}",
                "resumeId": resume["id"],
            })
            self.store.transition_job(job["id"], "ready", job["revision"])

        with (
            mock.patch.object(
                self.store,
                "_load_profile_document",
                wraps=self.store._load_profile_document,
            ) as load_profile,
            mock.patch.object(
                self.store,
                "_load_resumes_document",
                wraps=self.store._load_resumes_document,
            ) as load_resumes,
            mock.patch.object(
                self.store,
                "_managed_resume_observation",
                wraps=self.store._managed_resume_observation,
            ) as observe_resume,
        ):
            projection = self.store.owner_beta_overview()

        self.assertEqual(projection["nextAction"], "handoff_ready_job")
        self.assertEqual(load_profile.call_count, 2)
        self.assertEqual(load_resumes.call_count, 3)
        self.assertEqual(observe_resume.call_count, 1)

    def test_owner_beta_overview_bounds_managed_resume_hashing_and_rechecks_changed_identity(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "cached-ready-resume", "label": "Cached"},
            "resume.pdf",
            b"%PDF-1.7\noriginal-cache-bytes",
        )
        job = self.store.create_job({
            "id": "cached-ready-job",
            "url": "https://example.invalid/cached-ready",
            "resumeId": resume["id"],
        })
        self.store.transition_job(job["id"], "ready", job["revision"])
        managed_path = self.store.resume_files_path / resume["managedFile"]
        cache_identity = STORE_MODULE._managed_resume_digest_cache_identity
        posix_cache_identity = lambda metadata: (
            cache_identity(metadata, platform_name="posix")
        )

        with (
            mock.patch.object(
                STORE_MODULE,
                "_managed_resume_digest_cache_identity",
                side_effect=posix_cache_identity,
            ),
            mock.patch.object(
                self.store,
                "_private_file_digest",
                wraps=self.store._private_file_digest,
            ) as digest,
        ):
            first = self.store.owner_beta_overview()
            second = self.store.owner_beta_overview()
            self.assertEqual(first["nextAction"], "handoff_ready_job")
            self.assertEqual(second["nextAction"], "handoff_ready_job")
            self.assertEqual(digest.call_count, 1)

            original = managed_path.read_bytes()
            managed_path.write_bytes(b"X" * len(original))
            changed = self.store.owner_beta_overview()
            self.assertEqual(changed["nextAction"], "prepare_job")
            self.assertEqual(digest.call_count, 2)

        with self.assertRaisesRegex(STORE_MODULE.StoreError, "job is not ready"):
            self.store.acquire_ready_job(job["id"], "owner", job["revision"] + 1)

    def test_owner_beta_overview_disables_digest_reuse_for_windows_creation_time_semantics(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume = self.store.create_resume_bytes(
            {"id": "windows-cache-resume", "label": "Windows cache"},
            "resume.pdf",
            b"%PDF-1.7\nwindows-original",
        )
        job = self.store.create_job({
            "id": "windows-cache-job",
            "url": "https://example.invalid/windows-cache",
            "resumeId": resume["id"],
        })
        self.store.transition_job(job["id"], "ready", job["revision"])
        managed_path = self.store.resume_files_path / resume["managedFile"]
        cache_identity = STORE_MODULE._managed_resume_digest_cache_identity
        windows_cache_identity = lambda metadata: (
            cache_identity(metadata, platform_name="nt")
        )

        with (
            mock.patch.object(
                STORE_MODULE,
                "_managed_resume_digest_cache_identity",
                side_effect=windows_cache_identity,
            ),
            mock.patch.object(
                self.store,
                "_private_file_digest",
                wraps=self.store._private_file_digest,
            ) as digest,
        ):
            first = self.store.owner_beta_overview()
            second = self.store.owner_beta_overview()
            self.assertEqual(first["nextAction"], "handoff_ready_job")
            self.assertEqual(second["nextAction"], "handoff_ready_job")
            self.assertEqual(digest.call_count, 2)
            self.assertEqual(self.store._overview_resume_digest_cache, {})

            original_metadata = managed_path.stat()
            original = managed_path.read_bytes()
            managed_path.write_bytes(b"X" * len(original))
            os.utime(
                managed_path,
                ns=(original_metadata.st_atime_ns, original_metadata.st_mtime_ns),
            )
            changed = self.store.owner_beta_overview()

        self.assertEqual(changed["nextAction"], "prepare_job")
        self.assertEqual(digest.call_count, 3)

    def test_owner_beta_overview_live_claim_skips_ready_preflight(self):
        self.store.initialize()
        self.store.replace_profile({"firstName": "Ada"}, 1, "user")
        resume_path = self.home / "live-claim-fast-path.pdf"
        resume_path.write_bytes(b"%PDF-1.7\nlive-claim-fast-path")
        self.store.create_resume({
            "id": "live-claim-fast-path-resume",
            "label": "Fast path",
            "path": str(resume_path),
        })
        first = self.store.create_job({
            "id": "live-claim-fast-path-first",
            "url": "https://example.invalid/live-first",
        })
        second = self.store.create_job({
            "id": "live-claim-fast-path-second",
            "url": "https://example.invalid/live-second",
        })
        first = self.store.transition_job(first["id"], "ready", first["revision"])
        self.store.transition_job(second["id"], "ready", second["revision"])
        self.store.acquire_ready_job(first["id"], "active-owner", first["revision"])

        with mock.patch.object(
            self.store,
            "_preflight_job_record",
            wraps=self.store._preflight_job_record,
        ) as preflight:
            projection = self.store.owner_beta_overview()

        self.assertEqual(projection["nextAction"], "prepare_job")
        preflight.assert_not_called()

    def test_cli_filesystem_failure_is_terse(self):
        blocker = self.home / "not-a-directory"
        blocker.write_text("Ada private data", encoding="utf-8")
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(blocker), "init"],
            check=False,
            capture_output=True,
            text=True,
        )
        self.assertEqual(completed.returncode, 2)
        self.assertNotIn("Traceback", completed.stderr)
        self.assertNotIn("Ada private data", completed.stderr)
        self.assertIn("storage operation failed", completed.stderr)


if __name__ == "__main__":
    unittest.main()
