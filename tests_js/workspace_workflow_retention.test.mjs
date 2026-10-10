import assert from 'node:assert/strict';
import test from 'node:test';
import { workflowRetentionReport } from '../runtime/contracts/workspace/workflow-retention.js';
import { emptyWorkflowLedger, receiptLimit, taskLimit, validateWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';

const task = (taskId, status = 'finished') => ({ taskId, workflow: { id: 'application.prepare', version: 1 },
  revision: '2', subject: { jobId: 'job', jobRevision: '1', inputRevision: 'a'.repeat(64) }, status,
  pending: status === 'waiting' ? { requestId: 'PRIVATE_REQUEST', questionId: 'PRIVATE_QUESTION' } : null });
function ledgerWith(status = 'finished', receiptCount = 1) {
  const ledger = emptyWorkflowLedger(), current = task('task', status);
  ledger.tasks.task = current;
  if (status === 'active' || status === 'waiting') ledger.activeTaskId = 'task';
  for (let n = 0; n < receiptCount; n++) {
    const operationId = `operation-${n}`;
    ledger.receipts[operationId] = { fingerprint: 'b'.repeat(64), receipt: {
      operationId, task: structuredClone(current), outcome: 'started',
    } };
  }
  return ledger;
}
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

test('empty report shows existing limits, no reclaimed capacity and count-only availability', () => {
  const ledger = emptyWorkflowLedger(), report = workflowRetentionReport(ledger);
  assert.equal(report.mode, 'read_only'); assert.equal(report.archiveImplemented, false);
  assert.deepEqual(report.reclaimed, { tasks: 0, receipts: 0, serializedCodeUnits: 0 });
  assert.deepEqual(report.capacity.tasks, { used: 0, limit: taskLimit, remaining: taskLimit });
  assert.deepEqual(report.capacity.receipts, { used: 0, limit: receiptLimit, remaining: receiptLimit });
  assert.equal(report.capacity.serializedCodeUnits.used, JSON.stringify(ledger).length);
  assert.equal(report.capacity.serializedCodeUnits.limit, 1024 * 1024);
  assert.ok(Object.values(report.countCapacity).every(Boolean));
  assert.equal(report.pinnedTask, null); assert.deepEqual(report.terminalCandidates, []);
});

test('active and waiting tasks stay pinned, exposing no question, scope or operation values', () => {
  for (const status of ['active', 'waiting']) {
    const ledger = ledgerWith(status, 3), before = JSON.stringify(ledger);
    const report = workflowRetentionReport(freeze(ledger));
    assert.deepEqual(report.pinnedTask, { taskId: 'task', status, receiptCount: 3 });
    assert.deepEqual(report.terminalCandidates, []);
    assert.equal(report.countCapacity.startTask, false); assert.equal(report.countCapacity.startClaim, false);
    assert.doesNotMatch(JSON.stringify(report), /PRIVATE|inputRevision|questionId|requestId|operation-|aaaa|bbbb|jobRevision/);
    assert.equal(JSON.stringify(ledger), before);
  }
});

test('terminal candidate ordering and receipt counts are stable, provisional and detached', () => {
  const ledger = ledgerWith('cancelled', 2);
  ledger.tasks.z = task('z'); ledger.tasks.A = task('A');
  const before = JSON.stringify(ledger), report = workflowRetentionReport(ledger);
  assert.deepEqual(report.terminalCandidates, [
    { taskId: 'A', receiptCount: 0 }, { taskId: 'task', receiptCount: 2 }, { taskId: 'z', receiptCount: 0 },
  ]);
  report.terminalCandidates[0].taskId = 'changed'; report.capacity.tasks.remaining = -1;
  assert.equal(JSON.stringify(ledger), before);
  const second = workflowRetentionReport(ledger);
  ledger.tasks.A.taskId = 'later';
  assert.equal(second.terminalCandidates[0].taskId, 'A');
});

test('all receipt thresholds preserve routine recovery and terminal count distinctions', () => {
  for (const remaining of [0, 1, 2, 3, 4]) {
    const report = workflowRetentionReport(ledgerWith('finished', receiptLimit - remaining));
    assert.equal(report.capacity.receipts.remaining, remaining);
    assert.deepEqual(report.countCapacity, {
      appendReceipt: remaining > 0, startTask: remaining > 0, startClaim: remaining >= 3,
      routineClaimContinuation: remaining >= 3, recoverClaim: remaining >= 2,
    });
    assert.equal(report.reclaimed.receipts, 0);
  }
  const active = workflowRetentionReport(ledgerWith('active', receiptLimit - 1));
  assert.equal(active.countCapacity.recoverClaim, false);
  assert.equal(active.countCapacity.appendReceipt, true);
  assert.deepEqual(active.terminalCandidates, []);
  assert.equal(active.pinnedTask.receiptCount, receiptLimit - 1);
});

test('task saturation prevents new tasks but cannot imply that existing receipts are evicted', () => {
  const ledger = ledgerWith('finished', 1);
  for (let n = 1; n < taskLimit; n++) ledger.tasks[`task-${n}`] = task(`task-${n}`);
  const before = JSON.stringify(ledger), report = workflowRetentionReport(ledger);
  assert.equal(report.capacity.tasks.remaining, 0);
  assert.equal(report.countCapacity.startTask, false); assert.equal(report.countCapacity.startClaim, false);
  assert.equal(report.countCapacity.appendReceipt, true);
  assert.equal(report.terminalCandidates.length, taskLimit);
  assert.equal(report.reclaimed.tasks, 0); assert.equal(JSON.stringify(ledger), before);
});

test('serialized pressure follows the codec measure and does not claim operation byte eligibility', () => {
  const ledger = ledgerWith('finished', 253), limit = 1024 * 1024;
  // A valid large decimal revision brings the ledger close to the independent byte-size bound.
  let length = 1, upper = 4300;
  const resize = size => {
    const revision = '9'.repeat(size); ledger.tasks.task.revision = revision;
    for (const item of Object.values(ledger.receipts)) item.receipt.task.revision = revision;
  };
  while (length < upper) {
    const middle = Math.ceil((length + upper) / 2); resize(middle);
    if (JSON.stringify(ledger).length <= limit) length = middle; else upper = middle - 1;
  }
  resize(length);
  const report = workflowRetentionReport(ledger);
  assert.ok(report.capacity.serializedCodeUnits.remaining < 254);
  assert.equal(report.capacity.serializedCodeUnits.remaining, limit - JSON.stringify(ledger).length);
  assert.equal(report.countCapacity.startClaim, true, 'count-only flag does not promise the next receipt fits');
  resize(length + 1);
  assert.throws(() => validateWorkflowLedger(ledger), /invalid_task_state/);
  assert.throws(() => workflowRetentionReport(ledger), /invalid_task_state/);
});

test('malformed, future, orphaned and over-capacity ledgers fail closed', () => {
  const overflowTasks = emptyWorkflowLedger();
  for (let n = 0; n <= taskLimit; n++) overflowTasks.tasks[`task-${n}`] = task(`task-${n}`);
  const orphan = ledgerWith(); delete orphan.tasks.task;
  for (const invalid of [null, {}, { ...emptyWorkflowLedger(), schemaVersion: 2 },
    { ...emptyWorkflowLedger(), extra: 'PRIVATE' }, { ...emptyWorkflowLedger(), activeTaskId: 'missing' },
    overflowTasks, ledgerWith('finished', receiptLimit + 1), orphan]) {
    const before = JSON.stringify(invalid);
    assert.throws(() => workflowRetentionReport(invalid), /invalid_task_state/);
    assert.equal(JSON.stringify(invalid), before);
  }
});
