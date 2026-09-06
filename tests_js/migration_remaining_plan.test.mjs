import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { expandPlan, validatePlan, renderCatalog, renderGraph } from '../tools/migration/check-remaining-plan.mjs';

const root = new URL('../', import.meta.url);
const read = path => readFile(new URL(path, root), 'utf8');
const plan = JSON.parse(await read('docs/migration/remaining/plan.json'));
const canonical = JSON.parse(await read('config/migration/nodes.json')).nodes.map(node => node.id).filter(id => id !== 'RELEASE');

test('remaining plan covers canonical families and every assignment reaches final conversion', () => {
  assert.deepEqual(validatePlan(plan, canonical), []);
  const nodes = expandPlan(plan);
  assert.equal(new Set(nodes.map(node => node.id)).size, nodes.length);
  assert.ok(nodes.find(node => node.id === 'S01.V').dependencies.includes('P01.V'));
  assert.ok(nodes.find(node => node.id === 'S03.I').dependencies.includes('S01.V'));
  assert.ok(nodes.find(node => node.id === 'S03.I').dependencies.includes('S03.R'));
});

test('remaining plan rejects cycles, unknown dependencies, detached tasks and authority expansion', () => {
  for (const [mutate, pattern] of [
    [value => value.packages.find(row => row.id === 'P00').dependencies.push('G13'), /cycle/],
    [value => value.packages[0].dependencies.push('X99'), /Unknown dependency/],
    [value => value.packages.push({ ...value.packages[0], id: 'X99', dependencies: [] }), /does not contribute/],
    [value => { value.releaseExcluded = false; }, /authority/],
    [value => { value.packages[0].status = 'accepted'; }, /state/],
  ]) {
    const changed = structuredClone(plan); mutate(changed);
    assert.ok(validatePlan(changed, canonical).some(error => pattern.test(error)), String(pattern));
  }
});

test('remaining plan cannot hide removed canonical families or malformed tasks', () => {
  const changed = structuredClone(plan);
  changed.requiredParents = changed.requiredParents.filter(id => id !== 'HOST');
  for (const row of changed.packages) row.parents = row.parents.map(id => id === 'HOST' ? 'I' : id);
  assert.ok(validatePlan(changed, canonical).some(error => error.includes('canonical')));
  for (const invalid of [null, {}, { schemaVersion: 1, packages: [] }]) assert.ok(validatePlan(invalid, canonical).length);
  const malformed = structuredClone(plan); malformed.packages[0] = null;
  assert.ok(validatePlan(malformed, canonical).includes('Invalid task object'));
});

test('published catalog and graphs match the machine-readable plan', async () => {
  assert.equal(await read('docs/migration/remaining/task-catalog.md'), renderCatalog(plan));
  assert.equal(await read('docs/migration/remaining/packages.mmd'), renderGraph(plan));
  assert.equal(await read('docs/migration/remaining/agent-tasks.mmd'), renderGraph(plan, true));
  assert.deepEqual(JSON.parse(await read('docs/migration/remaining/agent-tasks.json')), expandPlan(plan));
});
