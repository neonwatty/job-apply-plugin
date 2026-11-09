import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkInventory, SCENARIOS } from '../tools/migration/check.mjs';
import { requirementSuiteRegistry } from '../tools/migration/requirement-suites.mjs';
import { validateRequirements } from '../tools/migration/requirements.mjs';

const files = ['tests_js/current.test.mjs', 'tests_js/reference.test.mjs'];
const required = { suites: [
  { id: 'shared', kind: 'node-test', include: [files[0]] },
  { id: 'policy', kind: 'command', command: ['node', 'policy.mjs'] },
] };
const reference = { suites: [
  { id: 'shared', kind: 'node-test', include: [files[1]] },
  { id: 'historical', kind: 'node-test', include: [files[1]] },
  { id: 'python-only', kind: 'python-unittest', include: ['tests/test_reference.py'] },
] };

test('evidence registry resolves optional reference bindings without changing the required matrix', () => {
  const before = JSON.stringify(required);
  const registry = requirementSuiteRegistry([required, reference], files);
  assert.deepEqual([...registry.get('shared')], files);
  assert.deepEqual([...registry.get('historical')], [files[1]]);
  assert.equal(registry.has('python-only'), false);
  assert.equal(registry.has('policy'), false);
  assert.equal(JSON.stringify(required), before);
  assert.equal(requirementSuiteRegistry([required], files).has('historical'), false);
});

test('requirement validation still rejects unknown suite or file bindings', () => {
  const hash = 'a'.repeat(64);
  const item = { id: 'evidence-one', family: 'PF', category: 'valid', surfaceIds: ['surface'],
    applicability: { status: 'required' }, platformCells: ['node-local'],
    oracleFiles: [{ path: files[1], sha256: hash }], expectedArtifacts: ['receipt.json'],
    testBindings: [{ suiteId: 'historical', file: files[1], testId: 'reference contract',
      command: ['node', '--test', files[1]], timeoutMs: 1000, maxOutputBytes: 4096 }] };
  const context = { nodes: new Set(['PF']), surfaces: new Set(['surface']), platforms: new Set(['node-local']),
    files: new Map([[files[1], hash]]), testIds: new Map([[files[1], new Set(['reference contract'])]]),
    suites: requirementSuiteRegistry([required, reference], files) };
  assert.deepEqual(validateRequirements([item], context), []);
  for (const patch of [{ suiteId: 'unknown' }, { file: 'tests_js/unknown.test.mjs' }]) {
    const changed = { ...item, testBindings: [{ ...item.testBindings[0], ...patch }] };
    assert.ok(validateRequirements([changed], context).some(error => error.includes('unregistered test binding')));
  }
});


test('a non-historical checkout validates declared node evidence without executing it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'migration-suite-registry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  execFileSync('git', ['init', '-q', root], { env });
  for (const directory of ['src', 'tests_js', 'config/migration']) await mkdir(join(root, directory), { recursive: true });
  const source = 'export const fixture = true;\n';
  const hash = value => createHash('sha256').update(value).digest('hex');
  const sourcePath = 'src/fixture.ts', testPath = 'tests_js/fixture.test.mjs';
  await writeFile(join(root, sourcePath), source);
  await writeFile(join(root, testPath), "import test from 'node:test'; test('synthetic contract', () => { throw Error('evidence declarations must not execute tests'); });\n");
  await writeFile(join(root, 'config/test-matrix.json'), JSON.stringify({ schemaVersion: 1,
    suites: [{ id: 'fixture', kind: 'node-test', include: [testPath], tiers: ['full'] }] }));
  const shards = {
    'nodes.json': { schemaVersion: 1, nodes: [{ id: 'PF', dependencies: [], status: 'open' }] },
    'source-catalog-fixture.json': { schemaVersion: 1, sources: [{ path: sourcePath, sha256: hash(source), classification: 'unreviewed' }] },
    'http-fixture-surfaces.json': { schemaVersion: 1, surfaces: [{ id: 'fixture', kind: 'http', method: 'GET', path: '/fixture',
      node: 'PF', sources: [sourcePath], effects: 'unclassified',
      scenarios: Object.fromEntries(SCENARIOS.map(name => [name, 'unverified'])) }] },
    'requirements-fixture.json': { schemaVersion: 1, requirements: [{ id: 'fixture-valid', family: 'PF', category: 'valid',
      surfaceIds: ['fixture'], applicability: { status: 'required' }, platformCells: ['node-local'],
      oracleFiles: [{ path: sourcePath, sha256: hash(source) }], expectedArtifacts: ['receipt.json'],
      testBindings: [{ suiteId: 'fixture', file: testPath, testId: 'synthetic contract',
        command: ['node', '--test', testPath], timeoutMs: 1000, maxOutputBytes: 4096 }] }] },
  };
  const lock = { schemaVersion: 1, files: [] };
  for (const [path, value] of Object.entries(shards)) {
    const text = JSON.stringify(value);
    await writeFile(join(root, 'config/migration', path), text);
    lock.files.push({ path, sha256: hash(text) });
  }
  await writeFile(join(root, 'config/migration/review-lock.json'), JSON.stringify(lock));
  execFileSync('git', ['add', '.'], { cwd: root, env });
  const receipt = await checkInventory(root);
  assert.equal(receipt.status, 'inventory-consistent', receipt.errors.join('; '));
  assert.equal(receipt.historicalAudit, undefined);
  assert.deepEqual(receipt.taskEvidence.acceptedTasks, []);
});
