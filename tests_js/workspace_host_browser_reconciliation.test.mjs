import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setupHost, host, acquire, proposal, binding, event, read, unchanged } from './workspace_host_browser_support.mjs';

for (const continuation of ['progress', 'recover']) test(`read-only reconciliation survives ${continuation} without relaxing writes`, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setupHost(fixture, `reconcile-${continuation}`);
  let interrupted = true;
  const adapter = { evidenceKind: 'synthetic_adapter', observe: () => state.adapter.observe(),
    mutate: request => state.adapter.mutate(request), readback: request => {
      if (interrupted) { interrupted = false; throw Error('lost readback'); }
      return state.adapter.readback(request);
    } };
  let ports = host(state, { adapter }); t.after(() => ports.host.close());
  const original = await acquire(ports), request = await proposal(ports, state, original);
  assert.equal((await ports.model.execute(request)).status, 'uncertain');
  let current;
  if (continuation === 'progress') current = (await ports.model.event(event('progress', original))).receipt.task;
  else {
    await ports.host.close();
    state.clock.now = '2026-10-10T12:06:00Z';
    ports = host(state, { adapter });
    await unchanged(state, () => ports.model.reconcile(binding(state, original), request.operationId), /authority_denied/);
    const recovery = event('recover', original, { operationId: 'recover-browser' });
    const reviewed = await ports.host.review(recovery);
    ports.host.approvals.approve(reviewed.binding, 300000);
    current = (await ports.model.event(recovery)).receipt.task;
  }
  assert.notEqual(current.revision, original.revision);
  await unchanged(state, () => ports.model.execute(request), /authority_denied/);
  await unchanged(state, () => ports.model.reconcile(binding(state, original), request.operationId), /authority_denied/);
  for (const field of ['taskId', 'jobId', 'attemptRevision', 'authorizationRevision']) {
    const forged = { ...binding(state, current), [field]: field.endsWith('Id') ? 'other' : '999' };
    await unchanged(state, () => ports.model.reconcile(forged, request.operationId), /authority_denied/);
  }
  const fresh = await proposal(ports, state, current, { operationId: 'blocked-write' });
  await unchanged(state, () => ports.model.execute(fresh), /reconciliation_required/);
  const originalStored = (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations[request.operationId].request;
  assert.match(originalStored.sourceGrantFingerprint, /^[a-f0-9]{64}$/);
  const writes = state.adapter.calls.writes;
  assert.equal((await ports.model.reconcile(binding(state, current), request.operationId)).status, 'verified');
  assert.equal(state.adapter.calls.writes, writes);
  const stored = (await read(state.root, 'jobs.json')).metadata.durableBrowserOperations.operations[request.operationId];
  assert.deepEqual(stored.request, originalStored);
  const next = await proposal(ports, state, current, { operationId: 'after-reconciliation' });
  assert.equal((await ports.model.execute(next)).status, 'verified');
  assert.equal(state.adapter.calls.writes, writes + 1);
  await state.authority.revoke(BigInt(state.authorization.revision));
  await unchanged(state, () => ports.model.reconcile(binding(state, current), request.operationId), /authority_denied/);
});
