"""Shared Store constants with no implementation dependencies."""

from __future__ import annotations

import re


SCHEMA_VERSION = 1
STORE_ENV = "JOB_APPLY_STORE_DIR"
ANSWER_STATES = {"confirmed", "inferred", "missing", "sensitive"}
ANSWER_REVIEW_STATUSES = {"accepted", "pending", "declined"}
SENSITIVITY_LEVELS = {"none", "personal", "high"}
HISTORY_EVENTS = {
    "started",
    "progressed",
    "reviewed",
    "completed",
    "abandoned",
    "failed",
    "job-started",
    "job-restarted",
    "legacy-review-rebuild",
    "claim-recovered",
    "job-blocked",
}
HISTORY_EVENT_IDENTIFIER = re.compile(r"^[a-z][a-z0-9-]{0,63}$", re.ASCII)
SESSION_STATUSES = {"active", "review", "completed", "abandoned"}
ATTENTION_BLOCKER_TYPES = {
    "readiness", "information", "upload", "validation", "browser_handoff",
    "owner_review", "final_action",
}
READINESS_EVIDENCE_KINDS = {
    "agent_attested_current_attempt", "repository_replay",
}
BROWSER_HANDOFF_STATES = {"not_required", "required", "ready_for_owner", "complete"}
READINESS_BLOCKER_CODES = {
    "readiness-evidence-stale", "form-observation-inaccessible",
    "required-control-evidence-missing", "required-upload-missing",
    "required-upload-rejected", "required-control-rejected",
    "required-control-unresolved", "required-control-inaccessible",
    "required-control-incomplete", "validation-error-present",
    "final-action-activated", "final-control-inaccessible",
    "final-control-unavailable", "external-upload-capability-unavailable",
}
AGENT_BLOCKER_CODES = {
    "login-required", "captcha-required", "mfa-required",
    "email-verification-required",
    "consent-required", "account-creation-required", "unsupported-control",
    "owner-input-required", "browser-state-uncertain",
}
AGENT_BLOCKER_TYPE_BY_CODE = {
    "login-required": "browser_handoff",
    "captcha-required": "browser_handoff",
    "mfa-required": "browser_handoff",
    "email-verification-required": "browser_handoff",
    "account-creation-required": "browser_handoff",
    "unsupported-control": "browser_handoff",
    "browser-state-uncertain": "browser_handoff",
    "consent-required": "owner_review",
    "owner-input-required": "information",
}
ATTENTION_BLOCKER_CODES = (
    READINESS_BLOCKER_CODES
    | AGENT_BLOCKER_CODES
    | {"answer-required", "sensitive-answer-required", "owner-upload-required"}
)
BROWSER_HANDOFF_REASON_CODES = (
    AGENT_BLOCKER_CODES
    | {
        "none", "owner-upload-required", "final-review-required",
        "form-observation-inaccessible", "required-control-inaccessible",
    }
)
APPROVAL_POLICY_MODES = {"strict", "bounded_loose"}
APPROVAL_USE_AUTHORITIES = {"none", "accepted_record", "per_use", "bounded_policy"}
READINESS_ASSERTION_NAMES = {
    "observation-current", "adapter-accessible", "required-controls-complete",
    "required-uploads-accepted", "validation-clear", "final-control-available",
    "final-action-untouched",
}
JOB_STATUSES = {
    "saved",
    "needs_info",
    "ready",
    "in_progress",
    "awaiting_review",
    "applied",
    "closed",
}
JOB_CLOSED_OUTCOMES = {
    "rejected",
    "withdrawn",
    "expired",
    "duplicate",
    "not_interested",
}
JOB_ORIGINS = {"human", "agent"}
JOB_PROVENANCE_ORIGINS = JOB_ORIGINS | {"migration"}
JOB_INGEST_FIELDS = {
    "url",
    "source",
    "sourceId",
    "role",
    "company",
    "location",
    "workplaceType",
    "employmentType",
    "compensation",
    "description",
    "ats",
    "priority",
    "notes",
    "lastCheckedAt",
}
JOB_TRANSITIONS = {
    "saved": {"needs_info", "ready", "closed"},
    "needs_info": {"saved", "ready", "in_progress", "closed"},
    "ready": {"saved", "needs_info", "in_progress", "closed"},
    "in_progress": {"needs_info", "awaiting_review", "closed"},
    "awaiting_review": {"in_progress", "applied", "closed"},
    "applied": {"closed"},
    "closed": {"saved"},
}
FACT_SOURCES = {"user", "resume", "agent", "migration"}
FACT_GROUP_ID = re.compile(r"^[a-f0-9]{32}$")
FACT_GROUP_MAX_PATHS = 128
PROFILE_NAMED_TOP_LEVEL = {
    "firstName", "lastName", "email", "phone", "location", "linkedInUrl",
    "portfolioUrl", "githubUrl", "workHistory", "education", "skills", "preferences",
}
REPLAY_TRANSITIONS = {"started", "reviewed"}
REPLAY_ATS = {"ashby", "greenhouse", "lever", "linkedin-easy-apply"}
SESSION_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
PENDING_REFERENCE = re.compile(r"^pending_[a-f0-9]{32}$")
LEGACY_PENDING_FIELD_KEYS = frozenset({"question", "state", "answerKey", "sensitive"})
_ATS_UNSET = object()
CLAIM_LEASE_SECONDS = 300
CLAIM_HEARTBEAT_SECONDS = 60
OVERVIEW_DIGEST_CACHE_SECONDS = 30
LEGACY_SEARCH_ROOT = ".claude-job-searches"
LEGACY_SEARCH_MAX_FILES = 100
LEGACY_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024
LEGACY_SEARCH_MAX_TOTAL_BYTES = 20 * 1024 * 1024
LEGACY_SEARCH_MAX_ENTRIES = 5_000
RESUME_MAX_BYTES = 10 * 1024 * 1024
UPLOAD_RECOVERY_GRACE_SECONDS = 5 * 60
RESUME_MEDIA_TYPES = {
    ".pdf": "application/pdf",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".txt": "text/plain; charset=utf-8",
}
EXTRACTION_MAX_BYTES = 256 * 1024
EXTRACTION_MAX_DEPTH = 12
EXTRACTION_MAX_LEAVES = 512
EXTRACTION_MAX_STRING = 32 * 1024
EXTRACTION_STATUSES = {"pending", "completed", "superseded"}
EXTRACTION_DECISIONS = {"use_extracted", "keep_current"}
EXTRACTION_REQUEST_STATUSES = {
    "requested", "completed", "failed", "stale", "cancelled",
}
EXTRACTION_REQUEST_FAILURE_REASONS = {
    "content_unreadable", "unsupported_resume", "extraction_failed",
    "candidate_invalid", "interrupted",
}
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
_MISSING = object()
