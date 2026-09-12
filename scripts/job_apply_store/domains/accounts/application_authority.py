"""Durable, value-free authority for non-final application automation."""

from __future__ import annotations

import copy
import uuid
from datetime import timedelta
from typing import Any
from urllib.parse import urlsplit

from ...constants import SCHEMA_VERSION
from ...errors import StoreError
from ...io import atomic_write_json, exclusive_file_lock, read_json_object, require_object, validate_version
from ...normalization import _safe_session_id


MODES = {"fill_to_review", "campaign"}
STATUSES = {"active", "revoked", "replaced", "consumed"}
OPERATIONS = {
    "fill_canonical_profile", "upload_managed_resume",
    "fill_confirmed_answer", "repair_cleared_field", "navigate_non_final",
}
SENSITIVE_FIELD_CLASSES = {
    "demographic", "disability", "veteran_status", "work_authorization",
    "criminal_history", "compensation", "other_declared_sensitive",
}
INTERRUPTS = {
    "missingOrUncertainData": "missing_or_uncertain_data",
    "captcha": "captcha",
    "mfa": "mfa",
    "emailVerification": "email_verification",
    "providerLegalConsent": "provider_legal_consent",
    "unsupportedControls": "unsupported_controls",
    "unexpectedDestination": "unexpected_destination",
    "ambiguity": "ambiguity",
    "finalAction": "final_action_manual",
}
MAX_JOBS = 50
MAX_WORKERS = 50
MAX_DURATION_MINUTES = 24 * 60


_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str, fallback: Any) -> Any:
    return _RUNTIME_PROVIDER().get(name, fallback)


def _positive(value: Any, label: str, *, zero: bool = False) -> int:
    minimum = 0 if zero else 1
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum:
        raise StoreError(f"{label} must be an integer of at least {minimum}")
    return value


def _strings(value: Any, label: str, *, allowed: set[str] | None = None) -> list[str]:
    if (
        not isinstance(value, list)
        or not all(isinstance(item, str) and item.strip() for item in value)
    ):
        raise StoreError(f"{label} must be a list of non-empty strings")
    normalized = sorted(item.strip() for item in value)
    if len(normalized) != len(set(normalized)):
        raise StoreError(f"{label} contains duplicates")
    if allowed is not None and not set(normalized) <= allowed:
        raise StoreError(f"{label} contains unsupported values")
    return normalized


def _origin(url: Any) -> str:
    if not isinstance(url, str):
        raise StoreError("application destination is invalid")
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise StoreError("application destination is invalid")
    return f"{parsed.scheme.lower()}://{parsed.netloc.lower()}"


def _binding(value: Any) -> dict[str, Any]:
    item = _late("_require_object", require_object)(value, "application authority job binding")
    if set(item) != {"jobId", "approvedJobRevision", "destinationOrigin", "resumeId", "resumeRevision"}:
        raise StoreError("application authority job binding contains unsupported fields")
    _late("_safe_session_id", _safe_session_id)(item.get("jobId", ""))
    _late("_safe_session_id", _safe_session_id)(item.get("resumeId", ""))
    _positive(item.get("approvedJobRevision"), "approved job revision")
    _positive(item.get("resumeRevision"), "approved resume revision")
    if _origin(item.get("destinationOrigin")) != item["destinationOrigin"]:
        raise StoreError("application authority destination origin is invalid")
    return dict(item)


def _record(value: Any) -> dict[str, Any]:
    record = _late("_require_object", require_object)(value, "application authority")
    fields = {
        "authorizationId", "mode", "status", "revision", "issuedAt", "expiresAt",
        "revokedAt", "jobBindings", "workerIds", "sensitiveFieldClasses",
    }
    if set(record) != fields:
        raise StoreError("application authority contains unsupported fields")
    if not isinstance(record["authorizationId"], str) or not record["authorizationId"].startswith("application-authority-"):
        raise StoreError("application authority identity is invalid")
    if record["mode"] not in MODES or record["status"] not in STATUSES:
        raise StoreError("application authority mode or status is invalid")
    _positive(record["revision"], "application authority revision")
    for field in ("issuedAt", "expiresAt"):
        if not isinstance(record[field], str) or not record[field]:
            raise StoreError("application authority timestamp is invalid")
    if record["status"] == "active" and record["revokedAt"] is not None:
        raise StoreError("active application authority has a terminal timestamp")
    if record["status"] != "active" and not isinstance(record["revokedAt"], str):
        raise StoreError("terminal application authority has no timestamp")
    bindings = [_binding(item) for item in record["jobBindings"]] if isinstance(record["jobBindings"], list) else []
    if not bindings or len(bindings) > MAX_JOBS or len({item["jobId"] for item in bindings}) != len(bindings):
        raise StoreError("application authority job scope is invalid")
    workers = _strings(record["workerIds"], "application authority workers")
    classes = _strings(record["sensitiveFieldClasses"], "sensitive field classes", allowed=SENSITIVE_FIELD_CLASSES)
    if record["mode"] == "fill_to_review" and (len(bindings) != 1 or len(workers) != 1):
        raise StoreError("Fill to Review requires one exact job and worker")
    if record["mode"] == "fill_to_review" and classes:
        raise StoreError("Fill to Review does not include sensitive field classes")
    if record["mode"] == "campaign" and (not workers or len(workers) > MAX_WORKERS):
        raise StoreError("Campaign requires an explicit bounded worker set")
    normalized = copy.deepcopy(record)
    normalized["jobBindings"] = sorted(bindings, key=lambda item: item["jobId"])
    normalized["workerIds"] = workers
    normalized["sensitiveFieldClasses"] = classes
    return normalized


