import { NativeClaimWorkflowTasks } from './native-claim-workflow-tasks.js';
import type { ClaimRepository } from '../workspace-core/claims.js';
import type { WorkflowTaskStore, WorkflowTransaction } from '../harness/task-store.js';
import type { ClaimWorkflowDomain } from '../contracts/workspace/claim-workflow-domain.js';
import { requireCampaignOperation } from '../contracts/workspace/sequential-campaign.js';

/** Campaign policy and the existing claim journal share one canonical Store lock. */
export class NativeCampaignWorkflowTasks implements WorkflowTaskStore<ClaimWorkflowDomain> {
  private readonly attempts: NativeClaimWorkflowTasks;
  constructor(repository: ClaimRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
    this.attempts = new NativeClaimWorkflowTasks(repository, now);
  }
  transaction<T>(operation: (tx: WorkflowTransaction<ClaimWorkflowDomain>) => Promise<T>): Promise<T> {
    return this.attempts.transaction(tx => operation({...tx, domain: {...tx.domain,
      execute: async (kind, jobId, revision, token, session, status, savedSessionFingerprint) => {
        await requireCampaignOperation(tx.domain.snapshot, kind, jobId, revision, status, this.now());
        return tx.domain.execute(kind, jobId, revision, token, session, status, savedSessionFingerprint);
      },
    }}));
  }
}
