import { copy, fromJSON, get, has, int, keys, object, set, string, text, JobsError } from './values.js';
import { strip } from './job-url.js';
export function exact(record, fields, message) {
    if (record.size !== fields.length || fields.some(field => !has(record, field)))
        throw new JobsError(message);
}
export function optionalEmail(value, label) {
    if (value === null)
        return null;
    const raw = string(value);
    if (raw === null)
        throw new JobsError(`${label} must be an email address or null`);
    const normalized = strip(raw);
    const whitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u;
    if ([...normalized].length > 254 || whitespace.test(normalized) || !/^[^@]+@[^@]+\.[^@]+$/u.test(normalized)) {
        throw new JobsError(`${label} must be a valid email address`);
    }
    return fromJSON(normalized);
}
export function revisionAndTime(record, label) {
    if ((int(get(record, 'revision')) ?? 0n) < 1n)
        throw new JobsError(`${label} revision must be a positive integer`);
    for (const field of ['createdAt', 'updatedAt'])
        if (!string(get(record, field)))
            throw new JobsError(`${label} timestamp is invalid`);
}
export function validateSettings(value) {
    const record = object(value, 'automation settings');
    exact(record, ['enabled', 'automaticAccountCreation', 'signupEmail', 'passwordStrategy', 'revision', 'createdAt', 'updatedAt'], 'automation settings contain unsupported fields');
    if (typeof get(record, 'enabled') !== 'boolean' || typeof get(record, 'automaticAccountCreation') !== 'boolean')
        throw new JobsError('automation settings switches must be booleans');
    optionalEmail(get(record, 'signupEmail'), 'signup email');
    if (!['unique_per_realm', 'shared', 'custom', 'ask_each_time'].includes(string(get(record, 'passwordStrategy')) ?? ''))
        throw new JobsError('password strategy is unsupported');
    revisionAndTime(record, 'automation settings');
    return record;
}
export function validateSettingsDocument(value) {
    const document = object(value, 'automation settings');
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('automation settings schema version is unsupported');
    exact(document, ['schemaVersion', 'settings'], 'automation settings document contains unsupported fields');
    validateSettings(get(document, 'settings'));
    return document;
}
export function publicSettings(record) {
    const result = copy(record);
    result.delete(text('signupEmail'));
    return set(result, 'signupEmailConfigured', get(record, 'signupEmail') !== null);
}
export function settingsPatch(value) {
    const patch = object(value, 'automation settings patch');
    if (!patch.size || keys(patch).some(key => !['enabled', 'automaticAccountCreation', 'signupEmail', 'passwordStrategy'].includes(key)))
        throw new JobsError('automation settings patch contains unsupported fields');
    return patch;
}
