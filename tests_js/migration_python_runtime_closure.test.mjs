import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverPythonRuntimeTargets, validatePythonRuntimeClosure } from '../tools/migration/python-runtime-closure.mjs';

const files = new Map([
  ['skills/job/SKILL.md', 'run python3 "<plugin-root>/scripts/job.py" and scripts/policy.py'],
  ['apps/companion/launch.mjs', 'const script = "scripts/workspace.py";'],
  ['package.json', 'python3 scripts/validation.py'],
]);
const paths = new Set(['scripts/job.py', 'scripts/policy.py', 'scripts/workspace.py',
  'runtime/job.js', 'runtime/policy.js', 'runtime/workspace.js', 'scripts/tree']);
const manifest = {
  schemaVersion: 1, status: 'migration-open', packagedPythonTrees: ['scripts/tree'], entrypoints: [
    { path: 'scripts/job.py', role: 'ordinary', state: 'typescript-fixture-only', replacement: 'runtime/job.js' },
    { path: 'scripts/policy.py', role: 'policy', state: 'python-required', replacement: null },
    { path: 'scripts/workspace.py', role: 'ordinary', state: 'typescript-fixture-only', replacement: 'runtime/workspace.js' },
  ],
};

test('runtime closure discovers shipped routing and excludes validation scripts', () => {
  assert.deepEqual([...discoverPythonRuntimeTargets(files)], [
    ['scripts/job.py', new Set(['skills/job/SKILL.md'])],
    ['scripts/policy.py', new Set(['skills/job/SKILL.md'])],
    ['scripts/workspace.py', new Set(['apps/companion/launch.mjs'])],
  ]);
  assert.deepEqual(validatePythonRuntimeClosure(manifest, files, paths), []);
});

test('runtime closure fails closed on unclassified, stale, or fabricated replacements', () => {
  const expanded = new Map(files).set('skills/job/reference.md', 'scripts/new.py');
  assert.match(validatePythonRuntimeClosure(manifest, expanded, new Set([...paths, 'scripts/new.py'])).join('\n'),
    /Unclassified shipped Python runtime target scripts\/new\.py/);
  const stale = structuredClone(manifest);
  stale.entrypoints.push({ path: 'scripts/stale.py', role: 'qa', state: 'python-required', replacement: null });
  assert.match(validatePythonRuntimeClosure(stale, files, new Set([...paths, 'scripts/stale.py'])).join('\n'),
    /Stale Python runtime declaration scripts\/stale\.py/);
  const fabricated = structuredClone(manifest);
  fabricated.entrypoints[0].replacement = 'runtime/missing.js';
  assert.match(validatePythonRuntimeClosure(fabricated, files, paths).join('\n'),
    /Invalid TypeScript replacement binding scripts\/job\.py/);
});

test('runtime closure rejects removal claims while Python callers remain', () => {
  const invalid = structuredClone(manifest);
  invalid.entrypoints[1].state = 'removed';
  assert.match(validatePythonRuntimeClosure(invalid, files, paths).join('\n'),
    /Invalid Python runtime entrypoint scripts\/policy\.py/);
});

test('runtime closure closes only with no shipped Python targets or packaged trees', () => {
  const closed = { schemaVersion: 1, status: 'migration-closed', entrypoints: [], packagedPythonTrees: [] };
  assert.deepEqual(validatePythonRuntimeClosure(closed, new Map(), new Set()), []);
  assert.match(validatePythonRuntimeClosure({ ...closed, packagedPythonTrees: ['scripts/tree'] }, new Map(), paths).join('\n'),
    /Closed Python runtime inventory must be empty/);
  assert.match(validatePythonRuntimeClosure(closed, files, paths).join('\n'),
    /Unclassified shipped Python runtime target/);
});
