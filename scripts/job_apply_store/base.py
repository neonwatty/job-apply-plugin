"""Constructor, path layout, and clock state shared by the Store facade."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .constants import SCHEMA_VERSION
from .errors import StoreError


class StoreBase:
    """State-only base; initialization and domain orchestration stay in the facade."""

    _runtime_provider = staticmethod(lambda: {"Path": Path})

    def __init__(self, root: Path, legacy_profile: Path | None = None, clock=None):
        runtime = self._runtime_provider()
        path_type = runtime.get("Path", Path)
        self.root = root.expanduser()
        self.profile_path = self.root / "profile.json"
        self.fact_groups_path = self.root / "fact-groups.json"
        self.answers_path = self.root / "answers.json"
        self.jobs_path = self.root / "jobs.json"
        self.resumes_path = self.root / "resumes.json"
        self.resume_files_path = self.root / "resume-files"
        self.resume_extractions_path = self.root / "resume-extractions.json"
        self.resume_extraction_requests_path = self.root / "resume-extraction-requests.json"
        self.resume_extraction_journal_path = self.root / "resume-extraction-journal.json"
        self.history_path = self.root / "applications.jsonl"
        self.sessions_path = self.root / "sessions"
        self.coordinator_path = self.root / "coordinator.json"
        self.coordinator_journal_path = self.root / "coordinator-journal.json"
        self.automation_settings_path = self.root / "automation-settings.json"
        self.employer_accounts_path = self.root / "employer-accounts.json"
        self.account_operation_journal_path = self.root / "account-operation-journal.json"
        self.trusted_fill_path = self.root / "trusted-fill.json"
        self.store_lock_path = self.root / ".store.lock"
        self.auto_submit_policy_path = self.root / "auto-submit"
        self.legacy_profile = (
            legacy_profile.expanduser()
            if legacy_profile is not None
            else path_type.home() / ".claude-job-profile.json"
        )
        self.clock = clock or (lambda: datetime.now(timezone.utc))
        self._overview_resume_digest_cache: dict[str, dict[str, Any]] = {}

    def _now_datetime(self) -> datetime:
        value = self.clock()
        if not isinstance(value, datetime):
            raise StoreError("coordinator clock returned an invalid value")
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    def _now(self) -> str:
        return self._now_datetime().isoformat(timespec="seconds").replace("+00:00", "Z")

    def paths(self) -> dict[str, Any]:
        return {
            "schemaVersion": SCHEMA_VERSION,
            "root": str(self.root),
            "profile": str(self.profile_path),
            "factGroups": str(self.fact_groups_path),
            "answers": str(self.answers_path),
            "jobs": str(self.jobs_path),
            "resumes": str(self.resumes_path),
            "resumeExtractionRequests": str(self.resume_extraction_requests_path),
            "history": str(self.history_path),
            "sessions": str(self.sessions_path),
            "coordinator": str(self.coordinator_path),
            "coordinatorJournal": str(self.coordinator_journal_path),
            "automationSettings": str(self.automation_settings_path),
            "employerAccounts": str(self.employer_accounts_path),
            "accountOperationJournal": str(self.account_operation_journal_path),
            "trustedFill": str(self.trusted_fill_path),
            "autoSubmitPolicy": str(self.auto_submit_policy_path),
            "legacyProfile": str(self.legacy_profile),
        }
