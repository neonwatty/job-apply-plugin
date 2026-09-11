import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { get, set, object, string, fromJSON, JobsError } from '../contracts/workspace/values.js';
import { planLegacyJobs } from './legacy-job-plan.js';
const drift = 'legacy job preview token rejected because the source, selection, input, or store drifted';
function select(discovery, selected, committing = false) {
    if (new Set(selected).size !== selected.length)
        throw new JobsError('legacy job selection contains duplicate item ids');
    const indexed = new Map(get(discovery, 'items').map(value => {
        const item = object(value, 'legacy item');
        return [string(get(item, 'itemId')), item];
    }));
    return selected.map(id => {
        const item = indexed.get(id);
        if (!item)
            throw new JobsError(committing ? drift : 'legacy job selection contains an unknown item id');
        if (string(get(item, 'state')) !== 'valid')
            throw new JobsError(committing ? drift : 'legacy job selection contains an invalid item');
        return item;
    });
}
function tokenFor(discovery, selected, chosen, snapshot) {
    const bound = object(fromJSON({ version: 1, origin: 'migration', selection: selected }), 'legacy token');
    set(bound, 'payloads', chosen.map(item => get(item, 'job')));
    set(bound, 'selectedLocators', chosen.map(item => get(item, 'source')));
    set(bound, 'manifest', get(discovery, 'manifest'));
    set(bound, 'jobsSnapshot', snapshot);
    return 'legacy-jobs-v1.' + createHash('sha256').update(canonicalJson(bound)).digest('hex');
}
function result(discovery, selected, decisions, token, committed = false) {
    const value = object(fromJSON({ selected, committed }), 'legacy result');
    for (const key of ['root', 'manifest', 'items'])
        set(value, key, get(discovery, key));
    if (decisions !== undefined) {
        const summary = { create: 0, update: 0, noop: 0, conflict: 0, invalid: 0 };
        for (const decision of decisions)
            summary[string(get(decision, 'action'))]++;
        set(value, 'token', fromJSON(token ?? null));
        set(value, 'summary', fromJSON(summary));
        set(value, 'decisions', decisions);
    }
    return value;
}
/** Discovery-only previews never read or initialize the jobs document. */
export class LegacyJobsService {
    repository;
    discover;
    now;
    constructor(repository, discover, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.discover = discover;
        this.now = now;
    }
    async preview(selected) {
        const discovery = await this.discover();
        if (!selected.length)
            return result(discovery, []);
        const chosen = select(discovery, selected);
        return this.repository.legacyTransaction(async (transaction) => {
            const { document, snapshot } = await transaction.snapshot();
            const token = tokenFor(discovery, selected, chosen, snapshot);
            const { decisions } = planLegacyJobs(document, chosen, this.now());
            return result(discovery, selected, decisions, token);
        });
    }
    async commit(selected, token) {
        if (!selected.length || typeof token !== 'string' || !token) {
            throw new JobsError('legacy job commit requires selection and a preview token');
        }
        return this.repository.legacyTransaction(async (transaction) => {
            const discovery = await this.discover(), chosen = select(discovery, selected, true);
            const { document, snapshot } = await transaction.snapshot();
            const expected = Buffer.from(tokenFor(discovery, selected, chosen, snapshot));
            const supplied = Buffer.from(token);
            if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied))
                throw new JobsError(drift);
            const planned = planLegacyJobs(document, chosen, this.now());
            if (planned.changed)
                await transaction.save(planned.document);
            return result(discovery, selected, planned.decisions, token, planned.changed);
        });
    }
}
