import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { discoverConsumerGraph } from '../tools/local-checks/consumer-graph.mjs';
import { evaluateFocusedClosure } from '../tools/local-checks/focused-closure.mjs';
import { createGraphFixture, GRAPH_SOURCE, GRAPH_RUNTIME, GRAPH_TEST, GRAPH_CHILD, GRAPH_SUPPORT } from './local_checks_graph_support.mjs';
import { selectLocalPlan } from '../tools/local-checks/policy.mjs';
import { policyFingerprint, reusableReceipt, successfulLocalResults } from '../tools/local-checks/run.mjs';

const matrix = JSON.parse(await readFile(new URL('../config/test-matrix.json', import.meta.url)));
const ids = (suites) => suites.map((suite) => suite.id);
const facts = (patch = {}) => ({ bounded: true, reasons: [], remainingPaths: [], docsOnly: false,
  lightTests: [], heavyTests: [], nativeTests: [], ruleIds: [], sharedContract: false, fingerprint: 'fixture', ...patch });
const selectedFiles = plan => [...plan.light, ...plan.heavy].flatMap(s => s.include ?? []);
async function checked(fixture, paths) {
  const graph = await discoverConsumerGraph(fixture.root, fixture.tracked());
  return evaluateFocusedClosure(graph, paths);
}


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
  const docs = selectLocalPlan(matrix, [], ['docs/migration.md'], { closure: facts({ docsOnly: true }) });
  assert.equal(docs.heavy.length, 0);
  assert.ok(ids(docs.light).includes('local-build'));
  assert.ok(ids(docs.light).includes('local-links'));
  const path = 'src/contracts/raw-json/numeric-atom.ts';
  const focused = selectLocalPlan(matrix, [path], [path], { closure: facts({ lightTests: ['tests_js/typed_json_boundary.test.mjs'] }) });
  assert.equal(focused.heavy.length, 0);
  assert.ok(ids(focused.light).includes('local-dependent-unit'));
});

test('new production modules, global edits, unknown paths and deleted codec escalate', () => {
  for (const path of ['src/contracts/raw-json/production.ts', 'package-lock.json',
    'tools/local-checks/run.mjs', 'unmapped.file', 'src/contracts/raw-json/numeric-atom.ts']) {
    const plan = selectLocalPlan(matrix, [], [path]);
    const selected = ids([...plan.light, ...plan.heavy]);
    for (const suite of matrix.suites) assert.ok(selected.includes(suite.id), `${path}: ${suite.id}`);
  }
});

test('accepted inert boundaries select focused tests and include dependent validation', () => {
  for (const [path, id, dependent] of [
    ['src/contracts/raw-json/parser.ts', 'local-typed-json', 'tests_js/store_validation_ts.test.mjs'],
    ['src/store/validation.ts', 'local-store-validation', 'tests_js/store_validation_ts.test.mjs'],
    ['src/workspace-ui/lib/resume-view.ts', 'local-resume-view', 'tests_js/workspace_helpers.test.mjs'],
    ['src/contracts/raw-json/numeric-atom.ts', 'local-numeric', 'tests_js/typed_json_boundary.test.mjs'],
  ]) {
    const plan = selectLocalPlan(matrix, [path], [path], { closure: facts({ ruleIds: [id], lightTests: [dependent] }) });
    assert.equal(plan.heavy.length, 0);
    assert.ok(plan.light.find((suite) => suite.id === 'local-dependent-unit').include.includes(dependent));
  }
});

test('tag pushes require complete local release and platform selection even with no changes', () => {
  const plan = selectLocalPlan(matrix, [], [], { tag: true });
  const selected = ids([...plan.light, ...plan.heavy]);
  assert.ok(matrix.suites.every((suite) => selected.includes(suite.id)));
});

