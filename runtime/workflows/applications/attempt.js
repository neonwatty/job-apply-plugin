import { WorkflowRegistry } from '../../harness/registry.js';
import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';
export const attemptIdentity = Object.freeze({ id: 'application.attempt', version: 1 });
export const attemptProfile = 'application_attempt';
const kinds = ['acquire', 'restart', 'recover', 'progress', 'handoff', 'cancel'];
export function claimEvent(raw) {
    const value = record(snapshot(raw), 'invalid_event');
    requireCondition(kinds.includes(value.kind), 'invalid_event');
    const kind = value.kind;
    const session = ['progress', 'handoff', 'cancel'].includes(kind);
    exact(value, ['kind', 'operationId', 'taskId', 'expectedRevision', 'jobId', 'jobRevision',
        ...(session ? ['session'] : []), ...(kind === 'handoff' ? ['status'] : [])], 'invalid_event');
    const fresh = kind === 'acquire' || kind === 'restart';
    if (fresh)
        requireCondition(value.taskId === null && value.expectedRevision === null, 'invalid_event');
    if (kind === 'handoff')
        requireCondition(value.status === 'needs_info' || value.status === 'awaiting_review', 'invalid_event');
    if (session)
        record(value.session, 'invalid_event');
    return { kind, operationId: identifier(value.operationId, 'invalid_event'),
        taskId: fresh ? null : identifier(value.taskId, 'invalid_event'),
        expectedRevision: fresh ? null : revision(value.expectedRevision, 'invalid_event'),
        jobId: identifier(value.jobId, 'invalid_event'), jobRevision: revision(value.jobRevision, 'invalid_event'),
        ...(session ? { session: value.session } : {}), ...(kind === 'handoff' ? { status: value.status } : {}) };
}
export function attemptRegistry() {
    return new WorkflowRegistry([{ id: attemptProfile, tools: kinds.map(kind => ({ id: `application.${kind}`, inputSchema: { parse: claimEvent } })),
            limits: { maxSteps: 256, maxToolCalls: 1, maxChildDepth: 0 } }], [{ ...attemptIdentity, routeDescription: 'One claim-owned attempt ending at a recoverable handoff or manual review.',
            requiredProfiles: [attemptProfile], startInputSchema: { parse: claimEvent }, userEventSchema: { parse: claimEvent } }]);
}
export const safeExit = (event) => event.kind === 'cancel' || event.kind === 'handoff' && event.status === 'needs_info';
