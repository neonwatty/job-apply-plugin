"""Resume, extraction-request, and proposal mutation routes."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from ..projections import (
    public_extraction_request,
    public_proposal_summary,
    public_resume,
)


class ResumeMutationMixin:
    def _mutate_resumes(
        self,
        method: str,
        path: str,
        parts: list[str],
        payload: dict[str, Any],
        filename: str | None,
        content: bytes | None,
    ) -> bool:
        store = self.server.store
        if method == "POST" and path == "/api/resumes/import":
            self._store_call(lambda: public_resume(
                store.create_resume_bytes(payload, filename, content)
            ))
            return True
        if method == "POST" and path == "/api/resume-extraction-requests":
            if set(payload) != {"resumeId", "expectedResumeRevision"} or not isinstance(
                payload.get("resumeId"), str
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body must contain only resumeId and expectedResumeRevision",
                )
                return True
            expected = payload.get("expectedResumeRevision")
            if not isinstance(expected, int) or isinstance(expected, bool) or expected < 1:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "expectedResumeRevision must be a positive integer",
                )
            else:
                self._store_call(lambda: public_extraction_request(
                    store.create_resume_extraction_request(payload["resumeId"], expected)
                ))
            return True
        if (
            method == "POST"
            and len(parts) == 5
            and parts[1:3] == ["api", "resume-extraction-requests"]
            and parts[4] in {"cancel", "retry"}
        ):
            action = parts[4]
            required = (
                {"expectedRevision"}
                if action == "cancel"
                else {"expectedRevision", "expectedResumeRevision"}
            )
            if set(payload) != required:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    f"{action} body has unsupported fields",
                )
                return True
            revision = self._expected_revision(payload)
            if revision is None:
                return True
            if action == "cancel":
                self._store_call(lambda: public_extraction_request(
                    store.cancel_resume_extraction_request(parts[3], revision)
                ))
                return True
            resume_revision = payload.get("expectedResumeRevision")
            if (
                not isinstance(resume_revision, int)
                or isinstance(resume_revision, bool)
                or resume_revision < 1
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "expectedResumeRevision must be a positive integer",
                )
            else:
                self._store_call(lambda: public_extraction_request(
                    store.retry_resume_extraction_request(
                        parts[3], revision, resume_revision
                    )
                ))
            return True
        if len(parts) == 4 and parts[1:3] == ["api", "resumes"] and method == "PATCH":
            if (
                set(payload) != {"patch", "expectedRevision"}
                or not isinstance(payload.get("patch"), dict)
                or not payload["patch"]
                or set(payload["patch"]) - {"label", "tags"}
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision"
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(lambda: public_resume(
                    store.update_resume(parts[3], payload["patch"], revision)
                ))
            return True
        if len(parts) == 5 and parts[1:3] == ["api", "resumes"]:
            resume_id, action = parts[3], parts[4]
            if action in {"replace", "adopt"} and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(
                        HTTPStatus.BAD_REQUEST,
                        f"{action} metadata requires expectedRevision",
                    )
                    return True
                revision = self._expected_revision(payload)
                if revision is not None:
                    operation = (
                        store.update_resume_bytes
                        if action == "replace"
                        else store.adopt_resume_bytes
                    )
                    self._store_call(lambda: public_resume(
                        operation(resume_id, filename, content, revision)
                    ))
                return True
            if action in {"default", "trash", "restore", "delete"} and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(
                        HTTPStatus.BAD_REQUEST,
                        f"{action} body requires expectedRevision",
                    )
                    return True
                revision = self._expected_revision(payload)
                if revision is not None:
                    operations = {
                        "default": store.set_default_resume,
                        "trash": store.trash_resume,
                        "restore": store.restore_resume,
                        "delete": store.delete_resume,
                    }
                    self._lifecycle_call(
                        "resume",
                        action,
                        resume_id,
                        lambda: operations[action](resume_id, revision),
                        public_resume,
                    )
                return True
        if (
            len(parts) == 5
            and parts[1:3] == ["api", "resume-proposals"]
            and parts[4] == "review"
            and method == "POST"
        ):
            allowed = {
                "decisions", "replacementConfirmations", "expectedRevision",
                "expectedProfileRevision",
            }
            if (
                set(payload) - allowed
                or not {"decisions", "expectedRevision", "expectedProfileRevision"}
                <= set(payload)
                or not isinstance(payload.get("decisions"), dict)
                or not isinstance(payload.get("replacementConfirmations", {}), dict)
            ):
                self._error(HTTPStatus.BAD_REQUEST, "review body is invalid")
                return True
            revision = self._expected_revision(payload)
            profile_revision = payload.get("expectedProfileRevision")
            if revision is None:
                return True
            if (
                not isinstance(profile_revision, int)
                or isinstance(profile_revision, bool)
                or profile_revision < 1
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "expectedProfileRevision must be a positive integer",
                )
            else:
                self._store_call(lambda: public_proposal_summary(
                    store.review_resume_proposal(
                        parts[3],
                        {
                            "decisions": payload["decisions"],
                            "replacementConfirmations": payload.get(
                                "replacementConfirmations", {}
                            ),
                        },
                        revision,
                        profile_revision,
                    )
                ))
            return True
        return False
