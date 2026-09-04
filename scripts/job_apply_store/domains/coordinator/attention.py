"""Privacy-minimized coordinator attention and activity projections."""

from __future__ import annotations

from datetime import datetime
from typing import Any


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _runtime() -> dict[str, Any]:
    return _RUNTIME_PROVIDER()


class CoordinatorAttentionMixin:
    """Read-only coordinator views composed ahead of the compatibility Store."""

    def list_needs_attention(self) -> dict[str, Any]:
        """Return one coherent, privacy-minimized cross-job attention snapshot."""

        runtime = _runtime()
        self.initialize()
        self._ensure_coordinator_files()
        with runtime["exclusive_file_lock"](self.store_lock_path):
            jobs = self._load_jobs_document()["jobs"]
            persisted_claim = self._load_coordinator_document()["claim"]
            return self._needs_attention_locked(
                jobs, persisted_claim, self._now_datetime()
            )

    def _needs_attention_locked(
        self,
        jobs: dict[str, dict[str, Any]],
        persisted_claim: dict[str, Any] | None,
        now: datetime,
    ) -> dict[str, Any]:
        """Derive attention rows from documents already read under the Store lock."""

        runtime = _runtime()
        reason_rank = {
            "expired_agent_attempt": 0,
            "claimless_interrupted_attempt": 1,
            "awaiting_human_review": 2,
            "browser_action_required": 3,
            "needs_information": 4,
        }
        reason_details = {
            "expired_agent_attempt": (
                "Expired agent attempt",
                "Resume this attempt with the CLI claim-recover command for this job.",
            ),
            "claimless_interrupted_attempt": (
                "Interrupted agent attempt",
                "Reset this claimless attempt to needs_info with the revision-bound CLI job-transition command, then resolve it before starting a new attempt.",
            ),
            "awaiting_human_review": (
                "Awaiting your review",
                "Open Job details. After you personally submit on the third-party site, confirm Applied, or close the job with an outcome.",
            ),
            "needs_information": (
                "Needs information",
                "Open Job details and resolve the missing facts, resume, or answers, then run preflight and mark the job ready.",
            ),
            "browser_action_required": (
                "Browser action required",
                "Open Job details and continue in the visible browser. The saved information is already known; do not create or re-enter an answer in Companion.",
            ),
        }
        rows: list[dict[str, Any]] = []
        for job in jobs.values():
            if job.get("deletedAt") is not None:
                continue
            reason_code = None
            attention_at = job["updatedAt"]
            if job["status"] == "in_progress":
                selected_claim = (
                    persisted_claim
                    if persisted_claim is not None
                    and persisted_claim["jobId"] == job["id"]
                    else None
                )
                if selected_claim is None:
                    reason_code = "claimless_interrupted_attempt"
                elif now >= self._parse_time(selected_claim["expiresAt"]):
                    reason_code = "expired_agent_attempt"
                    attention_at = selected_claim["expiresAt"]
            elif job["status"] == "awaiting_review":
                reason_code = "awaiting_human_review"
            elif job["status"] == "needs_info":
                reason_code = "needs_information"
            if reason_code is None:
                continue

            missing_count = 0
            session_revision = None
            session_projection = None
            if reason_code in {"needs_information", "awaiting_human_review"}:
                session_path = self._session_path(job["id"])
                if session_path.exists():
                    session = self._read_session_projection(
                        session_path, job["id"], job.get("ats")
                    )
                    missing_count = len(session.get("pendingFields", []))
                    session_revision = self._session_revision(session)
                    session_projection = {
                        key: runtime["copy"].deepcopy(session[key])
                        for key in (
                            "attemptRevision", "readiness", "blockers", "browserHandoff",
                        )
                        if key in session
                    }
                    if (
                        reason_code == "needs_information"
                        and missing_count == 0
                        and session.get("browserHandoff") == {
                            "state": "required",
                            "reasonCode": "unsupported-control",
                            "revision": session.get("browserHandoff", {}).get("revision"),
                        }
                        and {
                            (blocker.get("type"), blocker.get("code"))
                            for blocker in session.get("blockers", [])
                        } == {
                            ("browser_handoff", "unsupported-control"),
                            ("information", "owner-input-required"),
                        }
                    ):
                        reason_code = "browser_action_required"
            reason_label, guidance = reason_details[reason_code]
            rows.append({
                "jobId": job["id"],
                "status": job["status"],
                "revision": job["revision"],
                "priority": job.get("priority", 0),
                "reasonCode": reason_code,
                "reasonLabel": reason_label,
                "attentionAt": attention_at,
                "guidance": guidance,
                "missingInformationCount": missing_count,
                "sessionRevision": session_revision,
                "session": session_projection,
            })
        rows.sort(key=lambda item: (
            reason_rank[item["reasonCode"]],
            -item["priority"],
            item["attentionAt"],
            item["jobId"],
        ))
        serialized = runtime["json"].dumps(
            rows, ensure_ascii=False, separators=(",", ":"), sort_keys=True
        ).encode("utf-8")
        return {
            "items": rows,
            "snapshotSignature": runtime["hashlib"].sha256(serialized).hexdigest(),
        }

    def get_job_activity(self, job_id: str) -> dict[str, Any]:
        """Return a selected-job-only, value-free application activity view."""
        runtime = _runtime()
        self.initialize()
        self._ensure_coordinator_files()
        job_id = runtime["_safe_session_id"](job_id)
        with runtime["exclusive_file_lock"](self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise runtime["StoreError"]("job does not exist")

            session = None
            answers_document = self._load_answers_document()
            session_path = self._session_path(job_id)
            if session_path.exists():
                stored_session = self._read_session_projection(
                    session_path, job_id, job.get("ats")
                )
                session = {
                    key: stored_session[key]
                    for key in (
                        "status", "step", "attemptRevision", "readiness", "blockers",
                        "approvals", "browserHandoff", "createdAt", "updatedAt",
                    )
                    if key in stored_session
                }
                approval_attempt_is_current = (
                    job["status"] in {"needs_info", "awaiting_review"}
                    or job["status"] == "in_progress"
                    and stored_session.get("attemptRevision") == job["revision"]
                )
                session["approvals"] = (
                    self._current_session_approvals(stored_session, answers_document)
                    if approval_attempt_is_current
                    else []
                )
                session["revision"] = self._session_revision(stored_session)
                session["pendingInformation"] = [
                    {
                        key: pending[key]
                        for key in (
                            "state", "sensitive", "fieldClass", "matchConfidence",
                            "matchReasonCodes",
                        )
                        if key in pending
                    } | self._pending_resolution_projection(pending, answers_document)
                    for pending in stored_session.get("pendingFields", [])
                ]

            persisted_claim = self._load_coordinator_document()["claim"]
            selected_claim = (
                persisted_claim
                if persisted_claim is not None and persisted_claim["jobId"] == job_id
                else None
            )
            if selected_claim is not None:
                expired = self._now_datetime() >= self._parse_time(
                    selected_claim["expiresAt"]
                )
                claim = {
                    "state": "expired" if expired else "active",
                    "acquiredAt": selected_claim["acquiredAt"],
                    "heartbeatAt": selected_claim["heartbeatAt"],
                    "expiresAt": selected_claim["expiresAt"],
                }
            elif job["status"] == "in_progress":
                claim = {"state": "interrupted"}
            else:
                claim = {"state": "none"}
            if claim["state"] == "expired":
                claim["recoveryGuidance"] = (
                    "Resume this attempt with the CLI claim-recover command for this job."
                )
            elif claim["state"] == "interrupted":
                claim["recoveryGuidance"] = (
                    "Reset this claimless attempt with the CLI job-transition command "
                    f"to needs_info using revision {job['revision']}; resolve any missing "
                    "information, then mark it ready for a new agent attempt."
                )

            history = []
            for event in self.read_history():
                if event["applicationId"] != job_id:
                    continue
                history.append({
                    key: event[key]
                    for key in ("event", "status", "ats", "at")
                    if key in event
                })

            return {
                "job": {"status": job["status"], "revision": job["revision"]},
                "session": session,
                "claim": claim,
                "history": history,
            }

    @staticmethod
    def _session_revision(session: dict[str, Any]) -> int:
        """Return a stable positive JSON/JavaScript-safe revision token."""
        runtime = _runtime()
        digest = runtime["hashlib"].sha256(
            runtime["_canonical_json"](session).encode("utf-8")
        ).hexdigest()
        return int(digest[:13], 16) + 1

    def _pending_resolution_projection(
        self, field: dict[str, Any], answers: dict[str, Any]
    ) -> dict[str, Any]:
        projection: dict[str, Any] = {"reference": field["reference"]}
        key = field.get("answerKey")
        if not isinstance(key, str) or not key:
            return projection | {"resolutionEligible": False}
        resolved = self._resolve_answer_key_in_document(answers, key)
        answer = answers["answers"].get(resolved)
        if answer is None or answer.get("deletedAt") is not None:
            return projection | {"resolutionEligible": False}
        projection["answerRevision"] = answer.get("revision", 1)
        projection["answerKey"] = resolved
        projection["answerSensitivity"] = answer.get("sensitivity", "none")
        projection["resolutionEligible"] = bool(
            field.get("sensitive") is not True
            and field.get("state") != "sensitive"
            and answer.get("reviewStatus", "accepted") == "accepted"
            and answer.get("state") == "confirmed"
            and answer.get("value") is not None
            and not self._answer_is_sensitive(answer)
        )
        return projection

    def _current_session_approvals(
        self, session: dict[str, Any], answers: dict[str, Any]
    ) -> list[dict[str, Any]]:
        runtime = _runtime()
        pending = {
            field["reference"]: field
            for field in session.get("pendingFields", [])
        }
        current = []
        for approval in session.get("approvals", []):
            field = pending.get(approval.get("reference"))
            field_key = field.get("answerKey") if field is not None else None
            approval_key = approval.get("answerKey")
            if not isinstance(field_key, str) or not isinstance(approval_key, str):
                continue
            resolved_field = self._resolve_answer_key_in_document(answers, field_key)
            resolved_approval = self._resolve_answer_key_in_document(
                answers, approval_key
            )
            answer = answers["answers"].get(resolved_field)
            if (
                resolved_field != resolved_approval
                or answer is None
                or answer.get("deletedAt") is not None
                or answer.get("revision", 1) != approval.get("answerRevision")
            ):
                continue
            current.append(runtime["copy"].deepcopy(approval))
        return current

    def pending_answer_detail(self, job_id: str, reference: str) -> dict[str, Any]:
        """Resolve an opaque durable pending reference to its canonical answer."""
        runtime = _runtime()
        self.initialize()
        job_id = runtime["_safe_session_id"](job_id)
        if (
            not isinstance(reference, str)
            or runtime["PENDING_REFERENCE"].fullmatch(reference) is None
        ):
            raise runtime["StoreError"]("pending question reference is invalid")
        with runtime["exclusive_file_lock"](self.store_lock_path):
            job = self._load_jobs_document()["jobs"].get(job_id)
            if job is None or job.get("deletedAt") is not None:
                raise runtime["StoreError"]("job does not exist")
            path = self._session_path(job_id)
            if not path.exists():
                raise runtime["StoreError"]("answer resolution session does not exist")
            session = self._read_session_projection(path, job_id, job.get("ats"))
            field = next(
                (
                    item for item in session.get("pendingFields", [])
                    if item.get("reference") == reference
                ),
                None,
            )
            if field is None:
                raise runtime["StoreError"]("pending question reference is stale")
            key = field.get("answerKey")
            if not isinstance(key, str) or not key:
                raise runtime["StoreError"]("pending question has no referenced answer")
            answers = self._load_answers_document()
            answer = self._get_answer_record(key, document=answers)
            if answer is None:
                raise runtime["StoreError"]("referenced answer does not exist")
            return self.answer_detail_projection(answer, answers)
