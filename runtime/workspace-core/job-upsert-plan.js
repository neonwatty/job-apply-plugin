import { createHash } from 'node:crypto';
import { PythonObject } from '../contracts/python-object.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { normalizeJobUrl, strip } from '../contracts/workspace/job-url.js';
import { emptyObject, ingestFields, validateJob } from '../contracts/workspace/jobs.js';
import { copy, get, has, set, object, string, text, integer, int, keys, same, fromJSON, parse, serialize, JobsError } from '../contracts/workspace/values.js';
import { mayUpdate, nonempty, stamp } from './job-provenance.js';
function normalizeItem(value) {
    if (!(value instanceof PythonObject))
        throw new JobsError('job upsert item must be a JSON object');
    const item = value;
    if (keys(item).some(field => !ingestFields.has(field)))
        throw new JobsError('job upsert item contains unsupported fields');
    if (!nonempty(get(item, 'url')))
        throw new JobsError('job upsert item requires a URL');
    for (const field of ingestFields) {
        const value = get(item, field);
        if (field !== 'priority' && value !== null && string(value) === null) {
            throw new JobsError(`job upsert item.${field} must be a string`);
        }
    }
    const priority = get(item, 'priority');
    if (priority !== null && (int(priority) === null || int(priority) < 0n || int(priority) > 5n)) {
        throw new JobsError('job upsert item.priority must be an integer from 0 to 5');
    }
    const normalized = emptyObject();
    for (const field of keys(item)) {
        const value = get(item, field);
        if (nonempty(value))
            set(normalized, field, string(value) === null ? value : text(strip(string(value))));
    }
    set(normalized, 'normalizedUrl', text(normalizeJobUrl(string(get(normalized, 'url')))));
    return normalized;
}
const sourceName = (record) => strip(string(get(record, 'source')) ?? '').toLowerCase();
function sourceIdentity(record) {
    const source = sourceName(record), id = strip(string(get(record, 'sourceId')) ?? '');
    return source && id ? JSON.stringify([source, id]) : null;
}
function batchConflicts(items) {
    const identities = new Map(), conflicts = new Set();
    items.forEach((item, index) => {
        if (!item)
            return;
        const identityKeys = ['url:' + string(get(item, 'normalizedUrl'))];
        const source = sourceIdentity(item);
        if (source !== null)
            identityKeys.push('source:' + source);
        for (const key of identityKeys)
            identities.set(key, [...(identities.get(key) ?? []), index]);
    });
    for (const indexes of identities.values()) {
        if (new Set(indexes.map(index => canonicalJson(items[index]))).size > 1) {
            for (const index of indexes)
                conflicts.add(index);
        }
    }
    return conflicts;
}
function incompatible(current, item) {
    const previous = sourceIdentity(current), incoming = sourceIdentity(item);
    const sourceChanged = nonempty(get(current, 'source')) && nonempty(get(item, 'source'))
        && sourceName(current) !== sourceName(item);
    const idChanged = nonempty(get(current, 'sourceId')) && nonempty(get(item, 'sourceId'))
        && strip(string(get(current, 'sourceId'))) !== strip(string(get(item, 'sourceId')));
    return !same(get(current, 'normalizedUrl'), get(item, 'normalizedUrl'))
        || previous !== null && incoming !== null && previous !== incoming || sourceChanged || idChanged;
}
export function planJobUpsert(currentDocument, raw, author, now) {
    const errors = [];
    const normalized = raw.map(value => {
        try {
            const item = normalizeItem(value);
            errors.push(null);
            return item;
        }
        catch (error) {
            if (!(error instanceof JobsError))
                throw error;
            errors.push(error.message);
            return null;
        }
    });
    const conflicts = batchConflicts(normalized);
    const document = object(parse(serialize(currentDocument)), 'jobs');
    const jobs = object(get(document, 'jobs'), 'jobs.jobs');
    const decisions = [];
    let changed = false;
    const decide = (value) => { decisions.push(object(fromJSON(value), 'upsert decision')); };
    normalized.forEach((item, index) => {
        if (!item) {
            decide({ index, action: 'invalid', reason: errors[index] });
            return;
        }
        if (conflicts.has(index)) {
            decide({ index, action: 'conflict', reason: 'differing duplicate identities in input' });
            return;
        }
        const records = jobs.entries().map(([, value]) => object(value, 'job record'));
        const urlMatches = records.filter(record => same(get(record, 'normalizedUrl'), get(item, 'normalizedUrl')));
        const source = sourceIdentity(item);
        const sourceMatches = source === null ? [] : records.filter(record => sourceIdentity(record) === source);
        const matches = new Map([...urlMatches, ...sourceMatches].map(record => [string(get(record, 'id')), record]));
        if (urlMatches.length > 1 || sourceMatches.length > 1 || matches.size > 1
            || [...matches.values()].some(record => get(record, 'deletedAt') !== null)) {
            decide({ index, action: 'conflict', reason: 'job identities do not resolve to one active record' });
            return;
        }
        const current = matches.values().next().value;
        if (current) {
            const id = string(get(current, 'id'));
            const provenance = has(current, 'provenance') ? object(get(current, 'provenance'), 'job provenance') : emptyObject();
            if (incompatible(current, item)) {
                decide({ index, action: 'conflict', id, reason: 'incoming identity is incompatible with stored identity' });
                return;
            }
            const updated = copy(current), accepted = [];
            for (const field of ingestFields) {
                if (!has(item, field) || field === 'url' || author === 'agent' && !mayUpdate(current, provenance, field))
                    continue;
                if (!same(get(current, field), get(item, field))) {
                    set(updated, field, get(item, field));
                    accepted.push(field);
                }
            }
            if (!accepted.length) {
                decide({ index, action: 'noop', id });
                return;
            }
            set(updated, 'provenance', stamp(provenance, accepted, author, updated, now));
            set(updated, 'revision', integer(int(get(current, 'revision')) + 1n));
            set(updated, 'updatedAt', text(now));
            validateJob(id, updated);
            set(jobs, id, updated);
            decide({ index, action: 'update', id, fields: accepted.sort() });
            changed = true;
            return;
        }
        const id = 'job-' + createHash('sha256').update('url\0' + string(get(item, 'normalizedUrl'))).digest('hex').slice(0, 24);
        if (has(jobs, id)) {
            decide({ index, action: 'conflict', id, reason: 'deterministic job id is already in use' });
            return;
        }
        const record = copy(item), fields = [...ingestFields].filter(field => has(item, field));
        set(record, 'id', text(id));
        if (!has(record, 'priority'))
            set(record, 'priority', integer(0n));
        set(record, 'status', text('saved'));
        set(record, 'closedOutcome', null);
        set(record, 'provenance', stamp(emptyObject(), fields, author, item, now));
        set(record, 'revision', integer(1n));
        set(record, 'createdAt', text(now));
        set(record, 'updatedAt', text(now));
        set(record, 'deletedAt', null);
        try {
            validateJob(id, record);
        }
        catch (error) {
            if (!(error instanceof JobsError))
                throw error;
            decide({ index, action: 'invalid', reason: error.message });
            return;
        }
        set(jobs, id, record);
        decide({ index, action: 'create', id });
        changed = true;
    });
    if (changed)
        set(object(get(document, 'metadata'), 'jobs.metadata'), 'updatedAt', text(now));
    return { document, decisions, changed };
}
