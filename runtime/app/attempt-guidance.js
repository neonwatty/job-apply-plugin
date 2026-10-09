import { applicationPreflight, inspectAcquisition, inspectRecovery, inspectReviewRestart } from '../contracts/workspace/application-policy.js';
import { activeApplicationRun, currentRunJobIds } from '../contracts/workspace/application-runs.js';
import { claimExpired } from '../contracts/workspace/claims.js';
import { get, int, object, serialize, string, JobsError } from '../contracts/workspace/values.js';
import { agentCodes } from '../contracts/workspace/answer-session-fields.js';
import { receiptLimit, taskLimit } from '../contracts/workspace/workflow-tasks.js';
import { attemptIdentity, attemptRegistry } from '../workflows/applications/attempt.js';
import { preparationScope } from '../workflows/applications/prepare-scope.js';
const plain = (value) => JSON.parse(serialize(value));
/** Read-only advisory projection. Execution remains the authority for every event. */
export async function attemptGuidance(snapshot, ledger, task, ownsClaim, connected, access, now, requestedJobId) {
    const permitted = () => attemptRegistry().eligible(access()).some(item => item.id === attemptIdentity.id);
    const records = object(get(snapshot.jobs, 'jobs'), 'jobs').entries().map(([, value]) => object(value, 'job'))
        .filter(job => get(job, 'deletedAt') === null);
    const run = activeApplicationRun(snapshot.jobs), queued = run === null ? [] : currentRunJobIds(run);
    const jobs = records.filter(job => queued.includes(string(get(job, 'id'))))
        .map(job => ({ jobId: string(get(job, 'id')), jobRevision: int(get(job, 'revision')).toString(),
        status: string(get(job, 'status')), role: string(get(job, 'role')), company: string(get(job, 'company')) }));
    const ready = jobs.filter(job => job.status === 'ready');
    const jobId = requestedJobId ?? task?.subject.jobId ?? (ready.length === 1 ? ready[0].jobId : undefined);
    const job = records.find(item => string(get(item, 'id')) === jobId);
    const claimValue = get(snapshot.coordinator, 'claim'), claim = claimValue === null ? null : object(claimValue, 'claim');
    const claimState = claim === null ? 'none' : claimExpired(claim, now()) ? 'expired' : 'live';
    const result = { nextOperation: 'choose_job', blockers: [], jobs,
        claim: claim === null ? null : { jobId: string(get(claim, 'jobId')), state: claimState },
        selection: job ? { jobId: jobId, jobRevision: int(get(job, 'revision')).toString(), status: string(get(job, 'status')),
            preflightReady: false, inputsCurrent: false } : null,
        checkpoint: null, sessionRequiresObservation: false, actions: [] };
    if (!connected)
        return { ...result, nextOperation: 'inspect_only', blockers: ['broker_closed'] };
    if (task && (task.workflow.id !== attemptIdentity.id || task.workflow.version !== attemptIdentity.version)) {
        return { ...result, nextOperation: 'continue_other_task', blockers: ['different_active_workflow'] };
    }
    if (task && requestedJobId !== undefined && requestedJobId !== task.subject.jobId) {
        return { ...result, nextOperation: 'continue_other_task', blockers: ['different_active_job'] };
    }
    if (!job || !result.selection)
        return { ...result, blockers: jobId === undefined ? [] : ['job_unavailable'] };
    result.nextOperation = 'inspect_only';
    const revision = result.selection.jobRevision;
    const existing = snapshot.sessions.find(item => string(get(item, 'applicationId')) === jobId);
    const session = { status: 'active', attemptRevision: revision };
    if (existing) {
        for (const key of ['step', 'handoffChecklist', 'answerKeys']) {
            const value = get(existing, key);
            if (value !== null)
                session[key] = plain(value);
        }
        const pending = get(existing, 'pendingFields');
        result.sessionRequiresObservation = Array.isArray(pending) && pending.length > 0;
        // Derived blockers are rebuilt by canonical policy. Only closed agent blockers are inputs.
        const blockers = get(existing, 'blockers');
        session.blockers = Array.isArray(blockers) ? blockers.map(value => object(value, 'blocker'))
            .filter(value => agentCodes.includes(string(get(value, 'code'))))
            .map(value => ({ type: string(get(value, 'type')), code: string(get(value, 'code')) })) : [];
        result.checkpoint = { ...structuredClone(session), status: string(get(existing, 'status')),
            attemptRevision: int(get(existing, 'attemptRevision'))?.toString() ?? null };
    }
    try {
        const preflight = await applicationPreflight(snapshot, job);
        result.selection.preflightReady = get(preflight, 'ready') === true;
        result.blockers.push(...get(preflight, 'errors').map(value => string(value)));
    }
    catch (error) {
        if (!(error instanceof JobsError) || !['managed resume content is unavailable', 'resume file exceeds the 10 MiB limit',
            'resume source changed during import'].includes(error.message))
            throw error;
        result.blockers.push('resume_file_unavailable');
    }
    result.selection.inputsCurrent = result.selection.preflightReady && (!task || preparationScope(snapshot, job) === task.subject.inputRevision);
    if (task && !result.selection.inputsCurrent && !result.blockers.length)
        result.blockers.push('attempt_inputs_changed');
    if (task && task.subject.jobRevision !== revision)
        return { ...result, nextOperation: 'inspect_only', blockers: [...result.blockers, 'stale_job_revision'] };
    const remaining = receiptLimit - Object.keys(ledger.receipts).length;
    const add = (kind) => {
        const explicit = ['acquire', 'restart', 'recover', 'cancel'].includes(kind);
        const needsSession = ['progress', 'handoff', 'cancel'].includes(kind);
        const sessionMissing = needsSession && result.sessionRequiresObservation;
        result.actions.push({ kind, args: ['workflow', 'attempt', 'event', ...(explicit ? ['--host-user-event'] : [])],
            requiresExplicitUserEvent: explicit, requiredFields: ['operationId', ...(sessionMissing ? ['session'] : [])], input: {
                kind, taskId: task?.taskId ?? null, expectedRevision: task?.revision ?? null, jobId, jobRevision: revision,
                ...(needsSession && !sessionMissing ? { session: structuredClone(session) } : {}),
                ...(kind === 'handoff' ? { status: 'needs_info' } : {}),
            } });
    };
    if (task && ownsClaim) {
        // Safe exits remain possible after profile revocation or input drift.
        if (remaining > 0) {
            add('handoff');
            add('cancel');
        }
        if (permitted() && result.selection.inputsCurrent && remaining >= 3)
            add('progress');
        result.nextOperation = result.selection.inputsCurrent ? 'choose_action' : 'needs_info_handoff';
    }
    else if (task) {
        result.nextOperation = 'inspect_only';
        result.blockers.push('claim_capability_missing');
        if (permitted() && remaining >= 2) {
            try {
                inspectRecovery(snapshot, jobId, now);
                add('recover');
                result.nextOperation = 'recover_only_if_requested';
            }
            catch (error) {
                if (!(error instanceof JobsError))
                    throw error;
            }
        }
    }
    else if (permitted() && remaining >= 3 && Object.keys(ledger.tasks).length < taskLimit) {
        result.nextOperation = 'resolve_blockers';
        try {
            if (result.selection.status === 'awaiting_review') {
                await inspectReviewRestart(snapshot, jobId, BigInt(revision), now);
                add('restart');
            }
            else {
                await inspectAcquisition(snapshot, jobId, BigInt(revision), now);
                add('acquire');
            }
            result.nextOperation = result.actions[0].kind;
        }
        catch (error) {
            if (!(error instanceof JobsError))
                throw error;
            if (claim)
                result.blockers.push(claimState === 'expired' ? 'expired_claim_requires_recovery' : 'live_claim_exists');
            else if (!result.blockers.length)
                result.blockers.push('job_not_acquirable');
        }
    }
    // Recheck dynamic access after file observations; templates never grant authority.
    if (!permitted()) {
        result.actions = result.actions.filter(action => ['handoff', 'cancel'].includes(action.kind));
        result.blockers.push('profile_unavailable');
        result.nextOperation = result.actions.length ? 'needs_info_handoff' : 'inspect_only';
    }
    if (remaining < 3 || !task && Object.keys(ledger.tasks).length >= taskLimit)
        result.blockers.push('history_capacity_limited');
    if (result.sessionRequiresObservation)
        result.blockers.push('saved_pending_fields_require_observation');
    return result;
}
