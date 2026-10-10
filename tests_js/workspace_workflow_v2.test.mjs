import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyWorkflowLedger, upgradeWorkflowLedger, validateWorkflowLedger, encodeWorkflowLedger, decodeWorkflowLedger }
  from '../runtime/contracts/workspace/workflow-tasks.js';
import { serialize } from '../runtime/contracts/workspace/values.js';
import { workflowRetentionReport } from '../runtime/contracts/workspace/workflow-retention.js';
import { runDurableOperation } from '../runtime/harness/run.js';

const resumeTask = () => ({ taskId: 'resume-task', workflow: { id: 'resume.extract', version: 1 }, revision: '1',
  subject: { kind: 'resume', resumeId: 'resume', resumeRevision: '1', inputRevision: 'a'.repeat(64),
    requestId: 'request', requestRevision: '1', factRevision: null }, status: 'active', pending: null });
const accepted = task => ({ fingerprint: 'b'.repeat(64), receipt: { operationId: 'start', task, outcome: 'extraction_requested' } });

test('v1 encoding preserves the historical representation; resume protocol requires explicit v2', () => {
  const old = emptyWorkflowLedger(), before = JSON.stringify(old);
  const encoded = serialize(encodeWorkflowLedger(old));
  assert.equal(serialize(encodeWorkflowLedger(decodeWorkflowLedger(encodeWorkflowLedger(old)))), encoded);
  assert.equal(encoded.includes('archive'), false);
  const next = upgradeWorkflowLedger(old), task = resumeTask();
  next.tasks[task.taskId] = task; next.activeTaskId = task.taskId; next.receipts.start = accepted(task);
  assert.deepEqual(decodeWorkflowLedger(encodeWorkflowLedger(next)), JSON.parse(JSON.stringify(next)));
  assert.equal(JSON.stringify(old), before);
  const legacy = { ...next, schemaVersion: 1 }; delete legacy.archive;
  assert.throws(() => validateWorkflowLedger(legacy), /invalid_task_state/);
  for (const change of [t => t.subject.kind = 'job', t => t.subject.requestRevision = '0',
    t => t.subject.factRevision = 'free text', t => t.subject.extra = 'PRIVATE', t => delete t.subject.requestId]) {
    const invalid = structuredClone(next); change(invalid.tasks[task.taskId]);
    assert.throws(() => validateWorkflowLedger(invalid), /invalid_task_state/);
  }
  const badOutcome = structuredClone(next); badOutcome.receipts.start.receipt.outcome = 'invented';
  assert.throws(() => validateWorkflowLedger(badOutcome), /invalid_task_state/);
});

test('archived receipt authorizes before replay; changed operation and historical task reuse fail without execution', async () => {
  const task = { ...resumeTask(), status: 'finished' }, historical = accepted(task);
  const ledger = upgradeWorkflowLedger(emptyWorkflowLedger());
  const seen = [];
  const history = { task: id => id === task.taskId ? task : null, receipt: id => id === 'start' ? historical : null };
  const store = { transaction: callback => callback({ ledger, history, domain: {}, commit: async () => seen.push('commit') }) };
  const request = { operationId: 'start', fingerprint: historical.fingerprint, taskId: task.taskId, expectedRevision: '1' };
  const handler = { authorize: (_ledger, lookup) => { assert.deepEqual(lookup.task(task.taskId), task); seen.push('authorize'); },
    execute: async () => { seen.push('execute'); return { task, outcome: 'extraction_requested' }; } };
  assert.deepEqual(await runDurableOperation(store, request, handler), { receipt: historical.receipt, replayed: true });
  assert.deepEqual(seen, ['authorize']);
  await assert.rejects(runDurableOperation(store, { ...request, fingerprint: 'c'.repeat(64) }, handler), /operation_conflict/);
  await assert.rejects(runDurableOperation(store, { ...request, operationId: 'new' }, handler), /task_conflict/);
  await assert.rejects(runDurableOperation(store, request, { ...handler, authorize: () => { throw Error('revoked'); } }), /revoked/);
  assert.ok(!seen.includes('execute') && !seen.includes('commit'));
});

test('v2 retention reports the bounded archive without changing the v1 report shape', () => {
  const old = workflowRetentionReport(emptyWorkflowLedger());
  assert.equal(old.archiveImplemented, false); assert.equal(Object.hasOwn(old, 'archive'), false);
  const ledger = upgradeWorkflowLedger(emptyWorkflowLedger());
  ledger.archive.segments.push({ digest: 'd'.repeat(64), taskCount: 1, receiptCount: 253 });
  const report = workflowRetentionReport(ledger);
  assert.equal(report.archiveImplemented, true);
  assert.deepEqual(report.archive, { segments: { used: 1, limit: 32, remaining: 31 }, receipts: 253, finiteCapacity: true });
  assert.deepEqual(report.reclaimed, { tasks: 0, receipts: 0, serializedCodeUnits: 0 });
});
