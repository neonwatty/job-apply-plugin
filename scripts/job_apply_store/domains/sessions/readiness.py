"""Session readiness operations composed ahead of the Store facade."""

from __future__ import annotations

import copy
import hmac
import json
import re
import uuid
from pathlib import Path
from typing import Any

from ... import constants, io, normalization, sessions_runtime
from ...constants import _ATS_UNSET
from ...errors import StoreError
from ...validation import sessions


_RUNTIME_PROVIDER = lambda: {}


def _bind_runtime(provider) -> None:
    """Bind this root-local leaf to its facade's late-bound collaborators."""
    global _RUNTIME_PROVIDER
    _RUNTIME_PROVIDER = provider


def _late(name: str):
    runtime = _RUNTIME_PROVIDER()
    if name in runtime:
        return runtime[name]
    if name in {"ANSWER_MATCH_MODULE", "FORM_READINESS_MODULE"}:
        return sessions_runtime.companion({
            "ANSWER_MATCH_MODULE": "job_apply_answer_match",
            "FORM_READINESS_MODULE": "job_apply_form_readiness",
        }[name])
    return _CANONICAL[name]


_CANONICAL = {
    'Path': Path,
    'READINESS_EVIDENCE_KINDS': constants.READINESS_EVIDENCE_KINDS,
    '__file__': str(sessions_runtime.SCRIPT_PATH),
    '_canonical_json': normalization._canonical_json,
    '_meaningfully_present': sessions_runtime._meaningfully_present,
    '_require_object': io.require_object,
    'exclusive_file_lock': io.exclusive_file_lock,
    'hmac': hmac,
    're': re,
    'read_json_object': io.read_json_object,
}


