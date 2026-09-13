from tests.support.store_case import *


class StoreTests(StoreTestCase):

    def test_resume_extraction_request_create_and_single_open(self):
        source = self.home / "request-private.txt"
        source.write_text("private resume text", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "request-resume", "label": "Private label", "path": str(source)}
        )
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        self.assertEqual(set(request), {
            "requestId", "resumeId", "resumeContentRevision", "revision",
            "status", "createdAt", "updatedAt", "closedAt", "proposalId",
            "failureReason", "supersedesRequestId",
        })
        self.assertEqual(request["resumeContentRevision"], resume["contentRevision"])
        self.assertEqual(request["status"], "requested")
        self.assertEqual(
            self.store.get_resume_extraction_request(request["requestId"]), request
        )
        self.assertEqual(self.store.list_resume_extraction_requests(), [request])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "open extraction request"):
            self.store.create_resume_extraction_request(
                resume["id"], resume["revision"]
            )

    def test_same_second_retry_sorts_after_superseded_request(self):
        source = self.home / "same-second-retry.txt"
        source.write_text("synthetic same-second retry", encoding="utf-8")
        resume = self.store.create_resume({
            "id": "same-second-retry", "label": "Same second", "path": str(source)
        })
        with (
            mock.patch.object(
                STORE_MODULE, "utc_now", return_value="2026-09-03T12:00:00Z"
            ),
            mock.patch.object(
                STORE_MODULE.uuid, "uuid4",
                side_effect=["zzzz", "operation-1", "operation-2", "aaaa", "operation-3"],
            ),
        ):
            original = self.store.create_resume_extraction_request(
                resume["id"], resume["revision"]
            )
            failed = self.store.fail_resume_extraction_request(
                original["requestId"], "interrupted", original["revision"]
            )
            retried = self.store.retry_resume_extraction_request(
                failed["requestId"], failed["revision"], resume["revision"]
            )

        listed = self.store.list_resume_extraction_requests(resume_id=resume["id"])
        self.assertLess(retried["requestId"], failed["requestId"])
        self.assertEqual([item["requestId"] for item in listed], [
            failed["requestId"], retried["requestId"],
        ])

    def test_resume_extraction_request_document_rejects_invalid_records(self):
        source = self.home / "invalid-request.txt"
        source.write_text("synthetic invalid request", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "invalid-request-resume", "label": "Invalid", "path": str(source)}
        )
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        document = json.loads(
            self.store.resume_extraction_requests_path.read_text(encoding="utf-8")
        )
        document["requests"][request["requestId"]]["privateValue"] = "must reject"
        self.store.resume_extraction_requests_path.write_text(
            json.dumps(document), encoding="utf-8"
        )
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "request is invalid"):
            STORE_MODULE.Store(self.root, self.legacy).validate_workspace_startup()

    def test_resume_extraction_request_assigns_legacy_content_revision(self):
        source = self.home / "legacy-content-revision.txt"
        source.write_text("synthetic legacy managed resume", encoding="utf-8")
        resume = self.store.create_resume({
            "id": "legacy-content-revision", "label": "Legacy", "path": str(source)
        })
        document = json.loads(self.store.resumes_path.read_text(encoding="utf-8"))
        del document["resumes"][resume["id"]]["contentRevision"]
        self.store.resumes_path.write_text(json.dumps(document), encoding="utf-8")
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        updated = self.store.get_resume(resume["id"])
        self.assertEqual(updated["revision"], resume["revision"] + 1)
        self.assertEqual(request["resumeContentRevision"], updated["contentRevision"])

    def test_resume_extraction_request_lifecycle_and_content_staleness(self):
        source = self.home / "lifecycle.txt"
        source.write_text("synthetic lifecycle resume", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "lifecycle-resume", "label": "Lifecycle", "path": str(source)}
        )
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        metadata = self.store.update_resume(
            resume["id"], {"label": "Metadata only"}, resume["revision"]
        )
        self.assertEqual(
            self.store.get_resume_extraction_request(request["requestId"])["status"],
            "requested",
        )
        replacement = self.home / "replacement.txt"
        replacement.write_text("changed synthetic lifecycle resume", encoding="utf-8")
        changed = self.store.update_resume(
            resume["id"], {"path": str(replacement)}, metadata["revision"]
        )
        stale = self.store.get_resume_extraction_request(request["requestId"])
        self.assertEqual(stale["status"], "stale")
        retried = self.store.retry_resume_extraction_request(
            request["requestId"], stale["revision"], changed["revision"]
        )
        self.assertEqual(retried["supersedesRequestId"], request["requestId"])
        cancelled = self.store.cancel_resume_extraction_request(
            retried["requestId"], retried["revision"]
        )
        self.assertEqual(cancelled["status"], "cancelled")
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "request revision conflict"):
            self.store.fail_resume_extraction_request(
                retried["requestId"], "interrupted", retried["revision"]
            )

    def test_resume_extraction_request_trash_cancels_atomically(self):
        source = self.home / "trash-request.txt"
        source.write_text("synthetic trash request", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "trash-request-resume", "label": "Trash", "path": str(source)}
        )
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        trashed = self.store.trash_resume(resume["id"], resume["revision"])
        self.assertIsNotNone(trashed["deletedAt"])
        self.assertEqual(
            self.store.get_resume_extraction_request(request["requestId"])["status"],
            "cancelled",
        )

    def test_resume_extraction_request_completion_is_atomic_and_value_free(self):
        source = self.home / "completion.txt"
        source.write_text("synthetic completion resume", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "completion-resume", "label": "Completion", "path": str(source)}
        )
        profile = self.store.patch_profile({"firstName": "Human"}, 1, "user")
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        result = self.store.complete_resume_extraction_request(
            request["requestId"],
            {"firstName": "Extracted", "email": "fixture@example.invalid"},
            request["revision"], profile["revision"],
        )
        self.assertEqual(set(result), {"request", "proposalSummary"})
        self.assertEqual(result["request"]["status"], "completed")
        self.assertEqual(
            set(result["proposalSummary"]),
            {"id", "status", "revision", "autoFilledCount", "pendingCount"},
        )
        proposal = self.store.get_resume_proposal(result["proposalSummary"]["id"])
        self.assertEqual(proposal["resumeContentRevision"], resume["contentRevision"])
        self.assertIn("/email", proposal["autoFilledPaths"])
        self.assertIn("/firstName", proposal["pendingPaths"])
        with self.assertRaisesRegex(STORE_MODULE.StoreError, "request revision conflict"):
            self.store.complete_resume_extraction_request(
                request["requestId"], {"email": "second@example.invalid"},
                request["revision"], profile["revision"],
            )
        self.assertEqual(len(self.store.list_resume_proposals()), 1)
        metadata = self.store.update_resume(
            resume["id"], {"label": "Cosmetic"}, resume["revision"]
        )
        self.assertFalse(
            self.store.get_resume_proposal(result["proposalSummary"]["id"])["stale"]
        )
        self.assertEqual(metadata["contentRevision"], resume["contentRevision"])

    def test_resume_request_completion_conflicts_are_noops(self):
        source = self.home / "completion-conflict.txt"
        source.write_text("synthetic completion conflict", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "completion-conflict", "label": "Conflict", "path": str(source)}
        )
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )
        profile = self.store.patch_profile({"firstName": "Human"}, 1, "user")
        before_profile = self.store.inspect_profile()
        for candidate, request_revision, profile_revision, message in (
            ({}, request["revision"], profile["revision"], "candidate"),
            ({"email": "private@example.invalid"}, request["revision"] + 1,
             profile["revision"], "request revision conflict"),
            ({"email": "private@example.invalid"}, request["revision"],
             profile["revision"] + 1, "profile revision conflict"),
        ):
            with self.subTest(message=message):
                with self.assertRaisesRegex(STORE_MODULE.StoreError, message):
                    self.store.complete_resume_extraction_request(
                        request["requestId"], candidate, request_revision, profile_revision
                    )
                self.assertEqual(self.store.inspect_profile(), before_profile)
                self.assertEqual(self.store.list_resume_proposals(), [])
                self.assertEqual(
                    self.store.get_resume_extraction_request(request["requestId"])["status"],
                    "requested",
                )

    def test_resume_request_completion_journal_recovers_every_boundary(self):
        for boundary in ("profile", "proposals", "requests", "clear"):
            with self.subTest(boundary=boundary):
                root = self.home / f"request-recovery-{boundary}"
                store = STORE_MODULE.Store(root, self.legacy)
                source = self.home / f"request-recovery-{boundary}.txt"
                source.write_text(f"synthetic request recovery {boundary}", encoding="utf-8")
                resume = store.create_resume({
                    "id": f"request-recovery-{boundary}", "label": "Recovery",
                    "path": str(source),
                })
                request = store.create_resume_extraction_request(
                    resume["id"], resume["revision"]
                )
                original_write = STORE_MODULE.atomic_write_json
                journal_started = False
                failed = False

                def fail_boundary_once(path, payload):
                    nonlocal journal_started, failed
                    operation = payload.get("operation") if isinstance(payload, dict) else None
                    if path == store.resume_extraction_journal_path and operation is not None:
                        journal_started = True
                    target = {
                        "profile": store.profile_path,
                        "proposals": store.resume_extractions_path,
                        "requests": store.resume_extraction_requests_path,
                        "clear": store.resume_extraction_journal_path,
                    }[boundary]
                    should_fail = (
                        not failed and journal_started and path == target
                        and (boundary != "clear" or operation is None)
                    )
                    if should_fail:
                        failed = True
                        raise OSError("synthetic request journal failure")
                    return original_write(path, payload)

                with mock.patch.object(
                    STORE_MODULE, "atomic_write_json", side_effect=fail_boundary_once
                ):
                    with self.assertRaises(OSError):
                        store.complete_resume_extraction_request(
                            request["requestId"], {"email": f"{boundary}@example.invalid"},
                            request["revision"], 1,
                        )
                repaired = STORE_MODULE.Store(root, self.legacy)
                repaired.initialize()
                recovered_request = repaired.get_resume_extraction_request(
                    request["requestId"]
                )
                self.assertEqual(recovered_request["status"], "completed")
                self.assertEqual(len(repaired.list_resume_proposals()), 1)
                self.assertEqual(
                    repaired.inspect_profile()["profile"]["email"],
                    f"{boundary}@example.invalid",
                )

    def test_resume_request_trash_journal_recovers_every_boundary(self):
        for boundary in ("requests", "resumes", "clear"):
            with self.subTest(boundary=boundary):
                root = self.home / f"trash-recovery-{boundary}"
                store = STORE_MODULE.Store(root, self.legacy)
                source = self.home / f"trash-recovery-{boundary}.txt"
                source.write_text(f"synthetic trash recovery {boundary}", encoding="utf-8")
                resume = store.create_resume({
                    "id": f"trash-recovery-{boundary}", "label": "Recovery",
                    "path": str(source),
                })
                request = store.create_resume_extraction_request(
                    resume["id"], resume["revision"]
                )
                original_write = STORE_MODULE.atomic_write_json
                journal_started = False
                failed = False

                def fail_boundary_once(path, payload):
                    nonlocal journal_started, failed
                    operation = payload.get("operation") if isinstance(payload, dict) else None
                    if path == store.resume_extraction_journal_path and operation is not None:
                        journal_started = True
                    target = {
                        "requests": store.resume_extraction_requests_path,
                        "resumes": store.resumes_path,
                        "clear": store.resume_extraction_journal_path,
                    }[boundary]
                    if (
                        not failed and journal_started and path == target
                        and (boundary != "clear" or operation is None)
                    ):
                        failed = True
                        raise OSError("synthetic trash journal failure")
                    return original_write(path, payload)

                with mock.patch.object(
                    STORE_MODULE, "atomic_write_json", side_effect=fail_boundary_once
                ):
                    with self.assertRaises(OSError):
                        store.trash_resume(resume["id"], resume["revision"])
                repaired = STORE_MODULE.Store(root, self.legacy)
                repaired.initialize()
                self.assertIsNotNone(
                    repaired.get_resume(resume["id"], include_trashed=True)["deletedAt"]
                )
                self.assertEqual(
                    repaired.get_resume_extraction_request(request["requestId"])["status"],
                    "cancelled",
                )

    def test_resume_request_replacement_recovers_every_hard_interruption_boundary(self):
        class SimulatedPowerLoss(BaseException):
            pass

        for boundary in (
            "pre-journal", "post-journal", "requests-write", "resumes-write",
            "journal-clear",
        ):
            with self.subTest(boundary=boundary):
                root = self.home / f"replacement-hard-interruption-{boundary}"
                store = STORE_MODULE.Store(root, self.legacy)
                original_content = f"original synthetic resume {boundary}".encode()
                replacement_content = f"replacement synthetic resume {boundary}".encode()
                source = self.home / f"replacement-original-{boundary}.txt"
                replacement = self.home / f"replacement-new-{boundary}.txt"
                source.write_bytes(original_content)
                replacement.write_bytes(replacement_content)
                resume = store.create_resume({
                    "id": f"replacement-{boundary}", "label": "Replacement",
                    "path": str(source),
                })
                request = store.create_resume_extraction_request(
                    resume["id"], resume["revision"]
                )
                original_write = STORE_MODULE.atomic_write_json
                journal_started = False
                interrupted = False

                def interrupt_boundary(path, payload):
                    nonlocal journal_started, interrupted
                    operation = payload.get("operation") if isinstance(payload, dict) else None
                    starts_replacement = (
                        path == store.resume_extraction_journal_path
                        and isinstance(operation, dict)
                        and operation.get("kind") == "resume-request-close"
                    )
                    if starts_replacement and boundary == "pre-journal" and not interrupted:
                        interrupted = True
                        raise SimulatedPowerLoss()
                    result = original_write(path, payload)
                    if starts_replacement:
                        journal_started = True
                        if boundary == "post-journal" and not interrupted:
                            interrupted = True
                            raise SimulatedPowerLoss()
                    target = {
                        "requests-write": store.resume_extraction_requests_path,
                        "resumes-write": store.resumes_path,
                        "journal-clear": store.resume_extraction_journal_path,
                    }.get(boundary)
                    if (
                        target is not None and journal_started and path == target
                        and not interrupted
                        and (boundary != "journal-clear" or operation is None)
                    ):
                        interrupted = True
                        raise SimulatedPowerLoss()
                    return result

                with mock.patch.object(
                    STORE_MODULE, "atomic_write_json", side_effect=interrupt_boundary
                ):
                    with self.assertRaises(SimulatedPowerLoss):
                        store.update_resume(
                            resume["id"], {"path": str(replacement)}, resume["revision"]
                        )

                repaired = STORE_MODULE.Store(root, self.legacy)
                repaired.initialize()
                recovered_resume = repaired.get_resume(resume["id"])
                recovered_request = repaired.get_resume_extraction_request(
                    request["requestId"]
                )
                _record, recovered_content = repaired.read_resume_content(resume["id"])
                self.assertEqual(
                    recovered_resume["digest"], hashlib.sha256(recovered_content).hexdigest()
                )
                if boundary == "pre-journal":
                    self.assertEqual(recovered_content, original_content)
                    self.assertEqual(recovered_resume["revision"], resume["revision"])
                    self.assertEqual(
                        recovered_resume["contentRevision"], resume["contentRevision"]
                    )
                    self.assertEqual(recovered_request["status"], "requested")
                else:
                    self.assertEqual(recovered_content, replacement_content)
                    self.assertEqual(recovered_resume["revision"], resume["revision"] + 1)
                    self.assertNotEqual(
                        recovered_resume["contentRevision"], resume["contentRevision"]
                    )
                    self.assertEqual(recovered_request["status"], "stale")

    def test_two_agents_cannot_complete_one_extraction_request(self):
        source = self.home / "two-agents.txt"
        source.write_text("synthetic two agent resume", encoding="utf-8")
        resume = self.store.create_resume(
            {"id": "two-agent-resume", "label": "Two agents", "path": str(source)}
        )
        request = self.store.create_resume_extraction_request(
            resume["id"], resume["revision"]
        )

        def complete(index):
            try:
                return self.store.complete_resume_extraction_request(
                    request["requestId"],
                    {"email": f"agent-{index}@example.invalid"},
                    request["revision"], 1,
                )
            except STORE_MODULE.StoreError as error:
                return str(error)

        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(complete, (1, 2)))
        self.assertEqual(sum(isinstance(item, dict) for item in results), 1)
        self.assertEqual(sum(item == "request revision conflict" for item in results), 1)
        self.assertEqual(len(self.store.list_resume_proposals()), 1)
