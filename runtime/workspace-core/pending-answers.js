import { randomUUID } from 'node:crypto';
import { prepareAnswerResolution, pendingResolutionProjection, sessionRevision } from '../contracts/workspace/answer-resolution.js';
import { matches, pendingReference } from '../contracts/workspace/answer-session-fields.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { answerRevision, fallback, validateAnswers } from '../contracts/workspace/answers.js';
import { fromJSON, get, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { preflightJobRecord } from './job-preflight.js';
function pendingInformation(session, answers) {
    return fallback(session, 'pendingFields', []).map(field => {
        const result = pendingResolutionProjection(field, answers);
        for (const key of ['question', 'state', 'sensitive'])
            if (field.has(text(key)))
                set(result, key, get(field, key));
        return result;
    });
}
export class PendingAnswersService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    list() {
        return this.repository.pendingAnswerTransaction(async (transaction) => {
            const answers = validateAnswers(transaction.answers), jobs = object(get(transaction.jobs, 'jobs'), 'jobs');
            const groups = [];
            for (const [id, raw] of jobs.entries()) {
                const job = object(raw, 'job');
                if (get(job, 'deletedAt') !== null || string(get(job, 'status')) !== 'needs_info')
                    continue;
                const session = transaction.sessions.find(item => string(get(item, 'applicationId')) === string(id));
                if (!session)
                    continue;
                const pending = pendingInformation(session, answers);
                if (!pending.length)
                    continue;
                const group = object(fromJSON({ id: string(id), role: string(get(job, 'role')) ?? '', company: string(get(job, 'company')) ?? '', status: 'needs_info' }), 'pending job');
                set(group, 'jobRevision', get(job, 'revision'));
                set(group, 'sessionRevision', integer(sessionRevision(session)));
                set(group, 'pendingInformation', pending);
                groups.push(group);
            }
            return set(object(fromJSON({ mutated: false }), 'pending questions'), 'jobs', groups);
        });
    }
    resolve(jobId, reference, expectedJobRevision, expectedSessionRevision, expectedAnswerRevision, ownerConfirmed) {
        safeId(jobId);
        if (!ownerConfirmed)
            throw new JobsError('answer resolution requires explicit owner confirmation');
        if (!matches(text(reference), pendingReference))
            throw new JobsError('pending question reference is invalid');
        for (const revision of [expectedJobRevision, expectedSessionRevision, expectedAnswerRevision]) {
            if (typeof revision !== 'bigint' || revision < 1n)
                throw new JobsError('answer resolution revision is invalid');
        }
        return this.repository.pendingAnswerTransaction(async (transaction) => {
            const rawJob = get(object(get(transaction.jobs, 'jobs'), 'jobs'), jobId);
            if (rawJob === null || get(object(rawJob, 'job'), 'deletedAt') !== null)
                throw new JobsError('job does not exist');
            const job = object(rawJob, 'job');
            if (answerRevision(job) !== expectedJobRevision)
                throw new JobsError('job revision conflict');
            if (string(get(job, 'status')) !== 'needs_info')
                throw new JobsError('answer resolution requires a needs_info job');
            const session = transaction.sessions.find(item => string(get(item, 'applicationId')) === jobId);
            if (!session)
                throw new JobsError('answer resolution session does not exist');
            const args = { jobId, reference, expectedJobRevision, expectedSessionRevision, expectedAnswerRevision, ownerConfirmed, at: this.now(), operationId: randomUUID() };
            // First validate eligibility/revisions without observing resume files. Only
            // the final-field path may require preflight, and it must run under this lock.
            const preliminary = prepareAnswerResolution(transaction.jobs, transaction.answers, session, args, true);
            if (get(preliminary.result, 'ready') === true) {
                const preflight = await preflightJobRecord(job, transaction.profile, transaction.resumes, transaction.files);
                if (get(preflight, 'ready') !== true)
                    throw new JobsError('job preflight failed after answer resolution');
            }
            await transaction.commit(preliminary.operation);
            return preliminary.result;
        });
    }
}
