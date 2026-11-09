import { get, has, set, object, string, text, integer, int, same, JobsError } from '../contracts/workspace/values.js';
import { validateJob } from '../contracts/workspace/jobs.js';
import { planJobUpsert } from './job-upsert-plan.js';
function sources(record) {
    return has(record, 'legacySources') ? get(record, 'legacySources') : [];
}
function identity(value) {
    const source = object(value, 'legacy source');
    return JSON.stringify(['sourceKind', 'relativePath', 'entryId'].map(key => string(get(source, key))));
}
function compareSources(left, right) {
    const a = object(left, 'legacy source'), b = object(right, 'legacy source');
    for (const key of ['relativePath', 'entryId']) {
        const result = text(string(get(a, key))).compare(text(string(get(b, key))));
        if (result)
            return result;
    }
    return 0;
}
/** Locators identify an imported entry even when its URL or report bytes later change. */
export function planLegacyJobs(document, chosen, now) {
    const records = object(get(document, 'jobs'), 'jobs.jobs').entries().map(([, value]) => object(value, 'job'));
    const targets = chosen.map(item => {
        const locator = identity(get(item, 'source'));
        const matches = records.filter(record => sources(record).some(source => identity(source) === locator));
        if (matches.length > 1)
            throw new JobsError('legacy source locator resolves to multiple jobs');
        return matches.length ? string(get(matches[0], 'id')) : null;
    });
    const planned = planJobUpsert(document, chosen.map(item => get(item, 'job')), 'migration', now, targets);
    const jobs = object(get(planned.document, 'jobs'), 'jobs.jobs');
    chosen.forEach((item, index) => {
        const decision = planned.decisions[index];
        set(decision, 'itemId', get(item, 'itemId'));
        const action = string(get(decision, 'action'));
        if (action === 'conflict' || action === 'invalid')
            return;
        const id = string(get(decision, 'id'));
        const record = object(get(jobs, id), 'job');
        const previous = sources(record), locator = get(item, 'source'), locatorIdentity = identity(locator);
        let replaced = false;
        const merged = previous.map(source => {
            if (identity(source) !== locatorIdentity)
                return source;
            replaced = true;
            return locator;
        });
        if (!replaced)
            merged.push(locator);
        merged.sort(compareSources);
        if (same(merged, previous))
            return;
        set(record, 'legacySources', merged);
        if (action === 'noop') {
            set(record, 'revision', integer(int(get(record, 'revision')) + 1n));
            set(record, 'updatedAt', text(now));
            set(decision, 'action', text('update'));
            set(decision, 'fields', [text('legacySources')]);
        }
        else if (action === 'update') {
            const fields = get(decision, 'fields').map(value => string(value));
            set(decision, 'fields', [...new Set([...fields, 'legacySources'])].sort().map(text));
        }
        planned.changed = true;
        set(object(get(planned.document, 'metadata'), 'jobs.metadata'), 'updatedAt', text(now));
        validateJob(id, record);
    });
    if (planned.changed && string(get(object(get(document, 'metadata'), 'jobs.metadata'), 'createdAt')) === '1970-01-01T00:00:00Z') {
        set(object(get(planned.document, 'metadata'), 'jobs.metadata'), 'createdAt', text(now));
    }
    return planned;
}
