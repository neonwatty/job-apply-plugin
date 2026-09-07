import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, digest } from '../tools/migration/evidence-io.mjs';
import { lineageRepository } from './migration_task_lineage_git_support.mjs';
import { assertHandoffLineageCoexistence } from './migration_task_handoff_support.mjs';
import { assertOpen } from './migration_task_lineage_support.mjs';
const denied = result => { assert.ok(result.errors.length); assertOpen(result); };

test('P07 replacement cannot weaken accepted dependencies or required coverage', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal(), point = f.checkpoint();
  const variants = [
    { changeDag(dag) { dag.find(item => item.id === 'B.retry1.I').dependencies = []; } },
    { changeManifests(items) { for (const item of items) item.cells[0].requirementIds = []; } },
    { changeManifests(items) { for (const item of items) item.cells[0].environmentId = 'unknown'; } },
    { changeManifests(items) { for (const item of items) item.artifacts = []; } },
    { changeManifests(items) { for (const item of items) item.author = 'different-author'; } },
    { changeManifests(items) { for (const item of items) item.reviewer = 'different-reviewer'; } },
    { changeManifests(items) { for (const item of items) item.cells[0].command = ['node', '--test', 'tests_js/a.test.mjs']; } },
    { changePackage(pkg) { pkg.allowed_files.push('arbitrary.data'); pkg.emittedFiles.push('arbitrary.data'); }, mutate(transition) { transition.packageVersions[0].additions.allowed_files.push('arbitrary.data'); transition.packageVersions[0].additions.emittedFiles.push('arbitrary.data'); } },
    { changeRegistry(packages) { packages[0].owner = 'unrelated-owner'; } },
    { mutate(transition) { transition.packageVersions[0].additions.allowed_files.pop(); } },
    { mutate(transition) { transition.packageVersions[0].previous.packageSha256 = 'a'.repeat(64); } },
    { mutate(transition) { transition.packageVersions[0].previous.registry.revision = 'f'.repeat(40); } },
  ];
  for (const variant of variants) {
    f.restore(point); const next = await f.freezeReplacement(original, variant);
    await f.activateReplacement(next); const result = await f.check(); denied(result);
    assert.doesNotMatch(result.errors.join('\n'), /Uninventoried|Source hash differs|Missing source/);
    assert.match(result.errors.join('\n'), /lineage|Replacement|package|Witness|manifest|environment|registry|Cannot retire|Added emission/i);
    assert.equal(canonical(f.receipts), f.acceptedHistory);
  }
  f.restore(point); await f.implement(original, { mismatch: true }); await f.capture(original);
  const pending = f.checkpoint();
  for (const index of [0, 1]) {
    f.restore(pending);
    const adopted = await f.freezeReplacement(original, { changeManifests(items) { items[index].inputs = items[index].inputs.filter(item => item.path !== 'src/b.ts'); } });
    await f.activateReplacement(adopted); const result = await f.check(); denied(result);
    assert.match(result.errors.join('\n'), /adopt|input|bound/i);
  }
  for (const path of ['src/unowned.ts', 'runtime/unowned.js', 'tests_js/unowned.test.mjs', 'config/unowned.json', 'docs/migration/evidence/fake.tap', 'outside.md']) {
    f.restore(pending); await f.prepare('forbidden-preparation', [[path, '{}\n']]);
    const result = await f.check(); denied(result); assert.match(result.errors.join('\n'), /[Pp]reparation/);
  }
  f.restore(pending);
  await f.prepare('valid-preparation', [['docs/migration/evidence/pinned.md', 'immutable planning\n']]);
  assert.deepEqual((await f.check()).errors, []); const pinned = f.checkpoint();
  for (const mutate of [
    () => { f.lineage.preparations.pop(); },
    () => { f.lineage.preparations[0].files[0].sha256 = 'a'.repeat(64); },
  ]) {
    f.restore(pinned); mutate(); await f.write('config/migration/task-lineage.json', f.lineage); await f.lock(); f.commit();
    const result = await f.check(); denied(result); assert.match(result.errors.join('\n'), /[Pp]reparation|history|append/);
  }
  f.restore(pinned); await f.write('docs/migration/evidence/pinned.md', 'changed planning\n'); f.commit(); denied(await f.check());
  f.restore(pinned); await f.write('tests_js/unowned.mjs', 'export const unauthorized = true;\n'); f.commit();
  const drift = await f.check(); denied(drift); assert.match(drift.errors.join('\n'), /[Dd]rift|[Uu]ndeclared|[Ss]cope/);
});
test('P07 replacement cycles and fake Git ancestry fail closed', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal(), point = f.checkpoint();
  const cycle = await f.freezeReplacement(original, { mutate(transition) { transition.retirements[0].replacementId = 'B.I'; } });
  await f.activateReplacement(cycle); denied(await f.check()); f.restore(point);
  let sibling;
  const fake = await f.freezeReplacement(original, { mutate(transition) {
    sibling = f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', f.git('rev-parse', 'HEAD^{tree}'), '-p', point.revision, '-m', 'sibling DAG');
    transition.nextDag.revision = sibling;
  } });
  assert.ok(f.io.ancestor(point.revision, sibling)); assert.equal(f.io.ancestor(sibling, f.git('rev-parse', 'HEAD')), false);
  await f.activateReplacement(fake); denied(await f.check()); f.restore(point);
  const obsolete = await f.freezeReplacement(original); await f.activateReplacement(obsolete);
  await f.freezeOriginal('C', { archived: true }); const stale = await f.check(); denied(stale);
  assert.match(stale.errors.join('\n'), /obsolete assignment/); f.restore(point);
  const between = await f.freezeReplacement(original); await f.freezeOriginal('C'); await f.activateReplacement(between);
  const late = await f.check(); denied(late); assert.match(late.errors.join('\n'), /refinement|frozen/i); f.restore(point);
  const first = await f.freezeReplacement(original); await f.activateReplacement(first);
  const loop = await f.freezeReplacement(first, { key: 'B.retry2', mutate(transition) { transition.retirements[0].replacementId = 'B.I'; } });
  await f.activateReplacement(loop); denied(await f.check()); f.restore(point);
  await f.implement(original, { mismatch: true }); await f.capture(original);
  const attempt = await f.freezeReplacement(original, { mutate(transition) {
    const evidenceSibling = f.git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit-tree', f.io.tree(original.evidence), '-p', point.revision, '-m', 'sibling attempt');
    assert.equal(f.io.ancestor(evidenceSibling, f.git('rev-parse', 'HEAD')), false);
    transition.retirements[0].attempt.evidenceCommit = evidenceSibling;
  } });
  await f.activateReplacement(attempt); denied(await f.check());
});
test('P07 later replacement success cannot retroactively pass the rejected attempt', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal();
  await f.implement(original, { mismatch: true }); await f.capture(original);
  const next = await f.freezeReplacement(original); await f.activateReplacement(next); await f.implementReplacement(next); await f.capture(next);
  const result = await f.publish(next); assert.deepEqual(result.errors, []); assert.ok(result.taskEvidence.acceptedTasks.includes('B.retry1.V'));
  assert.equal(result.taskEvidence.acceptedTasks.includes('B.I'), false); assert.equal(result.taskEvidence.acceptedTasks.includes('B.V'), false);
  assert.equal(f.receipts.some(item => item.id === 'B.I' || item.id === 'B.V'), false);
  assert.equal(await readFile(join(f.root, original.manifests[0].cells[0].logPath), 'utf8'), original.log);
  const accepted = f.checkpoint();
  denied(await f.publish(original)); f.restore(accepted);
  f.receipts.push({ ...structuredClone(f.receipts.find(item => item.id === 'B.retry1.I')), id: 'B.I' });
  await f.write('config/migration/task-receipts.json', { schemaVersion: 1, receipts: f.receipts }); await f.lock(); f.commit();
  denied(await f.check()); f.restore(accepted);
  const consumer = await f.freezeOriginal('C'); await f.implement(consumer); await f.capture(consumer);
  const wrongDependency = await f.publish(consumer, { mutate(receipt) {
    if (receipt.id === 'C.I') receipt.dependencies = [{ id: 'B.V', sha256: digest(canonical(original.capture)) }];
  } });
  denied(wrongDependency); assert.match(wrongDependency.errors.join('\n'), /dependency|retired|bound/i);
});
test('P07 lineage activation and receipt snapshots preserve accepted history', async t => {
  const f = await lineageRepository(t, { lifecycle: true }), original = await f.freezeOriginal();
  await f.implement(original, { mismatch: true }); await f.capture(original);
  const next = await f.freezeReplacement(original); await f.activateReplacement(next);
  await f.implementReplacement(next); await f.capture(next); const result = await f.publish(next);
  assert.deepEqual(result.errors, []); assert.ok(result.taskEvidence.acceptedTasks.includes('B.retry1.V'));
  assert.equal(f.packages.find(item => item.id === 'B').status, 'implemented');
  assert.deepEqual(f.receipts.find(item => item.id === 'B.retry1.I').dependencies, [{ id: 'A.V', sha256: digest(canonical(f.receipts.find(item => item.id === 'A.V'))) }]);
  assert.equal(canonical(f.receipts.slice(0, 2)), f.acceptedHistory);
  for (const stage of ['B.retry1-capture-preparation', 'B.retry1-documents', 'B.retry1-transition-document', 'B.retry1-activation', 'B.retry1-subject', 'B.retry1-evidence', 'B.retry1-receipts']) {
    const observation = f.observations.find(item => item.stage === stage); assert.ok(observation, stage); assert.deepEqual(observation.result.errors, [], stage);
  }
  const consumer = await f.freezeOriginal('C'); await f.implement(consumer); await f.capture(consumer);
  const terminal = await f.publish(consumer); assert.deepEqual(terminal.errors, []);
  assert.ok(terminal.taskEvidence.acceptedTasks.includes('C.V'));
  assert.equal(canonical(f.receipts.slice(0, 2)), f.acceptedHistory);
  assert.equal(f.git('status', '--porcelain'), '');
  await f.write('unrelated-untracked.txt', 'not an ignored dependency link\n'); denied(await f.check());
  await rm(join(f.root, 'unrelated-untracked.txt'));
  await symlink(join(f.root, 'node_modules'), join(f.root, 'unrelated-link')); denied(await f.check());
  await rm(join(f.root, 'unrelated-link'));
  assert.deepEqual((await f.check()).errors, []);
  await assertHandoffLineageCoexistence(t);
});

