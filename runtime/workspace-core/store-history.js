import { randomUUID } from 'node:crypto';
import { safeId } from '../contracts/workspace/jobs.js';
import { copy, fromJSON, get, has, int, keys, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
const writableEvents = new Set([
    'started', 'progressed', 'reviewed', 'completed', 'abandoned', 'failed',
    'job-started', 'job-restarted', 'legacy-review-rebuild', 'claim-recovered', 'job-blocked',
]);
const fields = new Set([
    'schemaVersion', 'eventId', 'applicationId', 'event', 'company', 'role', 'ats', 'status', 'answerKeys', 'at',
]);
const inputFields = new Set(['applicationId', 'event', 'company', 'role', 'ats', 'status', 'answerKeys', 'at']);
function answerKeys(record) {
    const raw = get(record, 'answerKeys');
    if (!Array.isArray(raw) || raw.some(item => string(item) === null)) {
        throw new JobsError('history answerKeys list is invalid');
    }
    return raw.map(item => string(item));
}
function optionalStrings(record) {
    for (const field of ['company', 'role', 'ats', 'status']) {
        if (has(record, field) && get(record, field) !== null && string(get(record, field)) === null) {
            throw new JobsError(`history event.${field} must be a string`);
        }
    }
}
export function validateHistoryRecord(value, writing = false) {
    const event = object(value, 'history event');
    if (keys(event).some(key => !fields.has(key)))
        throw new JobsError('history event contains unsupported fields');
    if (int(get(event, 'schemaVersion')) !== 1n)
        throw new JobsError('history schema version is unsupported');
    safeId(string(get(event, 'applicationId')));
    const name = string(get(event, 'event'));
    if (name === null || !/^[a-z][a-z0-9-]{0,63}$/.test(name))
        throw new JobsError('history event type is invalid');
    if (writing && !writableEvents.has(name))
        throw new JobsError('history event type is unsupported');
    if (!string(get(event, 'eventId')))
        throw new JobsError('history event id is invalid');
    if (!string(get(event, 'at')))
        throw new JobsError('history event timestamp is invalid');
    answerKeys(event);
    optionalStrings(event);
    return event;
}
export class HistoryService {
    repository;
    now;
    id;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), id = () => randomUUID()) {
        this.repository = repository;
        this.now = now;
        this.id = id;
    }
    async append(value) {
        const incoming = object(value, 'history input');
        if (keys(incoming).some(key => !inputFields.has(key)))
            throw new JobsError('history event contains unsupported fields');
        const event = object(fromJSON({ schemaVersion: 1, eventId: this.id(), at: this.now() }), 'history event');
        for (const [key, item] of incoming.entries())
            event.set(key, item);
        if (!has(event, 'answerKeys'))
            set(event, 'answerKeys', []);
        if (!has(incoming, 'at'))
            set(event, 'at', text(this.now()));
        validateHistoryRecord(event, true);
        const references = answerKeys(event);
        return this.repository.historyTransaction(async (transaction) => {
            for (const key of references)
                if (!await transaction.answerExists(key)) {
                    throw new JobsError('history answerKey does not reference an existing answer');
                }
            await transaction.append(event);
            return copy(event);
        });
    }
    list() {
        return this.repository.historyTransaction(async (transaction) => {
            const events = await transaction.read();
            return events.map(value => copy(validateHistoryRecord(value)));
        });
    }
}
