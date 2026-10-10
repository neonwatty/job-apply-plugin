import { ClaimsService } from '../workspace-core/claims.js';
import type { ClaimRepository } from '../workspace-core/claims.js';
import { get, has, object, parse, serialize, set, text } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, encodeWorkflowLedger, TaskProtocolError,
  workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowTaskStore, WorkflowTransaction } from '../harness/task-store.js';
import type { PreparationDomain } from '../contracts/workspace/preparation-domain.js';

/** Preparation-only adapter. Metadata and selection share one jobs.json replacement under the
 * existing Store lock. Every other service write is rejected until claim-journal integration.
 */
export class NativeWorkflowTasks implements WorkflowTaskStore<PreparationDomain> {
  constructor(private readonly repository: ClaimRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  transaction<T>(operation: (tx: WorkflowTransaction<PreparationDomain>) => Promise<T>): Promise<T> {
    return this.repository.claimTransaction(async original => {
      let jobs = object(parse(serialize(original.jobs)), 'staged jobs'), committed = false;
      const unsupported = async (): Promise<never> => { throw new TaskProtocolError('action_unavailable'); };
      const buffered = { ...original, jobs,
        saveJobs: async (value: Document) => { jobs = value; buffered.jobs = value; },
        saveCoordinator: unsupported, saveSession: unsupported, commit: unsupported };
      const value = get(object(get(jobs, 'metadata'), 'jobs metadata'), workflowMetadataKey);
      const storedLedger = has(object(get(jobs, 'metadata'), 'jobs metadata'), workflowMetadataKey)
        ? decodeWorkflowLedger(value) : emptyWorkflowLedger();
      const prepared = await original.workflowArchive?.prepare(storedLedger);
      const ledger = prepared?.ledger ?? storedLedger;
      const service = new ClaimsService({ claimTransaction: callback => callback(buffered) }, this.now);
      return operation({ ledger, ...(prepared ? { history: prepared.history } : {}), domain: { snapshot: buffered,
        select: async (id, expected) => { await service.select(id, expected, true); } },
      commit: async next => {
        if (committed) throw new TaskProtocolError('invalid_task_state');
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
