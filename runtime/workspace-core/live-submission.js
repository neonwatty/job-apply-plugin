import { createHash, randomBytes } from 'node:crypto';
import { requireJobUnclaimed } from '../contracts/workspace/claims.js';
import { safeId, validateJob } from '../contracts/workspace/jobs.js';
import { liveSubmissionEnabled } from '../contracts/workspace/submission-preference.js';
import { get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { preflightJobRecord, reviewedInputsFingerprint } from './job-preflight.js';
import { canonicalSubmissionObservation, isSubmissionFingerprint, matchesSubmissionFingerprint, privateSubmissionFingerprint } from './submission-fingerprint.js';
const sha = (value) => createHash('sha256').update(value).digest('hex');
const revision = (value) => `sha256:${sha(JSON.stringify(value))}`;
const opaque = () => randomBytes(32).toString('hex');
const fingerprint = (value) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const opaqueId = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const liveSubmissionJobKey = (id) => `job-${sha(id)}`;
const check = (condition, reason) => { if (!condition)
    throw new JobsError(reason); };
function receipt(jobId, action, storeUpdated) {
    const receiptId = 'receiptId' in action ? action.receiptId : `receipt:${sha(`${jobId}:${action.claimId}`)}`;
    return { status: 'confirmed_submitted', evidence: 'agent_observed_portal_confirmation',
        receiptId, storeUpdated };
}
export function projectSubmissionOutcome(jobId, value, applied) {
    const action = value;
    if (!action)
        return null;
    if (action.status !== 'confirmed')
        return { status: 'verify_submission_status' };
    check('receiptId' in action ? /^receipt:[a-f0-9]{64}$/.test(action.receiptId) && fingerprint(action.targetFingerprint)
        : opaqueId(action.claimId) && fingerprint(action.confirmation), 'submission ledger is invalid');
    return receipt(jobId, action, applied);
}
function fields(value, names) {
    check(typeof value === 'object' && value !== null && !Array.isArray(value)
        && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key)), 'invalid submission request');
    return value;
}
function readJobRevision(item) {
    const jobId = safeId(typeof item.jobId === 'string' ? item.jobId : null);
    if (typeof item.jobRevision !== 'string' || !/^[1-9][0-9]{0,29}$/.test(item.jobRevision))
        throw new JobsError('an exact job revision is required');
    return { jobId, jobRevision: item.jobRevision };
}
function readItem(raw) {
    const item = fields(raw, ['jobId', 'jobRevision', 'reviewFingerprint']);
    if (!isSubmissionFingerprint(item.reviewFingerprint))
        throw new JobsError('a private browser review fingerprint is required');
    return { ...readJobRevision(item), reviewFingerprint: item.reviewFingerprint };
}
function activeJob(tx, id) {
    const value = get(object(get(tx.jobs, 'jobs'), 'jobs'), id);
    if (value === null)
        return null;
    const job = object(value, 'job');
    return get(job, 'deletedAt') === null ? job : null;
}
function postingFingerprint(job) {
    return revision(['canonical-posting', string(get(job, 'normalizedUrl'))]);
}
async function saveApplied(tx, id, job, now) {
    const at = new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
    set(job, 'status', text('applied'));
    set(job, 'closedOutcome', null);
    set(job, 'revision', integer(int(get(job, 'revision')) + 1n));
    set(job, 'updatedAt', text(at));
    set(object(get(tx.jobs, 'metadata'), 'jobs metadata'), 'updatedAt', text(at));
    validateJob(id, job);
    await tx.saveJobs(tx.jobs);
}
function profileRevision(tx) {
    check(liveSubmissionEnabled(tx.profile), 'Submit after approval is off');
    return (int(get(object(get(tx.profile, 'metadata'), 'profile metadata'), 'revision')) ?? 1n).toString();
}
async function bind(tx, item) {
    const job = activeJob(tx, item.jobId);
    if (job === null)
        throw new JobsError('job review is no longer current');
    check(string(get(job, 'status')) === 'awaiting_review'
        && int(get(job, 'revision'))?.toString() === item.jobRevision, 'job review is no longer current');
    requireJobUnclaimed(tx.coordinator, item.jobId);
    const session = tx.sessions.find(entry => string(get(entry, 'applicationId')) === item.jobId);
    check(session && string(get(session, 'status')) === 'review' && get(session, 'readiness') !== null, 'verified live review is required');
    const ready = object(get(session, 'readiness'), 'review readiness');
    check(string(get(ready, 'status')) === 'ready' && string(get(ready, 'evidenceKind')) === 'agent_attested_current_attempt'
        && int(get(ready, 'attemptRevision')) === BigInt(item.jobRevision) - 1n, 'verified live review is required');
    check(!tx.history.some(event => string(get(event, 'applicationId')) === item.jobId
        && ['status', 'event'].some(key => ['completed', 'applied', 'submitted', 'confirmed_submitted'].includes(string(get(event, key)) ?? ''))), 'application history already shows submission');
    const preflight = await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs);
    const reviewedInputs = reviewedInputsFingerprint(tx.jobs, tx.resumes);
    check(get(preflight, 'ready') === true && reviewedInputs !== null
        && reviewedInputs === string(get(session, 'reviewedInputsFingerprint')), 'the reviewed résumé or confirmed facts are no longer verified');
    return { ...item, workspaceFingerprint: revision([
            string(get(job, 'normalizedUrl')), int(get(ready, 'attemptRevision'))?.toString(),
            int(get(ready, 'observationRevision'))?.toString(), string(get(ready, 'controlSetFingerprint')), reviewedInputs,
        ]) };
}
export class LiveSubmissionService {
    repository;
    ledger;
    now;
    constructor(repository, ledger, now = Date.now) {
        this.repository = repository;
        this.ledger = ledger;
        this.now = now;
    }
    status() {
        return this.repository.claimTransaction(async (tx) => ({ enabled: liveSubmissionEnabled(tx.profile) }));
    }
    fingerprint(input) {
        const packet = fields(input, ['jobId', 'jobRevision', 'observation']);
        const { jobId, jobRevision } = readJobRevision(packet);
        const observation = canonicalSubmissionObservation(packet.observation);
        return this.repository.claimTransaction(async (tx) => {
            profileRevision(tx);
            const job = activeJob(tx, jobId);
            check(job && string(get(job, 'status')) === 'awaiting_review' && int(get(job, 'revision'))?.toString() === jobRevision, 'job review is no longer current');
            const key = await this.fingerprintKey(true);
            return { reviewFingerprint: privateSubmissionFingerprint(observation, key, jobId, jobRevision) };
        });
    }
    async fingerprintKey(create = false) {
        const name = 'review-fingerprint-key';
        const stored = await this.ledger.read(name);
        if (stored === null && create) {
            const key = opaque();
            await this.ledger.write(name, { key });
            return key;
        }
        if (!opaqueId(stored?.key))
            throw new JobsError('a private browser review fingerprint is required');
        return stored.key;
    }
    verifyFingerprint({ reviewFingerprint, jobId, jobRevision }, key) {
        check(matchesSubmissionFingerprint(reviewFingerprint, key, jobId, jobRevision), 'browser review fingerprint does not match this job');
    }
    preview(input, approvedId) {
        const { jobs } = fields(input, ['jobs']);
        check(Array.isArray(jobs) && jobs.length >= 1 && jobs.length <= 10, 'select one to ten reviewed jobs');
        const items = jobs.map(readItem);
        check(new Set(items.map(item => item.jobId)).size === items.length, 'reviewed jobs must be unique');
        return this.repository.claimTransaction(async (tx) => {
            const profile = profileRevision(tx);
            const key = await this.fingerprintKey();
            const bound = [];
            for (const item of items) {
                this.verifyFingerprint(item, key);
                check(await this.ledger.read(liveSubmissionJobKey(item.jobId)) === null, 'verify submission status before another attempt');
                bound.push(await bind(tx, item));
            }
            const previewId = revision({ profile, items: bound });
            if (approvedId === undefined)
                return { status: 'awaiting_approval', previewId, jobs: items.map(item => item.jobId) };
            check(approvedId === previewId, 'submission preview changed; request a fresh approval');
            const approvalId = opaque(), expiresAt = this.now() + 300_000;
            const approval = { expiresAt, profileRevision: profile, items: bound };
            await this.ledger.write(`approval-${approvalId}`, approval);
            return { status: 'approved', approvalId, expiresAt: new Date(expiresAt).toISOString() };
        });
    }
    claim(approvalId, input) {
        check(opaqueId(approvalId), 'invalid submission approval');
        const item = readItem(input);
        return this.repository.claimTransaction(async (tx) => {
            const profile = profileRevision(tx);
            const approval = await this.ledger.read(`approval-${approvalId}`);
            check(approval && approval.profileRevision === profile && Number.isSafeInteger(approval.expiresAt)
                && this.now() < approval.expiresAt && Array.isArray(approval.items), 'submission approval expired or the saved setting changed');
            this.verifyFingerprint(item, await this.fingerprintKey());
            const permitted = approval.items.find(row => row.jobId === item.jobId);
            check(permitted && JSON.stringify(permitted) === JSON.stringify(await bind(tx, item)), 'the application changed after approval');
            check(await this.ledger.read(liveSubmissionJobKey(item.jobId)) === null, 'verify submission status before another attempt');
            for (const other of approval.items) {
                const active = await this.ledger.read(liveSubmissionJobKey(other.jobId));
                check(active?.status !== 'claimed', 'check the previous application outcome before continuing');
            }
            const now = this.now();
            check(now < approval.expiresAt, 'submission approval expired');
            const useBefore = Math.min(approval.expiresAt, now + 15_000);
            const claimId = opaque();
            const action = { approvalId, claimId, jobRevision: item.jobRevision, status: 'claimed',
                targetFingerprint: postingFingerprint(activeJob(tx, item.jobId)) };
            const key = liveSubmissionJobKey(item.jobId);
            await this.ledger.write(key, action);
            if (this.now() >= useBefore) {
                // The Store lock is still held and no caller has received the claim.
                await this.ledger.write(key, null);
                throw new JobsError('submission approval expired before the attempt was issued');
            }
            return { status: 'claimed', claimId, useBefore: new Date(useBefore).toISOString() };
        });
    }
    outcome(input) {
        const { jobId: rawId, claimId, status, confirmation } = fields(input, ['jobId', 'claimId', 'status', 'confirmation']);
        const jobId = safeId(typeof rawId === 'string' ? rawId : null);
        check(opaqueId(claimId) && (status === 'confirmed' ? fingerprint(confirmation)
            : status === 'uncertain' && confirmation === null), 'a valid attempt and portal confirmation status are required');
        return this.repository.claimTransaction(async (tx) => {
            const key = liveSubmissionJobKey(jobId);
            const prior = await this.ledger.read(key);
            check(prior?.claimId === claimId, 'submission attempt does not match');
            const record = prior.status === 'confirmed' ? prior : {
                ...prior, status: status,
                ...(typeof confirmation === 'string' ? { confirmation } : {}),
            };
            check(status !== 'confirmed' || record.confirmation === confirmation, 'the verified receipt cannot change');
            if (prior.status !== 'confirmed')
                await this.ledger.write(key, record);
            if (record.status !== 'confirmed')
                return { status: 'verify_submission_status' };
            const job = activeJob(tx, jobId);
            if (job === null)
                return receipt(jobId, record, false);
            const current = int(get(job, 'revision'));
            const alreadyApplied = string(get(job, 'status')) === 'applied';
            if (current?.toString() !== record.jobRevision
                || string(get(job, 'status')) !== 'awaiting_review') {
                return receipt(jobId, record, alreadyApplied);
            }
            requireJobUnclaimed(tx.coordinator, jobId);
            await saveApplied(tx, jobId, job, this.now());
            return receipt(jobId, record, true);
        });
    }
    inspect(jobId) {
        safeId(jobId);
        return this.repository.claimTransaction(async (tx) => {
            const action = await this.ledger.read(liveSubmissionJobKey(jobId));
            const job = activeJob(tx, jobId);
            return projectSubmissionOutcome(jobId, action, job !== null && string(get(job, 'status')) === 'applied')
                ?? { status: 'no_agent_attempt' };
        });
    }
    confirmedReceiptForTransfer(jobId) {
        safeId(jobId);
        return this.repository.claimTransaction(async (tx) => {
            const action = await this.ledger.read(liveSubmissionJobKey(jobId));
            const job = activeJob(tx, jobId);
            if (job === null || action?.status !== 'confirmed')
                throw new JobsError('source has no confirmed submission for this job');
            const targetFingerprint = postingFingerprint(job);
            if (action.targetFingerprint === undefined) {
                // Older receipts predate the posting binding. Only the original applied revision is safe to transfer.
                check('jobRevision' in action && /^[1-9][0-9]{0,29}$/.test(action.jobRevision) && string(get(job, 'status')) === 'applied'
                    && int(get(job, 'revision')) === BigInt(action.jobRevision) + 1n, 'source posting cannot be verified');
            }
            else
                check(action.targetFingerprint === targetFingerprint, 'source posting changed after submission');
            const result = projectSubmissionOutcome(jobId, action, true);
            if (result?.status !== 'confirmed_submitted')
                throw new JobsError('source has no confirmed submission for this job');
            return { status: 'confirmed', receiptId: result.receiptId, targetFingerprint };
        });
    }
    async reconcileFrom(source, jobId, expectedRevision) {
        safeId(jobId);
        check(/^[1-9][0-9]{0,29}$/.test(expectedRevision), 'an exact destination job revision is required');
        const expected = BigInt(expectedRevision), incoming = await source.confirmedReceiptForTransfer(jobId);
        return this.repository.claimTransaction(async (tx) => {
            const job = activeJob(tx, jobId);
            if (job === null || postingFingerprint(job) !== incoming.targetFingerprint)
                throw new JobsError('destination posting does not match the receipt');
            requireJobUnclaimed(tx.coordinator, jobId);
            const key = liveSubmissionJobKey(jobId);
            const stored = await this.ledger.read(key);
            const prior = projectSubmissionOutcome(jobId, stored, false);
            check(prior === null || prior.status === 'confirmed_submitted' && prior.receiptId === incoming.receiptId, 'destination already has a different submission attempt');
            const current = int(get(job, 'revision')), status = string(get(job, 'status'));
            if (prior !== null && status === 'applied' && (current === expected || current === expected + 1n)) {
                return receipt(jobId, incoming, true);
            }
            check(current === expected, 'destination job revision conflict');
            check(status !== 'in_progress' && (status !== 'closed' || string(get(job, 'closedOutcome')) === 'duplicate'), 'destination job is unavailable for reconciliation');
            if (prior === null)
                await this.ledger.write(key, incoming);
            if (status !== 'applied')
                await saveApplied(tx, jobId, job, this.now());
            return receipt(jobId, incoming, true);
        });
    }
}
