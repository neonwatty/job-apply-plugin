import { randomUUID } from 'node:crypto';
import { claimExpired, claimHeartbeatSeconds, claimLeaseSeconds, heartbeatClaim, makeClaim, publicClaim, requireClaim, requireJobUnclaimed } from '../contracts/workspace/claims.js';
import { buildClaimSession, validateClaimHandoff } from '../contracts/workspace/claim-session.js';
import { validateReviewRestartEvidence } from '../contracts/workspace/review-restart.js';
import { safeId, validateJob } from '../contracts/workspace/jobs.js';
import { strip } from '../contracts/workspace/job-url.js';
import { copy, fromJSON, get, has, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { preflightJobRecord } from './job-preflight.js';
const doc = (value) => object(fromJSON(value), 'claim result');
function activeJob(jobs, id, error = 'job does not exist') {
    const value = get(object(get(jobs, 'jobs'), 'jobs'), id);
    if (value === null || get(object(value, 'job'), 'deletedAt') !== null)
        throw new JobsError(error);
    return object(value, 'job');
}
function owner(value) {
    const label = string(value);
    if (label === null || !strip(label))
        throw new JobsError('owner label must be a non-empty string');
}
function transitioned(job, target, at) {
    const result = copy(job);
    set(result, 'status', text(target));
    set(result, 'closedOutcome', null);
    set(result, 'revision', integer(int(get(job, 'revision')) + 1n));
    set(result, 'updatedAt', text(at));
    if (has(result, 'inputSelection'))
        set(object(get(result, 'inputSelection'), 'input selection'), 'jobRevision', get(result, 'revision'));
    return validateJob(string(get(job, 'id')), result);
}
function projectJob(job) {
    const result = doc({});
    for (const field of ['id', 'role', 'company', 'location', 'workplaceType', 'employmentType', 'status', 'priority', 'revision', 'createdAt', 'updatedAt'])
        if (has(job, field))
            set(result, field, get(job, field));
    return result;
}
function operation(kind, job, at, eventName, status, claim) {
    const operationId = randomUUID(), id = string(get(job, 'id'));
    const event = doc({ schemaVersion: 1, eventId: `coordinator-${operationId}`, applicationId: id, event: eventName, status, answerKeys: [], at });
    for (const field of ['company', 'role', 'ats'])
        if (string(get(job, field)) !== null)
            set(event, field, get(job, field));
    const result = doc({ kind, operationId, jobId: id, at });
    set(result, 'historyEvent', event);
    set(result, 'resultClaim', claim);
    if (kind !== 'recover') {
        set(result, 'sourceStatus', get(job, 'status'));
        set(result, 'targetStatus', text(status));
        set(result, 'expectedRevision', get(job, 'revision'));
    }
    return result;
}
export class ClaimsService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    status() {
        return this.repository.claimTransaction(async (tx) => set(doc({ leaseSeconds: claimLeaseSeconds, heartbeatSeconds: claimHeartbeatSeconds }), 'claim', publicClaim(get(tx.coordinator, 'claim'), this.now())));
    }
    confirmInput(id, resumeId, expectedJob, expectedResume, expectedFacts, confirmed) {
        safeId(id);
        safeId(resumeId);
        if (!confirmed)
            throw new JobsError('resume and facts require owner confirmation in chat');
        return this.repository.claimTransaction(async (tx) => {
            const job = activeJob(tx.jobs, id);
            if (int(get(job, 'revision')) !== expectedJob)
                throw new JobsError('job revision conflict');
            if (!['saved', 'needs_info', 'ready'].includes(string(get(job, 'status'))))
                throw new JobsError('job cannot change its input selection');
            requireJobUnclaimed(tx.coordinator, id);
            const resumeValue = get(object(get(tx.resumes, 'resumes'), 'resumes'), resumeId);
            if (resumeValue === null)
                throw new JobsError('resume does not exist');
            const resume = object(resumeValue, 'resume');
            if (get(resume, 'deletedAt') !== null || string(get(resume, 'storageKind')) !== 'managed'
                || int(get(resume, 'revision')) !== expectedResume)
                throw new JobsError('resume revision conflict');
            const observation = await tx.files.observation(resume);
            if (!observation.exists || observation.digest !== string(get(resume, 'digest')))
                throw new JobsError('resume file changed');
            const setValue = tx.facts ? get(object(get(tx.facts, 'sets'), 'resume fact sets'), resumeId) : null;
            const versions = setValue === null ? null : get(object(setValue, 'resume fact set'), 'versions');
            const latest = Array.isArray(versions) && versions.length ? object(versions[versions.length - 1], 'resume facts') : null;
            if (!latest || int(get(latest, 'revision')) !== expectedFacts || string(get(latest, 'state')) !== 'confirmed'
                || string(get(latest, 'contentRevision')) !== string(get(resume, 'contentRevision')))
                throw new JobsError('confirmed resume facts are unavailable or stale');
            const next = copy(job), now = this.now();
            set(next, 'resumeId', text(resumeId));
            set(next, 'revision', integer(expectedJob + 1n));
            set(next, 'updatedAt', text(now));
            const selection = doc({ resumeId, contentRevision: string(get(resume, 'contentRevision')),
                factRevision: null, jobRevision: null, confirmedAt: now });
            set(selection, 'factRevision', integer(expectedFacts));
            set(selection, 'jobRevision', integer(expectedJob + 1n));
            set(next, 'inputSelection', selection);
            validateJob(id, next);
            set(object(get(tx.jobs, 'jobs'), 'jobs'), id, next);
            set(object(get(tx.jobs, 'metadata'), 'jobs metadata'), 'updatedAt', text(now));
            await tx.saveJobs(tx.jobs);
            const result = doc({ resumeId });
            set(result, 'factRevision', integer(expectedFacts));
            set(result, 'jobRevision', integer(expectedJob + 1n));
            return set(result, 'job', projectJob(next));
        });
    }
    select(id, expectedRevision, confirmed) {
        safeId(id);
        if (confirmed !== true)
            throw new JobsError('task selection requires owner confirmation');
        if (typeof expectedRevision !== 'bigint')
            throw new JobsError('task selection requires an exact revision');
        return this.repository.claimTransaction(async (tx) => {
            const job = activeJob(tx.jobs, id, 'task selection job is unavailable');
            if (int(get(job, 'revision')) !== expectedRevision)
                throw new JobsError('task selection revision conflict');
            requireJobUnclaimed(tx.coordinator, id);
            if (!['saved', 'needs_info', 'ready'].includes(string(get(job, 'status'))))
                throw new JobsError('task selection job is unavailable');
            if (get(await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs), 'ready') !== true)
                throw new JobsError('task selection preflight failed');
            if (string(get(job, 'status')) === 'ready')
                return set(doc({ action: 'noop' }), 'job', projectJob(job));
            const updated = transitioned(job, 'ready', this.now());
            set(object(get(tx.jobs, 'jobs'), 'jobs'), id, updated);
            set(object(get(tx.jobs, 'metadata'), 'jobs.metadata'), 'updatedAt', get(updated, 'updatedAt'));
            await tx.saveJobs(tx.jobs);
            return set(doc({ action: 'ready' }), 'job', projectJob(updated));
        });
    }
    acquire(id, ownerLabel, expectedRevision) {
        safeId(id);
        owner(ownerLabel);
        return this.repository.claimTransaction(async (tx) => {
            const current = get(tx.coordinator, 'claim');
            if (current !== null)
                throw new JobsError(claimExpired(object(current, 'claim'), this.now()) ? 'expired claim requires explicit same-job recovery' : 'another live job claim already exists');
            const job = activeJob(tx.jobs, id);
            if (int(get(job, 'revision')) !== expectedRevision)
                throw new JobsError('job revision conflict');
            if (string(get(job, 'status')) !== 'ready')
                throw new JobsError('only a ready job can be acquired');
            const preflight = await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs);
            if (get(preflight, 'ready') !== true)
                throw new JobsError('job is not ready');
            const now = this.now(), { claim, token } = makeClaim(id, ownerLabel, now);
            const resume = copy(object(get(object(get(tx.resumes, 'resumes'), 'resumes'), string(get(preflight, 'resumeId'))), 'resume'));
            set(resume, 'path', string(get(resume, 'storageKind')) === 'managed' ? text(tx.files.path(resume)) : get(resume, 'path'));
            await tx.commit(operation('acquire', job, now, 'job-started', 'in_progress', claim));
            const result = doc({ token });
            set(result, 'job', transitioned(job, 'in_progress', now));
            set(result, 'resume', resume);
            return set(result, 'claim', publicClaim(claim, this.now()));
        });
    }
    restart(id, ownerLabel, expectedRevision, ownerConfirmedNotSubmitted) {
        safeId(id);
        if (ownerConfirmedNotSubmitted !== true)
            throw new JobsError('review restart requires explicit owner confirmation that the application was not submitted');
        owner(ownerLabel);
        if (typeof expectedRevision !== 'bigint' || expectedRevision < 1n)
            throw new JobsError('job revision is invalid');
        return this.repository.claimTransaction(async (tx) => {
            const current = get(tx.coordinator, 'claim');
            if (current !== null)
                throw new JobsError(claimExpired(object(current, 'claim'), this.now()) ? 'expired claim requires explicit same-job recovery' : 'another live job claim already exists');
            const job = activeJob(tx.jobs, id);
            if (int(get(job, 'revision')) !== expectedRevision)
                throw new JobsError('job revision conflict');
            if (string(get(job, 'status')) !== 'awaiting_review')
                throw new JobsError('review restart requires an awaiting_review job');
            const session = tx.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null;
            const event = validateReviewRestartEvidence(job, session, tx.history);
            const preflight = await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs);
            const rawResume = get(object(get(tx.resumes, 'resumes'), 'resumes'), string(get(preflight, 'resumeId')) ?? '');
            if (get(preflight, 'ready') !== true || rawResume === null || string(get(object(rawResume, 'resume'), 'storageKind')) !== 'managed')
                throw new JobsError('job is not ready with a current managed resume');
            const resume = copy(object(rawResume, 'resume'));
            set(resume, 'path', text(tx.files.path(resume)));
            const now = this.now(), { claim, token } = makeClaim(id, ownerLabel, now);
            // The prior review remains immutable evidence; new progress belongs to the new revision.
            await tx.commit(operation('review_restart', job, now, event, 'in_progress', claim));
            const result = doc({ token });
            set(result, 'job', transitioned(job, 'in_progress', now));
            set(result, 'resume', resume);
            return set(result, 'claim', publicClaim(claim, this.now()));
        });
    }
    heartbeat(id, token) {
        return this.repository.claimTransaction(async (tx) => {
            const claim = requireClaim(tx.coordinator, tx.jobs, id, token, this.now());
            const updated = heartbeatClaim(claim, this.now());
            await tx.saveCoordinator(set(doc({ schemaVersion: 1 }), 'claim', updated));
            return set(doc({}), 'claim', publicClaim(updated, this.now()));
        });
    }
    recover(id, ownerLabel) {
        safeId(id);
        owner(ownerLabel);
        return this.repository.claimTransaction(async (tx) => {
            const old = get(tx.coordinator, 'claim');
            if (old === null || string(get(object(old, 'claim'), 'jobId')) !== id)
                throw new JobsError('explicit recovery must name the expired claimed job');
            const raw = get(object(get(tx.jobs, 'jobs'), 'jobs'), id);
            if (raw === null || string(get(object(raw, 'job'), 'status')) !== 'in_progress')
                throw new JobsError('expired claim job is not in progress');
            if (!claimExpired(object(old, 'claim'), this.now()))
                throw new JobsError('live claim cannot be recovered');
            const job = object(raw, 'job'), now = this.now(), { claim, token } = makeClaim(id, ownerLabel, now);
            await tx.commit(operation('recover', job, now, 'claim-recovered', 'in_progress', claim));
            const result = doc({ token });
            set(result, 'job', job);
            return set(result, 'claim', publicClaim(claim, this.now()));
        });
    }
    progress(id, token, incoming) {
        return this.repository.claimTransaction(async (tx) => {
            requireClaim(tx.coordinator, tx.jobs, id, token, this.now());
            if (get(await preflightJobRecord(activeJob(tx.jobs, id), tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs), 'ready') !== true)
                throw new JobsError('confirmed application inputs changed');
            const session = this.session(tx, activeJob(tx.jobs, id), incoming);
            if (string(get(session, 'status')) !== 'active')
                throw new JobsError('claim progress session must remain active');
            await tx.saveSession(session);
            return session;
        });
    }
    handoff(id, token, status, incoming, expectedRevision) {
        if (!['needs_info', 'awaiting_review'].includes(status))
            throw new JobsError('claimed handoff status is unsupported');
        return this.repository.claimTransaction(async (tx) => {
            requireClaim(tx.coordinator, tx.jobs, id, token, this.now());
            const job = activeJob(tx.jobs, id);
            if (status === 'awaiting_review'
                && get(await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs), 'ready') !== true)
                throw new JobsError('confirmed application inputs changed');
            if (int(get(job, 'revision')) !== expectedRevision)
                throw new JobsError('job revision conflict');
            const now = this.now(), session = this.session(tx, job, incoming, now);
            validateClaimHandoff(session, incoming, status, get(job, 'revision'));
            const op = operation('handoff', job, now, status === 'needs_info' ? 'job-blocked' : 'reviewed', status, null);
            set(op, 'session', session);
            await tx.commit(op);
            const result = doc({ claim: null });
            set(result, 'job', transitioned(job, status, now));
            return set(result, 'session', session);
        });
    }
    session(tx, job, incoming, now = this.now()) {
        const id = string(get(job, 'id'));
        return buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
            existing: tx.sessions.find(session => string(get(session, 'applicationId')) === id) ?? null, answers: tx.answers });
    }
}