test('captured successor lifecycle preserves an accepted reference through retirement and fresh replacement review', async t => {
  const f = await lineageRepository(t, { lifecycle: true, sharedAudit: true });
  const history = canonical(f.receipts), h0 = digest(f.io.fileAt(f.git('rev-parse', 'HEAD'), f.sharedPath));
  assert.deepEqual(f.receipts.map(x => x.id), ['A.R']);
  const original = await f.freezeOriginal();
  await f.implement(original, { mismatch: true, sharedVersion: 1 }); await f.capture(original);
  const h1 = digest(f.io.fileAt(original.subject, f.sharedPath)); assert.notEqual(h0, h1);
  assert.match(original.log, /unexpected original result/);
  const first = await f.freezeReplacement(original); await f.activateReplacement(first);
  assert.equal(first.transition.retirements[1].attempt, null);
  assert.equal(first.manifests[0].inputs.find(x => x.path === f.sharedPath).sha256, h1);
  const pending = await f.check(); assert.deepEqual(pending.errors, []);
  assert.equal(pending.taskEvidence.currentAcceptance, 'open');
  assert.equal(pending.taskEvidence.acceptedTasks.length, 0);
  assert.equal(canonical(f.receipts), history);
  await f.implement(first, { mismatch: true, sharedVersion: 2 }); await f.capture(first);
  const h2 = digest(f.io.fileAt(first.subject, f.sharedPath)); assert.equal(new Set([h0, h1, h2]).size, 3);
  const next = await f.freezeReplacement(first, { key: 'B.retry2' }); await f.activateReplacement(next);
  assert.equal(next.manifests[1].inputs.find(x => x.path === f.sharedPath).sha256, h2);
  assert.deepEqual((await f.check()).errors, []);
  await f.implementReplacement(next); await f.capture(next); const accepted = await f.publish(next);
  assert.deepEqual(accepted.errors, []); assert.ok(accepted.taskEvidence.acceptedTasks.includes('B.retry2.V'));
  for (const id of ['B.I', 'B.V', 'B.retry1.I', 'B.retry1.V']) {
    assert.equal(accepted.taskEvidence.acceptedTasks.includes(id), false);
    assert.equal(f.receipts.some(x => x.id === id), false);
  }
  assert.equal(canonical(f.receipts.slice(0, 1)), history);
  assert.equal(await readFile(join(f.root, original.manifests[0].cells[0].logPath), 'utf8'), original.log);
  assert.equal(await readFile(join(f.root, first.manifests[0].cells[0].logPath), 'utf8'), first.log);
  assert.equal(f.git('status', '--porcelain'), '');
});

