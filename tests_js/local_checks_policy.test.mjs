import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { selectLocalPlan } from '../tools/local-checks/policy.mjs';
import { policyFingerprint, reusableReceipt, successfulLocalResults } from '../tools/local-checks/run.mjs';

const matrix = JSON.parse(await readFile(new URL('../config/test-matrix.json', import.meta.url)));
const ids = (suites) => suites.map((suite) => suite.id);

test('receipt policy fingerprint changes when active runner implementation changes', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'local-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, 'local-checks');
  const runner = join(root, 'test-runner');
  await mkdir(local);
  await mkdir(runner);
  await writeFile(join(local, 'run.mjs'), 'local');
  await writeFile(join(runner, 'execute.mjs'), 'old execution');
  const before = await policyFingerprint(local);
  await writeFile(join(runner, 'execute.mjs'), 'new execution');
  assert.notEqual(await policyFingerprint(local), before);
});

test('documentation stays light while exact inert codec changes add focused tests', () => {
  const docs = selectLocalPlan(matrix, [], ['docs/migration.md']);
  assert.equal(docs.heavy.length, 0);
  assert.ok(ids(docs.light).includes('local-build'));
  assert.ok(ids(docs.light).includes('local-links'));
  const path = 'src/contracts/raw-json/numeric-atom.ts';
  const focused = selectLocalPlan(matrix, [path], [path]);
  assert.equal(focused.heavy.length, 0);
  assert.ok(ids(focused.light).includes('local-numeric'));
});

test('new production modules, global edits, unknown paths and deleted codec escalate', () => {
  for (const path of ['src/contracts/raw-json/production.ts', 'package-lock.json',
    'tools/local-checks/run.mjs', 'unmapped.file', 'src/contracts/raw-json/numeric-atom.ts']) {
    const plan = selectLocalPlan(matrix, [], [path]);
    const selected = ids([...plan.light, ...plan.heavy]);
    for (const suite of matrix.suites) assert.ok(selected.includes(suite.id), `${path}: ${suite.id}`);
  }
});

test('tag pushes require complete local release and platform selection even with no changes', () => {
  const plan = selectLocalPlan(matrix, [], [], { tag: true });
  const selected = ids([...plan.light, ...plan.heavy]);
  assert.ok(matrix.suites.every((suite) => selected.includes(suite.id)));
});

test('known renderer changes select their suite without unrelated package tests', () => {
  const plan = selectLocalPlan(matrix, [], ['qa/renderer/render.mjs']);
  assert.ok(ids(plan.heavy).includes('node-renderer'));
  assert.ok(!ids(plan.heavy).includes('release-package'));
});

test('local success rejects missing, failed and wrongly skipped mandatory cells', () => {
  const suites = [{ id: 'required' }, { id: 'foreign', platforms: ['other-platform'] }];
  const results = [{ id: 'required', status: 'passed' }, { id: 'foreign', status: 'skipped' }];
  assert.equal(successfulLocalResults(results, suites), true);
  assert.equal(successfulLocalResults(results.slice(1), suites), false);
  for (const status of ['failed', 'skipped', 'timed-out']) {
    assert.equal(successfulLocalResults([{ id: 'required', status }, results[1]], suites), false);
  }
});

test('only fresh complete deep receipts for the exact identity can satisfy escalation', () => {
  const receipt = { schemaVersion: 1, key: 'exact', mode: 'deep', status: 'passed-local',
    completedAt: 100, expiresAt: 200, suites: [{ id: 'required' }],
    results: [{ id: 'required', status: 'passed' }] };
  assert.equal(reusableReceipt(receipt, 'exact', 150), true);
  assert.equal(reusableReceipt(receipt, 'different-commit-or-environment', 150), false);
  for (const patch of [{ mode: 'commit' }, { mode: 'push' }, { status: 'failed' },
    { completedAt: 151 }, { expiresAt: 150 }, { results: [] }, { results: undefined },
    { results: [{ id: 'required', status: 'skipped' }] }]) {
    assert.equal(reusableReceipt({ ...receipt, ...patch }, 'exact', 150), false);
  }
});
