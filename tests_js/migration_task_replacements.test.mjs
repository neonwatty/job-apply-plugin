import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lineageRepository, REGISTRY, B_SOURCE } from './migration_task_lineage_git_support.mjs';
import { digest, canonical } from '../tools/migration/evidence-io.mjs';
import { structuralPackage } from '../tools/migration/task-manifests.mjs';
import { assertOpen } from './migration_task_lineage_support.mjs';
const denied = result => { assert.ok(result.errors.length); assertOpen(result); };

test('P07 unexecuted refinement preserves the original contract without inventing an attempt', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal();
  const pristine = f.checkpoint();
  const next = await f.freezeReplacement(original); assert.ok(next.transition.retirements.every(item => item.attempt === null));
  await f.activateReplacement(next); const result = await f.check(); assert.deepEqual(result.errors, []);
  assert.equal(result.taskEvidence.acceptedTasks.includes('B.I'), false);
  for (const item of original.manifests) {
    const path = `docs/migration/evidence/fixture/${item.id}.json`;
    assert.deepEqual(await readFile(join(f.root, path)), f.io.fileAt(original.planning, path));
  }
  assert.equal(original.pkg.allowed_files.some(path => path.includes('retry1')), false);
  assert.ok(next.pkg.allowed_files.some(path => path.includes('retry1')));
  const previous = JSON.parse(f.io.fileAt(original.planning, REGISTRY));
  const currentBytes = await readFile(join(f.root, REGISTRY)), current = JSON.parse(currentBytes);
  assert.equal(digest(canonical(structuralPackage(previous.packages.find(item => item.id === 'B')))), original.manifests[0].packageSha256);
  assert.equal(digest(canonical(structuralPackage(current.packages.find(item => item.id === 'B')))), next.manifests[0].packageSha256);
  assert.equal(digest(currentBytes), next.transition.packageVersions[0].next.registry.sha256);
  assert.deepEqual(current.packages.find(item => item.id === 'A'), previous.packages.find(item => item.id === 'A'));
  assert.notEqual(next.transition.packageVersions[0].previous.registry.sha256, next.transition.packageVersions[0].next.registry.sha256);
  for (const path of [B_SOURCE, original.manifests[0].cells[0].logPath]) {
    f.restore(pristine);
    const bytes = f.io.fileAt(pristine.revision, path);
    await f.write(path, 'transient executed bytes\n');
    if (path === B_SOURCE) {
      await f.write('config/migration/source-catalog-B.json', { schemaVersion: 1, sources: [{ path, sha256: digest('transient executed bytes\n'), classification: 'unreviewed' }] });
      await f.lock();
    }
    f.commit();
    if (bytes === null) f.git('rm', path); else await f.write(path, bytes.toString());
    if (path === B_SOURCE) {
      await f.write('config/migration/source-catalog-B.json', f.io.fileAt(pristine.revision, 'config/migration/source-catalog-B.json').toString());
      await f.lock();
    }
    f.commit();
    const invalid = await f.freezeReplacement(original); await f.activateReplacement(invalid);
    const rejected = await f.check(); denied(rejected); assert.match(rejected.errors.join('\n'), /attempt|history|execut/i);
  }
});
test('P07 rejected attempt remains immutable while an explicit replacement is prepared', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal();
  await f.implement(original, { mismatch: true }); await f.capture(original); assert.match(original.log, /unexpected original result/);
  const point = f.checkpoint(), rejected = await f.publish(original); denied(rejected);
  assert.match(rejected.errors.join('\n'), /test|TAP|count|name/i);
  const published = await f.freezeReplacement(original); await f.activateReplacement(published);
  const forbidden = await f.check(); denied(forbidden); assert.match(forbidden.errors.join('\n'), /retire|receipted/i);
  f.restore(point);
  original.capture.cells[0].diagnostic = { code: 'TASK_EVIDENCE_REJECTED', message: rejected.errors.join('\n') };
  const next = await f.freezeReplacement(original); await f.activateReplacement(next);
  const result = await f.check(); assert.deepEqual(result.errors, []);
  assert.equal(result.taskEvidence.acceptedTasks.some(id => id.startsWith('B.')), false);
  assert.equal(result.taskEvidence.acceptedPackages.includes('B'), false);
  const attempt = next.transition.retirements[0].attempt;
  assert.equal(attempt.subject.sha, original.subject); assert.equal(attempt.evidenceCommit, original.evidence);
  assert.equal(next.transition.retirements[1].attempt, null);
  assert.equal(await readFile(join(f.root, original.manifests[0].cells[0].logPath), 'utf8'), original.log);
  assert.equal(original.capture.cells[0].diagnostic.message, rejected.errors.join('\n'));
  const archived = structuredClone(original.capture); archived.cells[0].diagnostic.message += ' altered';
  await f.write(attempt.capture.path, archived); f.commit(); denied(await f.check());
});
test('P07 replacement acceptance requires fresh exact-subject revalidation', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal();
  await f.implement(original); await f.capture(original);
  const next = await f.freezeReplacement(original); await f.activateReplacement(next); await f.implementReplacement(next); await f.capture(next);
  assert.equal(original.capture.cells[0].diagnostic, null);
  assert.notEqual(next.subject, original.subject); assert.notEqual(next.log, original.log);
  const point = f.checkpoint(), actualLog = next.log;
  next.log = original.log; await f.write(next.manifests[0].cells[0].logPath, next.log); next.evidence = f.commit();
  const copied = await f.publish(next); denied(copied); assert.match(copied.errors.join('\n'), /reus|preserv|archiv|fresh/i); f.restore(point); next.log = actualLog; next.evidence = point.revision;
  const actualSubject = next.subject; next.subject = original.subject;
  denied(await f.publish(next)); f.restore(point); next.subject = actualSubject;
  for (const change of [
    receipt => { receipt.review.subjectSha = original.subject; },
    receipt => { receipt.review.reviewer = receipt.review.author; },
    receipt => { receipt.dependencies[0].sha256 = 'a'.repeat(64); },
  ]) {
    const invalid = await f.publish(next, { mutate: change }); denied(invalid);
    assert.match(invalid.errors.join('\n'), /review|dependency|binding/i); f.restore(point);
  }
  const result = await f.publish(next); assert.deepEqual(result.errors, []);
  assert.ok(result.taskEvidence.acceptedTasks.includes('B.retry1.V')); assert.equal(result.taskEvidence.acceptedTasks.includes('B.V'), false);
});
test('P07 altered historical attempt logs and rejection records fail closed', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal();
  await f.implement(original, { mismatch: true }); await f.capture(original);
  const captured = f.checkpoint(), originalCapture = structuredClone(original.capture);
  const next = await f.freezeReplacement(original); await f.activateReplacement(next); const point = f.checkpoint();
  for (const path of [original.manifests[0].cells[0].logPath, next.transition.retirements[0].attempt.capture.path, next.transition.retirements[0].manifest.path]) {
    await f.write(path, (await readFile(join(f.root, path), 'utf8')) + '\n'); f.commit(); denied(await f.check()); f.restore(point);
  }
  f.git('rm', next.transition.retirements[0].manifest.path); f.commit(); denied(await f.check()); f.restore(point);
  const registry = JSON.parse(await readFile(join(f.root, REGISTRY), 'utf8'));
  registry.packages[0].owner = 'unrelated-author'; await f.write(REGISTRY, registry); await f.lock(); f.commit(); denied(await f.check());
  const mutations = [
    capture => { capture.unknown = true; },
    capture => { capture.cells[0].result.outputBytes += 1; },
    capture => { capture.cells[0].log = null; capture.cells[0].result.outputBytes = 0; },
    capture => { capture.cells[0].command = ['node', '--test', 'tests_js/a.test.mjs']; },
    capture => { capture.cells[0].environment.node = 'v0.0.0'; },
    capture => { capture.cells[0].artifacts.push({ ...capture.cells[0].artifacts[0] }); },
    capture => { capture.cells[0].artifacts[0].path = 'evidence/missing.json'; },
    capture => { capture.cells[0].log.sha256 = 'a'.repeat(64); },
    capture => { capture.subject.sha = captured.revision; },
  ];
  for (const mutate of mutations) {
    f.restore(captured); original.capture = structuredClone(originalCapture); mutate(original.capture);
    const invalid = await f.freezeReplacement(original); await f.activateReplacement(invalid);
    const result = await f.check(); assert.ok(result.errors.length, `Capture mutation was accepted: ${mutate}`);
    denied(result); assert.equal(canonical(f.receipts), f.acceptedHistory);
  }

});
test('P07 ambiguous or competing replacements grant no acceptance', async t => {
  const f = await lineageRepository(t), original = await f.freezeOriginal();
  const common = f.checkpoint(), first = await f.freezeReplacement(original), left = f.checkpoint();
  f.restore(common); const second = await f.freezeReplacement(original, { key: 'B.retry2' }), right = f.checkpoint();
  assert.ok(f.io.ancestor(common.revision, left.revision)); assert.ok(f.io.ancestor(common.revision, right.revision));
  assert.equal(f.io.ancestor(left.revision, right.revision), false); assert.equal(f.io.ancestor(right.revision, left.revision), false);
  await f.mergePrepared(left);
  assert.ok(f.io.ancestor(left.revision, f.git('rev-parse', 'HEAD'))); assert.ok(f.io.ancestor(right.revision, f.git('rev-parse', 'HEAD')));
  const prepared = f.checkpoint();
  await f.activateReplacement(first); assert.deepEqual((await f.check()).errors, []); f.restore(prepared);
  await f.activateReplacement(second); assert.deepEqual((await f.check()).errors, []); f.restore(prepared);
  await f.activateReplacement(first); const point = f.checkpoint();
  f.lineage.transitions.push({ ...first.transitionBinding }); await f.write('config/migration/task-lineage.json', f.lineage); await f.lock(); f.commit();
  denied(await f.check()); f.restore(point);
  await f.activateReplacement(second); const competing = await f.check(); denied(competing);
  assert.match(competing.errors.join('\n'), /[Cc]ompeting|transition/);
  f.restore(point);
  const chain = await f.freezeReplacement(first, { key: 'B.retry3' }); await f.activateReplacement(chain);
  assert.deepEqual((await f.check()).errors, []);
  assert.equal(chain.transition.previousDag.sha256, first.transition.nextDag.sha256);
  assert.equal(chain.transition.packageVersions[0].previous.registry.revision, first.executionBase);
});
