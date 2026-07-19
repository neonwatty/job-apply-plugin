import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
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
            }
        )
        updated = self.store.set_preferences({"salary": "250K"})
        self.assertEqual(
            updated, {"targetTitles": ["Engineer"], "salary": "250K"}
        )
        self.assertEqual(self.store.get_profile()["firstName"], "Ada")

    def test_atomic_write_failure_keeps_previous_document_and_cleans_temp(self):
        self.store.initialize()
        before = self.store.profile_path.read_text(encoding="utf-8")
        with mock.patch.object(STORE_MODULE.os, "replace", side_effect=OSError("boom")):
            with self.assertRaises(OSError):
                self.store.replace_profile({"firstName": "Grace"})
        self.assertEqual(self.store.profile_path.read_text(encoding="utf-8"), before)
        self.assertEqual(list(self.root.glob(".profile.json.*.tmp")), [])

    @unittest.skipIf(os.name == "nt", "POSIX permissions only")
    def test_private_permissions(self):
        self.store.initialize()
        self.assertEqual(stat.S_IMODE(self.root.stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(self.store.sessions_path.stat().st_mode), 0o700)
        for path in (
            self.store.profile_path,
            self.store.answers_path,
            self.store.history_path,
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
        self.assertIsNone(placeholder["value"])
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
        )
        self.assertIn("rememberedWithConsentAt", remembered)

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

    def test_history_is_minimal_parseable_and_rejects_answer_values(self):
        event = self.store.append_history(
            {
                "applicationId": "acme-role-1",
                "event": "started",
                "company": "Acme",
                "role": "Engineer",
                "answerKeys": ["work_authorization.us"],
            }
        )
        self.assertEqual(event["answerKeys"], ["work_authorization.us"])
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
