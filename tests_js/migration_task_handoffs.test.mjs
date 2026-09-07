import assert from 'node:assert/strict';
import test from 'node:test';
import { productRepository, acceptedProduct, noAcceptance, SHARED, RESERVED } from './migration_task_handoff_support.mjs';

test('P06 registered product overlap requires an independently frozen handoff', async t => {
  const repo = await acceptedProduct(t);
  const next = await repo.freeze('B'); await repo.activate(next); await repo.implement(next, { changeSource: false });
  const result = await repo.check();
  assert.ok(result.errors.length, 'accepted predecessor does not release overlap automatically');
});

test('P06 exact handoff permits only the named successor and overlapping paths', async t => {
  const repo = await acceptedProduct(t);
  const next = await repo.freeze('B'); await repo.authorize(next); await repo.activate(next); await repo.implement(next, { changeSource: false });
  const allowed = await repo.check(); assert.deepEqual(allowed.errors, []);
  const third = repo.packages.find(item => item.id === 'C');
  third.status = 'ready';
  await repo.savePackages(); await repo.writeLock(); repo.commit();
  const denied = await repo.check(); assert.ok(denied.errors.length);
  assert.ok(denied.errors.includes('Unaccepted dependency C:A'), JSON.stringify(denied));
  assert.equal(denied.errors.some(error => /Uninventoried|Source changed/.test(error)), false);
});

test('P06 forged stale expanded and competing handoffs unlock no product ownership', async t => {
  const mutations = [
    contract => { contract.author = contract.reviewer; },
    contract => { contract.predecessorReceiptSha256 = '0'.repeat(64); },
    contract => { contract.successorManifestSha256 = '0'.repeat(64); },
    contract => { contract.paths.push({ path: RESERVED, sha256: '0'.repeat(64) }); },
    contract => { contract.successorPackageId = 'C'; },
  ];
  const repo = await acceptedProduct(t), next = await repo.freeze('B');
  const checkpoint = repo.checkpoint();
  for (const mutate of mutations) {
    await repo.authorize(next, { mutate }); await repo.activate(next);
    const result = await repo.check(); assert.ok(result.errors.length); noAcceptance(result);
    repo.restore(checkpoint); repo.handoffs.length = 0;
  }
  const competing = await acceptedProduct(t, { competing: true });
  const b = await competing.freeze('B'), c = await competing.freeze('C');
  await competing.authorize(b); await competing.authorize(c); await competing.activate(b);
  const result = await competing.check();
  assert.ok(result.errors.some(error => /competing|multiple|already.*handoff/i.test(error)), JSON.stringify(result));
  noAcceptance(result);
  const premature = await productRepository(t);
  const a = await premature.freeze('A'); await premature.activate(a); await premature.implement(a);
  await premature.complete(a, { publish: false });
  const early = await premature.freeze('B'); await premature.authorize(early); await premature.activate(early);
  await premature.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: premature.receipts });
  await premature.writeLock(); premature.commit();
  const lateEvidence = await premature.check();
  assert.ok(lateEvidence.errors.some(error => /handoff|predecessor|freeze/i.test(error)), JSON.stringify(lateEvidence));
  noAcceptance(lateEvidence);
});

test('P06 unreleased predecessor paths remain reserved', async t => {
  const repo = await acceptedProduct(t);
  const next = await repo.freeze('B', { extraPaths: [RESERVED] });
  await repo.authorize(next); await repo.activate(next); await repo.implement(next, { changeSource: false });
  const result = await repo.check();
  assert.ok(result.errors.some(error => error.includes(RESERVED)), JSON.stringify(result));
});

test('P06 actual checker keeps pending successor acceptance open and accepts independently verified completion', async t => {
  const repo = await acceptedProduct(t);
  const next = await repo.freeze('B'); await repo.authorize(next); await repo.activate(next);
  await repo.implement(next);
  const pending = await repo.check(); assert.deepEqual(pending.errors, []); noAcceptance(pending);
  const finished = await repo.complete(next); assert.deepEqual(finished.errors, []);
  assert.ok(finished.taskEvidence.acceptedPackages.includes('B'));
  assert.ok(finished.taskEvidence.acceptedTasks.includes('B.V'));
  assert.ok(next.pkg.allowed_files.includes(SHARED));
});
