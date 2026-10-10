import { archiveSegmentLimit } from './workflow-archive.js';
import { receiptLimit, taskLimit, validateWorkflowLedger } from './workflow-tasks.js';
/** Matches the v1 codec's JSON.stringify length bound, measured in UTF-16 code units. */
const serializedCodeUnitLimit = 1024 * 1024;
const usage = (used, limit) => ({ used, limit, remaining: limit - used });
/** Read-only capacity planning. Does not read claims, move history, or grant an operation.
 * Serialized pressure uses the same measure as the ledger codec; the size of a proposed
 * next task/receipt is unknown, so countCapacity intentionally excludes byte eligibility.
 */
export function workflowRetentionReport(value) {
    const ledger = validateWorkflowLedger(value);
    const tasks = Object.values(ledger.tasks), receipts = Object.values(ledger.receipts);
    const taskCapacity = usage(tasks.length, taskLimit), receiptCapacity = usage(receipts.length, receiptLimit);
    const receiptCounts = new Map();
    for (const item of receipts) {
        const id = item.receipt.task.taskId;
        receiptCounts.set(id, (receiptCounts.get(id) ?? 0) + 1);
    }
    const summarize = (taskId) => ({ taskId, receiptCount: receiptCounts.get(taskId) ?? 0 });
    const pinned = ledger.activeTaskId === null ? null : ledger.tasks[ledger.activeTaskId];
    const canStart = pinned === null && taskCapacity.remaining > 0;
    return {
        mode: 'read_only', archiveImplemented: ledger.schemaVersion === 2,
        ...(ledger.schemaVersion === 2 ? { archive: {
                segments: usage(ledger.archive.segments.length, archiveSegmentLimit),
                receipts: ledger.archive.segments.reduce((count, item) => count + item.receiptCount, 0), finiteCapacity: true,
            } } : {}),
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
        pinnedTask: pinned === null ? null : { ...summarize(pinned.taskId), status: pinned.status },
        terminalCandidates: tasks.filter(task => task.status === 'finished' || task.status === 'cancelled')
            .map(task => summarize(task.taskId)).sort((left, right) => left.taskId < right.taskId ? -1 : left.taskId > right.taskId ? 1 : 0),
    };
}
