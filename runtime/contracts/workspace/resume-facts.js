import { safeId } from './jobs.js';
import { contentRevision, exact } from './extraction-requests.js';
import { validatedCandidate } from './extraction-proposals.js';
import { get, int, object, string, JobsError } from './values.js';
/** A resume's fact versions are immutable. Staleness is derived from the file. */
export function validateResumeFactVersion(value, expectedRevision) {
    const record = object(value, 'resume fact version');
    exact(record, ['revision', 'contentRevision', 'state', 'facts', 'createdAt', 'confirmedAt'], 'resume fact version contains unsupported fields');
    if (int(get(record, 'revision')) !== expectedRevision)
        throw new JobsError('resume fact revision is invalid');
    contentRevision(get(record, 'contentRevision'));
    const state = string(get(record, 'state'));
    if (state !== 'draft' && state !== 'confirmed')
        throw new JobsError('resume fact state is invalid');
    validatedCandidate(get(record, 'facts'));
    if (!string(get(record, 'createdAt')))
        throw new JobsError('resume fact timestamp is invalid');
    const confirmedAt = get(record, 'confirmedAt');
    if (state === 'confirmed' ? !string(confirmedAt) : confirmedAt !== null)
        throw new JobsError('resume fact confirmation is invalid');
    return record;
}
export function validateResumeFacts(document) {
    exact(document, ['schemaVersion', 'sets', 'metadata'], 'resume facts contain unsupported fields');
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('resume facts schema version is unsupported');
    object(get(document, 'metadata'), 'resume facts metadata');
    const sets = object(get(document, 'sets'), 'resume fact sets');
    for (const [key, raw] of sets.entries()) {
        const resumeId = safeId(string(key));
        const record = object(raw, 'resume fact set');
        exact(record, ['resumeId', 'versions'], 'resume fact set contains unsupported fields');
        if (string(get(record, 'resumeId')) !== resumeId)
            throw new JobsError('resume fact set identity is invalid');
        const versions = get(record, 'versions');
        if (!Array.isArray(versions) || !versions.length)
            throw new JobsError('resume fact set requires versions');
        versions.forEach((item, index) => validateResumeFactVersion(item, BigInt(index + 1)));
    }
    return document;
}
