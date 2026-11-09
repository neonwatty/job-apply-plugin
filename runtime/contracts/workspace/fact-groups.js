import { get, object, int, string, keys, JobsError } from './values.js';
import { strip } from './job-url.js';
export function id(value) {
    if (!/^[a-f0-9]{32}$/.test(value))
        throw new JobsError('fact group id is invalid');
    return value;
}
export function label(value) {
    const raw = string(value);
    if (raw === null)
        throw new JobsError('fact group label must be a string');
    const result = strip(raw);
    if (!result || [...result].length > 80 || /[\x00-\x1f]/.test(result))
        throw new JobsError('fact group label must contain 1 to 80 printable characters');
    return result;
}
export function paths(value) {
    if (!Array.isArray(value) || !value.length || value.length > 128 || value.some(item => string(item) === null)
        || new Set(value.map(item => string(item))).size !== value.length)
        throw new JobsError('fact group paths must contain 1 to 128 unique JSON pointers');
    for (const item of value) {
        const path = string(item);
        if (!path.startsWith('/') || path.split('/').slice(1).some(part => !part || /~(?![01])/.test(part)))
            throw new JobsError('fact group path is invalid');
    }
    return value.slice();
}
export function order(value) {
    const result = int(value);
    if (result === null || result < 0n || result > 1000000n)
        throw new JobsError('fact group order must be an integer between 0 and 1000000');
    return result;
}
export function validateGroups(document) {
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('fact groups schema version is unsupported');
    if (document.size !== 3 || keys(document).some(key => !['schemaVersion', 'groups', 'metadata'].includes(key)))
        throw new JobsError('fact groups contains unsupported fields');
    const groups = object(get(document, 'groups'), 'fact groups.groups'), metadata = object(get(document, 'metadata'), 'fact groups.metadata');
    if (metadata.size !== 2 || keys(metadata).some(key => !['createdAt', 'updatedAt'].includes(key)))
        throw new JobsError('fact groups metadata is invalid');
    if (!string(get(metadata, 'createdAt')) || !string(get(metadata, 'updatedAt')))
        throw new JobsError('fact groups metadata timestamp is invalid');
    for (const [key, value] of groups.entries()) {
        const name = id(string(key)), record = object(value, 'fact group record');
        if (record.size !== 7 || keys(record).some(key => !['id', 'label', 'paths', 'order', 'revision', 'createdAt', 'updatedAt'].includes(key)) || string(get(record, 'id')) !== name)
            throw new JobsError('fact group record is invalid');
        label(get(record, 'label'));
        paths(get(record, 'paths'));
        order(get(record, 'order'));
        if (int(get(record, 'revision')) === null || int(get(record, 'revision')) < 1n)
            throw new JobsError('fact group revision must be a positive integer');
        if (!string(get(record, 'createdAt')) || !string(get(record, 'updatedAt')))
            throw new JobsError('fact group timestamp is invalid');
    }
    return document;
}
