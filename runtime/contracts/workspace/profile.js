import { get, has, object, int, string, keys, JobsError } from './values.js';
import { emptyObject } from './jobs.js';
export const factSources = new Set(['user', 'resume', 'agent', 'migration']);
export function validateProfile(document) {
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('profile schema version is unsupported');
    object(get(document, 'profile'), 'profile.profile');
    const metadata = object(get(document, 'metadata'), 'profile.metadata');
    const revision = has(metadata, 'revision') ? int(get(metadata, 'revision')) : 1n;
    if (revision === null || revision < 1n)
        throw new JobsError('profile revision must be a positive integer');
    const provenance = has(metadata, 'factProvenance') ? object(get(metadata, 'factProvenance'), 'profile fact provenance') : emptyObject();
    for (const [key, value] of provenance.entries()) {
        if (!string(key)?.startsWith('/'))
            throw new JobsError('profile fact provenance path is invalid');
        const record = object(value, 'profile fact provenance record');
        if (record.size !== 2 || keys(record).some(key => !['source', 'updatedAt'].includes(key)))
            throw new JobsError('profile fact provenance record is invalid');
        if (!factSources.has(string(get(record, 'source'))))
            throw new JobsError('profile fact provenance source is unsupported');
        if (!string(get(record, 'updatedAt')))
            throw new JobsError('profile fact provenance timestamp is invalid');
    }
    return document;
}