class SessionReadinessMixin:
    """Plain readiness mixin with no independent Store state."""

    def profile_preparedness(self) -> dict[str, Any]:
        """Project value-free setup, coverage, and review state from Store data."""
        self.initialize()
        with _late('exclusive_file_lock')(self.store_lock_path):
            profile_document = self._load_profile_document()
            profile = profile_document["profile"]
            provenance = profile_document["metadata"].get("factProvenance", {})
            resumes = self._load_resumes_document()["resumes"]
            default_resume = next((
                item for item in resumes.values()
                if item.get("default") and item.get("deletedAt") is None
            ), None)

            essential_setup = []
            for item_id, key in (
                ("first_name", "firstName"),
                ("last_name", "lastName"),
                ("email", "email"),
            ):
                present = _late('_meaningfully_present')(profile.get(key))
                essential_setup.append({
                    "id": item_id,
                    "paths": [f"/{key}"],
                    "state": "present" if present else "blocked",
                    "reasonCode": None if present else f"{item_id}_missing",
                })

            resume_item: dict[str, Any] = {
                "id": "default_resume", "state": "blocked",
                "reasonCode": "default_resume_missing",
            }
            if default_resume is not None:
                resume_item["resumeId"] = default_resume["id"]
                if default_resume.get("storageKind") != "managed":
                    resume_item["reasonCode"] = "default_resume_unreadable"
                else:
                    observation = self._managed_resume_observation(default_resume)
                    if not observation["exists"]:
                        resume_item["reasonCode"] = "default_resume_unreadable"
                    elif observation.get("digest") != default_resume.get("digest"):
                        resume_item["reasonCode"] = "default_resume_changed"
                    else:
                        resume_item.update({"state": "present", "reasonCode": None})
            essential_setup.append(resume_item)

            coverage_groups = (
                ("phone", ("phone",)),
                ("location", ("location",)),
                ("work_history", ("workHistory",)),
                ("education", ("education",)),
                ("skills", ("skills",)),
                ("professional_links", ("linkedInUrl", "portfolioUrl", "githubUrl")),
            )
            common_coverage = []
            for item_id, keys in coverage_groups:
                present = any(_late('_meaningfully_present')(profile.get(key)) for key in keys)
                common_coverage.append({
                    "id": item_id,
                    "paths": [f"/{key}" for key in keys],
                    "state": "present" if present else "not_present",
                    "reasonCode": None if present else f"{item_id}_missing",
                })

            requests = (
                self._load_extraction_requests_document()["requests"].values()
                if self.resume_extraction_requests_path.exists() else []
            )
            review_health: list[dict[str, Any]] = []
            for request in requests:
                status = request["status"]
                if status not in {"requested", "failed", "stale"}:
                    continue
                item = {
                    "kind": "extraction_request",
                    "reasonCode": {
                        "requested": "extraction_requested",
                        "failed": "extraction_failed",
                        "stale": "extraction_stale",
                    }[status],
                    "resumeId": request["resumeId"],
                    "requestId": request["requestId"],
                }
                if status == "failed":
                    item["failureReason"] = request["failureReason"]
                review_health.append(item)

            proposals = (
                self._load_extractions_document()["proposals"].values()
                if self.resume_extractions_path.exists() else []
            )
            for proposal in proposals:
                if proposal["status"] != "pending" or not proposal["pendingPaths"]:
                    continue
                review_health.append({
                    "kind": "resume_proposal",
                    "reasonCode": "unresolved_conflicts",
                    "resumeId": proposal["resumeId"],
                    "proposalId": proposal["id"],
                    "count": len(proposal["pendingPaths"]),
                })
                protected_count = sum(
                    self._user_protects_path(provenance, path)
                    for path in proposal["pendingPaths"]
                )
                if protected_count:
                    review_health.append({
                        "kind": "resume_proposal",
                        "reasonCode": "human_protected_facts_retained",
                        "resumeId": proposal["resumeId"],
                        "proposalId": proposal["id"],
                        "count": protected_count,
                    })
            review_health.sort(key=lambda item: (
                item["kind"], item["reasonCode"],
                item.get("requestId", item.get("proposalId", "")),
            ))
            return {
                "essentialSetup": essential_setup,
                "commonCoverage": common_coverage,
                "reviewHealth": review_health,
            }


    @staticmethod
    def _readiness_blocker_type(code: str) -> str:
        if "upload" in code:
            return "upload"
        if "validation" in code:
            return "validation"
        if "final" in code:
            return "final_action"
        if "inaccessible" in code or code == "owner-upload-required":
            return "browser_handoff"
        return "readiness"


    def _recompute_readiness(
        self, raw: Any, expected_attempt_revision: int,
        expected_ats: str | None = None,
    ) -> dict[str, Any]:
        packet = _late('_require_object')(raw, "readiness input")
        required = {
            "attemptRevision", "evidenceKind", "fixture", "observation",
            "expectedObservationRevision", "formManifest",
        }
        if set(packet) != required:
            raise StoreError("readiness input contains unsupported fields")
        if packet.get("attemptRevision") != expected_attempt_revision:
            raise StoreError("readiness input is not bound to the current attempt")
        if packet.get("evidenceKind") not in _late('READINESS_EVIDENCE_KINDS'):
            raise StoreError("readiness evidence kind is unsupported")
        try:
            fixture = _late('_require_object')(packet["fixture"], "readiness fixture")
            fixture_id = fixture.get("id")
            if (
                not isinstance(fixture_id, str)
                or _late('re').fullmatch(r"[a-z0-9][a-z0-9-]{0,127}", fixture_id) is None
            ):
                raise StoreError("readiness fixture id is invalid")
            fixture_path = (
                _late('Path')(_late('__file__')).resolve().parent.parent
                / "qa" / "fixtures" / fixture_id / "fixture.json"
            )
            trusted_fixture = _late('read_json_object')(fixture_path, "readiness fixture")
            if not _late('hmac').compare_digest(
                _late('_canonical_json')(fixture), _late('_canonical_json')(trusted_fixture)
            ):
                raise StoreError("readiness fixture is not the bundled definition")
            if (
                isinstance(expected_ats, str)
                and expected_ats
                and fixture.get("platformFamily") != expected_ats
            ):
                raise StoreError("readiness fixture does not match the job ATS")
            steps = fixture.get("steps")
            if (
                not isinstance(steps, list)
                or not any(
                    isinstance(control, dict) and control.get("required") is True
                    for step in steps
                    if isinstance(step, dict)
                    for control in step.get("controls", [])
                    if isinstance(step.get("controls", []), list)
                )
            ):
                raise StoreError(
                    "readiness evidence requires an observed required control"
                )
            _late('FORM_READINESS_MODULE').validate_form_manifest(
                fixture,
                packet["formManifest"],
                expected_observation_revision=packet["expectedObservationRevision"],
            )
            report = _late('FORM_READINESS_MODULE').evaluate_readiness(
                fixture, packet["observation"],
                expected_observation_revision=packet["expectedObservationRevision"],
            )
        except Exception:
            raise StoreError("readiness evidence is invalid") from None
        return {
            "status": report["status"],
            "evidenceKind": packet["evidenceKind"],
            "attemptRevision": expected_attempt_revision,
            "observationRevision": report["observationRevision"],
            "controlSetFingerprint": packet["formManifest"][
                "controlSetFingerprint"
            ],
            "requiredControlCount": len(
                packet["formManifest"]["requiredControlIds"]
            ),
            "assertions": report["assertions"],
            "blockerCodes": report["blockerCodes"],
            "fallbackCode": report["fallbackCode"],
        }
