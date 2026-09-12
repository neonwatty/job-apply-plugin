import { emptyObject, safeId } from '../contracts/workspace/jobs.js';
import { validateResumeReferences } from '../contracts/workspace/resume-reference.js';
import { copy, get, int, integer, object, same, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { validateJobsDocument } from '../contracts/workspace/jobs.js';
import { validateExtractionResumes } from '../store/native-extraction-journal.js';
export class ResumeLifecycleError extends JobsError {
    jobReferences;
    constructor(message, jobReferences) {
        super(message);
        this.jobReferences = jobReferences;
    }
}
function updatedDocument(raw) {
    const document = copy(validateExtractionResumes(raw));
    const records = copy(object(get(document, 'resumes'), 'resumes.resumes'));
    const metadata = copy(object(get(document, 'metadata'), 'resumes.metadata'));
    set(document, 'resumes', records);
    set(document, 'metadata', metadata);
    return { document, records, metadata };
}
const active = (record) => get(record, 'deletedAt') === null;
export class ResumeLifecycleService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    trash(id, expectedRevision) {
        return this.setDeleted(id, expectedRevision, false);
    }
    restore(id, expectedRevision) {
        return this.setDeleted(id, expectedRevision, true);
    }
    setDeleted(id, expectedRevision, restore) {
        safeId(id);
        return this.repository.resumeLifecycleTransaction(async (transaction) => {
            const { document, records, metadata } = updatedDocument(transaction.resumes), value = get(records, id);
            if (value === null)
                throw new JobsError('resume does not exist');
            const current = object(value, 'resume record');
            if (int(get(current, 'revision')) !== expectedRevision)
                throw new JobsError('resume revision conflict');
            const trashed = !active(current);
            if (restore === !trashed)
                return current;
            if (restore) {
                if (records.entries().some(([key, value]) => string(key) !== id && active(object(value, 'resume record'))
                    && (string(get(current, 'storageKind')) === 'managed'
                        ? string(get(object(value, 'resume record'), 'storageKind')) === 'managed'
                            && same(get(object(value, 'resume record'), 'digest'), get(current, 'digest'))
                        : get(object(value, 'resume record'), 'storageKind') === null
                            && same(get(object(value, 'resume record'), 'path'), get(current, 'path'))))) {
                    throw new JobsError('active resume file already exists');
                }
            }
            else {
                const jobs = object(get(validateJobsDocument(await transaction.jobs()), 'jobs'), 'jobs.jobs');
                const assigned = jobs.entries().filter(([, value]) => active(object(value, 'job'))
                    && string(get(object(value, 'job'), 'resumeId')) === id).length;
                const implicit = jobs.entries().filter(([, value]) => {
                    const job = object(value, 'job');
                    return active(job) && get(job, 'resumeId') === null;
                }).length;
                const references = assigned + (get(current, 'default') === true ? implicit : 0);
                if (assigned)
                    throw new ResumeLifecycleError('resume is assigned to an active job', BigInt(references));
                if (get(current, 'default') === true && implicit) {
                    throw new ResumeLifecycleError('default resume is used by an active job', BigInt(implicit));
                }
            }
            const updated = copy(current), deletedAt = restore ? null : text(this.now()), timestamp = this.now();
            set(updated, 'deletedAt', deletedAt);
            set(updated, 'default', restore && !records.entries().some(([key, value]) => string(key) !== id && active(object(value, 'resume record'))));
            set(updated, 'revision', integer(expectedRevision + 1n));
            set(updated, 'updatedAt', text(timestamp));
            set(records, id, updated);
            set(metadata, 'updatedAt', text(timestamp));
            validateResumeReferences(records);
            await transaction.saveResumes(document, !restore);
            return updated;
        });
    }
    delete(id, expectedRevision) {
        safeId(id);
        return this.repository.resumeLifecycleTransaction(async (transaction) => {
            const { document, records, metadata } = updatedDocument(transaction.resumes), value = get(records, id);
            const result = set(emptyObject(), 'id', text(id));
            if (value === null)
                return set(result, 'deleted', false);
            const current = object(value, 'resume record');
            if (int(get(current, 'revision')) !== expectedRevision)
                throw new JobsError('resume revision conflict');
            if (active(current))
                throw new JobsError('resume must be trashed before permanent deletion');
            const requests = object(get(validateExtractionRequests(await transaction.requests()), 'requests'), 'requests.requests');
            if (requests.entries().some(([, value]) => {
                const request = object(value, 'request');
                return string(get(request, 'resumeId')) === id && string(get(request, 'status')) === 'requested';
            }))
                throw new JobsError('resume has an open extraction request');
            const jobs = object(get(validateJobsDocument(await transaction.jobs()), 'jobs'), 'jobs.jobs');
            const references = jobs.entries().filter(([, value]) => string(get(object(value, 'job'), 'resumeId')) === id).length;
            if (references)
                throw new ResumeLifecycleError('resume is still referenced by a job', BigInt(references));
            const previous = validateExtractionResumes(transaction.resumes), timestamp = this.now();
            records.delete(text(id));
            set(metadata, 'updatedAt', text(timestamp));
            validateResumeReferences(records);
            await transaction.deleteManaged(current, previous, document);
            return set(result, 'deleted', true);
        });
    }
}
