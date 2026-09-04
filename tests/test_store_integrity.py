from tests.support.store_case import *


class StoreTests(StoreTestCase):

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
