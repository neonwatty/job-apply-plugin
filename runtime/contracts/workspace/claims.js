import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { PythonObject } from '../python-object.js';
import { PythonText } from '../python-text.js';
import { safeAnswerSessionId } from './answer-session-validation.js';
import { strip } from './job-url.js';
import { claimTime, claimTimeString } from './claim-time.js';
import { copy, fromJSON, get, has, int, keys, object, set, string, text, JobsError } from './values.js';
export const claimLeaseSeconds = 300;
export const claimHeartbeatSeconds = 60;
export function validateCoordinator(value) {
    if (!(value instanceof PythonObject))
        throw new JobsError('coordinator must be a JSON object');
    const document = value;
    const version = int(get(document, 'schemaVersion'));
    if (version === null)
        throw new JobsError('coordinator has no valid schemaVersion');
    if (version > 1n)
        throw new JobsError(`coordinator uses unsupported future schemaVersion ${version}`);
    if (version !== 1n)
        throw new JobsError(`coordinator uses unsupported schemaVersion ${version}`);
    if (document.size !== 2 || !has(document, 'claim'))
        throw new JobsError('coordinator contains unsupported fields');
    if (get(document, 'claim') !== null)
        validateClaim(get(document, 'claim'));
    return document;
}
export function validateClaim(value) {
    if (!(value instanceof PythonObject))
        throw new JobsError('coordinator claim must be a JSON object');
    const claim = value;
    const required = ['claimId', 'jobId', 'ownerLabel', 'tokenHash', 'acquiredAt', 'heartbeatAt', 'expiresAt'];
    if (claim.size !== required.length || keys(claim).some(key => !required.includes(key))
        || required.some(key => !string(get(claim, key))))
        throw new JobsError('coordinator claim is invalid');
    safeAnswerSessionId(get(claim, 'jobId'));
    for (const key of ['acquiredAt', 'heartbeatAt', 'expiresAt'])
        claimTime(string(get(claim, key)));
    return claim;
}
export function claimExpired(claim, now) {
    return claimTime(now) >= claimTime(string(get(claim, 'expiresAt')));
}
export function publicClaim(value, now) {
    if (value === null)
        return null;
    const result = copy(object(value, 'coordinator claim'));
    result.delete(text('tokenHash'));
    return set(result, 'expired', claimExpired(object(value, 'coordinator claim'), now));
}
export function claimTokenHash(token) {
    if (!(token instanceof PythonText) || !token.length)
        throw new JobsError('claim token is required');
    return createHash('sha256').update(token.encodeUtf8()).digest('hex');
}
export function makeClaim(jobId, ownerLabel, now) {
    safeAnswerSessionId(text(jobId));
    const label = string(ownerLabel);
    if (label === null || !strip(label))
        throw new JobsError('owner label must be a non-empty string');
    const instant = claimTime(now), at = claimTimeString(instant);
    const token = `claim_${randomBytes(32).toString('base64url')}`;
    const claim = object(fromJSON({ claimId: randomUUID(), jobId, ownerLabel: strip(label), tokenHash: claimTokenHash(text(token)),
        acquiredAt: at, heartbeatAt: at, expiresAt: claimTimeString(instant + BigInt(claimLeaseSeconds) * 1000000n) }), 'claim');
    const points = ownerLabel.codePoints;
    let start = 0, end = points.length;
    while (start < end && !strip(String.fromCodePoint(points[start])))
        start++;
    while (end > start && !strip(String.fromCodePoint(points[end - 1])))
        end--;
    set(claim, 'ownerLabel', PythonText.fromCodePoints(points.slice(start, end)));
    return { claim, token };
}
export function requireClaim(coordinator, jobs, jobId, token, now, allowExpired = false) {
    const value = get(coordinator, 'claim');
    if (value === null || string(get(object(value, 'claim'), 'jobId')) !== jobId)
        throw new JobsError('job is not held by this claim');
    const claim = object(value, 'claim'), expected = string(get(claim, 'tokenHash'));
    const supplied = claimTokenHash(token);
    // Hash comparison remains constant-time for normal, fixed-length hash records.
    if (!/^[\x00-\x7f]*$/.test(expected))
        throw new TypeError('comparing strings with non-ASCII characters is not supported');
    const left = Buffer.from(expected), right = Buffer.from(supplied);
    if (left.length !== right.length || !timingSafeEqual(left, right))
        throw new JobsError('claim token is invalid');
    const rawJob = get(object(get(jobs, 'jobs'), 'jobs'), jobId);
    if (rawJob === null || get(object(rawJob, 'job'), 'deletedAt') !== null
        || string(get(object(rawJob, 'job'), 'status')) !== 'in_progress')
        throw new JobsError('claimed job is not in progress');
    if (!allowExpired && claimExpired(claim, now))
        throw new JobsError('claim has expired; use explicit recovery');
    return claim;
}
export function requireJobUnclaimed(coordinator, jobId) {
    const value = get(coordinator, 'claim');
    if (value !== null && string(get(object(value, 'claim'), 'jobId')) === jobId)
        throw new JobsError('claimed job requires a coordinator operation');
}
export function heartbeatClaim(claim, now) {
    const instant = claimTime(now), result = copy(claim);
    set(result, 'heartbeatAt', text(claimTimeString(instant)));
    return set(result, 'expiresAt', text(claimTimeString(instant + BigInt(claimLeaseSeconds) * 1000000n)));
}
