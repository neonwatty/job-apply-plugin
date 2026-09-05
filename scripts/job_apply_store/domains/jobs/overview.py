"""Privacy-minimized task views and job preflight for composed Stores."""

from __future__ import annotations

import hashlib
from datetime import datetime, timezone
from typing import Any

from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock
from ...normalization import _canonical_json, _safe_session_id, observe_resume_file
from ...validation.jobs_resumes import _validate_job_record


def _runtime(instance: Any) -> dict[str, Any]:
    return instance._runtime_provider()


def _value(instance: Any, name: str, fallback: Any = None) -> Any:
    return _runtime(instance).get(name, fallback)


def _utc_now(instance: Any) -> str:
    provider = _value(instance, "utc_now")
    if provider is not None:
        return provider()
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


class JobOverviewMixin:
    """Job overview and task operations composed ahead of the Store facade."""

    @staticmethod
    def _task_job_projection(record: dict[str, Any]) -> dict[str, Any]:
        """Project one canonical job without URLs, notes, or provenance."""

        return {
            key: record[key]
            for key in (
                "id", "role", "company", "location", "workplaceType",
                "employmentType", "status", "priority", "revision", "createdAt",
                "updatedAt",
            )
            if key in record
        }

    def task_snapshot(self) -> dict[str, Any]:
        """Return the shared, Store-owned task view used for job discussion."""

        self.initialize()
        self._ensure_coordinator_files()
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            profile = self._load_profile_document()["profile"]
            jobs = [
                item for item in self._load_jobs_document()["jobs"].values()
                if item.get("deletedAt") is None
            ]
            resumes = [
                item for item in self._load_resumes_document()["resumes"].values()
                if item.get("deletedAt") is None
            ]
            answers = [
                item for item in self._load_answers_document()["answers"].values()
                if item.get("deletedAt") is None
                and item.get("reviewStatus", "accepted") == "accepted"
            ]
            claim = self._load_coordinator_document()["claim"]
            now = self._now_datetime()
            overview = self._owner_beta_overview_locked(
                profile, jobs, resumes, answers, claim, now
            )
            projected_jobs = [
                self._task_job_projection(item)
                for item in sorted(
                    jobs,
                    key=lambda item: (
                        -item.get("priority", 0),
                        item.get("createdAt", ""),
                        item["id"],
                    ),
                )
            ]
            attention = self._needs_attention_locked(
                {item["id"]: item for item in jobs}, claim, now
            )
        signature_input = {
            "overview": overview,
            "jobs": projected_jobs,
            "attentionSignature": attention["snapshotSignature"],
        }
        canonical = _value(self, "_canonical_json", _canonical_json)
        return {
            "overview": overview,
            "jobs": projected_jobs,
            "attention": attention,
            "snapshotSignature": _value(self, "hashlib", hashlib).sha256(
                canonical(signature_input).encode("utf-8")
            ).hexdigest(),
        }

    def intake_task_job(
        self, incoming: dict[str, Any], origin: str = "agent"
    ) -> dict[str, Any]:
        """Atomically resolve or create exactly one active canonical job."""

        self.initialize()
        origin = _value(self, "_job_origin")(origin)
        payload = {"jobs": [incoming]}
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_jobs_document()
            planned, decisions, changed = self._plan_job_upsert(
                document, payload, origin, _utc_now(self)
            )
            if len(decisions) != 1:
                raise StoreError("task intake did not resolve exactly one job")
            decision = decisions[0]
            if decision["action"] in {"conflict", "invalid"}:
                raise StoreError(f"task intake {decision['action']}")
            job_id = decision.get("id")
            record = planned["jobs"].get(job_id)
            if (
                not isinstance(job_id, str)
                or record is None
                or record.get("deletedAt") is not None
            ):
                raise StoreError("task intake did not resolve one active job")
            if changed:
                _value(self, "atomic_write_json", atomic_write_json)(
                    self.jobs_path, planned
                )
        return {
            "action": decision["action"],
            "job": self._task_job_projection(record),
        }

    def select_task_job_ready(
        self, job_id: str, expected_revision: int, owner_confirmed: bool
    ) -> dict[str, Any]:
        """Apply an explicit, revision-bound owner choice to one canonical job."""

        self.initialize()
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        if owner_confirmed is not True:
            raise StoreError("task selection requires owner confirmation")
        if not isinstance(expected_revision, int) or isinstance(expected_revision, bool):
            raise StoreError("task selection requires an exact revision")
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("task selection job is unavailable")
            if current["revision"] != expected_revision:
                raise StoreError("task selection revision conflict")
            self._require_job_unclaimed_locked(job_id)
            if current["status"] not in {"saved", "needs_info", "ready"}:
                raise StoreError("task selection job is unavailable")
            if not self._preflight_job_record(current)["ready"]:
                raise StoreError("task selection preflight failed")
            if current["status"] == "ready":
                return {
                    "action": "noop",
                    "job": self._task_job_projection(current),
                }
            updated = dict(current)
            updated["status"] = "ready"
            updated["closedOutcome"] = None
            updated["revision"] += 1
            updated["updatedAt"] = _utc_now(self)
            _value(self, "_validate_job_record", _validate_job_record)(
                job_id, updated
            )
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            _value(self, "atomic_write_json", atomic_write_json)(
                self.jobs_path, document
            )
        return {"action": "ready", "job": self._task_job_projection(updated)}

    def owner_beta_overview(self) -> dict[str, Any]:
        """Return a value-free, Store-derived projection for the companion landing page."""

        self.initialize()
        self._ensure_coordinator_files()
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            profile = self._load_profile_document()["profile"]
            jobs = [
                item for item in self._load_jobs_document()["jobs"].values()
                if item.get("deletedAt") is None
            ]
            resumes = [
                item for item in self._load_resumes_document()["resumes"].values()
                if item.get("deletedAt") is None
            ]
            answers = [
                item for item in self._load_answers_document()["answers"].values()
                if item.get("deletedAt") is None
                and item.get("reviewStatus", "accepted") == "accepted"
            ]
            claim = self._load_coordinator_document()["claim"]
            now = self._now_datetime()
            return self._owner_beta_overview_locked(
                profile, jobs, resumes, answers, claim, now
            )

    def _owner_beta_overview_locked(
        self,
        profile: dict[str, Any],
        jobs: list[dict[str, Any]],
        resumes: list[dict[str, Any]],
        answers: list[dict[str, Any]],
        claim: dict[str, Any] | None,
        now: datetime,
    ) -> dict[str, Any]:
        """Derive the canonical overview from documents already read under the lock."""

        attention_count = 0
        for job in jobs:
            status = job["status"]
            if status in {"needs_info", "awaiting_review"}:
                attention_count += 1
            elif status == "in_progress":
                owns_job = claim is not None and claim["jobId"] == job["id"]
                if not owns_job or now >= self._parse_time(claim["expiresAt"]):
                    attention_count += 1

        live_claim = claim is not None and now < self._parse_time(claim["expiresAt"])
        acquirable_ready_count = 0
        if not live_claim:
            resumes_by_id = {resume["id"]: resume for resume in resumes}
            active_resume_ids = set(resumes_by_id)
            self._overview_resume_digest_cache = {
                key: value
                for key, value in self._overview_resume_digest_cache.items()
                if key in active_resume_ids
            }
            resume_observations: dict[str, dict[str, Any]] = {}
            acquirable_ready_count = sum(
                self._preflight_job_record(
                    item,
                    profile=profile,
                    resumes=resumes_by_id,
                    resume_observations=resume_observations,
                    managed_digest_cache=self._overview_resume_digest_cache,
                )["ready"]
                for item in jobs
                if item["status"] == "ready"
            )
        counts = {
            "jobs": len(jobs),
            "readyJobs": sum(item["status"] == "ready" for item in jobs),
            "attentionJobs": attention_count,
            "resumes": len(resumes),
            "answers": len(answers),
        }
        setup = {
            "hasProfileFacts": self._has_application_facts(profile),
            "hasResume": bool(resumes),
        }
        if not setup["hasResume"]:
            next_action, target = "import_resume", "resumes"
        elif not setup["hasProfileFacts"]:
            next_action, target = "review_facts", "facts"
        elif counts["attentionJobs"]:
            next_action, target = "resolve_attention", "attention"
        elif acquirable_ready_count:
            next_action, target = "handoff_ready_job", "jobs"
        elif not counts["jobs"]:
            next_action, target = "capture_job", "jobs"
        else:
            next_action, target = "prepare_job", "jobs"
        return {
            "setup": setup,
            "counts": counts,
            "nextAction": next_action,
            "targetWorkspace": target,
        }

    def _preflight_job_record(
        self,
        record: dict[str, Any],
        *,
        profile: dict[str, Any] | None = None,
        resumes: dict[str, dict[str, Any]] | None = None,
        resume_observations: dict[str, dict[str, Any]] | None = None,
        managed_digest_cache: dict[str, dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        errors: list[str] = []
        warnings: list[str] = []
        if profile is None:
            profile = self._load_profile_document()["profile"]
        if not self._has_application_facts(profile):
            errors.append("profile_empty")
        if resumes is None:
            resumes = self._load_resumes_document()["resumes"]
        resume_id = record.get("resumeId")
        if resume_id is None:
            default = next(
                (
                    item
                    for item in resumes.values()
                    if item.get("deletedAt") is None and item.get("default")
                ),
                None,
            )
            resume_id = default["id"] if default is not None else None
        resume = resumes.get(resume_id) if resume_id is not None else None
        if resume is None or resume.get("deletedAt") is not None:
            errors.append("resume_missing")
        else:
            observation = None
            if resume_observations is not None:
                observation = resume_observations.get(resume["id"])
            if observation is None:
                observation = (
                    self._managed_resume_observation(
                        resume, digest_cache=managed_digest_cache
                    )
                    if resume.get("storageKind") == "managed"
                    else _value(self, "observe_resume_file", observe_resume_file)(
                        str(self._resume_path(resume))
                    )
                )
                if resume_observations is not None:
                    resume_observations[resume["id"]] = observation
            if not observation["exists"]:
                errors.append("resume_file_missing")
            elif (
                observation["size"] != resume.get("observedSize")
                or observation["modifiedAt"] != resume.get("observedModifiedAt")
                or (
                    resume.get("storageKind") == "managed"
                    and observation.get("digest") != resume.get("digest")
                )
            ):
                if resume.get("storageKind") == "managed":
                    errors.append("resume_file_changed")
                else:
                    warnings.append("resume_file_changed")
        if not record.get("role"):
            warnings.append("role_missing")
        if not record.get("company"):
            warnings.append("company_missing")
        return {
            "id": record["id"],
            "revision": record["revision"],
            "ready": not errors,
            "resumeId": resume_id,
            "errors": errors,
            "warnings": warnings,
        }

    def preflight_job(self, job_id: str) -> dict[str, Any]:
        self.initialize()
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        record = self._load_jobs_document()["jobs"].get(job_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("job does not exist")
        return self._preflight_job_record(record)
