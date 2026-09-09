import { factSources, validateProfile } from '../contracts/workspace/profile.js';
import { copy, get, has, set, object, int, integer, text, JobsError } from '../contracts/workspace/values.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { applyPatch, changedPaths, provenanceAfter } from './profile-patch.js';
export function inspectProfile(document) {
    const metadata = object(get(document, 'metadata'), 'profile.metadata');
    const result = emptyObject();
    set(result, 'profile', get(document, 'profile'));
    set(result, 'revision', has(metadata, 'revision') ? get(metadata, 'revision') : integer(1n));
    set(result, 'factProvenance', has(metadata, 'factProvenance') ? get(metadata, 'factProvenance') : emptyObject());
    return set(result, 'updatedAt', get(metadata, 'updatedAt'));
}
export class ProfileService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    inspect() { return this.repository.profileTransaction(async (document) => inspectProfile(validateProfile(document))); }
    async get() { return get(await this.inspect(), 'profile'); }
    async preferences() {
        const profile = object(await this.get(), 'profile');
        return has(profile, 'preferences') ? object(get(profile, 'preferences'), 'profile.preferences') : emptyObject();
    }
    async patch(value, revision, source, atomic = [], deleted = []) {
        const patch = object(value, 'profile patch');
        if (!patch.size)
            throw new JobsError('profile patch must not be empty');
        return this.mutate(revision, source, current => applyPatch(current, patch, atomic, deleted));
    }
    async replace(value, revision, source) {
        const next = object(value, 'profile');
        if (revision < 0n)
            throw new JobsError('profile expected revision must be a non-negative integer');
        return this.mutate(revision, source, current => [next, changedPaths(current, next)]);
    }
    async setPreferences(value, revision, source, replace = false) {
        const preferences = object(value, 'preferences');
        if (!replace)
            return this.patch(set(emptyObject(), 'preferences', preferences), revision, source);
        return this.mutate(revision, source, current => {
            const next = set(copy(current), 'preferences', preferences);
            return [next, changedPaths(current, next)];
        });
    }
    mutate(revision, source, update) {
        if (!factSources.has(source))
            throw new JobsError('profile fact source is unsupported');
        return this.repository.profileTransaction(async (raw, save) => {
            const document = validateProfile(raw), metadata = object(get(document, 'metadata'), 'profile.metadata');
            const actual = has(metadata, 'revision') ? int(get(metadata, 'revision')) : 1n;
            if (actual !== revision)
                throw new JobsError('profile revision conflict');
            const current = object(get(document, 'profile'), 'profile.profile');
            const [next, changed] = update(current);
            if (!changed.length)
                return inspectProfile(document);
            const now = this.now();
            const provenance = has(metadata, 'factProvenance') ? object(get(metadata, 'factProvenance'), 'profile fact provenance') : emptyObject();
            const updatedMetadata = copy(metadata);
            set(updatedMetadata, 'factProvenance', provenanceAfter(provenance, changed, source, now, current));
            set(updatedMetadata, 'updatedAt', text(now));
            set(updatedMetadata, 'revision', integer(actual + 1n));
            const updated = set(set(copy(document), 'profile', next), 'metadata', updatedMetadata);
            await save(updated);
            return inspectProfile(updated);
        });
    }
}
