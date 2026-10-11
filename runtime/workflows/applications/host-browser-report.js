import { exact, record, requireCondition, snapshot } from '../../harness/validation.js';
import { claimEvent } from './attempt.js';
/** Closed agent attestation; canonical ClaimWorkflow remains the mutation authority. */
export function hostBrowserReport(raw) {
    const value = record(snapshot(raw), 'invalid_event');
    requireCondition(value.evidenceKind === 'agent_attested'
        && (value.outcome === 'progress' || value.outcome === 'needs_info'), 'invalid_event');
    const saved = Object.hasOwn(value, 'savedSessionFingerprint');
    requireCondition(!saved || value.outcome === 'needs_info', 'invalid_event');
    exact(value, ['operationId', 'taskId', 'expectedRevision', 'jobId', 'jobRevision',
        'evidenceKind', 'outcome', saved ? 'savedSessionFingerprint' : 'session'], 'invalid_event');
    return claimEvent({ operationId: value.operationId, taskId: value.taskId,
        expectedRevision: value.expectedRevision, jobId: value.jobId, jobRevision: value.jobRevision,
        kind: value.outcome === 'progress' ? 'progress' : 'handoff',
        ...(value.outcome === 'needs_info' ? { status: 'needs_info' } : {}),
        ...(saved ? { savedSessionFingerprint: value.savedSessionFingerprint } : { session: value.session }) });
}
