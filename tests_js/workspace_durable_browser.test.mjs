import assert from 'node:assert/strict';
import test from 'node:test';
import { emptyBrowserOperationLedger, validateBrowserOperationLedger, validateBrowserOperationTransition } from '../runtime/contracts/workspace/browser-operations.js';
import { requestFingerprint } from '../runtime/integrations/browser/contract.js';
import { adapter, boundary, memoryStore, mutation, observation, wrapper } from './workspace_durable_browser_support.mjs';

const reject = (promise, code) => assert.rejects(promise, error => error.code === code && error.message === code && error.cause === undefined);

test('pending intent is durable before any adapter call and reauthorization closes the Store I/O gap', async () => {
  const base = adapter(); let checks = 0;
  const store = memoryStore(), authority = { check: async request => {
    checks++;
    if (checks === 2) assert.equal(store.ledger.operations[request.operationId].state, 'pending');
    return { authorized: checks !== 2, requestFingerprint: requestFingerprint(request) };
  } };
  const app = boundary(store, base, authority), request = mutation(await app.observe());
  await reject(app.execute(request), 'authority_denied');
  assert.equal(base.calls.mutate, 0);
  assert.equal(store.ledger.operations[request.operationId].state, 'rejected');
  assert.equal(store.ledger.operations[request.operationId].receipt.reason, 'authority_denied');
  assert.equal((await boundary(store, base).execute(request)).status, 'not_applied');
  assert.equal(base.calls.mutate, 0);
});

test('no Store lock surrounds authority or adapter; duplicate instances share one durable write fence', async () => {
  const base = adapter(), store = memoryStore();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const wrapped = wrapper(base, { mutate: async request => {
    assert.equal((await store.transaction(async tx => tx.ledger)).operations[request.operationId].state, 'pending');
    entered(); await gate;
    return base.mutate(request);
  } });
  const app = boundary(store, wrapped), second = boundary(store, wrapped);
  const request = mutation(await app.observe()); await second.observe();
  const first = app.execute(request); await started;
  assert.equal((await second.execute(request)).status, 'uncertain');
  await reject(second.execute({ ...request, operationId: 'second' }), 'reconciliation_required');
  await reject(second.execute({ ...request, valueRef: 'other' }), 'operation_conflict');
  release(); assert.equal((await first).status, 'verified');
  assert.equal((await second.execute(request)).status, 'verified');
  assert.equal(base.calls.writes, 1);
});

test('lost write response survives reconstruction; exact reconciliation reads once and never retries mutation', async () => {
  const base = adapter(), store = memoryStore();
  const app = boundary(store, wrapper(base, { mutate: async request => {
    await base.mutate(request); throw Error('PRIVATE LOST RESPONSE');
  } }));
  const request = mutation(await app.observe());
  assert.equal((await app.execute(request)).status, 'uncertain');
  assert.equal(store.ledger.operations[request.operationId].state, 'uncertain');
  const restored = boundary(store, base), latest = await restored.observe();
  await reject(restored.execute(mutation(latest, { operationId: 'blind-retry' })), 'reconciliation_required');
  assert.equal((await restored.execute(request)).status, 'uncertain');
  assert.equal(base.calls.readback, 0);
  assert.equal((await restored.reconcile(request.operationId)).status, 'verified');
  assert.deepEqual(base.calls, { observe: 2, mutate: 1, writes: 1, readback: 1 });
  const before = base.calls;
  assert.equal((await boundary(store, base).execute(request)).status, 'verified');
  assert.deepEqual(base.calls, before);
  assert.doesNotMatch(JSON.stringify(store.ledger), /PRIVATE/);
});

test('conditional rejection remains terminal on restart; fresh operation requires a fresh observation', async () => {
  const base = adapter(), store = memoryStore(), app = boundary(store, base);
  const request = mutation(await app.observe(), { valueRef: 'missing-reference' });
  assert.deepEqual(await app.execute(request), { operationId: request.operationId, evidenceKind: 'synthetic_adapter',
    status: 'not_applied', reason: 'control_unavailable' });
  assert.equal(store.ledger.operations[request.operationId].state, 'rejected');
  const restored = boundary(store, base), before = base.calls;
  assert.equal((await restored.reconcile(request.operationId)).status, 'not_applied');
  assert.equal((await restored.execute(request)).status, 'not_applied');
  assert.deepEqual(base.calls, before);
  await reject(restored.execute({ ...request, operationId: 'new', valueRef: 'profile.email' }), 'observation_required');
  assert.equal((await restored.execute(mutation(await restored.observe(), { operationId: 'new' }))).status, 'verified');
});

