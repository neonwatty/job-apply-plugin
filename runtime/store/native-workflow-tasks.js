import { ClaimsService } from '../workspace-core/claims.js';
import { get, has, object, parse, serialize, set, text } from '../contracts/workspace/values.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, encodeWorkflowLedger, TaskProtocolError, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
/** Preparation-only adapter. Metadata and selection share one jobs.json replacement under the
 * existing Store lock. Every other service write is rejected until claim-journal integration.
 */
export class NativeWorkflowTasks {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    transaction(operation) {
        return this.repository.claimTransaction(async (original) => {
            let jobs = object(parse(serialize(original.jobs)), 'staged jobs'), committed = false;
            const unsupported = async () => { throw new TaskProtocolError('action_unavailable'); };
            const buffered = { ...original, jobs,
                saveJobs: async (value) => { jobs = value; buffered.jobs = value; },
                saveCoordinator: unsupported, saveSession: unsupported, commit: unsupported };
            const value = get(object(get(jobs, 'metadata'), 'jobs metadata'), workflowMetadataKey);
            const storedLedger = has(object(get(jobs, 'metadata'), 'jobs metadata'), workflowMetadataKey)
                ? decodeWorkflowLedger(value) : emptyWorkflowLedger();
            const prepared = await original.workflowArchive?.prepare(storedLedger);
            const ledger = prepared?.ledger ?? storedLedger;
            const service = new ClaimsService({ claimTransaction: callback => callback(buffered) }, this.now);
            return operation({ ledger, ...(prepared ? { history: prepared.history } : {}), domain: { snapshot: buffered,
                    select: async (id, expected) => { await service.select(id, expected, true); } },
                commit: async (next) => {
                    if (committed)
                        throw new TaskProtocolError('invalid_task_state');
                    const metadata = object(get(jobs, 'metadata'), 'jobs metadata');
                    set(metadata, workflowMetadataKey, encodeWorkflowLedger(next));
                    set(metadata, 'updatedAt', text(this.now()));
                    committed = true;
                    await prepared?.flush();
                    await original.saveJobs(jobs);
                } });
        });
    }
}
