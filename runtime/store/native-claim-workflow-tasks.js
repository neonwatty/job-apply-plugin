import { ClaimsService } from '../workspace-core/claims.js';
import { fromJSON, get, has, object, parse, serialize, set, text, integer } from '../contracts/workspace/values.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, TaskProtocolError, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import { workflowCommit } from '../contracts/workspace/workflow-journal.js';
const clone = (value) => object(parse(serialize(value)), 'staged document');
/** One staged claim operation and its workflow receipt use the existing recovery journal. */
export class NativeClaimWorkflowTasks {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    transaction(operation) {
        return this.repository.claimTransaction(async (original) => {
            let staged = null, committed = false, invoked = false;
            const unsupported = async () => { throw new TaskProtocolError('action_unavailable'); };
            const buffered = { ...original, jobs: clone(original.jobs), coordinator: clone(original.coordinator),
                authority: clone(original.authority), sessions: original.sessions.map(clone),
                saveJobs: unsupported, saveCoordinator: unsupported, saveSession: unsupported,
                commit: async (value) => { if (staged)
                    throw new TaskProtocolError('action_unavailable'); staged = clone(value); } };
            const service = new ClaimsService({ claimTransaction: callback => callback(buffered) }, this.now);
            const metadata = object(get(original.jobs, 'metadata'), 'metadata');
            const ledger = has(metadata, workflowMetadataKey) ? decodeWorkflowLedger(get(metadata, workflowMetadataKey)) : emptyWorkflowLedger();
            return operation({ ledger, domain: { snapshot: buffered,
                    execute: async (kind, id, revision, token, session, status) => {
                        if (invoked)
                            throw new TaskProtocolError('action_unavailable');
                        invoked = true;
                        const owner = text('Experimental workflow broker');
                        if (kind === 'acquire')
                            return service.acquire(id, owner, revision);
                        if (kind === 'restart')
                            return service.restart(id, owner, revision, true);
                        if (kind === 'recover')
                            return service.recover(id, owner);
                        if (!session)
                            throw new TaskProtocolError('action_unavailable');
                        if (kind === 'progress') {
                            buffered.saveSession = async (value) => {
                                staged = object(fromJSON({ kind: 'workflow_progress', jobId: id, at: this.now() }), 'progress');
                                set(staged, 'expectedRevision', integer(revision));
                                set(staged, 'session', value);
                                set(staged, 'resultClaim', get(buffered.coordinator, 'claim'));
                            };
                            return service.progress(id, token, session);
                        }
                        return service.handoff(id, token, kind === 'cancel' ? 'needs_info' : status, session, revision);
                    } }, commit: async (next) => {
                    if (committed || !staged)
                        throw new TaskProtocolError('invalid_task_state');
                    committed = true;
                    set(staged, 'workflow', workflowCommit(original.jobs, next));
                    await original.commit(staged);
                } });
        });
    }
}
