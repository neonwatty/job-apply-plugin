import { requireJobUnclaimed } from '../contracts/workspace/claims.js';
import { safeId, statuses, validateJob } from '../contracts/workspace/jobs.js';
import { copy, get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { preflightJobRecord } from './job-preflight.js';
const transitions = {
    saved: ['needs_info', 'ready', 'closed'],
    needs_info: ['saved', 'ready', 'in_progress', 'closed'],
    ready: ['saved', 'needs_info', 'in_progress', 'closed'],
    in_progress: ['needs_info', 'awaiting_review', 'closed'],
    awaiting_review: ['in_progress', 'applied', 'closed'],
    applied: ['closed'],
    closed: ['saved'],
};
export class JobTransitionsService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    async transition(id, status, expectedRevision, closedOutcome = null, userConfirmed = false) {
        safeId(id);
        if (!statuses.has(status))
            throw new JobsError('job status is unsupported');
        if (typeof expectedRevision !== 'bigint' || expectedRevision < 1n)
            throw new JobsError('job revision is invalid');
        if (typeof userConfirmed !== 'boolean')
            throw new JobsError('user confirmation must be a boolean');
        return this.repository.claimTransaction(async (tx) => {
            const jobs = object(get(tx.jobs, 'jobs'), 'jobs.jobs');
            const value = get(jobs, id);
            if (value === null || get(object(value, 'job record'), 'deletedAt') !== null) {
                throw new JobsError('job does not exist');
            }
            const current = object(value, 'job record');
            if (int(get(current, 'revision')) !== expectedRevision)
                throw new JobsError('job revision conflict');
            requireJobUnclaimed(tx.coordinator, id);
            const source = string(get(current, 'status'));
            if (status === source)
                return current;
            if (!transitions[source].includes(status))
                throw new JobsError('job status transition is unsupported');
            if (status === 'in_progress')
                throw new JobsError('in_progress requires atomic job-acquire');
            if (status === 'applied' && !userConfirmed)
                throw new JobsError('applied status requires explicit user confirmation');
            if (status === 'ready' && get(await preflightJobRecord(current, tx.profile, tx.resumes, tx.files), 'ready') !== true) {
                throw new JobsError('job is not ready');
            }
            const updated = copy(current);
            set(updated, 'status', text(status));
            set(updated, 'closedOutcome', status === 'closed' ? closedOutcome : null);
            set(updated, 'revision', integer(expectedRevision + 1n));
            set(updated, 'updatedAt', text(this.now()));
            validateJob(id, updated);
            set(jobs, id, updated);
            set(object(get(tx.jobs, 'metadata'), 'jobs.metadata'), 'updatedAt', get(updated, 'updatedAt'));
            await tx.saveJobs(tx.jobs);
            return updated;
        });
    }
}
