import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';
export const recoveryActions = ['pause_preserve_draft', 'request_fresh_attempt', 'request_user_sign_in',
    'request_manual_control', 'inspect_field_validation', 'refresh_once', 'request_refresh_approval',
    'inspect_session_separate_tab', 'retry_after_sign_in', 'retry_save_once', 'inspect_existing_draft',
    'draft_registered'];
export function recoveryEvidence(raw) {
    const v = record(snapshot(raw), 'invalid_event');
    exact(v, ['ats', 'draft', 'observation', 'session', 'failure', 'refreshApproved'], 'invalid_event');
    for (const [key, allowed] of Object.entries({ ats: ['workday', 'other'], draft: ['present', 'missing', 'unknown'],
        observation: ['current', 'stale', 'unknown'], session: ['unknown', 'authenticated', 'signed_out', 'reauthenticated'],
        failure: ['none', 'field_validation', 'unsupported_control', 'generic_save', 'page_load'] })) {
        requireCondition(allowed.includes(v[key]), 'invalid_event');
    }
    requireCondition(typeof v.refreshApproved === 'boolean', 'invalid_event');
    return v;
}
export function recoveryBudget(raw) {
    const v = record(snapshot(raw), 'invalid_event');
    exact(v, ['save', 'afterSignIn', 'refresh'], 'invalid_event');
    requireCondition(Object.values(v).every(n => n === 0 || n === 1), 'invalid_event');
    return v;
}
export function recoveryRequest(raw) {
    const v = record(snapshot(raw), 'invalid_event');
    exact(v, ['operationId', 'taskId', 'expectedRevision', 'jobId', 'jobRevision', 'recoveryRevision', 'draftId', 'mode', 'evidence'], 'invalid_event');
    requireCondition(v.mode === 'fresh_draft' || v.mode === 'decide', 'invalid_event');
    return { operationId: identifier(v.operationId, 'invalid_event'), taskId: identifier(v.taskId, 'invalid_event'),
        expectedRevision: revision(v.expectedRevision, 'invalid_event'), jobId: identifier(v.jobId, 'invalid_event'),
        jobRevision: revision(v.jobRevision, 'invalid_event'),
        recoveryRevision: v.recoveryRevision === null ? null : revision(v.recoveryRevision, 'invalid_event'),
        draftId: v.draftId === null ? null : identifier(v.draftId, 'invalid_event'),
        mode: v.mode, evidence: recoveryEvidence(v.evidence) };
}
export const recoveryNeedsApproval = (r) => r.mode === 'fresh_draft' || r.evidence.refreshApproved;
