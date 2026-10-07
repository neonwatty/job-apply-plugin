import type { WorkflowLedger } from '../contracts/workspace/workflow-tasks.js';

/** One lock and one atomic commit for workflow metadata and staged domain changes. */
export interface WorkflowTransaction<Domain> {
  ledger: WorkflowLedger;
  domain: Domain;
  commit(ledger: WorkflowLedger): Promise<void>;
}
export interface WorkflowTaskStore<Domain> {
  transaction<T>(operation: (transaction: WorkflowTransaction<Domain>) => Promise<T>): Promise<T>;
}
