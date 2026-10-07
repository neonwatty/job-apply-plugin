import { validateJob } from './jobs.js';
import { claimExpired, requireClaim, requireJobUnclaimed } from './claims.js';
import { buildClaimSession, validateClaimHandoff } from './claim-session.js';
import { validateReviewRestartEvidence } from './review-restart.js';
import { preflightJobRecord } from './application-preflight.js';
import { copy, get, int, integer, object, set, string, text, JobsError } from './values.js';
export function activeApplicationJob(snapshot, id, error = 'job does not exist') {
    const value = get(object(get(snapshot.jobs, 'jobs'), 'jobs'), id);
    if (value === null || get(object(value, 'job'), 'deletedAt') !== null)
        throw new JobsError(error);
    return object(value, 'job');
}
export function applicationPreflight(snapshot, job) {
    return preflightJobRecord(job, snapshot.profile, snapshot.resumes, snapshot.files, snapshot.facts, snapshot.requests, snapshot.jobs);
}
function requireRevision(job, expected, error = 'job revision conflict') {
    if (int(get(job, 'revision')) !== expected)
        throw new JobsError(error);
}
function requireFreeCoordinator(snapshot, now) {
    const current = get(snapshot.coordinator, 'claim');
    if (current !== null)
        throw new JobsError(claimExpired(object(current, 'claim'), now())
            ? 'expired claim requires explicit same-job recovery' : 'another live job claim already exists');
}
export async function inspectSelection(snapshot, id, expected) {
    const job = activeApplicationJob(snapshot, id, 'task selection job is unavailable');
    requireRevision(job, expected, 'task selection revision conflict');
    requireJobUnclaimed(snapshot.coordinator, id);
    if (!['saved', 'needs_info', 'ready'].includes(string(get(job, 'status'))))
        throw new JobsError('task selection job is unavailable');
    if (get(await applicationPreflight(snapshot, job), 'ready') !== true)
        throw new JobsError('task selection preflight failed');
    return job;
}
export async function inspectAcquisition(snapshot, id, expected, now) {
    requireFreeCoordinator(snapshot, now);
    const job = activeApplicationJob(snapshot, id);
    requireRevision(job, expected);
    if (string(get(job, 'status')) !== 'ready')
        throw new JobsError('only a ready job can be acquired');
    const preflight = await applicationPreflight(snapshot, job);
    if (get(preflight, 'ready') !== true)
        throw new JobsError('job is not ready');
    return { job, preflight };
}
export async function inspectReviewRestart(snapshot, id, expected, now) {
    requireFreeCoordinator(snapshot, now);
    const job = activeApplicationJob(snapshot, id);
    requireRevision(job, expected);
    if (string(get(job, 'status')) !== 'awaiting_review')
        throw new JobsError('review restart requires an awaiting_review job');
    const session = snapshot.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null;
    const event = validateReviewRestartEvidence(job, session, snapshot.history);
    const preflight = await applicationPreflight(snapshot, job);
    const rawResume = get(object(get(snapshot.resumes, 'resumes'), 'resumes'), string(get(preflight, 'resumeId')) ?? '');
    if (get(preflight, 'ready') !== true || rawResume === null || string(get(object(rawResume, 'resume'), 'storageKind')) !== 'managed') {
        throw new JobsError('job is not ready with a current managed resume');
    }
    return { job, resume: object(rawResume, 'resume'), event };
}
export function inspectRecovery(snapshot, id, now) {
    const old = get(snapshot.coordinator, 'claim');
    if (old === null || string(get(object(old, 'claim'), 'jobId')) !== id)
        throw new JobsError('explicit recovery must name the expired claimed job');
    const raw = get(object(get(snapshot.jobs, 'jobs'), 'jobs'), id);
    if (raw === null || string(get(object(raw, 'job'), 'status')) !== 'in_progress')
        throw new JobsError('expired claim job is not in progress');
    if (!claimExpired(object(old, 'claim'), now()))
        throw new JobsError('live claim cannot be recovered');
    return object(raw, 'job');
}
function sessionFor(snapshot, job, incoming, now) {
    const id = string(get(job, 'id'));
    return buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
        existing: snapshot.sessions.find(session => string(get(session, 'applicationId')) === id) ?? null,
        answers: snapshot.answers });
}
export async function inspectProgress(snapshot, id, token, incoming, now) {
    requireClaim(snapshot.coordinator, snapshot.jobs, id, token, now());
    const job = activeApplicationJob(snapshot, id);
    if (get(await applicationPreflight(snapshot, job), 'ready') !== true)
        throw new JobsError('confirmed application inputs changed');
    const at = now(), session = sessionFor(snapshot, job, incoming, at);
    if (string(get(session, 'status')) !== 'active')
        throw new JobsError('claim progress session must remain active');
    return session;
}
export async function inspectHandoff(snapshot, id, token, status, incoming, expected, now) {
    requireClaim(snapshot.coordinator, snapshot.jobs, id, token, now());
    const job = activeApplicationJob(snapshot, id);
    if (status === 'awaiting_review' && get(await applicationPreflight(snapshot, job), 'ready') !== true) {
        throw new JobsError('confirmed application inputs changed');
    }
    requireRevision(job, expected);
    const at = now(), session = sessionFor(snapshot, job, incoming, at);
    validateClaimHandoff(session, incoming, status, get(job, 'revision'));
    return { job, session, at };
}
const transitions = {
    saved: ['needs_info', 'ready', 'closed'],
    needs_info: ['saved', 'ready', 'in_progress', 'closed'],
    ready: ['saved', 'needs_info', 'in_progress', 'closed'],
    in_progress: ['needs_info', 'awaiting_review', 'closed'],
    awaiting_review: ['in_progress', 'applied', 'closed'],
    applied: ['closed'],
    closed: ['saved'],
};
export async function inspectJobTransition(snapshot, id, target, expected, userConfirmed) {
    const job = activeApplicationJob(snapshot, id);
    requireRevision(job, expected);
    requireJobUnclaimed(snapshot.coordinator, id);
    const source = string(get(job, 'status'));
    if (target === source)
        return job;
    if (!transitions[source].includes(target))
        throw new JobsError('job status transition is unsupported');
    if (target === 'in_progress')
        throw new JobsError('in_progress requires atomic job-acquire');
    if (target === 'applied' && !userConfirmed)
        throw new JobsError('applied status requires explicit user confirmation');
    if (target === 'ready' && get(await applicationPreflight(snapshot, job), 'ready') !== true)
        throw new JobsError('job is not ready');
    return job;
}
/** Build and validate the direct status edit without persisting it. Same-status calls are no-ops. */
export function buildJobTransition(job, target, closedOutcome, now) {
    if (target === string(get(job, 'status')))
        return job;
    const updated = copy(job);
    set(updated, 'status', text(target));
    set(updated, 'closedOutcome', target === 'closed' ? closedOutcome : null);
    set(updated, 'revision', integer(int(get(job, 'revision')) + 1n));
    set(updated, 'updatedAt', text(now()));
    return validateJob(string(get(job, 'id')), updated);
}
