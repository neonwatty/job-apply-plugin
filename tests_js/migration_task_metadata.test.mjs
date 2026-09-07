import assert from 'node:assert/strict';
import test from 'node:test';
import { repository } from './migration_task_support.mjs';
import { loadTaskEvidence } from '../tools/migration/load-task-evidence.mjs';
import { acceptedProduct, noAcceptance, SHARED } from './migration_task_handoff_support.mjs';

async function successor(repo, id = 'B', predecessor = 'A') {
  const next = await repo.freeze(id); await repo.authorize(next, { predecessor }); await repo.activate(next); return next;
}
function consistent(observations) {
  for (const { stage, result } of observations) assert.deepEqual(result.errors, [], stage);
}

test('P06 coordinator catalog and review lock evolve through actual activation and receipt snapshots', async t => {
  const repo = await acceptedProduct(t, { lifecycle: true });
  consistent(repo.observations);
  assert.deepEqual(repo.observations.map(item => item.stage), ['prerequisite-planning', 'prerequisite-receipt', 'independent-package-ready',
    'A-preparation', 'A-planning', 'A-activation', 'A-subject', 'A-evidence', 'A-receipt']);
});

test('P06 metadata evolution cannot conceal source edits or unrelated shard changes', async t => {
  const repo = await acceptedProduct(t);
  const next = await successor(repo), checkpoint = repo.checkpoint();
  await repo.write('src/unowned.ts', 'export const unowned = 1;\n');
  await repo.writeLock(); repo.commit();
  assert.ok((await repo.check()).errors.length);
  repo.restore(checkpoint);
  await repo.write('config/migration/unrelated.json', { schemaVersion: 1, unrelated: true });
  await repo.writeLock(); repo.commit();
  assert.ok((await repo.check()).errors.length);
  repo.restore(checkpoint);
  await repo.implement(next);
  await repo.write('notes-untracked.txt', 'unrelated dirt\n');
  const dirty = await repo.check(); assert.ok(dirty.errors.length); noAcceptance(dirty);
});

test('P06 frozen metadata identities and historical evidence remain immutable', async t => {
  const audit = await repository(); t.after(audit.cleanup);
  assert.deepEqual((await loadTaskEvidence(audit.root, audit.context)).errors, []);
  audit.receipt.cells[0].result.durationMs += 1;
  await audit.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: [audit.receipt] });
  await audit.writeLock(); audit.commit();
  const rewritten = await loadTaskEvidence(audit.root, audit.context);
  assert.ok(rewritten.errors.length, 'otherwise valid receipt metric rewrite must fail historical immutability');
  assert.equal(rewritten.acceptedTasks.size, 0);
  const repo = await acceptedProduct(t);
  await successor(repo); const checkpoint = repo.checkpoint();
  const catalog = structuredClone(repo.catalog);
  for (const mutate of [
    value => { value.assignments[0].author = 'forged-author'; },
    value => { value.assignments[0].manifest.sha256 = '0'.repeat(64); },
    value => { value.environments[0].node = 'v0.0.0'; },
  ]) {
    const altered = structuredClone(catalog); mutate(altered);
    await repo.write('config/migration/task-contracts.json', altered); await repo.writeLock(); repo.commit();
    const result = await repo.check(); assert.ok(result.errors.length); noAcceptance(result);
    repo.restore(checkpoint);
  }
  const receipts = structuredClone(repo.receipts); receipts[0].review.reviewer = 'replacement-reviewer';
  await repo.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts });
  await repo.writeLock(); repo.commit();
  const result = await repo.check(); assert.ok(result.errors.length); noAcceptance(result);
});

test('P06 actual dependency-linked hook snapshots support the complete registered product lifecycle', async t => {
  const repo = await acceptedProduct(t, { lifecycle: true });
  const next = await repo.freeze('B'); await repo.authorize(next);
  const parallel = await repo.freeze('E');
  await repo.activate(next); parallel.executionBase = next.executionBase;
  const common = next.executionBase;
  repo.git('checkout', '-qb', 'fixture-b'); await repo.implement(next);
  const bSubject = next.subject;
  repo.git('checkout', '-qb', 'fixture-e', common); await repo.implement(parallel);
  const eSubject = parallel.subject;
  repo.git('checkout', 'fixture-b');
  try { repo.git('merge', '--no-commit', '--no-ff', 'fixture-e'); }
  catch (error) {
    assert.deepEqual(repo.git('diff', '--name-only', '--diff-filter=U').split('\n'), ['config/migration/review-lock.json']);
  }
  await repo.writeLock(); await repo.observe('parallel-merge'); repo.commit();
  assert.equal(repo.git('merge-base', bSubject, eSubject), common);
  assert.equal(repo.git('rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  const pending = await repo.check(); assert.deepEqual(pending.errors, []); noAcceptance(pending);
  const result = await repo.complete(next); assert.deepEqual(result.errors, []);
  noAcceptance(result);
  const parallelResult = await repo.complete(parallel);
  assert.deepEqual(parallelResult.errors, []);
  assert.ok(parallelResult.taskEvidence.acceptedPackages.includes('B'));
  assert.ok(parallelResult.taskEvidence.acceptedPackages.includes('E'));
  const later = await successor(repo, 'D', 'B');
  await repo.implement(later); const completed = await repo.complete(later);
  assert.deepEqual(completed.errors, []); assert.ok(completed.taskEvidence.acceptedPackages.includes('D'));
  consistent(repo.observations);
  assert.ok(repo.observations.some(item => item.stage === 'D-receipt'));
  assert.match(repo.git('show', `HEAD:${SHARED}`), /'D'/);
});
