"""Frozen Store facade inventory and inspection helpers for Task 7."""

from __future__ import annotations

import argparse
import ast
import importlib.util
import inspect
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "job-apply-store.py"

PUBLIC_MODULE_NAMES = {
    "SCHEMA_VERSION", "STORE_ENV", "ANSWER_STATES", "ANSWER_REVIEW_STATUSES",
    "SENSITIVITY_LEVELS", "HISTORY_EVENTS", "HISTORY_EVENT_IDENTIFIER",
    "SESSION_STATUSES", "ATTENTION_BLOCKER_TYPES", "READINESS_EVIDENCE_KINDS",
    "BROWSER_HANDOFF_STATES", "READINESS_BLOCKER_CODES", "AGENT_BLOCKER_CODES",
    "AGENT_BLOCKER_TYPE_BY_CODE", "ATTENTION_BLOCKER_CODES",
    "BROWSER_HANDOFF_REASON_CODES", "APPROVAL_POLICY_MODES",
    "APPROVAL_USE_AUTHORITIES", "READINESS_ASSERTION_NAMES", "JOB_STATUSES",
    "JOB_CLOSED_OUTCOMES", "JOB_ORIGINS", "JOB_PROVENANCE_ORIGINS",
    "JOB_INGEST_FIELDS", "JOB_TRANSITIONS", "FACT_SOURCES", "FACT_GROUP_ID",
    "FACT_GROUP_MAX_PATHS", "PROFILE_NAMED_TOP_LEVEL", "REPLAY_TRANSITIONS",
    "REPLAY_ATS", "SESSION_ID", "PENDING_REFERENCE", "LEGACY_PENDING_FIELD_KEYS",
    "CLAIM_LEASE_SECONDS", "CLAIM_HEARTBEAT_SECONDS",
    "OVERVIEW_DIGEST_CACHE_SECONDS", "LEGACY_SEARCH_ROOT",
    "LEGACY_SEARCH_MAX_FILES", "LEGACY_SEARCH_MAX_FILE_BYTES",
    "LEGACY_SEARCH_MAX_TOTAL_BYTES", "LEGACY_SEARCH_MAX_ENTRIES",
    "RESUME_MAX_BYTES", "UPLOAD_RECOVERY_GRACE_SECONDS", "RESUME_MEDIA_TYPES",
    "EXTRACTION_MAX_BYTES", "EXTRACTION_MAX_DEPTH", "EXTRACTION_MAX_LEAVES",
    "EXTRACTION_MAX_STRING", "EXTRACTION_STATUSES", "EXTRACTION_DECISIONS",
    "EXTRACTION_REQUEST_STATUSES", "EXTRACTION_REQUEST_FAILURE_REASONS",
    "ACCOUNTS_MODULE", "ACCOUNT_FLOWS_MACOS_MODULE", "ACCOUNT_FLOWS_MODULE",
    "TRUSTED_FILL_MODULE", "CREDENTIALS_MODULE", "CREDENTIALS_MACOS_MODULE",
    "ACCOUNT_EXECUTOR_MODULE", "PASSWORD_ACCOUNT_FLOWS_MODULE",
    "CANARY_EXECUTOR_MODULE", "FORM_READINESS_MODULE", "ANSWER_MATCH_MODULE",
    "EMAIL_PATTERN", "StoreError", "TrustedFillCurrentError", "utc_now",
    "exclusive_file_lock", "atomic_write_json", "read_json_object",
    "validate_version", "normalize_question", "answer_key", "normalize_job_url",
    "normalize_resume_path", "observe_resume_file", "order_extraction_requests",
    "Store", "build_parser", "resolve_store", "run", "main",
}

PRIVATE_MODULE_NAMES = {
    "_canonical_json", "_managed_resume_digest_cache_identity",
    "_pointer_baseline", "_pointer_lookup", "_replacement_scope",
    "_scope_fingerprint", "_top_level_pointer_key",
}

IMPORTED_SEAMS = {"Path", "os", "secrets", "sys", "uuid", "zipfile"}

