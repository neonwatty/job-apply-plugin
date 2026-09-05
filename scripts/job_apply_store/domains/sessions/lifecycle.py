"""Session lifecycle operations composed ahead of the Store facade."""

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
    '_fsync_directory': io._fsync_directory,
    'atomic_write_json': io.atomic_write_json,
    'exclusive_file_lock': io.exclusive_file_lock,
}


class SessionLifecycleMixin:
    """Plain lifecycle mixin with no independent Store state."""

    def save_session(
        self, application_id: str, incoming: dict[str, Any]
    ) -> dict[str, Any]:
        self.initialize()
        with _late('exclusive_file_lock')(self.store_lock_path):
            self._require_generic_session_mutation_allowed_locked(application_id)
            session = self._build_session(application_id, incoming)
            path = self._session_path(application_id)
            _late('atomic_write_json')(path, session)
            return session


    def load_session(self, application_id: str) -> dict[str, Any]:
        self.initialize()
        path = self._session_path(application_id)
        if not path.exists():
            raise StoreError("session does not exist")
        job = (
            self._load_jobs_document()["jobs"].get(application_id)
            if self.jobs_path.exists()
            else None
        )
        return self._read_session_projection(path, application_id, job.get("ats")) \
            if job is not None else self._read_session_projection(path, application_id)


    def list_sessions(self) -> list[dict[str, Any]]:
        self.initialize()
        return self._list_sessions_uninitialized()


    def _list_sessions_uninitialized(self) -> list[dict[str, Any]]:
        sessions: list[dict[str, Any]] = []
        jobs = (
            self._load_jobs_document()["jobs"] if self.jobs_path.exists() else {}
        )
        for path in sorted(self.sessions_path.glob("*.json")):
            job = jobs.get(path.stem)
            session = self._read_session_projection(path, path.stem, job.get("ats")) \
                if job is not None else self._read_session_projection(path, path.stem)
            sessions.append(session)
        return sessions


    def delete_session(self, application_id: str) -> dict[str, Any]:
        self.initialize()
        with _late('exclusive_file_lock')(self.store_lock_path):
            self._require_generic_session_mutation_allowed_locked(
                application_id, allow_terminal_delete=True
            )
            path = self._session_path(application_id)
            if not path.exists():
                return {"deleted": False, "applicationId": application_id}
            path.unlink()
            _late('_fsync_directory')(self.sessions_path)
            return {"deleted": True, "applicationId": application_id}


    def _require_generic_session_mutation_allowed_locked(
        self, application_id: str, allow_terminal_delete: bool = False
    ) -> None:
        job = self._load_jobs_document()["jobs"].get(application_id)
        if (
            job is not None
            and job.get("deletedAt") is None
            and not (
                allow_terminal_delete and job.get("status") in {"applied", "closed"}
            )
        ):
            raise StoreError("canonical job sessions require a coordinator operation")
