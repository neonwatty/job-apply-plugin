"""Explicit-runtime Store CLI dispatch implementation."""

from __future__ import annotations

import argparse
from typing import Any


def run(args: argparse.Namespace, runtime: dict[str, Any]) -> Any:
    store = runtime['resolve_store'](args)
    command = args.command
    if command == "init":
        return store.initialize()
    if command == "paths":
        return store.paths()
    if command == "profile-get":
        return store.get_profile()
    if command == "profile-inspect":
        return store.inspect_profile()
    if command == "profile-replace":
        return store.replace_profile(
            runtime['_read_input'](args.input), args.expected_revision, args.source
        )
    if command == "profile-patch":
        return store.patch_profile(
            runtime['_read_input'](args.input), args.expected_revision, args.source
        )
    if command == "fact-group-list":
        return store.list_fact_groups()
    if command == "fact-group-get":
        return store.get_fact_group(args.id)
    if command == "fact-group-create":
        return store.create_fact_group(runtime['_read_input'](args.input))
    if command == "fact-group-update":
        return store.update_fact_group(
            args.id, runtime['_read_input'](args.input), args.expected_revision
        )
    if command == "fact-group-delete":
        return store.delete_fact_group(args.id, args.expected_revision)
    if command == "preferences-get":
        return store.get_preferences()
    if command == "preferences-set":
        return store.set_preferences(
            runtime['_read_input'](args.input), args.expected_revision, args.source, args.replace
        )
    if command == "answer-key":
        return {"key": runtime['answer_key'](args.question, runtime['_scope'](args.scope))}
    if command == "answer-put":
        return store.put_answer(
            runtime['_read_input'](args.input),
            remember_sensitive=args.remember_sensitive,
            expected_revision=args.expected_revision,
        )
    if command == "answer-get":
        return store.get_answer(args.key, include_trashed=args.include_trashed)
    if command == "answer-find":
        return store.find_answer(args.question, runtime['_scope'](args.scope))
    if command == "answer-list":
        return store.query_answers(
            query=args.query,
            state=args.state,
            review_status=None if args.all_review_statuses else args.review_status,
            include_trashed=args.include_trashed,
            trashed_only=args.trashed_only,
            offset=args.offset,
            limit=args.limit,
        )
    if command == "answer-reveal":
        return store.reveal_answer(args.key)
    if command == "answer-observe":
        return store.observe_answer(runtime['_read_input'](args.input))
    if command == "answer-review":
        return store.review_answer(
            args.key,
            args.decision,
            args.expected_revision,
            runtime['_read_input'](args.input) if args.input else None,
            remember_sensitive=args.remember_sensitive,
        )
    if command == "answer-update":
        return store.update_answer(
            args.key,
            runtime['_read_input'](args.input),
            args.expected_revision,
            remember_sensitive=args.remember_sensitive,
        )
    if command == "answer-trash":
        return store.trash_answer(args.key, args.expected_revision)
    if command == "answer-restore":
        return store.restore_answer(args.key, args.expected_revision)
    if command == "answer-delete":
        return store.delete_answer(args.key, args.expected_revision)
    if command == "answer-merge":
        return store.merge_answers(
            args.winner_key,
            args.source_key,
            args.expected_winner_revision,
            args.expected_source_revision,
        )
    if command == "answer-semantic-lookup":
        return store.semantic_answer_lookup(runtime['_read_input'](args.input))
    if command == "answer-cleanup-preview":
        return store.preview_answer_cleanup()
    if command == "answer-cleanup-approve":
        return store.approve_answer_cleanup(
            runtime['_read_input'](args.input), owner_confirmed=args.owner_confirmed
        )
    if command == "job-create":
        return store.create_job(runtime['_read_input'](args.input), origin=args.origin)
    if command == "job-upsert-preview":
        return store.preview_job_upsert(runtime['_read_input'](args.input), args.origin)
    if command == "job-upsert-commit":
        return store.commit_job_upsert(
            runtime['_read_input'](args.input), args.origin, args.token
        )
    if command == "legacy-jobs-preview":
        return store.preview_legacy_jobs(args.select)
    if command == "legacy-jobs-commit":
        return store.commit_legacy_jobs(args.select, args.confirm)
    if command == "job-get":
        return store.get_job(args.id, include_trashed=args.include_trashed)
    if command == "job-list":
        return store.list_jobs(
            args.status,
            include_trashed=args.include_trashed,
            trashed_only=args.trashed_only,
        )
    if command == "job-preflight":
        return store.preflight_job(args.id)
    if command == "job-update":
        return store.update_job(
            args.id,
            runtime['_read_input'](args.input),
            args.expected_revision,
            origin=args.origin,
        )
    if command == "job-transition":
        return store.transition_job(
            args.id,
            args.status,
            args.expected_revision,
            closed_outcome=args.closed_outcome,
            user_confirmed=args.user_confirmed,
        )
    if command == "job-acquire":
        return store.acquire_ready_job(args.id, args.owner, args.expected_revision)
    if command == "job-review-restart":
        return store.restart_reviewed_job(
            args.id,
            args.owner,
            args.expected_revision,
            owner_confirmed_not_submitted=args.owner_confirmed_not_submitted,
        )
    if command == "claim-status":
        return store.claim_status()
    if command == "claim-heartbeat":
        return store.heartbeat_claim(args.id, args.token)
    if command == "claim-recover":
        return store.recover_claim(args.id, args.owner)
    if command == "claim-progress":
        return store.save_claim_progress(args.id, args.token, runtime['_read_input'](args.input))
    if command == "claim-handoff":
        return store.handoff_claimed_job(
            args.id,
            args.token,
            args.status,
            runtime['_read_input'](args.input),
            args.expected_revision,
        )
    if command == "attention-approval-preview":
        payload = runtime['_read_input'](args.input)
        if set(payload) != {"decisions"}:
            raise runtime['StoreError']("grouped approval input must contain decisions")
        return store.preview_grouped_approval(
            args.id, args.expected_job_revision, args.expected_session_revision,
            payload["decisions"],
        )
    if command == "attention-approval-approve":
        payload = runtime['_read_input'](args.input)
        if set(payload) != {"decisions"}:
            raise runtime['StoreError']("grouped approval input must contain decisions")
        return store.approve_grouped_approval(
            args.id, args.expected_job_revision, args.expected_session_revision,
            payload["decisions"], args.preview_token,
            owner_confirmed=args.owner_confirmed,
        )
    if command == "job-trash":
        return store.trash_job(args.id, args.expected_revision)
    if command == "job-restore":
        return store.restore_job(args.id, args.expected_revision)
    if command == "job-delete":
        return store.delete_job(args.id, args.expected_revision)
    if command == "resume-create":
        return store.create_resume(runtime['_read_input'](args.input))
    if command == "resume-import":
        return store.import_resume(runtime['_read_input'](args.input))
    if command == "resume-get":
        return store.get_resume(args.id, include_trashed=args.include_trashed)
    if command == "resume-resolve":
        return store.resolve_resume(args.id)
    if command == "resume-list":
        return store.list_resumes(
            include_trashed=args.include_trashed,
            trashed_only=args.trashed_only,
        )
    if command == "resume-update":
        return store.update_resume(
            args.id, runtime['_read_input'](args.input), args.expected_revision
        )
    if command == "resume-adopt":
        return store.adopt_resume(args.id, args.path, args.expected_revision)
    if command == "resume-set-default":
        return store.set_default_resume(args.id, args.expected_revision)
    if command == "resume-check":
        return store.check_resume(args.id)
    if command == "resume-trash":
        return store.trash_resume(args.id, args.expected_revision)
    if command == "resume-restore":
        return store.restore_resume(args.id, args.expected_revision)
    if command == "resume-delete":
        return store.delete_resume(args.id, args.expected_revision)
    if command == "resume-extraction-request-create":
        return store.create_resume_extraction_request(
            args.resume_id, args.expected_resume_revision
        )
    if command == "resume-extraction-request-get":
        return store.get_resume_extraction_request(args.id)
    if command == "resume-extraction-request-list":
        return store.list_resume_extraction_requests(args.resume_id, args.status)
    if command == "resume-extraction-request-cancel":
        return store.cancel_resume_extraction_request(args.id, args.expected_revision)
    if command == "resume-extraction-request-fail":
        return store.fail_resume_extraction_request(
            args.id, args.reason, args.expected_revision
        )
    if command == "resume-extraction-request-retry":
        return store.retry_resume_extraction_request(
            args.id, args.expected_revision, args.expected_resume_revision
        )
    if command == "resume-extraction-request-complete":
        return store.complete_resume_extraction_request(
            args.id, runtime['_read_input'](args.input), args.expected_request_revision,
            args.expected_profile_revision, args.expected_pending_proposal_id,
        )
    if command == "profile-preparedness-get":
        return store.profile_preparedness()
    if command == "resume-proposal-create":
        return store.create_resume_proposal(
            args.resume_id,
            runtime['_read_input'](args.input),
            args.expected_resume_revision,
            args.expected_profile_revision,
            args.supersedes,
        )
    if command == "resume-proposal-get":
        return store.get_resume_proposal(args.id)
    if command == "resume-proposal-list":
        return store.list_resume_proposals(
            args.resume_id, args.status, summary_only=args.summary_only
        )
    if command == "resume-proposal-review":
        return store.review_resume_proposal(
            args.id,
            runtime['_read_input'](args.input),
            args.expected_revision,
            args.expected_profile_revision,
        )
    if command == "history-append":
        return store.append_history(runtime['_read_input'](args.input))
    if command == "history-list":
        store.initialize()
        return store.read_history()
    if command == "replay-transition":
        return store.record_replay_transition(
            args.id, args.transition, args.ats
        )
    if command == "session-save":
        return store.save_session(args.id, runtime['_read_input'](args.input))
    if command == "session-load":
        return store.load_session(args.id)
    if command == "session-list":
        return store.list_sessions()
    if command == "session-delete":
        return store.delete_session(args.id)
    if command == "automation-settings-get":
        return store.get_automation_settings(public=True)
    if command == "automation-settings-update":
        return store.update_automation_settings(
            runtime['_read_input'](args.input), args.expected_revision, public=True
        )
    if command == "automation-settings-copy-profile-email":
        return store.copy_profile_email_to_automation_settings(
            args.expected_profile_revision, args.expected_settings_revision,
        )
    if command == "automation-capability":
        return store.automation_capability(args.platform)
    if command == "account-realm-resolve":
        return store.resolve_account_realm(args.url)
    if command == "employer-account-list":
        return store.list_employer_accounts(public=True)
    if command == "employer-account-get":
        return store.get_employer_account(args.realm_ref, public=True)
    if command == "employer-account-create":
        metadata = runtime['_read_input'](args.input) if args.input else {}
        if set(metadata) - {"signupEmailOverride"}:
            raise runtime['StoreError']("employer account input contains unsupported fields")
        return store.create_employer_account(
            args.url, metadata.get("signupEmailOverride"), public=True
        )
    if command == "employer-account-update":
        return store.update_employer_account(
            args.realm_ref, runtime['_read_input'](args.input), args.expected_revision, public=True
        )
    if command == "employer-account-execute-synthetic":
        return store.execute_synthetic_account(runtime['_read_input'](args.input))
    if command == "employer-account-operation-status":
        return store.account_operation_status()
    if command == "employer-account-operation-recover":
        return store.recover_account_operation()
    if command == "trusted-fill-approve":
        return store.approve_trusted_fill(runtime['_read_input'](args.input))
    if command == "trusted-fill-status":
        return store.trusted_fill_status(args.id)
    if command == "trusted-fill-evaluate":
        return store.evaluate_trusted_fill(runtime['_read_input'](args.input))
    if command == "trusted-fill-revoke":
        return store.revoke_trusted_fill(args.id, args.expected_approval_revision)
    raise runtime['StoreError']("unsupported command")
