"""Static assets and read-only workspace API routes."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from . import ASSETS, ASSET_ROOT, runtime
from .projections import (
    public_extraction_request,
    public_proposal_detail,
    public_proposal_summary,
    public_resumes,
    resume_projection,
    unified_trash_projection,
)


class QueryMixin:
    """Read-only routes over the public Store API."""

    def _asset(self, path: str) -> None:
        asset = ASSETS.get(path)
        if asset is None:
            self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")
            return
        try:
            body = (ASSET_ROOT / asset[0]).read_bytes()
        except OSError:
            self._error(
                HTTPStatus.INTERNAL_SERVER_ERROR,
                "workspace asset is unavailable",
            )
            return
        self._send_bytes(HTTPStatus.OK, body, asset[1])

    def do_HEAD(self) -> None:
        path = self._path()
        if path is None or not self._valid_host():
            return
        self._asset(path)

    def do_GET(self) -> None:
        path = self._path()
        if path is None:
            return
        if path.startswith("/api/"):
            if self._authorized_api():
                self._get_api(path)
            return
        if self._valid_host():
            self._asset(path)

    def _get_api(self, path: str) -> None:
        if path == "/api/boot":
            self._json(HTTPStatus.OK, self.server.boot_status)
            return
        if self.server.boot_status["status"] != "ready":
            self._error(
                HTTPStatus.SERVICE_UNAVAILABLE,
                "canonical store is unavailable",
                "store_unavailable",
            )
            return
        store = self.server.store
        exact = {
            "/api/overview": store.owner_beta_overview,
            "/api/profile": store.inspect_profile,
            "/api/account-operation": store.account_operation_status,
            "/api/attention": store.list_needs_attention,
            "/api/profile-preparedness": store.profile_preparedness,
            "/api/answers/cleanup-preview": store.preview_answer_cleanup,
        }
        if path in exact:
            self._store_call(exact[path])
            return
        if path == "/api/automation":
            self._store_call(lambda: {
                "settings": store.get_automation_settings(companion=True),
                "capability": store.automation_capability(),
                "accounts": store.list_employer_accounts(companion=True),
                "profileRevision": store.inspect_profile()["revision"],
            })
            return
        if path == "/api/fact-groups":
            self._store_call(lambda: {"groups": store.list_fact_groups()})
            return
        if path == "/api/state":
            self._store_call(lambda: {
                "jobs": store.list_jobs(),
                "resumes": public_resumes(store.list_resumes()),
            })
            return
        if path == "/api/jobs":
            self._store_call(lambda: {"jobs": store.list_jobs()})
            return
        if path == "/api/trash":
            self._store_call(lambda: unified_trash_projection(store))
            return
        if path == "/api/resumes":
            self._store_call(lambda: {"resumes": self._resume_list(False)})
            return
        if path == "/api/resumes/trash":
            self._store_call(lambda: {"resumes": self._resume_list(True)})
            return
        if path == "/api/resume-extraction-requests":
            self._store_call(lambda: {
                "requests": [
                    public_extraction_request(item)
                    for item in store.list_resume_extraction_requests()
                ]
            })
            return
        if path == "/api/resume-proposals":
            self._store_call(lambda: {
                "proposals": [
                    public_proposal_summary(item)
                    for item in store.list_resume_proposals()
                ]
            })
            return
        if path == "/api/answers":
            self._store_call(store.query_answers)
            return
        self._get_detail(path)

    def _get_detail(self, path: str) -> None:
        store = self.server.store
        store_module = runtime()["STORE_MODULE"]
        parts = path.split("/")
        if len(parts) == 4 and parts[1:3] == ["api", "trusted-fill"]:
            self._store_call(lambda: store.trusted_fill_status(parts[3], public=True))
            return
        if len(parts) == 4 and parts[1:3] == ["api", "employer-accounts"]:
            def employer_account_detail() -> dict[str, Any]:
                account = store.get_employer_account(parts[3], public=True)
                if account is None:
                    raise store_module.StoreError("employer account does not exist")
                return account
            self._store_call(employer_account_detail)
            return
        if len(parts) == 4 and parts[1:3] == ["api", "fact-groups"]:
            def fact_group_detail() -> dict[str, Any]:
                group = store.get_fact_group(parts[3])
                if group is None:
                    raise store_module.StoreError("fact group does not exist")
                return group
            self._store_call(fact_group_detail)
            return
        if len(parts) == 5 and parts[1:4] == ["api", "answers", "by-key"]:
            def encoded_answer_detail() -> dict[str, Any]:
                answer = store.get_answer(
                    self._encoded_answer_key(parts[4]), include_trashed=True
                )
                if answer is None:
                    raise store_module.StoreError("answer does not exist")
                return answer
            self._store_call(encoded_answer_detail)
            return
        if (
            len(parts) == 6
            and parts[1:3] == ["api", "jobs"]
            and parts[4] == "pending-answers"
        ):
            self._store_call(lambda: store.pending_answer_detail(parts[3], parts[5]))
            return
        if len(parts) == 4 and parts[1:3] == ["api", "answers"]:
            def answer_detail() -> dict[str, Any]:
                answer = store.get_answer(
                    self._answer_key(parts[3]), include_trashed=True
                )
                if answer is None:
                    raise store_module.StoreError("answer does not exist")
                return answer
            self._store_call(answer_detail)
            return
        if len(parts) == 4 and parts[1:3] == ["api", "resumes"]:
            self._store_call(lambda: self._resume_projection(parts[3]))
            return
        if (
            len(parts) == 5
            and parts[1:3] == ["api", "resumes"]
            and parts[4] == "content"
        ):
            self._send_resume_content(parts[3])
            return
        if len(parts) == 4 and parts[1:3] == ["api", "resume-proposals"]:
            self._store_call(lambda: self._proposal_detail(parts[3]))
            return
        if len(parts) == 4 and parts[1:3] == ["api", "jobs"]:
            self._store_call(lambda: self._require_job(parts[3]))
            return
        if len(parts) == 5 and parts[1:3] == ["api", "jobs"]:
            if parts[4] == "activity":
                self._store_call(lambda: store.get_job_activity(parts[3]))
                return
            if parts[4] == "preflight":
                self._store_call(lambda: store.preflight_job(parts[3]))
                return
        self._error(HTTPStatus.NOT_FOUND, "route not found", "not_found")

    def _require_job(
        self, job_id: str, include_trashed: bool = False
    ) -> dict[str, Any]:
        job = self.server.store.get_job(job_id, include_trashed=include_trashed)
        if job is None:
            raise runtime()["STORE_MODULE"].StoreError("job does not exist")
        return job

    def _require_resume(
        self, resume_id: str, include_trashed: bool = False
    ) -> dict[str, Any]:
        resume = self.server.store.get_resume(
            resume_id, include_trashed=include_trashed
        )
        if resume is None:
            raise runtime()["STORE_MODULE"].StoreError("resume does not exist")
        return resume

    def _resume_list(self, trashed: bool) -> list[dict[str, Any]]:
        store = self.server.store
        jobs = store.list_jobs(include_trashed=True)
        proposals = store.list_resume_proposals()
        records = store.list_resumes(include_trashed=trashed)
        requests = store.list_resume_extraction_requests()
        if trashed:
            records = [item for item in records if item.get("deletedAt") is not None]
        return [resume_projection(item, jobs, proposals, requests) for item in records]

    def _resume_projection(self, resume_id: str) -> dict[str, Any]:
        store = self.server.store
        return resume_projection(
            self._require_resume(resume_id, True),
            store.list_jobs(include_trashed=True),
            store.list_resume_proposals(resume_id=resume_id),
            store.list_resume_extraction_requests(resume_id=resume_id),
        )

    def _proposal_detail(self, proposal_id: str) -> dict[str, Any]:
        proposal = self.server.store.get_resume_proposal(proposal_id)
        if proposal is None:
            raise runtime()["STORE_MODULE"].StoreError(
                "resume proposal does not exist"
            )
        return public_proposal_detail(
            proposal, self.server.store.inspect_profile()
        )

    def _send_resume_content(self, resume_id: str) -> None:
        store_module = runtime()["STORE_MODULE"]
        try:
            record, content = self.server.store.read_resume_content(resume_id)
        except store_module.StoreError as error:
            message = str(error)
            missing = "does not exist" in message
            self._error(
                HTTPStatus.NOT_FOUND if missing else HTTPStatus.CONFLICT,
                message,
                "not_found" if missing else "content_unavailable",
            )
            return
        extension = {
            value: key for key, value in store_module.RESUME_MEDIA_TYPES.items()
        }[record["mediaType"]]
        disposition = "attachment" if extension == ".docx" else "inline"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", record["mediaType"])
        self.send_header("Content-Length", str(len(content)))
        self.send_header(
            "Content-Disposition",
            f'{disposition}; filename="resume-{resume_id}{extension}"',
        )
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)
