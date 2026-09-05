"""Resume-extraction proposal creation, inspection, and review behavior."""

from __future__ import annotations

import copy
import re
import types
import uuid
from datetime import datetime, timezone
from typing import Any

from ... import io, normalization
from ...constants import (
    EXTRACTION_DECISIONS,
    EXTRACTION_STATUSES,
    SCHEMA_VERSION,
)
from ...errors import StoreError
from ...validation import extraction


def _canonical_validate_content_revision(value: Any) -> str:
    if not isinstance(value, str) or re.fullmatch(
        r"content_[A-Za-z0-9_-]{32,128}", value
    ) is None:
        raise StoreError("resume content revision is unverifiable")
    return value


_CANONICAL_TRUSTED_FILL = types.SimpleNamespace(
    TrustedFillError=StoreError,
    validate_content_revision=_canonical_validate_content_revision,
)


def _canonical_utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace(
        "+00:00", "Z"
    )


def _canonical_validate_proposal(key: str, value: Any) -> dict[str, Any]:
    return extraction._validate_extraction_proposal(
        key, value, trusted_fill_module=_CANONICAL_TRUSTED_FILL
    )


def _canonical_validate_document(document: dict[str, Any]) -> dict[str, Any]:
    return extraction._validate_extractions_document(
        document, trusted_fill_module=_CANONICAL_TRUSTED_FILL
    )


_CANONICAL_RUNTIME = {
    "_json_values_equal": normalization._json_values_equal,
    "_pointer_baseline": normalization._pointer_baseline,
    "_pointer_lookup": normalization._pointer_lookup,
    "_replacement_scope": normalization._replacement_scope,
    "_require_object": io.require_object,
    "_safe_session_id": normalization._safe_session_id,
    "_set_pointer_value": normalization._set_pointer_value,
    "_validate_extraction_proposal": _canonical_validate_proposal,
    "_validate_extractions_document": _canonical_validate_document,
    "_validated_candidate": extraction._validated_candidate,
    "copy": copy,
    "exclusive_file_lock": io.exclusive_file_lock,
    "utc_now": _canonical_utc_now,
    "uuid": uuid,
}
_RUNTIME_PROVIDER = lambda: globals()


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its composing facade's late-bound globals."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    return _RUNTIME_PROVIDER().get(name, _CANONICAL_RUNTIME[name])


