"""Canonical job CRUD and lifecycle mutations for composed Stores."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from ...constants import JOB_INGEST_FIELDS, JOB_STATUSES, JOB_TRANSITIONS
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock, read_json_object, require_object, validate_version
from ...normalization import _safe_session_id, normalize_job_url
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


class JobCrudMixin:
    """Job record operations composed ahead of the compatibility Store."""

    def _load_jobs_document(self) -> dict[str, Any]:
        document = _value(self, "read_json_object", read_json_object)(
            self.jobs_path, "jobs"
        )
        _value(self, "validate_version", validate_version)(document, "jobs")
        require = _value(self, "_require_object", require_object)
        jobs = require(document.get("jobs"), "jobs.jobs")
        require(document.get("metadata"), "jobs.metadata")
        validate = _value(self, "_validate_job_record", _validate_job_record)
        for key, record in jobs.items():
            if not isinstance(key, str) or not key:
                raise StoreError("job index keys must be non-empty strings")
            validate(key, record)
        return document

    def _require_active_resume(self, resume_id: str | None) -> None:
        if resume_id is None:
            return
        if not isinstance(resume_id, str):
            raise StoreError("job resume id must be a string")
        _value(self, "_safe_session_id", _safe_session_id)(resume_id)
        record = self._load_resumes_document()["resumes"].get(resume_id)
        if record is None or record.get("deletedAt") is not None:
            raise StoreError("assigned resume does not exist")

    def create_job(
        self, incoming: dict[str, Any], origin: str = "human"
    ) -> dict[str, Any]:
        self.initialize()
        origin = _value(self, "_job_origin")(origin)
        allowed = {
            "id", "url", "source", "sourceId", "role", "company", "location",
            "workplaceType", "employmentType", "compensation", "description",
            "ats", "priority", "status", "closedOutcome", "resumeId", "notes",
            "provenance", "lastCheckedAt",
        }
        if set(incoming) - allowed:
            raise StoreError("job input contains unsupported fields")
        url = incoming.get("url")
        normalized_url = _value(self, "normalize_job_url", normalize_job_url)(url)
        job_id = incoming.get("id") or f"job-{_value(self, 'uuid', uuid).uuid4()}"
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        status = incoming.get("status", "saved")
        if status != "saved":
            raise StoreError("new jobs must start with saved status")
        now = _utc_now(self)
        incoming_provenance = _value(self, "_require_object", require_object)(
            incoming.get("provenance", {}), "job provenance"
        )
        _value(self, "_reject_supplied_migration_provenance")(incoming_provenance)
        nonempty = _value(self, "_nonempty_job_value")
        stamped_fields = {
            field
            for field in JOB_INGEST_FIELDS
            if field in incoming and nonempty(incoming[field])
        }
        record = {
            **incoming,
            "id": job_id,
            "url": url.strip(),
            "normalizedUrl": normalized_url,
            "priority": incoming.get("priority", 0),
            "status": status,
            "closedOutcome": incoming.get("closedOutcome"),
            "provenance": _value(self, "_stamp_job_provenance")(
                incoming_provenance,
                stamped_fields,
                origin,
                _value(self, "_job_observation_source")(incoming),
                now,
            ),
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "deletedAt": None,
        }
        validate = _value(self, "_validate_job_record", _validate_job_record)
        validate(job_id, record)
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            self._require_active_resume(incoming.get("resumeId"))
            document = self._load_jobs_document()
            if job_id in document["jobs"]:
                raise StoreError("job id already exists")
            duplicate = next(
                (
                    item
                    for item in document["jobs"].values()
                    if item.get("deletedAt") is None
                    and item.get("normalizedUrl") == normalized_url
                ),
                None,
            )
            if duplicate is not None:
                raise StoreError("active job URL already exists")
            document["jobs"][job_id] = record
            document["metadata"]["updatedAt"] = now
            _value(self, "atomic_write_json", atomic_write_json)(
                self.jobs_path, document
            )
        return record

    def get_job(self, job_id: str, include_trashed: bool = False) -> dict[str, Any] | None:
        self.initialize()
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        record = self._load_jobs_document()["jobs"].get(job_id)
        if record is None or (record.get("deletedAt") is not None and not include_trashed):
            return None
        return _value(self, "_require_object", require_object)(record, "job record")

    def list_jobs(
        self,
        status: str | None = None,
        include_trashed: bool = False,
        trashed_only: bool = False,
    ) -> list[dict[str, Any]]:
        self.initialize()
        if status is not None and status not in JOB_STATUSES:
            raise StoreError("job status is unsupported")
        if trashed_only:
            include_trashed = True
        records = []
        for record in self._load_jobs_document()["jobs"].values():
            if record.get("deletedAt") is not None and not include_trashed:
                continue
            if trashed_only and record.get("deletedAt") is None:
                continue
            if status is not None and record.get("status") != status:
                continue
            records.append(record)
        return sorted(
            records,
            key=lambda item: (
                -item.get("priority", 0), item.get("createdAt", ""), item["id"]
            ),
        )

    def update_job(
        self,
        job_id: str,
        patch: dict[str, Any],
        expected_revision: int,
        origin: str = "human",
    ) -> dict[str, Any]:
        self.initialize()
        origin = _value(self, "_job_origin")(origin)
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        allowed = {
            "url", "source", "sourceId", "role", "company", "location",
            "workplaceType", "employmentType", "compensation", "description",
            "ats", "priority", "resumeId", "notes", "provenance", "lastCheckedAt",
        }
        if not patch or set(patch) - allowed:
            raise StoreError("job patch contains unsupported fields")
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            require = _value(self, "_require_object", require_object)
            current_provenance = require(current.get("provenance", {}), "job provenance")
            provenance = current_provenance
            provenance_changed = False
            if origin == "human" and "provenance" in patch:
                provenance = require(patch["provenance"], "job provenance")
                _value(self, "_validate_migration_provenance_replacement")(
                    current_provenance, provenance
                )
                provenance_changed = provenance != current_provenance
            accepted: dict[str, Any] = {}
            nonempty = _value(self, "_nonempty_job_value")
            for field, value in patch.items():
                if field == "provenance":
                    continue
                if origin in {"agent", "migration"} and not nonempty(value):
                    continue
                if origin == "agent" and not _value(
                    self, "_agent_may_update_job_field"
                )(current, current_provenance, field):
                    continue
                if origin == "migration" and not _value(
                    self, "_migration_may_update_job_field"
                )(current, current_provenance, field):
                    continue
                accepted[field] = value
            if "resumeId" in accepted:
                self._require_active_resume(accepted["resumeId"])
            updated = {**current, **accepted}
            if "url" in accepted:
                updated["normalizedUrl"] = _value(
                    self, "normalize_job_url", normalize_job_url
                )(accepted["url"])
                updated["url"] = accepted["url"].strip()
                duplicate = next(
                    (
                        item
                        for key, item in document["jobs"].items()
                        if key != job_id
                        and item.get("deletedAt") is None
                        and item.get("normalizedUrl") == updated["normalizedUrl"]
                    ),
                    None,
                )
                if duplicate is not None:
                    raise StoreError("active job URL already exists")
            changed = [
                field for field in accepted if current.get(field) != updated.get(field)
            ]
            if not changed and not provenance_changed:
                return current
            now = _utc_now(self)
            updated["provenance"] = _value(self, "_stamp_job_provenance")(
                provenance,
                changed,
                origin,
                _value(self, "_job_observation_source")(updated),
                now,
            )
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = now
            validate = _value(self, "_validate_job_record", _validate_job_record)
            validate(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            _value(self, "atomic_write_json", atomic_write_json)(
                self.jobs_path, document
            )
        return updated

    def transition_job(
        self,
        job_id: str,
        status: str,
        expected_revision: int,
        closed_outcome: str | None = None,
        user_confirmed: bool = False,
    ) -> dict[str, Any]:
        self.initialize()
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        if status not in JOB_STATUSES:
            raise StoreError("job status is unsupported")
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None or current.get("deletedAt") is not None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            self._require_job_unclaimed_locked(job_id)
            if status == current["status"]:
                return current
            if status not in JOB_TRANSITIONS[current["status"]]:
                raise StoreError("job status transition is unsupported")
            if status == "in_progress":
                raise StoreError("in_progress requires atomic job-acquire")
            if status == "applied" and not user_confirmed:
                raise StoreError("applied status requires explicit user confirmation")
            if status == "ready" and not self._preflight_job_record(current)["ready"]:
                raise StoreError("job is not ready")
            updated = dict(current)
            updated["status"] = status
            updated["closedOutcome"] = closed_outcome if status == "closed" else None
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = _utc_now(self)
            validate = _value(self, "_validate_job_record", _validate_job_record)
            validate(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            _value(self, "atomic_write_json", atomic_write_json)(
                self.jobs_path, document
            )
        return updated

    def trash_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_job_deleted(job_id, expected_revision, restore=False)

    def restore_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        return self._set_job_deleted(job_id, expected_revision, restore=True)

    def _set_job_deleted(
        self, job_id: str, expected_revision: int, restore: bool
    ) -> dict[str, Any]:
        self.initialize()
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None:
                raise StoreError("job does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            self._require_job_unclaimed_locked(job_id)
            is_trashed = current.get("deletedAt") is not None
            if restore == (not is_trashed):
                return current
            if restore:
                self._require_active_resume(current.get("resumeId"))
                duplicate = next(
                    (
                        item
                        for key, item in document["jobs"].items()
                        if key != job_id
                        and item.get("deletedAt") is None
                        and item.get("normalizedUrl") == current["normalizedUrl"]
                    ),
                    None,
                )
                if duplicate is not None:
                    raise StoreError("active job URL already exists")
            updated = dict(current)
            updated["deletedAt"] = None if restore else _utc_now(self)
            updated["revision"] = current["revision"] + 1
            updated["updatedAt"] = _utc_now(self)
            validate = _value(self, "_validate_job_record", _validate_job_record)
            validate(job_id, updated)
            document["jobs"][job_id] = updated
            document["metadata"]["updatedAt"] = updated["updatedAt"]
            _value(self, "atomic_write_json", atomic_write_json)(
                self.jobs_path, document
            )
        return updated

    def delete_job(self, job_id: str, expected_revision: int) -> dict[str, Any]:
        self.initialize()
        _value(self, "_safe_session_id", _safe_session_id)(job_id)
        lock = _value(self, "exclusive_file_lock", exclusive_file_lock)
        with lock(self.store_lock_path):
            document = self._load_jobs_document()
            current = document["jobs"].get(job_id)
            if current is None:
                return {"deleted": False, "id": job_id}
            if current["revision"] != expected_revision:
                raise StoreError("job revision conflict")
            self._require_job_unclaimed_locked(job_id)
            if current.get("deletedAt") is None:
                raise StoreError("job must be trashed before permanent deletion")
            session_path = self._session_path(job_id)
            if session_path.exists():
                session = self._read_session_projection(
                    session_path, job_id, current.get("ats")
                )
                if session["status"] not in {"completed", "abandoned"}:
                    raise StoreError(
                        "job is referenced by a nonterminal application session"
                    )
            del document["jobs"][job_id]
            document["metadata"]["updatedAt"] = _utc_now(self)
            _value(self, "atomic_write_json", atomic_write_json)(
                self.jobs_path, document
            )
        return {"deleted": True, "id": job_id}
