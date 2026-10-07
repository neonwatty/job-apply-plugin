import { requireTransitionIntent } from '../contracts/workspace/application-intents.js';
import { inspectJobTransition, buildJobTransition } from '../contracts/workspace/application-policy.js';
import { get, object, set, string } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';
import type { ClaimRepository } from './claims.js';

export class JobTransitionsService {
  constructor(private readonly repository: ClaimRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}

  async transition(id: string, status: string, expectedRevision: bigint,
    closedOutcome: Value = null, userConfirmed: boolean = false): Promise<Value> {
    requireTransitionIntent(id,status,expectedRevision,userConfirmed);
    return this.repository.claimTransaction(async tx => {
      const jobs = object(get(tx.jobs, 'jobs'), 'jobs.jobs');
      const current = await inspectJobTransition(tx,id,status,expectedRevision,userConfirmed);
      if (status === string(get(current, 'status'))) return current;
      const updated = buildJobTransition(current,status,closedOutcome,this.now);
      set(jobs, id, updated);
      set(object(get(tx.jobs, 'metadata'), 'jobs.metadata'), 'updatedAt', get(updated, 'updatedAt'));
      await tx.saveJobs(tx.jobs);
      return updated;
    });
  }
}
