import { receiptLimit, taskLimit, validateWorkflowLedger } from './workflow-tasks.js';

/** Matches the v1 codec's JSON.stringify length bound, measured in UTF-16 code units. */
const serializedCodeUnitLimit = 1024 * 1024;
interface Usage { used: number; limit: number; remaining: number }
interface TaskSummary { taskId: string; receiptCount: number }
export interface WorkflowRetentionReport {
  mode: 'read_only';
  archiveImplemented: false;
  reclaimed: { tasks: 0; receipts: 0; serializedCodeUnits: 0 };
  capacity: { tasks: Usage; receipts: Usage; serializedCodeUnits: Usage };
  /** Count checks only. No flag guarantees byte space, authorization or canonical eligibility. */
  countCapacity: {
    appendReceipt: boolean;
    startTask: boolean;
    startClaim: boolean;
    routineClaimContinuation: boolean;
    recoverClaim: boolean;
  };
  /** The active/waiting record and its pending binding must remain hot. */
  pinnedTask: (TaskSummary & { status: 'active' | 'waiting' }) | null;
  /** Provisional whole-task candidates; canonical claim/journal checks are still required. */
  terminalCandidates: TaskSummary[];
}
const usage = (used: number, limit: number): Usage => ({ used, limit, remaining: limit - used });

/** Read-only capacity planning. Does not read claims, move history, or grant an operation.
 * Serialized pressure uses the same measure as the ledger codec; the size of a proposed
 * next task/receipt is unknown, so countCapacity intentionally excludes byte eligibility.
 */
export function workflowRetentionReport(value: unknown): WorkflowRetentionReport {
  const ledger = validateWorkflowLedger(value);
  const tasks = Object.values(ledger.tasks), receipts = Object.values(ledger.receipts);
  const taskCapacity = usage(tasks.length, taskLimit), receiptCapacity = usage(receipts.length, receiptLimit);
  const receiptCounts = new Map<string, number>();
  for (const item of receipts) {
    const id = item.receipt.task.taskId;
    receiptCounts.set(id, (receiptCounts.get(id) ?? 0) + 1);
  }
  const summarize = (taskId: string): TaskSummary => ({ taskId, receiptCount: receiptCounts.get(taskId) ?? 0 });
  const pinned = ledger.activeTaskId === null ? null : ledger.tasks[ledger.activeTaskId]!;
  const canStart = pinned === null && taskCapacity.remaining > 0;
  return {
    mode: 'read_only', archiveImplemented: false,
    reclaimed: { tasks: 0, receipts: 0, serializedCodeUnits: 0 },
    capacity: { tasks: taskCapacity, receipts: receiptCapacity,
      serializedCodeUnits: usage(JSON.stringify(ledger).length, serializedCodeUnitLimit) },
    countCapacity: {
      appendReceipt: receiptCapacity.remaining > 0,
      startTask: canStart && receiptCapacity.remaining > 0,
      startClaim: canStart && receiptCapacity.remaining >= 3,
      routineClaimContinuation: receiptCapacity.remaining >= 3,
      recoverClaim: receiptCapacity.remaining >= 2,
    },
    pinnedTask: pinned === null ? null : { ...summarize(pinned.taskId), status: pinned.status as 'active' | 'waiting' },
    terminalCandidates: tasks.filter(task => task.status === 'finished' || task.status === 'cancelled')
      .map(task => summarize(task.taskId)).sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0),
  };
}