class ExtractionProposalMixin:
    """Proposal operations composed ahead of the compatibility Store."""

    def _proposal_stale_reasons(self, proposal: dict[str, Any]) -> list[str]:
        resume = self._load_resumes_document()["resumes"].get(proposal["resumeId"])
        if resume is None:
            return ["resume_deleted"]
        reasons: list[str] = []
        if resume.get("deletedAt") is not None:
            reasons.append("resume_trashed")
        if resume.get("storageKind") != "managed":
            reasons.append("resume_not_managed")
            return reasons
        content_revision = proposal.get("resumeContentRevision")
        if content_revision is not None:
            if resume.get("contentRevision") != content_revision:
                reasons.append("resume_content_revision_changed")
        else:
            if resume["revision"] != proposal["resumeRevision"]:
                reasons.append("resume_revision_changed")
            if resume["digest"] != proposal["resumeDigest"]:
                reasons.append("resume_digest_changed")
        observation = self._managed_resume_observation(resume)
        if not observation["exists"]:
            reasons.append("resume_file_missing")
        elif observation.get("digest") != resume["digest"]:
            reasons.append("resume_file_changed")
        return reasons

    def _proposal_result(self, proposal: dict[str, Any]) -> dict[str, Any]:
        result = dict(proposal)
        reasons = self._proposal_stale_reasons(proposal)
        result["stale"] = bool(reasons)
        result["staleReasons"] = reasons
        return result

    @staticmethod
    def _proposal_summary(proposal: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": proposal["id"],
            "resumeId": proposal["resumeId"],
            "status": proposal["status"],
            "revision": proposal["revision"],
            "autoFilledCount": len(proposal["autoFilledPaths"]),
            "pendingCount": len(proposal["pendingPaths"]),
        }

    def _create_resume_proposal_locked(
        self,
        resume: dict[str, Any],
        candidate_input: dict[str, Any],
        profile_document: dict[str, Any],
        proposals_document: dict[str, Any],
        supersedes: str | None,
        *,
        bind_content_revision: bool,
    ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
        candidate, candidate_paths = _late("_validated_candidate")(candidate_input)
        profile_revision = profile_document["metadata"].get("revision", 1)
        pending = next((
            proposal for proposal in proposals_document["proposals"].values()
            if proposal["resumeId"] == resume["id"] and proposal["status"] == "pending"
        ), None)
        if pending is not None:
            if supersedes != pending["id"]:
                raise StoreError("pending proposal requires explicit supersession")
        elif supersedes is not None:
            raise StoreError("proposal to supersede does not exist")
        now = _late("utc_now")()
        proposal_id = f"proposal-{_late('uuid').uuid4()}"
        profile = _late("copy").deepcopy(profile_document["profile"])
        provenance = dict(profile_document["metadata"].get("factProvenance", {}))
        baselines = {
            path: _late("_pointer_baseline")(profile_document["profile"], path)
            for path in candidate_paths
        }
        auto_filled: list[str] = []
        pending_paths: list[str] = []
        for path in candidate_paths:
            baseline = baselines[path]
            ancestors_allow_fill = all(
                not ancestor["exists"]
                or (ancestor.get("container") is True and ancestor.get("empty") is False)
                or ("value" in ancestor and ancestor["value"] is None)
                for ancestor in baseline["ancestors"]
            )
            empty = not baseline["exists"] or baseline.get("value") is None
            if empty and ancestors_allow_fill and not self._user_protects_path(provenance, path):
                _exists, extracted = _late("_pointer_lookup")(candidate, path)
                _late("_set_pointer_value")(
                    profile, path, extracted, replace_ancestors=False
                )
                auto_filled.append(path)
            else:
                pending_paths.append(path)
        result_profile_revision = profile_revision
        if auto_filled:
            metadata = dict(profile_document["metadata"])
            metadata["revision"] = profile_revision + 1
            metadata["updatedAt"] = now
            metadata["factProvenance"] = self._stamp_fact_provenance(
                provenance, auto_filled, "resume", now, profile_document["profile"]
            )
            profile_document = {
                "schemaVersion": SCHEMA_VERSION, "profile": profile, "metadata": metadata,
            }
            result_profile_revision = metadata["revision"]
        if pending is not None:
            replaced = dict(pending)
            replaced.update({
                "status": "superseded", "supersededBy": proposal_id,
                "revision": pending["revision"] + 1, "updatedAt": now,
            })
            _late("_validate_extraction_proposal")(pending["id"], replaced)
            proposals_document["proposals"][pending["id"]] = replaced
        proposal = {
            "id": proposal_id,
            "resumeId": resume["id"],
            "resumeRevision": resume["revision"],
            "resumeDigest": resume["digest"],
            "profileRevision": profile_revision,
            "resultProfileRevision": result_profile_revision,
            "candidate": candidate,
            "baselines": baselines,
            "autoFilledPaths": auto_filled,
            "pendingPaths": pending_paths,
            "decisions": {},
            "status": "pending" if pending_paths else "completed",
            "revision": 1,
            "createdAt": now,
            "updatedAt": now,
            "supersededBy": None,
        }
        if bind_content_revision:
            proposal["resumeContentRevision"] = resume["contentRevision"]
        _late("_validate_extraction_proposal")(proposal_id, proposal)
        proposals_document["proposals"][proposal_id] = proposal
        proposals_document["metadata"]["updatedAt"] = now
        _late("_validate_extractions_document")(proposals_document)
        return profile_document, proposals_document, proposal

    def create_resume_proposal(
        self,
        resume_id: str,
        candidate_input: dict[str, Any],
        expected_resume_revision: int,
        expected_profile_revision: int,
        supersedes: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(resume_id)
        _late("_validated_candidate")(candidate_input)
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._ensure_extraction_files_locked()
            self._roll_forward_extraction_locked()
            resumes = self._load_resumes_document()["resumes"]
            resume = resumes.get(resume_id)
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume["revision"] != expected_resume_revision:
                raise StoreError("resume revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            profile_document = self._load_profile_document()
            profile_revision = profile_document["metadata"].get("revision", 1)
            if profile_revision != expected_profile_revision:
                raise StoreError("profile revision conflict")
            proposals_document = self._load_extractions_document()
            profile_document, proposals_document, proposal = (
                self._create_resume_proposal_locked(
                    resume, candidate_input, profile_document,
                    proposals_document, supersedes, bind_content_revision=False,
                )
            )
            self._commit_extraction_operation_locked(
                "create", profile_document, proposals_document
            )
            return self._proposal_result(proposal)

    def complete_resume_extraction_request(
        self,
        request_id: str,
        candidate_input: dict[str, Any],
        expected_request_revision: int,
        expected_profile_revision: int,
        expected_pending_proposal_id: str | None = None,
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(request_id)
        if expected_pending_proposal_id is not None:
            _late("_safe_session_id")(expected_pending_proposal_id)
        _late("_validated_candidate")(candidate_input)
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._ensure_extraction_requests_file_locked()
            self._roll_forward_extraction_locked()
            requests_document = self._load_extraction_requests_document()
            request = requests_document["requests"].get(request_id)
            if request is None:
                raise StoreError("resume extraction request does not exist")
            if request["revision"] != expected_request_revision:
                raise StoreError("request revision conflict")
            if request["status"] != "requested":
                raise StoreError("resume extraction request is not open")
            resume = self._load_resumes_document()["resumes"].get(request["resumeId"])
            if resume is None or resume.get("deletedAt") is not None:
                raise StoreError("resume does not exist")
            if resume.get("storageKind") != "managed":
                raise StoreError("resume must be adopted before extraction")
            if resume.get("contentRevision") != request["resumeContentRevision"]:
                raise StoreError("resume content revision conflict")
            observation = self._managed_resume_observation(resume)
            if not observation["exists"] or observation.get("digest") != resume["digest"]:
                raise StoreError("resume file is not ready for extraction")
            profile_document = self._load_profile_document()
            if profile_document["metadata"].get("revision", 1) != expected_profile_revision:
                raise StoreError("profile revision conflict")
            proposals_document = self._load_extractions_document()
            profile_document, proposals_document, proposal = (
                self._create_resume_proposal_locked(
                    resume, candidate_input, profile_document, proposals_document,
                    expected_pending_proposal_id, bind_content_revision=True,
                )
            )
            completed = self._close_resume_extraction_request_locked(
                requests_document, request_id, expected_request_revision,
                "completed", proposal_id=proposal["id"],
            )
            self._commit_extraction_operation_locked(
                "request-complete", profile_document, proposals_document,
                requests_document,
            )
            return {
                "request": completed,
                "proposalSummary": {
                    "id": proposal["id"],
                    "status": proposal["status"],
                    "revision": proposal["revision"],
                    "autoFilledCount": len(proposal["autoFilledPaths"]),
                    "pendingCount": len(proposal["pendingPaths"]),
                },
            }

    def get_resume_proposal(self, proposal_id: str) -> dict[str, Any] | None:
        self.initialize()
        _late("_safe_session_id")(proposal_id)
        if not self.resume_extractions_path.exists():
            return None
        proposal = self._load_extractions_document()["proposals"].get(proposal_id)
        return self._proposal_result(proposal) if proposal is not None else None

    def list_resume_proposals(
        self, resume_id: str | None = None, status: str | None = None,
        *, summary_only: bool = False,
    ) -> list[dict[str, Any]]:
        self.initialize()
        if resume_id is not None:
            _late("_safe_session_id")(resume_id)
        if status is not None and status not in EXTRACTION_STATUSES:
            raise StoreError("resume proposal status is unsupported")
        if not self.resume_extractions_path.exists():
            return []
        proposals = [
            proposal
            for proposal in self._load_extractions_document()["proposals"].values()
            if (resume_id is None or proposal["resumeId"] == resume_id)
            and (status is None or proposal["status"] == status)
        ]
        proposals.sort(key=lambda item: (item["createdAt"], item["id"]))
        projection = self._proposal_summary if summary_only else self._proposal_result
        return [projection(proposal) for proposal in proposals]

    def review_resume_proposal(
        self,
        proposal_id: str,
        decisions_input: dict[str, Any],
        expected_revision: int,
        expected_profile_revision: int,
    ) -> dict[str, Any]:
        self.initialize()
        _late("_safe_session_id")(proposal_id)
        decisions_object = _late("_require_object")(
            decisions_input.get("decisions"), "proposal decisions"
        )
        confirmations = _late("_require_object")(
            decisions_input.get("replacementConfirmations", {}),
            "proposal replacement confirmations",
        )
        if set(decisions_input) - {"decisions", "replacementConfirmations"} or not decisions_object:
            raise StoreError("proposal review must contain decisions")
        if any(
            not isinstance(path, str) or decision not in EXTRACTION_DECISIONS
            for path, decision in decisions_object.items()
        ):
            raise StoreError("proposal review decision is unsupported")
        with _late("exclusive_file_lock")(self.store_lock_path):
            self._ensure_extraction_files_locked()
            self._roll_forward_extraction_locked()
            proposals_document = self._load_extractions_document()
            current = proposals_document["proposals"].get(proposal_id)
            if current is None:
                raise StoreError("resume proposal does not exist")
            if current["revision"] != expected_revision:
                raise StoreError("resume proposal revision conflict")
            if current["status"] != "pending":
                raise StoreError("resume proposal is not pending")
            if self._proposal_stale_reasons(current):
                raise StoreError("resume proposal is stale")
            if not set(decisions_object) <= set(current["pendingPaths"]):
                raise StoreError("proposal review path is not pending")
            profile_document = self._load_profile_document()
            profile_revision = profile_document["metadata"].get("revision", 1)
            if profile_revision != expected_profile_revision:
                raise StoreError("profile revision conflict")
            for path in decisions_object:
                if not _late("_json_values_equal")(
                    _late("_pointer_baseline")(profile_document["profile"], path),
                    current["baselines"][path],
                ):
                    raise StoreError("proposal review baseline changed")
            required_confirmations = {}
            for path, decision in decisions_object.items():
                if decision != "use_extracted":
                    continue
                replacement = _late("_replacement_scope")(current["baselines"][path])
                if replacement is not None:
                    required_confirmations[path] = replacement["path"]
            if confirmations != required_confirmations:
                raise StoreError("proposal review replacement confirmation is required")
            now = _late("utc_now")()
            profile = _late("copy").deepcopy(profile_document["profile"])
            accepted: list[str] = []
            for path, decision in decisions_object.items():
                if decision == "use_extracted":
                    _exists, extracted = _late("_pointer_lookup")(current["candidate"], path)
                    _late("_set_pointer_value")(
                        profile, path, extracted, replace_ancestors=True
                    )
                    accepted.append(path)
            result_profile_revision = profile_revision
            if accepted:
                metadata = dict(profile_document["metadata"])
                metadata["revision"] = profile_revision + 1
                metadata["updatedAt"] = now
                metadata["factProvenance"] = self._stamp_fact_provenance(
                    dict(metadata.get("factProvenance", {})), accepted, "user", now,
                    profile_document["profile"],
                )
                profile_document = {
                    "schemaVersion": SCHEMA_VERSION,
                    "profile": profile,
                    "metadata": metadata,
                }
                result_profile_revision = metadata["revision"]
            remaining = [
                path for path in current["pendingPaths"] if path not in decisions_object
            ]
            baselines = dict(current["baselines"])
            for path in remaining:
                baselines[path] = _late("_pointer_baseline")(profile, path)
            decisions = dict(current["decisions"])
            decisions.update({
                path: {"decision": decision, "decidedAt": now}
                for path, decision in decisions_object.items()
            })
            updated = dict(current)
            updated.update({
                "pendingPaths": remaining,
                "baselines": baselines,
                "decisions": decisions,
                "status": "pending" if remaining else "completed",
                "resultProfileRevision": result_profile_revision,
                "revision": current["revision"] + 1,
                "updatedAt": now,
            })
            _late("_validate_extraction_proposal")(proposal_id, updated)
            proposals_document["proposals"][proposal_id] = updated
            proposals_document["metadata"]["updatedAt"] = now
            _late("_validate_extractions_document")(proposals_document)
            self._commit_extraction_operation_locked(
                "review", profile_document, proposals_document
            )
            return self._proposal_result(updated)
