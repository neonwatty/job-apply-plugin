import { ClaimsService } from '../workspace-core/claims.js';
import type { ClaimRepository, ClaimTransaction } from '../workspace-core/claims.js';
import { fromJSON, get, has, object, parse, serialize, set, text, integer } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import { decodeWorkflowLedger, emptyWorkflowLedger, TaskProtocolError, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import { workflowCommit } from '../contracts/workspace/workflow-journal.js';
import type { WorkflowTaskStore, WorkflowTransaction } from '../harness/task-store.js';
import type { ClaimWorkflowDomain } from '../contracts/workspace/claim-workflow-domain.js';
const clone = (value: Document): Document => object(parse(serialize(value)), 'staged document');

/** One staged claim operation and its workflow receipt use the existing recovery journal. */
export class NativeClaimWorkflowTasks implements WorkflowTaskStore<ClaimWorkflowDomain> {
  constructor(private readonly repository: ClaimRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  transaction<T>(operation: (tx: WorkflowTransaction<ClaimWorkflowDomain>) => Promise<T>): Promise<T> {
    return this.repository.claimTransaction(async original => {
      let staged: Document | null = null, committed = false, invoked = false;
      const unsupported = async (): Promise<never> => { throw new TaskProtocolError('action_unavailable'); };
      const buffered: ClaimTransaction = { ...original, jobs: clone(original.jobs), coordinator: clone(original.coordinator),
        authority: clone(original.authority), sessions: original.sessions.map(clone),
        saveJobs: unsupported, saveCoordinator: unsupported, saveSession: unsupported,
        commit: async value => { if (staged) throw new TaskProtocolError('action_unavailable'); staged = clone(value); } };
      const service = new ClaimsService({claimTransaction: callback => callback(buffered)}, this.now);
      const metadata = object(get(original.jobs, 'metadata'), 'metadata');
      const ledger = has(metadata, workflowMetadataKey) ? decodeWorkflowLedger(get(metadata, workflowMetadataKey)) : emptyWorkflowLedger();
      return operation({ ledger, domain: { snapshot: buffered,
        execute: async (kind, id, revision, token, session, status, savedSessionFingerprint) => {
          if (invoked) throw new TaskProtocolError('action_unavailable');
          invoked = true;
          const owner = text('Experimental workflow broker');
          if (savedSessionFingerprint !== undefined) {
            if (session !== undefined || !(kind === 'cancel' || kind === 'handoff' && status === 'needs_info')) {
              throw new TaskProtocolError('action_unavailable');
            }
            return service.handoffSaved(id, token, revision, savedSessionFingerprint);
          }
          if (kind === 'acquire') return service.acquire(id, owner, revision);
          if (kind === 'restart') return service.restart(id, owner, revision, true);
          if (kind === 'recover') return service.recover(id, owner);
          if (!session) throw new TaskProtocolError('action_unavailable');
          if (kind === 'progress') {
            buffered.saveSession = async value => {
              staged = object(fromJSON({kind:'workflow_progress',jobId:id,at:this.now()}), 'progress');
              set(staged, 'expectedRevision', integer(revision));
              set(staged, 'session', value); set(staged, 'resultClaim', get(buffered.coordinator, 'claim'));
            };
            return service.progress(id, token, session);
          }
          return service.handoff(id, token, kind === 'cancel' ? 'needs_info' : status!, session, revision);
        } }, commit: async next => {
        if (committed || !staged) throw new TaskProtocolError('invalid_task_state');
        committed = true;
        set(staged, 'workflow', workflowCommit(original.jobs, next));
        await original.commit(staged);
      } });
    });
  }
}
