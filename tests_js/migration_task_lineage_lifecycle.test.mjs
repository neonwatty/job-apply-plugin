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
