import type { WorkflowTaskStore } from './task-store.js';
import { TaskProtocolError, receiptLimit, taskLimit, validateWorkflowLedger } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowLedger, WorkflowReceipt, WorkflowTask, TaskOutcome } from '../contracts/workspace/workflow-tasks.js';

export interface DurableOperation {
  operationId: string;
  fingerprint: string;
  taskId: string | null;
  expectedRevision: string | null;
}
export interface OperationResult { receipt: WorkflowReceipt; replayed: boolean }
export interface DurableHandler<Domain> {
  /** Check current access before returning even a historical receipt. Never mutate here. */
  authorize(ledger: WorkflowLedger): void;
  execute(task: WorkflowTask | null, domain: Domain): Promise<{ task: WorkflowTask; outcome: TaskOutcome }>;
}

/** Replay lookup precedes task-revision checks; a matching accepted request returns its old receipt.
 * Replays perform no domain work. A reused ID with changed input is rejected. New requests stage
 * their domain effects and task event together; commit is the only persistence boundary.
 */
export async function runDurableOperation<Domain>(store: WorkflowTaskStore<Domain>, request: DurableOperation,
  handler: DurableHandler<Domain>): Promise<OperationResult> {
  return store.transaction(async tx => {
    const ledger = tx.ledger;
    handler.authorize(ledger);
    const prior = Object.hasOwn(ledger.receipts, request.operationId) ? ledger.receipts[request.operationId]! : null;
    if (prior) {
      if (prior.fingerprint !== request.fingerprint) throw new TaskProtocolError('operation_conflict');
      return { receipt: structuredClone(prior.receipt), replayed: true };
    }
    if (Object.keys(ledger.receipts).length >= receiptLimit) throw new TaskProtocolError('history_full');
    const current = request.taskId !== null && Object.hasOwn(ledger.tasks, request.taskId) ? ledger.tasks[request.taskId]! : null;
    if (request.taskId === null) {
      if (ledger.activeTaskId !== null || request.expectedRevision !== null) throw new TaskProtocolError('task_conflict');
      if (Object.keys(ledger.tasks).length >= taskLimit) throw new TaskProtocolError('history_full');
    } else {
      if (!current || ledger.activeTaskId !== current.taskId) throw new TaskProtocolError('task_conflict');
      if (current.revision !== request.expectedRevision) throw new TaskProtocolError('stale_revision');
    }
    const next = await handler.execute(current ? structuredClone(current) : null, tx.domain);
    if (current ? next.task.taskId !== current.taskId || next.task.revision !== (BigInt(current.revision) + 1n).toString()
      : Object.hasOwn(ledger.tasks, next.task.taskId) || next.task.revision !== '1') throw new TaskProtocolError('invalid_task_state');
    const receipt: WorkflowReceipt = { operationId: request.operationId, task: structuredClone(next.task), outcome: next.outcome };
    const updated: WorkflowLedger = { ...ledger,
      activeTaskId: ['active', 'waiting'].includes(next.task.status) ? next.task.taskId : null,
      tasks: { ...ledger.tasks, [next.task.taskId]: next.task },
      receipts: { ...ledger.receipts, [request.operationId]: { fingerprint: request.fingerprint, receipt } } };
    validateWorkflowLedger(updated);
    await tx.commit(updated);
    return { receipt: structuredClone(receipt), replayed: false };
  });
}
