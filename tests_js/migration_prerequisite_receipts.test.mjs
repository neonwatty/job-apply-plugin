import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { validatePrerequisiteReceipts } from '../tools/migration/prerequisite-receipts.mjs';

const digest = (value) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const head = 'a'.repeat(40);
  const base = 'b'.repeat(40);
  const file = 'tools/reference.mjs';
  const fileHash = digest('synthetic source');
  const logPath = 'docs/evidence/reference.tap';
  const log = ['TAP version 13', '# Subtest: synthetic', 'ok 1 - synthetic', '1..1',
    '# tests 1', '# suites 0', '# pass 1', '# fail 0', '# cancelled 0', '# skipped 0',
    '# todo 0', '# duration_ms 1', ''].join('\n');
  const command = ['node', '--test', file];
  const receipt = { id: 'reference-ready', kind: 'reference', base, head,
    files: [{ path: file, sha256: fileHash }], requirements: ['requirement'],
    environment: { id: 'mac-node', platform: 'darwin', node: 'v22.22.3', unicode: '16.0' },
    command, result: { exitCode: 0, tests: 1, failures: 0, skips: 0, cancelled: 0 },
    log: { path: logPath, sha256: digest(log) },
    review: { author: 'worker', reviewer: 'independent', decision: 'approved' }, status: 'passed' };
  const context = { files: new Map([[file, fileHash], [logPath, digest(log)]]),
    revisionFiles: new Map([[head, new Map([[file, fileHash], [logPath, digest(log)]])]]),
    knownRevisions: new Set([head, base]), knownRequirements: new Set(['requirement']),
    expectedCommands: new Map([['requirement', [command]]]),
    expectedEnvironments: new Set(['mac-node']), logs: new Map([[logPath, log]]),
    ancestryPairs: new Set([`${base}:${head}`]),
    expectedEnvironmentDetails: new Map([['mac-node', { ...receipt.environment }]]),
    contracts: new Map([[receipt.id, { kind: receipt.kind, requirements: ['requirement'],
      filePaths: [file], command, environmentId: 'mac-node', author: 'worker', reviewer: 'independent' }]]) };
  return { receipt, context };
}

function rejects(change) {
  const { receipt, context } = fixture();
  change(receipt, context);
  const result = validatePrerequisiteReceipts([receipt], context);
  assert.ok(result.errors.length);
  assert.equal(result.acceptedReferences.size, 0);
  assert.equal(result.acceptedInterfaces.size, 0);
}

test('verified evidence unlocks only its prerequisite kind', () => {
  const { receipt, context } = fixture();
  assert.deepEqual([...validatePrerequisiteReceipts([receipt], context).acceptedReferences], ['reference-ready']);
  receipt.kind = 'interface';
  context.contracts.get(receipt.id).kind = 'interface';
  const result = validatePrerequisiteReceipts([receipt], context);
  assert.deepEqual(result.errors, []);
  assert.deepEqual([...result.acceptedInterfaces], ['reference-ready']);
  assert.equal(result.acceptedReferences.size, 0);
});

test('status, review or outcome assertions cannot replace successful evidence', () => {
  for (const change of [
    r => { r.extra = true; }, r => { r.status = 'accepted'; },
    r => { r.review.reviewer = 'worker'; }, r => { r.review.decision = 'pending'; },
    r => { r.result.tests = 0; }, r => { r.result.tests = 2; },
    r => { r.result.failures = 1; }, r => { r.result.skips = 1; },
    r => { r.result.cancelled = 1; }, r => { r.result.exitCode = 1; },
  ]) rejects(change);
});

test('immutable revisions and current files must agree', () => {
  for (const change of [
    r => { r.head = 'unknown'; }, (r, c) => c.knownRevisions.delete(r.base),
    (r, c) => c.files.delete(r.files[0].path),
    (r, c) => c.files.set(r.files[0].path, 'c'.repeat(64)),
    (r, c) => c.revisionFiles.get(r.head).clear(),
    r => { delete r.files[0].sha256; }, r => { r.files[0].path = '../escape'; },
    (r, c) => c.ancestryPairs.clear(),
    (r, c) => c.revisionFiles.get(r.head).delete(r.log.path),
  ]) rejects(change);
});

test('every requirement needs canonical command and known environment', () => {
  for (const change of [
    r => { r.requirements.push('unknown'); }, r => { r.command = ['node', '-e', '0']; },
    r => { r.environment.id = 'unverified'; }, r => { r.requirements = []; },
    r => { r.environment.platform = 'linux'; },
    (r, c) => { r.requirements.push('second'); c.knownRequirements.add('second'); },
  ]) rejects(change);
});

test('captured TAP must match counts and be complete, current and supported', () => {
  for (const transform of [
    log => log.replace('# pass 1', '# pass 0'),
    log => log.replace('# skipped 0', '# skipped 1'),
    log => log.replace('ok 1 -', 'not ok 1 -'),
    log => log.replace('ok 1 - synthetic', 'ok 1 - synthetic # SKIP disabled'),
    log => log.replace('1..1\n', ''),
    log => log.replace('# duration_ms 1\n', ''),
    log => log + 'unexpected trailing output\n',
    log => log.replace('TAP version 13', 'TAP version 12'),
  ]) {
    rejects((r, c) => {
      const changed = transform(c.logs.get(r.log.path));
      c.logs.set(r.log.path, changed);
      r.log.sha256 = digest(changed);
      c.files.set(r.log.path, r.log.sha256);
      c.revisionFiles.get(r.head).set(r.log.path, r.log.sha256);
    });
  }
  rejects((r, c) => c.logs.delete(r.log.path));
  rejects(r => { r.log.sha256 = 'd'.repeat(64); });
});

test('registered prerequisite scope cannot shrink to a convenient passing subset', () => {
  rejects(r => { r.id = 'invented'; });
  rejects((r, c) => { c.contracts.get(r.id).filePaths.push('tools/another.mjs'); });
  rejects((r, c) => { c.contracts.get(r.id).requirements.push('another'); });
  rejects(r => { r.review.author = 'someone-else'; });
  rejects((r, c) => { c.expectedEnvironmentDetails.set(r.environment.id, {}); });
});

test('malformed records and duplicate receipts return errors without partial unlocking', () => {
  const { receipt, context } = fixture();
  for (const value of [null, [], {}, { ...receipt, files: [null] }, { ...receipt, result: null }]) {
    assert.ok(validatePrerequisiteReceipts([value], context).errors.length);
  }
  const duplicated = validatePrerequisiteReceipts([receipt, structuredClone(receipt)], context);
  assert.ok(duplicated.errors.length);
  assert.equal(duplicated.acceptedReferences.size, 0);
  assert.ok(validatePrerequisiteReceipts([receipt], {}).errors.length);
  for (const key of ['id', 'base', 'head']) {
    rejects((item) => { item[key] = { toString: null }; });
  }
  for (const key of ['node', 'unicode']) {
    rejects((item) => { item.environment[key] = { toString: null }; });
  }
});
