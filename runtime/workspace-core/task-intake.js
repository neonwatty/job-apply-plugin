import { get, object, set, string, text, fromJSON, JobsError } from '../contracts/workspace/values.js';
import { origin } from './job-provenance.js';
import { planJobUpsert } from './job-upsert-plan.js';
import { taskJobProjection } from './task-job-projection.js';
/** Resolve one canonical job under the same lock that protects ingestion writes. */
export class TaskIntakeService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    async intake(incoming, author = 'agent') {
        const by = origin(author);
        return this.repository.upsertTransaction(async (transaction) => {
            const planned = planJobUpsert(transaction.document, [incoming], by, this.now());
            if (planned.decisions.length !== 1)
                throw new JobsError('task intake did not resolve exactly one job');
            const decision = planned.decisions[0], action = string(get(decision, 'action'));
            if (action === 'conflict' || action === 'invalid')
                throw new JobsError(`task intake ${action}`);
            const id = string(get(decision, 'id'));
            const record = id === null ? null : get(object(get(planned.document, 'jobs'), 'jobs'), id);
            if (record === null || get(object(record, 'job'), 'deletedAt') !== null) {
                throw new JobsError('task intake did not resolve one active job');
            }
            if (planned.changed)
                await transaction.save(planned.document);
            const result = object(fromJSON({}), 'task intake result');
            set(result, 'action', text(action));
            set(result, 'job', taskJobProjection(object(record, 'job')));
            return result;
        });
    }
}
