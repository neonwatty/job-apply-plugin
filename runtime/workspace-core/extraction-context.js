import { randomBytes, randomUUID } from 'node:crypto';
import { get, set, int, integer, object, string, text, fromJSON, JobsError } from '../contracts/workspace/values.js';
export class ExtractionContext {
    repository;
    now;
    id;
    contentRevision;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), id = (kind) => `${kind}-${randomUUID()}`, contentRevision = () => `content_${randomBytes(24).toString('base64url')}`) {
        this.repository = repository;
        this.now = now;
        this.id = id;
        this.contentRevision = contentRevision;
    }
}
export const records = (document, key) => object(get(document, key), key);
export const profileRevision = (document) => int(get(records(document, 'metadata'), 'revision')) ?? 1n;
export function touch(document, now) { set(records(document, 'metadata'), 'updatedAt', text(now)); }
export function revision(record, expected, message) {
    if (int(get(record, 'revision')) !== expected)
        throw new JobsError(message);
}
export async function readyResume(tx, id, expected) {
    const value = get(records(tx.resumes, 'resumes'), id);
    if (value === null || get(object(value, 'resume'), 'deletedAt') !== null)
        throw new JobsError('resume does not exist');
    const resume = object(value, 'resume');
    if (string(get(resume, 'storageKind')) !== 'managed')
        throw new JobsError('resume must be adopted before extraction');
    if (expected !== undefined)
        revision(resume, expected, 'resume revision conflict');
    const observed = await tx.files.observation(resume);
    if (!observed.exists || observed.digest !== string(get(resume, 'digest')))
        throw new JobsError('resume file is not ready for extraction');
    return resume;
}
export function closeRequest(document, id, expected, status, now, failure = null, proposal = null) {
    const value = get(records(document, 'requests'), id);
    if (value === null)
        throw new JobsError('resume extraction request does not exist');
    const current = object(value, 'request');
    revision(current, expected, 'request revision conflict');
    if (string(get(current, 'status')) !== 'requested')
        throw new JobsError('resume extraction request is not open');
    set(current, 'status', text(status));
    set(current, 'failureReason', failure === null ? null : text(failure));
    set(current, 'proposalId', proposal === null ? null : text(proposal));
    set(current, 'revision', integer(expected + 1n));
    set(current, 'updatedAt', text(now));
    set(current, 'closedAt', text(now));
    touch(document, now);
    return current;
}
/** Called inside resume replacement recovery/commit, together with the new resume metadata. */
export function staleOpenRequests(document, resumeId, now) {
    let changed = false;
    for (const [id, value] of records(document, 'requests').entries()) {
        const record = object(value, 'request');
        if (string(get(record, 'resumeId')) === resumeId && string(get(record, 'status')) === 'requested') {
            closeRequest(document, string(id), int(get(record, 'revision')), 'stale', now);
            changed = true;
        }
    }
    return changed;
}
export function newRequest(context, resume, supersedes) {
    const now = context.now();
    const record = object(fromJSON({ requestId: context.id('request'), resumeId: string(get(resume, 'id')),
        revision: 1, status: 'requested', createdAt: now, updatedAt: now, closedAt: null, proposalId: null,
        failureReason: null, supersedesRequestId: supersedes }), 'request');
    return set(record, 'resumeContentRevision', get(resume, 'contentRevision'));
}