test('malformed or wrong readback stays uncertain and delayed mismatch cannot downgrade concurrent verification', async () => {
  for (const change of [
    value => ({ ...value, effect: ['matches'] }),
    value => ({ ...value, operationId: 'other' }),
    value => ({ ...value, observation: { ...value.observation, observationRevision: '1' } }),
    value => ({ ...value, observation: { ...value.observation, finalAction: 'activated' } }),
  ]) {
    const base = adapter(), store = memoryStore(), app = boundary(store, wrapper(base, {
      readback: async request => change(await base.readback(request)),
    }));
    const request = mutation(await app.observe());
    assert.equal((await app.execute(request)).status, 'uncertain');
    assert.equal((await boundary(store, base).reconcile(request.operationId)).status, 'verified');
    assert.equal(base.calls.writes, 1);
  }
  const base = adapter(), store = memoryStore(), app = boundary(store, wrapper(base, {
    mutate: async request => { await base.mutate(request); throw Error('lost response'); },
  }));
  const request = mutation(await app.observe()); await app.execute(request);
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const delayed = boundary(store, wrapper(base, { readback: async request => {
    const result = await base.readback(request); entered(); await gate;
    return { ...result, effect: 'differs' };
  } }));
  const first = delayed.reconcile(request.operationId); await started;
  assert.equal((await boundary(store, base).reconcile(request.operationId)).status, 'verified');
  release(); assert.equal((await first).status, 'verified');
  assert.equal(store.ledger.operations[request.operationId].state, 'verified');
  assert.equal(base.calls.writes, 1);
});

test('commit failures fail closed before mutation and after write without false completion', async () => {
  for (const mode of ['before-intent', 'after-intent', 'before-result', 'after-result']) {
    const base = adapter(); let enabled = true;
    const store = memoryStore(undefined, async (stage, next) => {
      const pending = next.operations['operation-one'].state === 'pending';
      const fail = mode === 'before-intent' ? stage === 'before' && pending
        : mode === 'after-intent' ? stage === 'after' && pending
          : mode === 'before-result' ? stage === 'before' && !pending : stage === 'after' && !pending;
      if (enabled && fail) throw Error('PRIVATE STORE FAILURE');
    });
    const app = boundary(store, base), request = mutation(await app.observe());
    await reject(app.execute(request), 'storage_unavailable');
    enabled = false;
    assert.equal(base.calls.writes, mode.endsWith('intent') ? 0 : 1);
    const restored = boundary(store, base);
    if (mode === 'before-intent') {
      assert.deepEqual(Object.keys(store.ledger.operations), []);
      await restored.observe();
      assert.equal((await restored.execute(request)).status, 'verified');
    } else if (mode === 'after-intent') {
      assert.equal((await restored.reconcile(request.operationId)).status, 'uncertain');
      const latest = await restored.observe();
      await reject(restored.execute(mutation(latest, { operationId: 'blind-retry' })), 'reconciliation_required');
    } else {
      assert.equal((await restored.reconcile(request.operationId)).status, 'verified');
      assert.equal(base.calls.writes, 1);
    }
  }
});

test('denial, stale scopes, malformed input and final actions make no writes or intent records', async () => {
  const base = adapter(), store = memoryStore(), denied = boundary(store, base, { check: async () => { throw Error('PRIVATE'); } });
  const request = mutation(await denied.observe());
  await reject(denied.execute(request), 'authority_denied');
  const app = boundary(store, base); await app.observe();
  for (const input of [{ ...request, kind: 'submit' }, { ...request, kind: ['fill'] }, { ...request, approved: true }]) {
    await reject(app.execute(input), 'invalid_browser_input');
  }
  await reject(app.execute({ ...request, controlId: 'submit' }), 'scope_changed');
  for (const id of [1, ['operation-one'], { toString() { throw Error('must not coerce'); } }]) {
    await reject(app.reconcile(id), 'invalid_browser_input');
  }
  for (const key of ['taskId', 'jobId', 'taskRevision', 'attemptRevision', 'authorizationRevision', 'observationRevision']) {
    await reject(app.execute({ ...request, scope: { ...request.scope, [key]: key.endsWith('Id') ? 'other' : '99' } }), 'scope_changed');
  }
  assert.equal(store.commits, 0); assert.equal(base.calls.mutate, 0);
});