PUBLIC_STORE_SIGNATURES = {
    "paths": "(self) -> 'dict[str, Any]'",
    "initialize": "(self) -> 'dict[str, Any]'",
    "validate_workspace_startup": "(self) -> 'None'",
    "get_profile": "(self) -> 'dict[str, Any]'",
    "inspect_profile": "(self) -> 'dict[str, Any]'",
    "profile_preparedness": "(self) -> 'dict[str, Any]'",
    "replace_profile": "(self, profile: 'dict[str, Any]', expected_revision: 'int', source: 'str') -> 'dict[str, Any]'",
    "patch_profile": "(self, patch: 'dict[str, Any]', expected_revision: 'int', source: 'str', atomic_paths: 'list[str] | None' = None, deleted_paths: 'list[str] | None' = None) -> 'dict[str, Any]'",
    "get_preferences": "(self) -> 'dict[str, Any]'",
    "set_preferences": "(self, preferences: 'dict[str, Any]', expected_revision: 'int', source: 'str', replace: 'bool' = False) -> 'dict[str, Any]'",
    "list_fact_groups": "(self) -> 'list[dict[str, Any]]'",
    "get_fact_group": "(self, group_id: 'str') -> 'dict[str, Any] | None'",
    "create_fact_group": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "update_fact_group": "(self, group_id: 'str', patch: 'dict[str, Any]', expected_revision: 'int') -> 'dict[str, Any]'",
    "delete_fact_group": "(self, group_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "answer_detail_projection": "(self, record: 'dict[str, Any]', document: 'dict[str, Any]', reveal_value: 'bool' = False) -> 'dict[str, Any]'",
    "get_answer": "(self, key: 'str', include_trashed: 'bool' = False) -> 'dict[str, Any] | None'",
    "list_answers": "(self, state: 'str | None' = None, include_trashed: 'bool' = False, review_status: 'str | None' = 'accepted') -> 'list[dict[str, Any]]'",
    "query_answers": "(self, query: 'str' = '', state: 'str | None' = None, review_status: 'str | None' = 'accepted', include_trashed: 'bool' = False, trashed_only: 'bool' = False, offset: 'int' = 0, limit: 'int' = 50) -> 'dict[str, Any]'",
    "reveal_answer": "(self, key: 'str') -> 'dict[str, Any]'",
    "find_answer": "(self, question: 'str', scope: 'dict[str, Any] | None' = None) -> 'dict[str, Any] | None'",
    "semantic_answer_lookup": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "preview_answer_cleanup": "(self) -> 'dict[str, Any]'",
    "approve_answer_cleanup": "(self, incoming: 'dict[str, Any]', owner_confirmed: 'bool' = False) -> 'dict[str, Any]'",
    "put_answer": "(self, incoming: 'dict[str, Any]', remember_sensitive: 'bool' = False, expected_revision: 'int | None' = None) -> 'dict[str, Any]'",
    "update_answer": "(self, key: 'str', patch: 'dict[str, Any]', expected_revision: 'int', remember_sensitive: 'bool' = False, _review_status_transition: 'str | None' = None) -> 'dict[str, Any]'",
    "observe_answer": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "review_answer": "(self, key: 'str', review_status: 'str', expected_revision: 'int', patch: 'dict[str, Any] | None' = None, remember_sensitive: 'bool' = False) -> 'dict[str, Any]'",
    "merge_answers": "(self, winner_key: 'str', source_key: 'str', expected_winner_revision: 'int', expected_source_revision: 'int', *, cleanup_approval: 'dict[str, Any] | None' = None) -> 'dict[str, Any]'",
    "trash_answer": "(self, key: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "restore_answer": "(self, key: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "delete_answer": "(self, key: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "create_job": "(self, incoming: 'dict[str, Any]', origin: 'str' = 'human') -> 'dict[str, Any]'",
    "get_job": "(self, job_id: 'str', include_trashed: 'bool' = False) -> 'dict[str, Any] | None'",
    "list_jobs": "(self, status: 'str | None' = None, include_trashed: 'bool' = False, trashed_only: 'bool' = False) -> 'list[dict[str, Any]]'",
    "task_snapshot": "(self) -> 'dict[str, Any]'",
    "intake_task_job": "(self, incoming: 'dict[str, Any]', origin: 'str' = 'agent') -> 'dict[str, Any]'",
    "select_task_job_ready": "(self, job_id: 'str', expected_revision: 'int', owner_confirmed: 'bool') -> 'dict[str, Any]'",
    "owner_beta_overview": "(self) -> 'dict[str, Any]'",
    "list_needs_attention": "(self) -> 'dict[str, Any]'",
    "preflight_job": "(self, job_id: 'str') -> 'dict[str, Any]'",
    "update_job": "(self, job_id: 'str', patch: 'dict[str, Any]', expected_revision: 'int', origin: 'str' = 'human') -> 'dict[str, Any]'",
    "preview_job_upsert": "(self, payload: 'dict[str, Any]', origin: 'str') -> 'dict[str, Any]'",
    "commit_job_upsert": "(self, payload: 'dict[str, Any]', origin: 'str', token: 'str') -> 'dict[str, Any]'",
    "preview_legacy_jobs": "(self, selected: 'list[str]') -> 'dict[str, Any]'",
    "commit_legacy_jobs": "(self, selected: 'list[str]', token: 'str') -> 'dict[str, Any]'",
    "transition_job": "(self, job_id: 'str', status: 'str', expected_revision: 'int', closed_outcome: 'str | None' = None, user_confirmed: 'bool' = False) -> 'dict[str, Any]'",
    "claim_status": "(self) -> 'dict[str, Any]'",
    "get_job_activity": "(self, job_id: 'str') -> 'dict[str, Any]'",
    "pending_answer_detail": "(self, job_id: 'str', reference: 'str') -> 'dict[str, Any]'",
    "resolve_pending_answer": "(self, job_id: 'str', reference: 'str', expected_job_revision: 'int', expected_session_revision: 'int', expected_answer_revision: 'int', owner_confirmed: 'bool' = False) -> 'dict[str, Any]'",
    "acquire_ready_job": "(self, job_id: 'str', owner_label: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "restart_reviewed_job": "(self, job_id: 'str', owner_label: 'str', expected_revision: 'int', owner_confirmed_not_submitted: 'bool' = False) -> 'dict[str, Any]'",
    "heartbeat_claim": "(self, job_id: 'str', token: 'str') -> 'dict[str, Any]'",
    "recover_claim": "(self, job_id: 'str', owner_label: 'str') -> 'dict[str, Any]'",
    "trash_job": "(self, job_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "restore_job": "(self, job_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "delete_job": "(self, job_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "create_resume": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "import_resume": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "create_resume_bytes": "(self, incoming: 'dict[str, Any]', original_filename: 'str', content: 'bytes') -> 'dict[str, Any]'",
    "update_resume_bytes": "(self, resume_id: 'str', original_filename: 'str', content: 'bytes', expected_revision: 'int') -> 'dict[str, Any]'",
    "adopt_resume_bytes": "(self, resume_id: 'str', original_filename: 'str', content: 'bytes', expected_revision: 'int') -> 'dict[str, Any]'",
    "read_resume_content": "(self, resume_id: 'str') -> 'tuple[dict[str, Any], bytes]'",
    "resolve_resume": "(self, resume_id: 'str | None' = None) -> 'dict[str, Any]'",
    "get_resume": "(self, resume_id: 'str', include_trashed: 'bool' = False) -> 'dict[str, Any] | None'",
    "list_resumes": "(self, include_trashed: 'bool' = False, trashed_only: 'bool' = False) -> 'list[dict[str, Any]]'",
    "update_resume": "(self, resume_id: 'str', patch: 'dict[str, Any]', expected_revision: 'int') -> 'dict[str, Any]'",
    "adopt_resume": "(self, resume_id: 'str', source_path: 'str | None', expected_revision: 'int') -> 'dict[str, Any]'",
    "set_default_resume": "(self, resume_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "check_resume": "(self, resume_id: 'str') -> 'dict[str, Any]'",
    "trash_resume": "(self, resume_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "restore_resume": "(self, resume_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "delete_resume": "(self, resume_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "create_resume_extraction_request": "(self, resume_id: 'str', expected_resume_revision: 'int') -> 'dict[str, Any]'",
    "get_resume_extraction_request": "(self, request_id: 'str') -> 'dict[str, Any] | None'",
    "list_resume_extraction_requests": "(self, resume_id: 'str | None' = None, status: 'str | None' = None) -> 'list[dict[str, Any]]'",
    "cancel_resume_extraction_request": "(self, request_id: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "fail_resume_extraction_request": "(self, request_id: 'str', reason: 'str', expected_revision: 'int') -> 'dict[str, Any]'",
    "retry_resume_extraction_request": "(self, request_id: 'str', expected_revision: 'int', expected_resume_revision: 'int') -> 'dict[str, Any]'",
    "create_resume_proposal": "(self, resume_id: 'str', candidate_input: 'dict[str, Any]', expected_resume_revision: 'int', expected_profile_revision: 'int', supersedes: 'str | None' = None) -> 'dict[str, Any]'",
    "complete_resume_extraction_request": "(self, request_id: 'str', candidate_input: 'dict[str, Any]', expected_request_revision: 'int', expected_profile_revision: 'int', expected_pending_proposal_id: 'str | None' = None) -> 'dict[str, Any]'",
    "get_resume_proposal": "(self, proposal_id: 'str') -> 'dict[str, Any] | None'",
    "list_resume_proposals": "(self, resume_id: 'str | None' = None, status: 'str | None' = None, *, summary_only: 'bool' = False) -> 'list[dict[str, Any]]'",
    "review_resume_proposal": "(self, proposal_id: 'str', decisions_input: 'dict[str, Any]', expected_revision: 'int', expected_profile_revision: 'int') -> 'dict[str, Any]'",
    "read_history": "(self) -> 'list[dict[str, Any]]'",
    "append_history": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "record_replay_transition": "(self, application_id: 'str', transition: 'str', ats: 'str') -> 'dict[str, Any]'",
    "save_claim_progress": "(self, job_id: 'str', token: 'str', incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "handoff_claimed_job": "(self, job_id: 'str', token: 'str', status: 'str', incoming: 'dict[str, Any]', expected_revision: 'int') -> 'dict[str, Any]'",
    "preview_grouped_approval": "(self, job_id: 'str', expected_job_revision: 'int', expected_session_revision: 'int', decisions: 'list[dict[str, Any]]') -> 'dict[str, Any]'",
    "approve_grouped_approval": "(self, job_id: 'str', expected_job_revision: 'int', expected_session_revision: 'int', decisions: 'list[dict[str, Any]]', preview_token: 'str', owner_confirmed: 'bool' = False) -> 'dict[str, Any]'",
    "save_session": "(self, application_id: 'str', incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "load_session": "(self, application_id: 'str') -> 'dict[str, Any]'",
    "list_sessions": "(self) -> 'list[dict[str, Any]]'",
    "delete_session": "(self, application_id: 'str') -> 'dict[str, Any]'",
    "get_automation_settings": "(self, *, public: 'bool' = False, companion: 'bool' = False) -> 'dict[str, Any]'",
    "update_automation_settings": "(self, patch: 'dict[str, Any]', expected_revision: 'int', *, public: 'bool' = False) -> 'dict[str, Any]'",
    "copy_profile_email_to_automation_settings": "(self, expected_profile_revision: 'int', expected_settings_revision: 'int', *, public: 'bool' = True) -> 'dict[str, Any]'",
    "automation_capability": "(self, platform: 'str | None' = None) -> 'dict[str, Any]'",
    "resolve_account_realm": "(self, portal_url: 'str') -> 'dict[str, Any]'",
    "employer_account_flow_decision": "(self, job_id: 'str') -> 'dict[str, Any]'",
    "list_employer_accounts": "(self, *, public: 'bool' = False, companion: 'bool' = False) -> 'list[dict[str, Any]]'",
    "get_employer_account": "(self, realm_ref: 'str', *, public: 'bool' = False) -> 'dict[str, Any] | None'",
    "create_employer_account": "(self, portal_url: 'str', signup_email_override: 'str | None' = None, *, public: 'bool' = False) -> 'dict[str, Any]'",
    "update_employer_account": "(self, realm_ref: 'str', patch: 'dict[str, Any]', expected_revision: 'int', *, public: 'bool' = False) -> 'dict[str, Any]'",
    "account_operation_status": "(self) -> 'dict[str, Any]'",
    "recover_account_operation": "(self) -> 'dict[str, Any]'",
    "execute_synthetic_account": "(self, incoming: 'dict[str, Any]', *, provider: 'Any | None' = None, observer: 'Any | None' = None, public: 'bool' = False, test_authority: 'object | None' = None) -> 'dict[str, Any]'",
    "execute_synthetic_email_only_account": "(self, incoming: 'dict[str, Any]', *, provider: 'Any', test_authority: 'object | None' = None) -> 'dict[str, Any]'",
    "revalidate_live_email_only_stable_scope": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "revalidate_live_email_only_preparation_scope": "(self, scope: 'dict[str, Any]', portal_url: 'str', portal_name: 'str', realm_descriptor: 'str') -> 'dict[str, Any]'",
    "acquire_or_recover_live_email_only_claim": "(self, incoming: 'dict[str, Any]', *, owner_label: 'str') -> 'dict[str, Any]'",
    "prepare_live_email_only_account_execution": "(self, incoming: 'dict[str, Any]', binding: 'dict[str, Any]') -> 'dict[str, Any]'",
    "execute_live_email_only_account": "(self, incoming: 'dict[str, Any]', *, authority: 'Any', provider: 'Any', now: 'datetime') -> 'dict[str, Any]'",
    "revalidate_live_password_stable_scope": "(self, incoming: 'dict[str, Any]') -> 'dict[str, Any]'",
    "acquire_or_recover_live_password_claim": "(self, incoming: 'dict[str, Any]', *, owner_label: 'str') -> 'dict[str, Any]'",
    "prepare_live_password_account_execution": "(self, incoming: 'dict[str, Any]', binding: 'dict[str, Any]') -> 'dict[str, Any]'",
    "execute_live_password_account": "(self, incoming: 'dict[str, Any]', *, authority: 'Any', provider: 'Any', now: 'datetime') -> 'dict[str, Any]'",
    "approve_trusted_fill": "(self, incoming: 'dict[str, Any]', *, public: 'bool' = False) -> 'dict[str, Any]'",
    "trusted_fill_status": "(self, job_id: 'str', *, public: 'bool' = False) -> 'dict[str, Any] | None'",
    "revoke_trusted_fill": "(self, job_id: 'str', expected_approval_revision: 'int', *, public: 'bool' = False) -> 'dict[str, Any]'",
    "evaluate_trusted_fill": "(self, incoming: 'dict[str, Any]', *, public: 'bool' = False) -> 'dict[str, Any]'",
}

PRIVATE_STORE_SIGNATURES = {
    "_answer_candidates": "(record: 'dict[str, Any]') -> 'set[str]'",
    "_answer_reference_counts": "(self, document: 'dict[str, Any] | None' = None, sessions: 'list[dict[str, Any]] | None' = None, history: 'list[dict[str, Any]] | None' = None) -> 'dict[str, dict[str, int]]'",
    "_append_history_event_idempotent_locked": "(self, event: 'dict[str, Any]') -> 'None'",
    "_ensure_coordinator_files": "(self) -> 'None'",
    "_ensure_trusted_fill_document": "(self) -> 'None'",
    "_history_event_for_operation": "(self, operation_id: 'str', job: 'dict[str, Any]', event: 'str', status: 'str', at: 'str') -> 'dict[str, Any]'",
    "_load_account_operation_journal": "(self) -> 'dict[str, Any]'",
    "_load_coordinator_document": "(self) -> 'dict[str, Any]'",
    "_load_coordinator_journal": "(self) -> 'dict[str, Any]'",
    "_load_employer_accounts_document": "(self) -> 'dict[str, Any]'",
    "_load_jobs_document": "(self) -> 'dict[str, Any]'",
    "_load_profile_document": "(self) -> 'dict[str, Any]'",
    "_load_resumes_document": "(self) -> 'dict[str, Any]'",
    "_managed_resume_observation": "(self, record: 'dict[str, Any]', *, digest_cache: 'dict[str, dict[str, Any]] | None' = None) -> 'dict[str, Any]'",
    "_parse_time": "(value: 'str') -> 'datetime'",
    "_preflight_job_record": "(self, record: 'dict[str, Any]', *, profile: 'dict[str, Any] | None' = None, resumes: 'dict[str, dict[str, Any]] | None' = None, resume_observations: 'dict[str, dict[str, Any]] | None' = None, managed_digest_cache: 'dict[str, dict[str, Any]] | None' = None) -> 'dict[str, Any]'",
    "_preview_answer_cleanup_document": "(self, document: 'dict[str, Any]') -> 'dict[str, Any]'",
    "_private_file_digest": "(path: 'Path') -> 'str | None'",
    "_session_path": "(self, application_id: 'str') -> 'Path'",
    "_session_revision": "(session: 'dict[str, Any]') -> 'int'",
    "_token_hash": "(token: 'str') -> 'str'",
    "_write_account_stage_locked": "(self, account: 'dict[str, Any]', lifecycle: 'str', operation: 'dict[str, Any]', stage: 'str', *, provider_id: 'str | None' = None, credential_ref: 'str | None' = None, credential_version: 'int | None' = None) -> 'dict[str, Any]'",
    "_account_attention_handoff_locked": "(self, job: 'dict[str, Any]', reason: 'str') -> 'dict[str, Any]'",
    "_get_answer_record": "(self, key: 'str', include_trashed: 'bool' = False, document: 'dict[str, Any] | None' = None) -> 'dict[str, Any] | None'",
    "_load_answers_document": "(self) -> 'dict[str, Any]'",
    "_now_datetime": "(self) -> 'datetime'",
}


def load_module(script: Path = SCRIPT, name: str = "store_facade_contract") -> Any:
    spec = importlib.util.spec_from_file_location(name, script)
    if spec is None or spec.loader is None:
        raise AssertionError("Store facade spec unavailable")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalized_text(value: str | None) -> str | None:
    return " ".join(value.split()) if value is not None else None


def action_receipt(action: argparse.Action) -> dict[str, Any]:
    action_type = getattr(action.type, "__name__", None)
    return {
        "options": list(action.option_strings),
        "dest": action.dest,
        "kind": action.__class__.__name__,
        "type": action_type,
        "choices": list(action.choices) if action.choices is not None else None,
        "default": action.default,
        "required": action.required,
        "nargs": action.nargs,
        "const": action.const,
        "help": normalized_text(action.help),
        "metavar": action.metavar,
    }


def parser_receipt(parser: argparse.ArgumentParser) -> dict[str, Any]:
    subparsers = next(
        action for action in parser._actions
        if isinstance(action, argparse._SubParsersAction)
    )
    root_actions = [
        action_receipt(action) for action in parser._actions
        if not isinstance(action, (argparse._HelpAction, argparse._SubParsersAction))
    ]
    commands = []
    for name, command_parser in subparsers.choices.items():
        actions = [
            action_receipt(action) for action in command_parser._actions
            if not isinstance(action, argparse._HelpAction)
        ]
        groups = [
            {
                "required": group.required,
                "members": [action.dest for action in group._group_actions],
            }
            for group in command_parser._mutually_exclusive_groups
        ]
        commands.append({
            "name": name,
            "description": normalized_text(command_parser.description),
            "actions": actions,
            "mutuallyExclusive": groups,
        })
    return {
        "description": normalized_text(parser.description),
        "rootActions": root_actions,
        "commands": commands,
    }


def dispatch_commands(script: Path = SCRIPT) -> list[str]:
    tree = ast.parse(script.read_text(encoding="utf-8"))
    run = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == "run")
    commands = []
    for node in ast.walk(run):
        if not isinstance(node, ast.Compare) or len(node.ops) != 1:
            continue
        if not isinstance(node.left, ast.Name) or node.left.id != "command":
            continue
        if isinstance(node.ops[0], (ast.Eq, ast.In)):
            for comparator in node.comparators:
                if isinstance(comparator, ast.Constant) and isinstance(comparator.value, str):
                    commands.append(comparator.value)
                elif isinstance(comparator, (ast.Set, ast.Tuple)):
                    commands.extend(
                        item.value for item in comparator.elts
                        if isinstance(item, ast.Constant) and isinstance(item.value, str)
                    )
    by_source = {name: index for index, name in enumerate(commands)}
    return sorted(by_source, key=by_source.get)


def signatures(owner: Any, names: set[str] | dict[str, str]) -> dict[str, str]:
    return {name: str(inspect.signature(getattr(owner, name))) for name in names}


def private_package_keys(package_name: str) -> set[str]:
    return {
        name for name in sys.modules
        if name == package_name or name.startswith(package_name + ".")
    }


def stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)
