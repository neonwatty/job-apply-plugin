import type { WorkflowLedger, WorkflowTask } from '../contracts/workspace/workflow-tasks.js';

export interface WorkflowHistoryLookup {
  task(taskId: string): WorkflowTask | null;
  receipt(operationId: string): WorkflowLedger['receipts'][string] | null;
}
export interface WorkflowArchiveService {
  validate(ledger: WorkflowLedger): Promise<void>;
  prepare(ledger: WorkflowLedger): Promise<{ ledger: WorkflowLedger; history: WorkflowHistoryLookup; flush(): Promise<void> }>;
}
export function workflowHistory(tx: { ledger: WorkflowLedger; history?: WorkflowHistoryLookup }): WorkflowHistoryLookup {
  return tx.history ?? {
    task: id => Object.hasOwn(tx.ledger.tasks, id) ? tx.ledger.tasks[id]! : null,
    receipt: id => Object.hasOwn(tx.ledger.receipts, id) ? tx.ledger.receipts[id]! : null,
  };
}
/** One lock and one atomic commit for workflow metadata and staged domain changes. */
export interface WorkflowTransaction<Domain> {
  ledger: WorkflowLedger;
  history?: WorkflowHistoryLookup;
  domain: Domain;
  commit(ledger: WorkflowLedger): Promise<void>;
}
export interface WorkflowTaskStore<Domain> {
  transaction<T>(operation: (transaction: WorkflowTransaction<Domain>) => Promise<T>): Promise<T>;
}
