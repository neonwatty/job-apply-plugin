import { randomBytes, randomUUID } from 'node:crypto';
import { casefold } from '../contracts/workspace/casefold.js';
import { safeId, emptyObject } from '../contracts/workspace/jobs.js';
import { strip } from '../contracts/workspace/job-url.js';
import { validateResumeReferences } from '../contracts/workspace/resume-reference.js';
import { resumeExtension } from '../contracts/workspace/resume-content.js';
import { copy, get, has, int, integer, keys, object, set, string, text, truth, JobsError } from '../contracts/workspace/values.js';
const compareText = (left, right) => {
    const a = [...left], b = [...right];
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const difference = a[index].codePointAt(0) - b[index].codePointAt(0);
        if (difference)
            return difference;
    }
    return a.length - b.length;
};
const active = (record) => get(record, 'deletedAt') === null;
function tags(value) {
    if (!Array.isArray(value))
        throw new JobsError('resume tags must be a list');
    const result = value.map(item => {
        const tag = string(item);
        if (tag === null)
            throw new JobsError('resume tags must be non-empty strings');
        return strip(tag);
    });
    if (result.some(tag => !tag))
        throw new JobsError('resume tags must be non-empty strings');
    if (new Set(result).size !== result.length)
        throw new JobsError('resume tags must be unique');
    return result;
}
export function resumeMetadata(value, patch = false) {
    const input = object(value, patch ? 'resume patch' : 'resume input');
    const allowed = patch ? ['label', 'tags'] : ['id', 'label', 'tags', 'default'];
    if (patch && !input.size || keys(input).some(key => !allowed.includes(key))) {
        throw new JobsError(`resume ${patch ? 'patch' : 'input'} contains unsupported fields`);
    }
    const result = {};
    if (has(input, 'id') && truth(get(input, 'id')))
        result.id = safeId(string(get(input, 'id')));
    if (has(input, 'label')) {
        const label = string(get(input, 'label'));
        if (label === null || !strip(label))
            throw new JobsError('resume label must be a non-empty string');
        result.label = strip(label);
    }
    else if (!patch)
        throw new JobsError('resume label must be a non-empty string');
    if (has(input, 'tags'))
        result.tags = tags(get(input, 'tags'));
    else if (!patch)
        result.tags = [];
    if (has(input, 'default')) {
        if (typeof get(input, 'default') !== 'boolean')
            throw new JobsError('resume default must be a boolean');
        result.default = get(input, 'default');
    }
    return result;
}
function updatedDocument(document) {
    const next = copy(document), records = copy(object(get(document, 'resumes'), 'resumes.resumes'));
    const metadata = copy(object(get(document, 'metadata'), 'resumes.metadata'));
    set(next, 'resumes', records);
    set(next, 'metadata', metadata);
    return { document: next, records, metadata };
}
function applyStage(record, stage, contentRevision) {
    set(record, 'storageKind', text('managed'));
    set(record, 'managedFile', text(stage.managedFile));
    set(record, 'originalFilename', text(stage.originalFilename));
    set(record, 'mediaType', text(stage.mediaType));
    set(record, 'digest', text(stage.digest));
    set(record, 'contentRevision', text(contentRevision));
    set(record, 'observedSize', integer(BigInt(stage.observedSize)));
    set(record, 'observedModifiedAt', text(stage.observedModifiedAt));
}
export class ResumeService {
    repository;
    now;
    id;
    contentRevision;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), id = () => `resume-${randomUUID()}`, contentRevision = () => `content_${randomBytes(24).toString('base64url')}`) {
        this.repository = repository;
        this.now = now;
        this.id = id;
        this.contentRevision = contentRevision;
    }
    uploadedFilename(filename, preserve) {
        return preserve ? filename : `.browser-upload.${randomBytes(6).toString('base64url')}${resumeExtension(filename)}`;
    }
    import(value, filename, content, preserveFilename = false) {
        const input = resumeMetadata(value), id = safeId(input.id ?? this.id());
        return this.repository.resumeTransaction(async (transaction) => {
            const { document, records, metadata } = updatedDocument(transaction.document);
            if (has(records, id))
                throw new JobsError('resume id already exists');
            const stage = await transaction.files.stage(id, this.uploadedFilename(filename, preserveFilename), content);
            if (records.entries().some(([, item]) => string(get(object(item, 'resume record'), 'digest')) === stage.digest)) {
                await transaction.files.discard(stage);
                throw new JobsError('resume file is already managed');
            }
            const timestamp = this.now(), activeRecords = records.entries().map(([, item]) => object(item, 'resume record')).filter(active);
            const makeDefault = input.default ?? activeRecords.length === 0;
            if (makeDefault)
                for (const [key, item] of records.entries()) {
                    const record = object(item, 'resume record');
                    if (active(record) && get(record, 'default') === true) {
                        const changed = copy(record);
                        set(changed, 'default', false);
                        set(changed, 'revision', integer(int(get(record, 'revision')) + 1n));
                        set(changed, 'updatedAt', text(timestamp));
                        set(records, string(key), changed);
                    }
                }
            const record = emptyObject();
            set(record, 'id', text(id));
            set(record, 'label', text(input.label));
            applyStage(record, stage, this.contentRevision());
            set(record, 'tags', input.tags.map(text));
            set(record, 'default', makeDefault);
            set(record, 'revision', integer(1n));
            set(record, 'createdAt', text(timestamp));
            set(record, 'updatedAt', text(timestamp));
            set(record, 'deletedAt', null);
            set(records, id, record);
            set(metadata, 'updatedAt', text(timestamp));
            validateResumeReferences(records);
            await transaction.files.install(stage, document, null, transaction.saveJournal, transaction.save);
            return record;
        });
    }
    get(id, includeTrashed = false) {
        safeId(id);
        return this.repository.resumeTransaction(async ({ document }) => {
            const value = get(object(get(document, 'resumes'), 'resumes.resumes'), id);
            if (value === null)
                return null;
            const record = object(value, 'resume record');
            return includeTrashed || active(record) ? record : null;
        });
    }
    list(includeTrashed = false, trashedOnly = false) {
        return this.repository.resumeTransaction(async ({ document }) => object(get(document, 'resumes'), 'resumes.resumes').entries()
            .map(([, value]) => object(value, 'resume record'))
            .filter(record => (includeTrashed || trashedOnly || active(record)) && (!trashedOnly || !active(record)))
            .sort((a, b) => Number(get(b, 'default')) - Number(get(a, 'default'))
            || compareText(casefold(string(get(a, 'label'))), casefold(string(get(b, 'label'))))
            || compareText(string(get(a, 'id')), string(get(b, 'id')))));
    }
    update(id, value, expectedRevision) {
        safeId(id);
        const patch = resumeMetadata(value, true);
        return this.repository.resumeTransaction(async (transaction) => {
            const { document, records, metadata } = updatedDocument(transaction.document);
            const value = get(records, id);
            if (value === null || !active(object(value, 'resume record')))
                throw new JobsError('resume does not exist');
            const current = object(value, 'resume record');
            if (int(get(current, 'revision')) !== expectedRevision)
                throw new JobsError('resume revision conflict');
            const record = copy(current), timestamp = this.now();
            if (patch.label !== undefined)
                set(record, 'label', text(patch.label));
            if (patch.tags !== undefined)
                set(record, 'tags', patch.tags.map(text));
            set(record, 'revision', integer(expectedRevision + 1n));
            set(record, 'updatedAt', text(timestamp));
            set(records, id, record);
            set(metadata, 'updatedAt', text(timestamp));
            validateResumeReferences(records);
            await transaction.save(document);
            return record;
        });
    }
    replace(id, filename, content, expectedRevision, adopt = false, preserveFilename = false) {
        safeId(id);
        return this.repository.resumeTransaction(async (transaction) => {
            const { document, records, metadata } = updatedDocument(transaction.document);
            const value = get(records, id);
            if (value === null || !active(object(value, 'resume record')))
                throw new JobsError('resume does not exist');
            const current = object(value, 'resume record'), managed = string(get(current, 'storageKind')) === 'managed';
            if (int(get(current, 'revision')) !== expectedRevision)
                throw new JobsError('resume revision conflict');
            if (adopt === managed)
                throw new JobsError(managed ? 'resume is already managed' : 'legacy resume bytes require resume-adopt');
            const stage = await transaction.files.stage(id, this.uploadedFilename(filename, preserveFilename), content);
            if (records.entries().some(([key, item]) => string(key) !== id && string(get(object(item, 'resume record'), 'digest')) === stage.digest)) {
                await transaction.files.discard(stage);
                throw new JobsError('resume file is already managed');
            }
            const record = copy(current), timestamp = this.now();
            if (has(record, 'path'))
                record.delete(text('path'));
            applyStage(record, stage, this.contentRevision());
            set(record, 'revision', integer(expectedRevision + 1n));
            set(record, 'updatedAt', text(timestamp));
            set(records, id, record);
            set(metadata, 'updatedAt', text(timestamp));
            validateResumeReferences(records);
            await transaction.files.install(stage, document, managed ? string(get(current, 'managedFile')) : null, transaction.saveJournal, transaction.save);
            return record;
        });
    }
    setDefault(id, expectedRevision) {
        safeId(id);
        return this.repository.resumeTransaction(async (transaction) => {
            const { document, records, metadata } = updatedDocument(transaction.document), value = get(records, id);
            if (value === null || !active(object(value, 'resume record')))
                throw new JobsError('resume does not exist');
            const target = object(value, 'resume record');
            if (int(get(target, 'revision')) !== expectedRevision)
                throw new JobsError('resume revision conflict');
            if (get(target, 'default') === true)
                return target;
            const timestamp = this.now();
            for (const [key, item] of records.entries()) {
                const current = object(item, 'resume record'), currentId = string(key);
                if (active(current) && (get(current, 'default') === true || currentId === id)) {
                    const changed = copy(current);
                    set(changed, 'default', currentId === id);
                    set(changed, 'revision', integer(int(get(current, 'revision')) + 1n));
                    set(changed, 'updatedAt', text(timestamp));
                    set(records, currentId, changed);
                }
            }
            set(metadata, 'updatedAt', text(timestamp));
            validateResumeReferences(records);
            await transaction.save(document);
            return object(get(records, id), 'resume record');
        });
    }
    content(id) {
        safeId(id);
        return this.repository.resumeTransaction(async ({ document, files }) => {
            const value = get(object(get(document, 'resumes'), 'resumes.resumes'), id);
            if (value === null || !active(object(value, 'resume record')))
                throw new JobsError('managed resume does not exist');
            const record = object(value, 'resume record');
            return { record, content: await files.content(record) };
        });
    }
    async resolve(id) {
        const record = id === undefined
            ? (await this.list()).find(item => get(item, 'default') === true) ?? null
            : await this.get(id);
        if (record === null)
            throw new JobsError('active resume does not exist');
        if (string(get(record, 'storageKind')) !== 'managed')
            throw new JobsError('resume must be adopted before use');
        const resolved = await this.repository.resumeTransaction(async ({ files }) => {
            await files.content(record);
            return files.path(record);
        });
        const result = emptyObject();
        set(result, 'id', get(record, 'id'));
        set(result, 'revision', get(record, 'revision'));
        set(result, 'mediaType', get(record, 'mediaType'));
        set(result, 'path', text(resolved));
        return result;
    }
    check(id) {
        safeId(id);
        return this.repository.resumeTransaction(async ({ document, files }) => {
            const value = get(object(get(document, 'resumes'), 'resumes.resumes'), id);
            if (value === null)
                throw new JobsError('resume does not exist');
            const record = object(value, 'resume record');
            const managed = string(get(record, 'storageKind')) === 'managed';
            const current = managed ? await files.observation(record) : await files.externalObservation(string(get(record, 'path')));
            const result = emptyObject(), observedSize = int(get(record, 'observedSize'));
            set(result, 'id', text(id));
            set(result, 'exists', current.exists);
            set(result, 'changed', !current.exists || current.size !== (observedSize === null ? null : Number(observedSize))
                || current.modifiedAt !== string(get(record, 'observedModifiedAt')) || managed && current.digest !== string(get(record, 'digest')));
            set(result, 'observedSize', get(record, 'observedSize'));
            set(result, 'observedModifiedAt', get(record, 'observedModifiedAt'));
            set(result, 'currentSize', current.size === null ? null : integer(BigInt(current.size)));
            set(result, 'currentModifiedAt', current.modifiedAt === null ? null : text(current.modifiedAt));
            set(result, 'storageKind', text(managed ? 'managed' : 'external'));
            return result;
        });
    }
}
