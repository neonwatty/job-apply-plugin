"""Job creation, approval, transitions, and lifecycle routes."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

from .. import MAX_BULK_URLS, runtime


class JobMutationMixin:
    def _mutate_jobs(
        self, method: str, path: str, parts: list[str], payload: dict[str, Any]
    ) -> bool:
        store = self.server.store
        if method == "POST" and path == "/api/jobs":
            job = payload.get("job")
            if not isinstance(job, dict) or set(payload) != {"job"}:
                self._error(
                    HTTPStatus.BAD_REQUEST, "body must contain only a job object"
                )
            else:
                self._store_call(lambda: store.create_job(job, origin="human"))
            return True
        if method == "POST" and path == "/api/jobs/bulk":
            self._bulk_create(payload)
            return True
        if (
            method == "POST"
            and len(parts) == 5
            and parts[1:3] == ["api", "jobs"]
            and parts[4] == "resolve-pending-answer"
        ):
            required = {
                "reference", "expectedJobRevision", "expectedSessionRevision",
                "expectedAnswerRevision", "ownerConfirmed",
            }
            if set(payload) != required or payload.get("ownerConfirmed") is not True:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "body requires an explicit owner-confirmed exact-revision recheck",
                )
                return True
            revisions = [
                payload.get(name)
                for name in (
                    "expectedJobRevision",
                    "expectedSessionRevision",
                    "expectedAnswerRevision",
                )
            ]
            if any(
                not isinstance(value, int) or isinstance(value, bool) or value < 1
                for value in revisions
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "all expected revisions must be positive integers",
                )
            else:
                self._store_call(lambda: store.resolve_pending_answer(
                    parts[3],
                    payload["reference"],
                    payload["expectedJobRevision"],
                    payload["expectedSessionRevision"],
                    payload["expectedAnswerRevision"],
                    owner_confirmed=True,
                ))
            return True
        if (
            method == "POST"
            and len(parts) == 5
            and parts[1:3] == ["api", "jobs"]
            and parts[4] in {"approval-preview", "approval-approve"}
        ):
            required = {
                "expectedJobRevision", "expectedSessionRevision", "decisions"
            }
            if parts[4] == "approval-approve":
                required |= {"previewToken", "ownerConfirmed"}
            if set(payload) != required or not isinstance(
                payload.get("decisions"), list
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST, "grouped approval body is invalid"
                )
            elif parts[4] == "approval-preview":
                self._store_call(lambda: store.preview_grouped_approval(
                    parts[3],
                    payload["expectedJobRevision"],
                    payload["expectedSessionRevision"],
                    payload["decisions"],
                ))
            elif payload.get("ownerConfirmed") is not True:
                self._error(
                    HTTPStatus.BAD_REQUEST,
                    "grouped approval requires explicit owner confirmation",
                )
            else:
                self._store_call(lambda: store.approve_grouped_approval(
                    parts[3],
                    payload["expectedJobRevision"],
                    payload["expectedSessionRevision"],
                    payload["decisions"],
                    payload["previewToken"],
                    owner_confirmed=True,
                ))
            return True
        if len(parts) == 4 and parts[1:3] == ["api", "jobs"] and method == "PATCH":
            if set(payload) != {"patch", "expectedRevision"} or not isinstance(
                payload.get("patch"), dict
            ):
                self._error(
                    HTTPStatus.BAD_REQUEST, "body requires patch and expectedRevision"
                )
                return True
            revision = self._expected_revision(payload)
            if revision is not None:
                self._store_call(lambda: store.update_job(
                    parts[3], payload["patch"], revision, origin="human"
                ))
            return True
        if len(parts) == 5 and parts[1:3] == ["api", "jobs"]:
            job_id, action = parts[3], parts[4]
            if action == "transition" and method == "POST":
                return self._transition_job(job_id, payload)
            if action in {"trash", "restore", "delete"} and method == "POST":
                if set(payload) != {"expectedRevision"}:
                    self._error(
                        HTTPStatus.BAD_REQUEST,
                        f"{action} body requires expectedRevision",
                    )
                    return True
                revision = self._expected_revision(payload)
                if revision is not None:
                    operations = {
                        "trash": store.trash_job,
                        "restore": store.restore_job,
                        "delete": store.delete_job,
                    }
                    self._lifecycle_call(
                        "job",
                        action,
                        job_id,
                        lambda: operations[action](job_id, revision),
                    )
                return True
        return False

    def _transition_job(self, job_id: str, payload: dict[str, Any]) -> bool:
        allowed = {"status", "expectedRevision", "closedOutcome", "userConfirmed"}
        if set(payload) - allowed or not {"status", "expectedRevision"} <= set(payload):
            self._error(HTTPStatus.BAD_REQUEST, "transition body is invalid")
            return True
        if not isinstance(payload["status"], str):
            self._error(
                HTTPStatus.BAD_REQUEST, "transition status must be a string"
            )
            return True
        if "closedOutcome" in payload and payload["closedOutcome"] is not None and not isinstance(payload["closedOutcome"], str):
            self._error(
                HTTPStatus.BAD_REQUEST, "closedOutcome must be a string or null"
            )
            return True
        if "userConfirmed" in payload and not isinstance(payload["userConfirmed"], bool):
            self._error(
                HTTPStatus.BAD_REQUEST, "userConfirmed must be a boolean"
            )
            return True
        revision = self._expected_revision(payload)
        if revision is not None:
            self._store_call(lambda: self.server.store.transition_job(
                job_id,
                payload["status"],
                revision,
                closed_outcome=payload.get("closedOutcome"),
                user_confirmed=payload.get("userConfirmed") is True,
            ))
        return True

    def _bulk_create(self, payload: dict[str, Any]) -> None:
        urls = payload.get("urls")
        if (
            set(payload) != {"urls"}
            or not isinstance(urls, list)
            or not urls
            or len(urls) > MAX_BULK_URLS
        ):
            self._error(
                HTTPStatus.BAD_REQUEST,
                f"urls must contain 1 to {MAX_BULK_URLS} items",
            )
            return
        store_module = runtime()["STORE_MODULE"]
        results = []
        for index, url in enumerate(urls):
            try:
                if not isinstance(url, str):
                    raise store_module.StoreError("job URL must be a string")
                job = self.server.store.create_job({"url": url}, origin="human")
                results.append(
                    {"index": index, "url": url, "ok": True, "job": job}
                )
            except (store_module.StoreError, OSError) as error:
                results.append(
                    {"index": index, "url": url, "ok": False, "error": str(error)}
                )
        self._json(HTTPStatus.OK, {"results": results})
