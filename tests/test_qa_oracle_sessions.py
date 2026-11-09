from tests.support.oracle_fixtures import *
from tests.support.running_replay_server import *


class SemanticOracleTests(SemanticOracleCase):
    def test_absent_session_directory_or_json_files_fails(self):
        for remove_directory in (False, True):
            with self.subTest(remove_directory=remove_directory):
                for path in self.store.sessions.glob("*.json"):
                    path.unlink()
                if remove_directory:
                    self.store.sessions.rmdir()
                report = self.evaluate()
                self.assertEqual(report["assertions"]["session-present"], "failed")
                self.assertIn("session-missing", report["failureCategories"])
                if remove_directory:
                    self.store.sessions.mkdir()

    def test_malformed_or_future_sessions_are_rejected(self):
        cases = (
            "not-json",
            json.dumps([]),
            json.dumps({**valid_session(), "schemaVersion": 2}),
            json.dumps({**valid_session(), "future": True}),
        )
        session_path = self.store.sessions / "application-1.json"
        for content in cases:
            with self.subTest(content=content[:30]):
                session_path.write_text(content, encoding="utf-8")
                with self.assertRaises(OracleError) as caught:
                    self.evaluate()
                self.assertNotIn("SESSION SECRET", str(caught.exception))

    def test_legacy_and_exact_rich_replay_sessions_are_accepted(self):
        session_path = self.store.sessions / "application-1.json"
        for session in (
            valid_session(),
            rich_replay_session("active"),
            rich_replay_session("review"),
        ):
            with self.subTest(status=session["status"], rich="browserHandoff" in session):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                self.assertEqual(self.evaluate()["status"], "passed")

    def test_rich_replay_session_extension_is_all_or_none(self):
        session_path = self.store.sessions / "application-1.json"
        for omitted in (
            "attemptRevision",
            "readiness",
            "blockers",
            "approvals",
            "browserHandoff",
        ):
            session = rich_replay_session()
            del session[omitted]
            with self.subTest(omitted=omitted):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                with self.assertRaisesRegex(OracleError, "invalid session artifact"):
                    self.evaluate()

    def test_rich_replay_session_rejects_malformed_pending_match_metadata(self):
        session_path = self.store.sessions / "application-1.json"
        cases = {
            "reference": "not-opaque",
            "fieldClass": {},
            "matchConfidence": "bogus",
            "matchReasonCodes": ["private-reason"],
            "matchAnswerRevision": True,
        }
        for field, invalid in cases.items():
            session = rich_replay_session()
            session["pendingFields"][0][field] = invalid
            with self.subTest(field=field):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                with self.assertRaisesRegex(OracleError, "invalid session artifact"):
                    self.evaluate()

    def test_rich_replay_session_rejects_non_value_free_projection_fields(self):
        session_path = self.store.sessions / "application-1.json"
        mutations = {
            "attemptRevision": 1,
            "readiness": {},
            "blockers": [{}],
            "approvals": [{}],
        }
        for field, invalid in mutations.items():
            session = rich_replay_session()
            session[field] = invalid
            with self.subTest(field=field):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                with self.assertRaisesRegex(OracleError, "invalid session artifact"):
                    self.evaluate()

    def test_rich_replay_session_rejects_malformed_or_mismatched_handoff(self):
        session_path = self.store.sessions / "application-1.json"
        cases = {
            "not-object": [],
            "missing-key": {"state": "ready_for_owner", "revision": 1},
            "extra-key": {
                "state": "ready_for_owner",
                "reasonCode": "final-review-required",
                "revision": 1,
                "extra": None,
            },
            "wrong-state": {
                "state": "not_required",
                "reasonCode": "final-review-required",
                "revision": 1,
            },
            "wrong-reason": {
                "state": "ready_for_owner",
                "reasonCode": "none",
                "revision": 1,
            },
            "wrong-revision": {
                "state": "ready_for_owner",
                "reasonCode": "final-review-required",
                "revision": 2,
            },
            "boolean-revision": {
                "state": "ready_for_owner",
                "reasonCode": "final-review-required",
                "revision": True,
            },
        }
        for case, handoff in cases.items():
            session = rich_replay_session()
            session["browserHandoff"] = handoff
            with self.subTest(case=case):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                with self.assertRaisesRegex(OracleError, "invalid session artifact"):
                    self.evaluate()

        for status in ("completed", "abandoned"):
            session = rich_replay_session(status)
            with self.subTest(status=status):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                with self.assertRaisesRegex(OracleError, "invalid session artifact"):
                    self.evaluate()

    def test_rich_replay_session_forbidden_nested_values_are_redacted_failures(self):
        session = rich_replay_session()
        session["blockers"] = [{"metadata": {"answerValue": "SESSION SECRET"}}]
        session_path = self.store.sessions / "application-1.json"
        session_path.write_text(json.dumps(session), encoding="utf-8")

        report = self.evaluate()

        self.assertEqual(report["assertions"]["session-value-free"], "failed")
        self.assertIn("session-value-present", report["failureCategories"])
        self.assertNotIn("SESSION SECRET", json.dumps(report))

    def test_value_bearing_sessions_are_scored_as_redacted_failures(self):
        deeply_nested = valid_session()
        deeply_nested["pendingFields"][0]["details"] = {
            "nested": {"VaLuE": "SESSION SECRET"}
        }
        cases = (
            {**valid_session(), "value": "SESSION SECRET"},
            {**valid_session(), "answerValue": "SESSION SECRET"},
            {**valid_session(), "mixedcasevAlUe": "SESSION SECRET"},
            deeply_nested,
        )
        session_path = self.store.sessions / "application-1.json"
        for session in cases:
            with self.subTest(keys=sorted(session)):
                session_path.write_text(json.dumps(session), encoding="utf-8")
                report = self.evaluate()
                self.assertEqual(report["assertions"]["session-value-free"], "failed")
                self.assertEqual(report["status"], "failed")
                self.assertIn("session-value-present", report["failureCategories"])
                self.assertNotIn("SESSION SECRET", json.dumps(report))

    def test_deep_and_large_session_documents_are_rejected(self):
        session = valid_session()
        nested = {}
        cursor = nested
        for _ in range(70):
            cursor["node"] = {}
            cursor = cursor["node"]
        session["pendingFields"][0]["details"] = nested
        session_path = self.store.sessions / "application-1.json"
        session_path.write_text(json.dumps(session), encoding="utf-8")
        with self.assertRaisesRegex(OracleError, "invalid session artifact"):
            self.evaluate()

        session_path.write_bytes(b" " * (1024 * 1024 + 1))
        with self.assertRaisesRegex(OracleError, "invalid session artifact"):
            self.evaluate()

    def test_session_file_count_is_bounded(self):
        for index in range(256):
            (self.store.sessions / f"extra-{index}.json").write_text(
                json.dumps(valid_session(f"extra-{index}")), encoding="utf-8"
            )
        with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
            self.evaluate()

    def test_session_entry_limit_counts_every_suffix_without_materializing_excess(self):
        for index in range(3):
            (self.store.sessions / f"ignored-{index}.txt").write_text(
                "SESSION SECRET", encoding="utf-8"
            )
        with mock.patch("qa.oracle.MAX_SESSION_ENTRIES", 3):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
                self.evaluate()

        (self.store.sessions / "ignored-2.txt").unlink()
        with mock.patch("qa.oracle.MAX_SESSION_ENTRIES", 3):
            self.assertEqual(self.evaluate()["status"], "passed")

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_session_entry_limit_counts_symlinks_and_special_entries(self):
        for path in self.store.sessions.iterdir():
            path.unlink()
        target = Path(self.temporary.name) / "outside"
        target.write_text("SESSION SECRET", encoding="utf-8")
        (self.store.sessions / "entry.json").symlink_to(target)
        (self.store.sessions / "special-directory").mkdir()
        with mock.patch("qa.oracle.MAX_SESSION_ENTRIES", 1):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
                self.evaluate()

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_symlinked_store_artifacts_and_root_are_rejected(self):
        outside = Path(self.temporary.name) / "outside.json"
        outside.write_text(
            json.dumps(history_event("started")) + "\n", encoding="utf-8"
        )
        history_path = self.store.root / "applications.jsonl"
        history_path.unlink()
        history_path.symlink_to(outside)
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

        history_path.unlink()
        self.store.write_history([history_event("started"), history_event("reviewed")])
        session_path = self.store.sessions / "application-1.json"
        session_path.unlink()
        session_path.symlink_to(outside)
        with self.assertRaisesRegex(OracleError, "invalid session artifact"):
            self.evaluate()

        alias = Path(self.temporary.name) / "store-alias"
        alias.symlink_to(self.store.root, target_is_directory=True)
        with self.assertRaisesRegex(OracleError, "invalid store root"):
            self.evaluate(store_root=alias)

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_broken_artifact_symlinks_are_rejected_not_treated_as_absent(self):
        missing_target = Path(self.temporary.name) / "missing-target"
        history_path = self.store.root / "applications.jsonl"
        history_path.unlink()
        history_path.symlink_to(missing_target)
        with self.assertRaisesRegex(OracleError, "invalid history artifact"):
            self.evaluate()

        history_path.unlink()
        self.store.write_history([history_event("started"), history_event("reviewed")])
        for path in self.store.sessions.iterdir():
            path.unlink()
        self.store.sessions.rmdir()
        self.store.sessions.symlink_to(missing_target, target_is_directory=True)
        with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
            self.evaluate()

    def test_descriptor_traversal_is_required(self):
        with mock.patch("qa.oracle._DESCRIPTOR_TRAVERSAL_AVAILABLE", False):
            with self.assertRaisesRegex(OracleError, "invalid store root"):
                self.evaluate()

    def test_sessions_descriptor_is_closed_when_identity_check_fails(self):
        real_fstat = os.fstat
        calls = 0
        failed_descriptor = None

        def fail_sessions_fstat(descriptor):
            nonlocal calls, failed_descriptor
            calls += 1
            if calls == 3:
                failed_descriptor = descriptor
                raise OSError("synthetic failure")
            return real_fstat(descriptor)

        with mock.patch("qa.oracle.os.fstat", side_effect=fail_sessions_fstat):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts"):
                self.evaluate()
        self.assertIsNotNone(failed_descriptor)
        with self.assertRaises(OSError):
            real_fstat(failed_descriptor)

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_root_swap_is_refused_without_reading_outside_store(self):
        outside = Path(self.temporary.name) / "outside-store"
        OracleStore(outside).make_valid()
        backup = Path(self.temporary.name) / "original-store"
        real_open = os.open
        swapped = False

        def swap_root(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal swapped
            if path == self.store.root and dir_fd is None and not swapped:
                swapped = True
                self.store.root.rename(backup)
                self.store.root.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("qa.oracle.os.open", side_effect=swap_root):
            with self.assertRaisesRegex(OracleError, "invalid store root") as caught:
                self.evaluate()
        self.assertTrue(swapped)
        self.assertNotIn(str(outside), str(caught.exception))

    @unittest.skipIf(not hasattr(os, "symlink"), "symlinks unavailable")
    def test_sessions_swap_is_refused_without_reading_outside_directory(self):
        outside = Path(self.temporary.name) / "outside-sessions"
        outside.mkdir()
        (outside / "application-1.json").write_text(
            json.dumps({**valid_session(), "value": "OUTSIDE SECRET"}),
            encoding="utf-8",
        )
        backup = self.store.root / "original-sessions"
        real_open = os.open
        swapped = False

        def swap_sessions(path, flags, mode=0o777, *, dir_fd=None):
            nonlocal swapped
            if path == "sessions" and dir_fd is not None and not swapped:
                swapped = True
                self.store.sessions.rename(backup)
                self.store.sessions.symlink_to(outside, target_is_directory=True)
            return real_open(path, flags, mode, dir_fd=dir_fd)

        with mock.patch("qa.oracle.os.open", side_effect=swap_sessions):
            with self.assertRaisesRegex(OracleError, "invalid session artifacts") as caught:
                self.evaluate()
        self.assertTrue(swapped)
        self.assertNotIn("OUTSIDE SECRET", str(caught.exception))
