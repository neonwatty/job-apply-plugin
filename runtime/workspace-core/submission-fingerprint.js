import { createHmac, timingSafeEqual } from 'node:crypto';
import { JobsError } from '../contracts/workspace/values.js';
const masked = /^(?:\[(?:redacted|masked)\]|<(?:redacted|masked)>|[•●*]{3,})$/i;
function invalid() { throw new JobsError('exact observed form values are required'); }
function record(input, keys) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length
        || !keys.every(key => Object.hasOwn(input, key)))
        invalid();
    return input;
}
function exactText(value, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || masked.test(value.trim()))
        invalid();
    return value;
}
function destination(value) {
    const raw = exactText(value);
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        invalid();
    }
    if (url.protocol !== 'https:' || url.username || url.password)
        invalid();
    return raw;
}
/** Produces a canonical serialization of the browser's exact current logical controls. */
export function canonicalSubmissionObservation(input) {
    const form = record(input, ['destination', 'jobIdentity', 'finalControl', 'controls', 'complete']);
    const final = record(form.finalControl, ['id', 'label', 'enabled']);
    if (form.complete !== true || final.enabled !== true || !Array.isArray(form.controls)
        || !form.controls.length || form.controls.length > 256)
        invalid();
    const controls = form.controls.map(value => {
        const row = record(value, ['id', 'kind', 'value']);
        const id = exactText(row.id);
        if (row.kind === 'text')
            return { id, kind: row.kind, value: exactText(row.value, true) };
        if (row.kind === 'check' && typeof row.value === 'boolean')
            return { id, kind: row.kind, value: row.value };
        if ((row.kind === 'choice' || row.kind === 'file') && Array.isArray(row.value)) {
            return { id, kind: row.kind, value: row.value.map(item => exactText(item)) };
        }
        return invalid();
    }).sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
    if (new Set(controls.map(row => row.id)).size !== controls.length)
        invalid();
    return JSON.stringify({
        version: 1, destination: destination(form.destination), jobIdentity: exactText(form.jobIdentity),
        finalControl: { id: exactText(final.id), label: exactText(final.label), enabled: true }, controls,
    });
}
const proofPattern = /^review-v1:([a-f0-9]{64}):([a-f0-9]{64})$/;
export const isSubmissionFingerprint = (value) => typeof value === 'string' && proofPattern.test(value);
function hmac(key, data) {
    return createHmac('sha256', Buffer.from(key, 'hex')).update(data).digest('hex');
}
function proofTag(key, jobId, revision, digest) {
    return hmac(key, JSON.stringify(['review-proof-v1', jobId, revision, digest]));
}
export function privateSubmissionFingerprint(observation, key, jobId, revision) {
    const digest = hmac(key, observation);
    return `review-v1:${digest}:${proofTag(key, jobId, revision, digest)}`;
}
export function matchesSubmissionFingerprint(proof, key, jobId, revision) {
    const match = proofPattern.exec(proof);
    return match !== null && timingSafeEqual(Buffer.from(match[2], 'hex'), Buffer.from(proofTag(key, jobId, revision, match[1]), 'hex'));
}