test('captured successor lifecycle rejects unbound adoption and keeps invalid batches closed', async t => {
  const f = await lineageRepository(t, { sharedAudit: true }), original = await f.freezeOriginal();
  await f.implement(original, { mismatch: true, sharedVersion: 1 }); await f.capture(original);
  const checkpoint = f.checkpoint();
  for (const role of [0, 1]) {
    f.restore(checkpoint);
    const next = await f.freezeReplacement(original, { changeManifests(items) {
      items[role].inputs = items[role].inputs.filter(x => x.path !== f.sharedPath);
    } });
    await f.activateReplacement(next); const result = await f.check();
    denied(result); assert.match(result.errors.join('\n'), /adopt|input|bound/i);
  }
  for (const mutate of [
    transition => { transition.retirements[0].attempt.files.find(x => x.path === f.sharedPath).sha256 = '0'.repeat(64); },
    transition => { transition.retirements[0].attempt = null; },
    transition => { transition.retirements[0].attempt.artifacts[0].sha256 = '0'.repeat(64); },
    transition => { transition.retirements[0].replacementId = 'B.I'; },
  ]) {
    f.restore(checkpoint);
    const next = await f.freezeReplacement(original, { mutate }); await f.activateReplacement(next);
    const result = await f.check(); denied(result); assert.match(result.errors.join('\n'), /capture|attempt|lineage|retir|cycle|artifact|binding/i);
  }
  f.restore(checkpoint);
  const next = await f.freezeReplacement(original); await f.activateReplacement(next);
  const active = f.checkpoint();
  const matrix = JSON.parse(await readFile(join(f.root, f.sharedPath), 'utf8'));
  matrix.suites[0].include.push('tests_js/unbound-future.test.mjs'); await f.write(f.sharedPath, matrix); f.commit();
  // A pending, owned implementation change is allowed, but cannot manufacture a receipt.
  const changed = await f.check(); assert.deepEqual(changed.errors, []);
  assert.equal(changed.taskEvidence.currentAcceptance, 'open'); assert.equal(changed.taskEvidence.acceptedTasks.length, 0);
  f.restore(active); await f.implementReplacement(next); await f.capture(next);
  const ready = f.checkpoint();
  const accepted = await f.publish(next); assert.deepEqual(accepted.errors, []);
  const valid = f.checkpoint();
  const wrong = await f.publish(original); denied(wrong); f.restore(valid);
  f.restore(ready);
  const invalid = await f.publish(next, { mutate(receipt) {
    if (receipt.id === 'B.retry1.I') receipt.dependencies[0].sha256 = '0'.repeat(64);
  } }); denied(invalid); assert.match(invalid.errors.join('\n'), /dependency|bound|receipt/i);
  f.restore(active);
  await f.implement(next, { mismatch: true, sharedVersion: 2 }); await f.capture(next);
  const twice = f.checkpoint();
  const retry2 = await f.freezeReplacement(next, { key: 'B.retry2' }); await f.activateReplacement(retry2);
  assert.deepEqual((await f.check()).errors, []);
  const chain = f.checkpoint();
  for (const task of [original, next]) {
    f.restore(chain);
    await rm(join(f.root, task.manifests[0].cells[0].logPath)); f.commit();
    const missing = await f.check(); denied(missing); assert.match(missing.errors.join('\n'), /capture|artifact|log|history|lineage/i);
  }
  f.restore(twice);
  const cycle = await f.freezeReplacement(next, { key: 'B.retry2', mutate(transition) {
    transition.retirements[0].replacementId = 'B.I';
  } });
  await f.activateReplacement(cycle); denied(await f.check());
  const product = await lineageRepository(t, { sharedAudit: true, productBridge: true });
  const productOriginal = await product.freezeOriginal();
  await product.implement(productOriginal, { mismatch: true, sharedVersion: 1 });
  const beforeCapture = await product.check(); denied(beforeCapture);
  assert.match(beforeCapture.errors.join('\n'), /product edits require a frozen predecessor handoff/);
  await product.capture(productOriginal);
  assert.equal(product.packages.find(x => x.id === 'B').status, 'planned');
  const productRetry = await product.freezeReplacement(productOriginal); await product.activateReplacement(productRetry);
  const noHandoff = await product.check(); denied(noHandoff);
  assert.ok(noHandoff.errors.some(error => error.includes('dirty/stale/untracked subject file')), noHandoff.errors.join('\n'));
});
