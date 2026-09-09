import { get, set, object, string, text, integer, int, JobsError } from '../contracts/workspace/values.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { failureReasons, requestStatuses, orderRequests, validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { ExtractionContext, records, readyResume, revision, touch, closeRequest, newRequest } from './extraction-context.js';
export class ExtractionRequests extends ExtractionContext {
    createRequest(resumeId, expectedResumeRevision) {
        safeId(resumeId);
        return this.repository.extractionTransaction(async (tx) => {
            const resume = await readyResume(tx, resumeId, expectedResumeRevision);
            this.noOpen(tx.requests, resumeId);
            const upgraded = get(resume, 'contentRevision') === null;
            if (upgraded) {
                set(resume, 'contentRevision', text(this.contentRevision()));
                set(resume, 'revision', integer(int(get(resume, 'revision')) + 1n));
                set(resume, 'updatedAt', text(this.now()));
                touch(tx.resumes, this.now());
            }
            const request = newRequest(this, resume, null);
            set(records(tx.requests, 'requests'), string(get(request, 'requestId')), request);
            touch(tx.requests, string(get(request, 'updatedAt')));
            validateExtractionRequests(tx.requests);
            await tx.commit('request-create', { requests: tx.requests, ...(upgraded ? { resumes: tx.resumes } : {}) });
            return request;
        });
    }
    getRequest(id) {
        safeId(id);
        return this.repository.extractionTransaction(async (tx) => {
            const value = get(records(tx.requests, 'requests'), id);
            return value === null ? null : object(value, 'request');
        });
    }
    listRequests(resumeId, status) {
        if (resumeId !== undefined)
            safeId(resumeId);
        if (status !== undefined && !requestStatuses.has(status))
            throw new JobsError('resume extraction request status is unsupported');
        return this.repository.extractionTransaction(async (tx) => orderRequests(records(tx.requests, 'requests').entries()
            .map(([, value]) => object(value, 'request')).filter(record => (resumeId === undefined || string(get(record, 'resumeId')) === resumeId)
            && (status === undefined || string(get(record, 'status')) === status))));
    }
    cancelRequest(id, expected) { return this.close(id, expected, 'cancelled'); }
    failRequest(id, reason, expected) {
        if (!failureReasons.has(reason))
            throw new JobsError('resume extraction failure reason is unsupported');
        return this.close(id, expected, 'failed', reason);
    }
    close(id, expected, status, reason = null) {
        safeId(id);
        return this.repository.extractionTransaction(async (tx) => {
            const result = closeRequest(tx.requests, id, expected, status, this.now(), reason);
            validateExtractionRequests(tx.requests);
            await tx.commit('request-close', { requests: tx.requests });
            return result;
        });
    }
    retryRequest(id, expected, expectedResumeRevision) {
        safeId(id);
        return this.repository.extractionTransaction(async (tx) => {
            const value = get(records(tx.requests, 'requests'), id);
            if (value === null)
                throw new JobsError('resume extraction request does not exist');
            const current = object(value, 'request');
            revision(current, expected, 'request revision conflict');
            if (!['failed', 'stale'].includes(string(get(current, 'status'))))
                throw new JobsError('resume extraction request cannot be retried');
            const resumeId = string(get(current, 'resumeId'));
            const resume = await readyResume(tx, resumeId, expectedResumeRevision);
            this.noOpen(tx.requests, resumeId);
            const request = newRequest(this, resume, id);
            set(records(tx.requests, 'requests'), string(get(request, 'requestId')), request);
            touch(tx.requests, string(get(request, 'updatedAt')));
            validateExtractionRequests(tx.requests);
            await tx.commit('request-retry', { requests: tx.requests });
            return request;
        });
    }
    noOpen(document, resumeId) {
        if (records(document, 'requests').entries().some(([, value]) => {
            const record = object(value, 'request');
            return string(get(record, 'resumeId')) === resumeId && string(get(record, 'status')) === 'requested';
        }))
            throw new JobsError('open extraction request already exists');
    }
}
