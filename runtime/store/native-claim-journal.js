import { validateCoordinator } from '../contracts/workspace/claims.js';
import { validateAnswerHistory, validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { validateJobsDocument, safeId } from '../contracts/workspace/jobs.js';
import { fromJSON, get, has, int, integer, keys, object, parse, serialize, set, string, JobsError } from '../contracts/workspace/values.js';
import { NativeClaimHistory } from './native-claim-history.js';
export const claimOperationKinds = new Set(['acquire', 'review_restart', 'recover', 'handoff']);
export function validateClaimJournal(journal) {
    if (journal.size !== 2 || int(get(journal, 'schemaVersion')) !== 1n || !has(journal, 'operation'))
        throw new JobsError('invalid coordinator journal');
    const operation = object(get(journal, 'operation'), 'coordinator journal operation');
    const kind = string(get(operation, 'kind'));
    const fields = ['kind', 'operationId', 'jobId', 'at', 'historyEvent', 'resultClaim',
        ...(kind === 'recover' ? [] : ['sourceStatus', 'targetStatus', 'expectedRevision']), ...(kind === 'handoff' ? ['session'] : [])];
    if (!claimOperationKinds.has(kind) || operation.size !== fields.length || keys(operation).some(key => !fields.includes(key)))
        throw new JobsError('coordinator journal operation is invalid');
    const id = safeId(string(get(operation, 'jobId')));
    if (!string(get(operation, 'operationId')) || !string(get(operation, 'at')))
        throw new JobsError('coordinator journal operation is invalid');
    const event = validateAnswerHistory(get(operation, 'historyEvent'));
    if (string(get(event, 'applicationId')) !== id)
        throw new JobsError('coordinator history identity does not match');
    if (kind !== 'recover' && (int(get(operation, 'expectedRevision')) === null || int(get(operation, 'expectedRevision')) < 1n))
        throw new JobsError('coordinator journal revision is invalid');
    if (kind === 'acquire' && (string(get(operation, 'sourceStatus')) !== 'ready' || string(get(operation, 'targetStatus')) !== 'in_progress'))
        throw new JobsError('coordinator acquisition transition is invalid');
    if (kind === 'review_restart' && (string(get(operation, 'sourceStatus')) !== 'awaiting_review' || string(get(operation, 'targetStatus')) !== 'in_progress'))
        throw new JobsError('coordinator review restart transition is invalid');
    if (kind === 'handoff') {
        if (string(get(operation, 'sourceStatus')) !== 'in_progress' || !['needs_info', 'awaiting_review'].includes(string(get(operation, 'targetStatus'))))
            throw new JobsError('coordinator handoff transition is invalid');
        if (string(get(validateAnswerSession(get(operation, 'session')), 'applicationId')) !== id)
            throw new JobsError('coordinator session identity does not match');
        if (get(operation, 'resultClaim') !== null)
            throw new JobsError('coordinator handoff must release its claim');
    }
    else {
        const coordinator = object(fromJSON({ schemaVersion: 1, claim: null }), 'coordinator');
        set(coordinator, 'claim', get(operation, 'resultClaim'));
        validateCoordinator(coordinator);
        if (get(coordinator, 'claim') === null || string(get(object(get(coordinator, 'claim'), 'claim'), 'jobId')) !== id)
            throw new JobsError('coordinator claim identity does not match');
    }
    return operation;
}
function project(operation, jobs) {
    if (!has(operation, 'targetStatus'))
        return null;
    const next = validateJobsDocument(object(parse(serialize(jobs)), 'jobs'));
    const id = string(get(operation, 'jobId')), current = get(object(get(next, 'jobs'), 'jobs'), id);
    if (current === null || get(object(current, 'job'), 'deletedAt') !== null)
        throw new JobsError('coordinator journal references a missing job');
    const job = object(current, 'job'), expected = int(get(operation, 'expectedRevision'));
    if (int(get(job, 'revision')) === expected) {
        if (string(get(job, 'status')) !== string(get(operation, 'sourceStatus')))
            throw new JobsError('coordinator journal source status drifted');
        set(job, 'status', get(operation, 'targetStatus'));
        set(job, 'closedOutcome', null);
        set(job, 'revision', integer(expected + 1n));
        set(job, 'updatedAt', get(operation, 'at'));
        set(object(get(next, 'metadata'), 'jobs.metadata'), 'updatedAt', get(operation, 'at'));
        return validateJobsDocument(next);
    }
    if (int(get(job, 'revision')) !== expected + 1n || string(get(job, 'status')) !== string(get(operation, 'targetStatus')))
        throw new JobsError('coordinator journal cannot be reconciled');
    return null;
}
export class NativeClaimJournal {
    write;
    history;
    checkpoint;
    constructor(write, history, checkpoint = async () => { }) {
        this.write = write;
        this.history = history;
        this.checkpoint = checkpoint;
    }
    async recover(journal, jobs) {
        const operation = validateClaimJournal(journal), next = project(operation, jobs);
        const event = object(get(operation, 'historyEvent'), 'history event');
        // Validate every destination and collision before the first document write.
        await this.history.isIdempotent(event);
        if (next)
            await this.write('jobs', next);
        if (has(operation, 'session'))
            await this.write(`sessions/${string(get(operation, 'jobId'))}`, object(get(operation, 'session'), 'session'));
        await this.history.append(event);
        await this.checkpoint('history');
        const coordinator = object(fromJSON({ schemaVersion: 1, claim: null }), 'coordinator');
        set(coordinator, 'claim', get(operation, 'resultClaim'));
        await this.write('coordinator', coordinator);
        await this.write('coordinator-journal', object(fromJSON({ schemaVersion: 1, operation: null }), 'journal'));
    }
    async commit(operation, jobs) {
        const journal = object(fromJSON({ schemaVersion: 1, operation: null }), 'journal');
        set(journal, 'operation', operation);
        validateClaimJournal(journal);
        project(operation, jobs);
        await this.history.isIdempotent(object(get(operation, 'historyEvent'), 'history event'));
        await this.write('coordinator-journal', journal);
        await this.recover(journal, jobs);
    }
}