test('replay and reconciliation require current authority; missing effect remains blocked after observation', async () => {
  const base = adapter(), store = memoryStore();
  const app = boundary(store, wrapper(base, { mutate: async () => { throw Error('no write'); } }));
  const request = mutation(await app.observe()); await app.execute(request);
  const denied = boundary(store, base, { check: async request => ({ authorized: false, requestFingerprint: requestFingerprint(request) }) });
  const before = base.calls, stored = JSON.stringify(store.ledger);
  await reject(denied.execute(request), 'authority_denied');
  await reject(denied.reconcile(request.operationId), 'authority_denied');
  assert.deepEqual(base.calls, before); assert.equal(JSON.stringify(store.ledger), stored);
  const restored = boundary(store, base);
  assert.equal((await restored.reconcile(request.operationId)).status, 'uncertain');
  const latest = await restored.observe();
  await reject(restored.execute(mutation(latest, { operationId: 'replacement' })), 'reconciliation_required');
  assert.equal(base.calls.writes, 0);
});

test('finite 64-operation policy preserves replay and uncertainty fences instead of silently evicting them', async () => {
  const store = memoryStore(), base = adapter(), app = boundary(store, base); let first;
  for (let index = 0; index < 64; index++) {
    const request = mutation(await app.observe(), { operationId: `operation-${index}` });
    first ??= request;
    assert.equal((await app.execute(request)).status, 'verified');
  }
  const restored = boundary(store, base), latest = await restored.observe(), before = base.calls;
  await reject(restored.execute(mutation(latest, { operationId: 'overflow' })), 'capacity_reached');
  assert.equal((await restored.execute(first)).status, 'verified');
  await reject(restored.execute({ ...first, valueRef: 'different' }), 'operation_conflict');
  assert.deepEqual(base.calls, before);
});

test('strict durable schema and transition validation reject corruption, eviction and terminal downgrades', async () => {
  const store = memoryStore(), base = adapter(), app = boundary(store, base), request = mutation(await app.observe());
  await app.execute(request);
  const valid = structuredClone(store.ledger);
  for (const corrupt of [
    { ...valid, schemaVersion: 2 }, { ...valid, extra: true },
    { ...valid, operations: { ...valid.operations, wrong: valid.operations['operation-one'] } },
    { ...valid, operations: { 'operation-one': { ...valid.operations['operation-one'], state: ['verified'] } } },
    { ...valid, operations: { 'operation-one': { ...valid.operations['operation-one'], fingerprint: '0'.repeat(64) } } },
    { ...valid, operations: { 'operation-one': { ...valid.operations['operation-one'], receipt: {
      ...valid.operations['operation-one'].receipt, reason: ['readback_matched'] } } } },
  ]) assert.throws(() => validateBrowserOperationLedger(corrupt), { code: 'invalid_browser_state' });
  const downgraded = structuredClone(valid);
  downgraded.operations['operation-one'].state = 'uncertain';
  downgraded.operations['operation-one'].receipt.status = 'uncertain';
  downgraded.operations['operation-one'].receipt.reason = 'reconciliation_required';
  assert.throws(() => validateBrowserOperationTransition(valid, downgraded), { code: 'invalid_browser_state' });
  assert.throws(() => validateBrowserOperationTransition(valid, emptyBrowserOperationLedger()), { code: 'invalid_browser_state' });
  const two = structuredClone(downgraded), nextRequest = mutation(observation(), { operationId: 'two' });
  two.operations.two = { request: nextRequest, fingerprint: requestFingerprint(nextRequest), state: 'pending',
    receipt: { ...downgraded.operations['operation-one'].receipt, operationId: 'two' } };
  assert.throws(() => validateBrowserOperationLedger(two), { code: 'invalid_browser_state' });
});