test('known renderer changes select their suite without unrelated package tests', () => {
  const plan = selectLocalPlan(matrix, [], ['qa/renderer/render.mjs'], { closure: facts({ remainingPaths: ['qa/renderer/render.mjs'] }) });
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


test('P03 runtime focused rules include the independent transitive consumer witnesses', async (t) => {
  const f = await createGraphFixture(t);
  const closure = await checked(f, [GRAPH_RUNTIME]);
  assert.equal(closure.bounded, true, closure.reasons.join('\n'));
  assert.deepEqual(closure.lightTests, [GRAPH_CHILD, GRAPH_TEST].sort());
  const plan = selectLocalPlan(matrix, f.tracked(), [GRAPH_RUNTIME], { closure });
  assert.ok(selectedFiles(plan).includes(GRAPH_CHILD));
  assert.ok(selectedFiles(plan).includes(GRAPH_TEST));
  assert.equal(plan.heavy.length, 0);
  assert.equal(plan.native.length, 0);
  const deep = selectLocalPlan(matrix, f.tracked(), [], { closure, mode: 'deep' });
  assert.equal(deep.native.flatMap(s => s.include).length, 6);
  assert.ok(deep.native.every(s => !selectedFiles(plan).includes(s.include[0])));
});

test('P03 reference-only edits retain bounded direct consumer selection', async (t) => {
  const f = await createGraphFixture(t);
  await f.write('tools/contracts/fixed/reference.py', '# fixed synthetic reference\n');
  Object.assign(f.contract.rules[0], { referencePaths: ['tools/contracts/fixed/reference.py'], referenceTests: [GRAPH_TEST] });
  await f.writeContract();
  const closure = await checked(f, ['tools/contracts/fixed/reference.py']);
  assert.equal(closure.bounded, true, closure.reasons.join('\n'));
  assert.deepEqual(closure.lightTests, [GRAPH_TEST]);
  assert.deepEqual(closure.heavyTests, []);
});

test('P03 mutation deleting each required consumer fails independent coverage validation', async (t) => {
  for (const path of [GRAPH_TEST, GRAPH_CHILD]) {
    const f = await createGraphFixture(t);
    await rm(join(f.root, path));
    f.files.delete(path);
    const closure = await checked(f, [GRAPH_SOURCE]);
    assert.equal(closure.bounded, false);
    assert.ok(closure.reasons.some(reason => reason.includes('Missing required consumer') && reason.includes(path)));
    const plan = selectLocalPlan(matrix, f.tracked(), [GRAPH_SOURCE], { closure });
    assert.ok(matrix.suites.every(s => ids([...plan.light, ...plan.heavy]).includes(s.id)));
  }
});

test('P03 mutation through support and child-process modules cannot conceal a failing consumer', async (t) => {
  const f = await createGraphFixture(t);
  await f.write(GRAPH_RUNTIME, 'export const value = 2;\n');
  const closure = await checked(f, [GRAPH_RUNTIME]);
  assert.ok(closure.lightTests.includes(GRAPH_CHILD));
  assert.ok(closure.lightTests.includes(GRAPH_TEST));
  const result = spawnSync(process.execPath, ['--test', GRAPH_CHILD], { cwd: f.root, encoding: 'utf8', timeout: 5000,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT')) });
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /child failed/);
  await f.write(GRAPH_SUPPORT, `export { value } from '../${GRAPH_RUNTIME}';\nimport('./unbound-' + Date.now() + '.mjs');\n`);
  const unbounded = await checked(f, []);
  assert.equal(unbounded.bounded, false);
});

test('P03 shared type changes escalate while source and runtime changes select equivalent coverage', async (t) => {
  const f = await createGraphFixture(t);
  f.contract.rules[0].sharedContractPaths = [GRAPH_SOURCE];
  f.contract.rules[0].runtimePaths = [GRAPH_RUNTIME];
  f.contract.rules[0].sharedContractAdditionalHeavyTests = [GRAPH_CHILD];
  await f.writeContract();
  const source = await checked(f, [GRAPH_SOURCE]);
  const runtime = await checked(f, [GRAPH_RUNTIME]);
  assert.equal(source.sharedContract, true);
  assert.equal(runtime.sharedContract, false);
  assert.ok(source.heavyTests.includes(GRAPH_CHILD));
  assert.deepEqual([...new Set([...source.lightTests, ...source.heavyTests])].sort(), runtime.lightTests);
  const plan = selectLocalPlan(matrix, f.tracked(), [GRAPH_SOURCE], { closure: source });
  assert.ok(ids(plan.heavy).includes('local-dependent-integration'));
  assert.equal(plan.native.flatMap(s => s.include).length, 6);
});

test('P03 unknown deleted renamed global lock and policy changes retain complete escalation', async (t) => {
  const f = await createGraphFixture(t);
  for (const path of ['new/outside.mjs', 'deleted.ts', 'renamed.ts', 'package-lock.json', 'tools/local-checks/policy.mjs']) {
    const closure = await checked(f, [path]);
    const plan = selectLocalPlan(matrix, f.tracked(), [path], { closure });
    assert.ok(matrix.suites.every(s => ids([...plan.light, ...plan.heavy]).includes(s.id)), path);
  }
  const unbounded = facts({ bounded: false, reasons: ['unknown dispatch'], nativeTests: f.contract.nativeFallback.testRoots });
  for (const mode of ['deep', 'push']) {
    const plan = selectLocalPlan(matrix, f.tracked(), [], { closure: unbounded, mode });
    assert.equal(plan.native.flatMap(s => s.include).length, 6);
  }
  const closure = await checked(f, ['README.md']);
  assert.equal(selectLocalPlan(matrix, f.tracked(), ['README.md'], { closure }).native.length, 0);
  assert.equal(selectLocalPlan(matrix, f.tracked(), ['README.md'], { closure, mode: 'deep' }).native.flatMap(s => s.include).length, 6);
  assert.equal(selectLocalPlan(matrix, f.tracked(), [], { closure, mode: 'commit' }).heavy.length, 0);
});