class ApplicationAuthorityMixin:
    """Persist and evaluate current-use authority without storing field values."""

    def _empty_application_authority_document(self) -> dict[str, Any]:
        now = self._now()
        return {
            "schemaVersion": _late("SCHEMA_VERSION", SCHEMA_VERSION),
            "activeAuthorityId": None,
            "authorities": {},
            "metadata": {"revision": 0, "createdAt": now, "updatedAt": now},
        }

    def _ensure_application_authority_document(self) -> None:
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            if not self.application_authority_path.exists():
                _late("atomic_write_json", atomic_write_json)(
                    self.application_authority_path,
                    self._empty_application_authority_document(),
                )

    def _load_application_authority_document(self) -> dict[str, Any]:
        document = _late("read_json_object", read_json_object)(
            self.application_authority_path, "application authority"
        )
        _late("validate_version", validate_version)(document, "application authority")
        if set(document) != {"schemaVersion", "activeAuthorityId", "authorities", "metadata"}:
            raise StoreError("application authority document contains unsupported fields")
        authorities = _late("_require_object", require_object)(document["authorities"], "application authorities")
        for key, value in authorities.items():
            normalized = _record(value)
            if normalized["authorizationId"] != key:
                raise StoreError("application authority identity does not match")
        active_id = document["activeAuthorityId"]
        if active_id is not None and (active_id not in authorities or authorities[active_id]["status"] != "active"):
            raise StoreError("active application authority pointer is invalid")
        metadata = _late("_require_object", require_object)(document["metadata"], "application authority metadata")
        if set(metadata) != {"revision", "createdAt", "updatedAt"}:
            raise StoreError("application authority metadata is invalid")
        _positive(metadata["revision"], "application authority document revision", zero=True)
        return document

    def _active_application_authority(self, document: dict[str, Any]) -> dict[str, Any] | None:
        active_id = document["activeAuthorityId"]
        return document["authorities"].get(active_id) if active_id is not None else None

    def _authority_public(self, record: dict[str, Any] | None, revision: int) -> dict[str, Any]:
        if record is None:
            return {"mode": "guided", "status": "active", "revision": revision, "authorizationId": None,
                    "expiresAt": None, "jobIds": [], "workerIds": [], "sensitiveFieldClasses": []}
        status = record["status"]
        if status == "active" and self._now_datetime() >= self._parse_time(record["expiresAt"]):
            status = "expired"
        return {
            "mode": record["mode"] if status == "active" else "guided",
            "status": status, "revision": revision,
            "authorizationId": record["authorizationId"], "expiresAt": record["expiresAt"],
            "jobIds": [item["jobId"] for item in record["jobBindings"]],
            "workerIds": list(record["workerIds"]),
            "sensitiveFieldClasses": list(record["sensitiveFieldClasses"]),
        }

    def application_authority_status(self, *, public: bool = False) -> dict[str, Any]:
        self.initialize()
        self._ensure_application_authority_document()
        document = self._load_application_authority_document()
        record = self._active_application_authority(document)
        if public:
            return self._authority_public(record, document["metadata"]["revision"])
        return {"revision": document["metadata"]["revision"], "authority": copy.deepcopy(record)}

    def set_application_authority(self, incoming: dict[str, Any], expected_revision: int, *, public: bool = False) -> dict[str, Any]:
        packet = _late("_require_object", require_object)(incoming, "application authority request")
        if set(packet) != {"mode", "jobIds", "workerIds", "sensitiveFieldClasses", "durationMinutes"}:
            raise StoreError("application authority request contains unsupported fields")
        mode = packet.get("mode")
        if mode not in MODES:
            raise StoreError("application authority mode is invalid")
        job_ids = _strings(packet["jobIds"], "application authority jobs")
        worker_ids = _strings(packet["workerIds"], "application authority workers")
        classes = _strings(packet["sensitiveFieldClasses"], "sensitive field classes", allowed=SENSITIVE_FIELD_CLASSES)
        duration = _positive(packet["durationMinutes"], "application authority duration")
        if duration > MAX_DURATION_MINUTES:
            raise StoreError("application authority duration is too long")
        if mode == "fill_to_review" and (len(job_ids) != 1 or len(worker_ids) != 1):
            raise StoreError("Fill to Review requires one exact job and worker")
        if mode == "fill_to_review" and classes:
            raise StoreError("Fill to Review does not include sensitive field classes")
        if mode == "campaign" and (
            not job_ids or not worker_ids
            or len(job_ids) > MAX_JOBS or len(worker_ids) > MAX_WORKERS
        ):
            raise StoreError("Campaign requires bounded job and worker sets")
        self.initialize()
        self._ensure_application_authority_document()
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            document = self._load_application_authority_document()
            if document["metadata"]["revision"] != expected_revision:
                raise StoreError("application authority revision conflict")
            jobs = self._load_jobs_document()["jobs"]
            resumes = self._load_resumes_document()["resumes"]
            bindings = []
            for job_id in job_ids:
                _late("_safe_session_id", _safe_session_id)(job_id)
                job = jobs.get(job_id)
                if job is None or job.get("deletedAt") is not None or job["status"] not in {"ready", "in_progress"}:
                    raise StoreError("application authority requires selected Ready or In Progress jobs")
                preflight = self._preflight_job_record(job)
                resume = resumes.get(preflight.get("resumeId"))
                if not preflight["ready"] or resume is None or resume.get("storageKind") != "managed":
                    raise StoreError("application authority requires a current managed resume")
                bindings.append({
                    "jobId": job_id, "approvedJobRevision": job["revision"],
                    "destinationOrigin": _origin(job["normalizedUrl"]),
                    "resumeId": resume["id"], "resumeRevision": resume["revision"],
                })
            now = self._now_datetime()
            timestamp = self._now()
            previous = self._active_application_authority(document)
            if previous is not None:
                previous["status"] = "replaced"
                previous["revokedAt"] = timestamp
                previous["revision"] += 1
            revision = document["metadata"]["revision"] + 1
            record = {
                "authorizationId": f"application-authority-{uuid.uuid4()}",
                "mode": mode, "status": "active", "revision": 1,
                "issuedAt": timestamp,
                "expiresAt": (now + timedelta(minutes=duration)).isoformat(timespec="seconds").replace("+00:00", "Z"),
                "revokedAt": None, "jobBindings": bindings,
                "workerIds": worker_ids, "sensitiveFieldClasses": classes,
            }
            record = _record(record)
            document["authorities"][record["authorizationId"]] = record
            document["activeAuthorityId"] = record["authorizationId"]
            document["metadata"].update({"revision": revision, "updatedAt": timestamp})
            _late("atomic_write_json", atomic_write_json)(self.application_authority_path, document)
        return self._authority_public(record, revision) if public else copy.deepcopy(record)

    def revoke_application_authority(self, expected_revision: int, *, public: bool = False) -> dict[str, Any]:
        self.initialize()
        self._ensure_application_authority_document()
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            document = self._load_application_authority_document()
            if document["metadata"]["revision"] != expected_revision:
                raise StoreError("application authority revision conflict")
            record = self._active_application_authority(document)
            if record is None:
                raise StoreError("application authority is already Guided")
            record["status"] = "revoked"
            record["revokedAt"] = self._now()
            record["revision"] += 1
            document["activeAuthorityId"] = None
            document["metadata"].update({"revision": expected_revision + 1, "updatedAt": self._now()})
            _late("atomic_write_json", atomic_write_json)(self.application_authority_path, document)
        return self._authority_public(None, expected_revision + 1) if public else copy.deepcopy(record)

    def _complete_application_authority_locked(self, job_id: str) -> None:
        if not self.application_authority_path.exists():
            return
        document = self._load_application_authority_document()
        record = self._active_application_authority(document)
        if record is None or record["mode"] != "fill_to_review":
            return
        if record["jobBindings"][0]["jobId"] != job_id:
            return
        record["status"] = "consumed"
        record["revokedAt"] = self._now()
        record["revision"] += 1
        document["activeAuthorityId"] = None
        document["metadata"]["revision"] += 1
        document["metadata"]["updatedAt"] = self._now()
        _late("atomic_write_json", atomic_write_json)(self.application_authority_path, document)

    def evaluate_application_authority(self, incoming: dict[str, Any], *, public: bool = False) -> dict[str, Any]:
        del public
        packet = _late("_require_object", require_object)(incoming, "application authority evaluation")
        required = {"jobId", "workerId", "destinationUrl", "operations", "answerRefs", "sensitiveAnswerUses", "interrupts"}
        if set(packet) != required:
            raise StoreError("application authority evaluation contains unsupported fields")
        operations = _strings(packet["operations"], "application operations", allowed=OPERATIONS)
        answers = _strings(packet["answerRefs"], "application answer references")
        interrupts = _late("_require_object", require_object)(packet["interrupts"], "application interrupts")
        if set(interrupts) != set(INTERRUPTS) or not all(isinstance(value, bool) for value in interrupts.values()):
            raise StoreError("application interrupt flags are invalid")
        for field, reason in INTERRUPTS.items():
            if interrupts[field]:
                return {"authorized": False, "mode": "guided", "reasonCode": reason, "interrupt": True}
        self.initialize()
        self._ensure_application_authority_document()
        with _late("exclusive_file_lock", exclusive_file_lock)(self.store_lock_path):
            document = self._load_application_authority_document()
            record = self._active_application_authority(document)
            if record is None:
                return {"authorized": False, "mode": "guided", "reasonCode": "granular_confirmation_required", "interrupt": True}
            if self._now_datetime() >= self._parse_time(record["expiresAt"]):
                return {"authorized": False, "mode": "guided", "reasonCode": "authority_expired", "interrupt": True}
            job_id = _late("_safe_session_id", _safe_session_id)(packet.get("jobId", ""))
            worker = packet.get("workerId")
            if not isinstance(worker, str) or worker.strip() not in record["workerIds"]:
                return {"authorized": False, "mode": "guided", "reasonCode": "worker_out_of_scope", "interrupt": True}
            binding = next((item for item in record["jobBindings"] if item["jobId"] == job_id), None)
            if binding is None:
                return {"authorized": False, "mode": "guided", "reasonCode": "job_out_of_scope", "interrupt": True}
            if _origin(packet["destinationUrl"]) != binding["destinationOrigin"]:
                return {"authorized": False, "mode": "guided", "reasonCode": "unexpected_destination", "interrupt": True}
            jobs = self._load_jobs_document()["jobs"]
            job = jobs.get(job_id)
            claim = self._load_coordinator_document()["claim"] if self.coordinator_path.exists() else None
            if job is None or job.get("status") != "in_progress" or claim is None or claim["jobId"] != job_id or claim["ownerLabel"] != worker.strip():
                return {"authorized": False, "mode": "guided", "reasonCode": "worker_claim_mismatch", "interrupt": True}
            if self._now_datetime() >= self._parse_time(claim["expiresAt"]):
                return {"authorized": False, "mode": "guided", "reasonCode": "worker_claim_expired", "interrupt": True}
            preflight = self._preflight_job_record(job)
            resumes = self._load_resumes_document()["resumes"]
            resume = resumes.get(binding["resumeId"])
            if (
                not preflight["ready"]
                or preflight.get("resumeId") != binding["resumeId"]
                or resume is None
                or resume.get("storageKind") != "managed"
                or resume.get("revision") != binding["resumeRevision"]
            ):
                return {"authorized": False, "mode": "guided", "reasonCode": "canonical_data_changed", "interrupt": True}
            canonical_answers = self._load_answers_document()["answers"]
            for answer_ref in answers:
                answer = canonical_answers.get(answer_ref)
                if answer is None or answer.get("deletedAt") is not None or answer.get("reviewStatus", "accepted") != "accepted" or answer.get("state") != "confirmed" or answer.get("value") is None or self._answer_is_sensitive(answer):
                    return {"authorized": False, "mode": "guided", "reasonCode": "answer_not_confirmed_non_sensitive", "interrupt": True}
            uses = packet["sensitiveAnswerUses"]
            if not isinstance(uses, list):
                raise StoreError("sensitive answer uses must be a list")
            seen = set()
            for use in uses:
                item = _late("_require_object", require_object)(use, "sensitive answer use")
                if set(item) != {"answerRef", "fieldClass"} or item.get("fieldClass") not in SENSITIVE_FIELD_CLASSES or item["answerRef"] in seen:
                    raise StoreError("sensitive answer use is invalid")
                seen.add(item["answerRef"])
                answer = canonical_answers.get(item["answerRef"])
                if item["fieldClass"] not in record["sensitiveFieldClasses"] or answer is None or answer.get("reviewStatus", "accepted") != "accepted" or answer.get("state") != "confirmed" or answer.get("value") is None or not self._answer_is_sensitive(answer):
                    return {"authorized": False, "mode": "guided", "reasonCode": "sensitive_current_use_not_approved", "interrupt": True}
            return {
                "authorized": True, "mode": record["mode"],
                "reasonCode": "authorized_to_review_boundary", "interrupt": False,
                "operations": operations, "authorizationId": record["authorizationId"],
                "revision": document["metadata"]["revision"],
            }
