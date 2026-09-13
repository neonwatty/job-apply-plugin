from tests.support.store_case import *


class StoreTests(StoreTestCase):

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
