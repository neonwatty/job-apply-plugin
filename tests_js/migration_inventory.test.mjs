import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { SCENARIOS, inSourceScope, validateInventory, validateReviewLock, checkInventory } from '../tools/migration/check.mjs';

function fixture() {
  const hash = 'a'.repeat(64);
  const data = {
    nodes: [{ id: 'I', dependencies: [], status: 'open' }, { id: 'AUTH', dependencies: ['I'], status: 'open' }],
    sources: [{ path: 'scripts/router.py', sha256: hash, classification: 'unreviewed' }],
    surfaces: [{ id: 'http:GET:/api/jobs/{id}', kind: 'http', method: 'GET',
      path: '/api/jobs/{id}', node: 'AUTH', sources: ['scripts/router.py'], effects: 'unclassified',
      scenarios: Object.fromEntries(SCENARIOS.map((name) => [name, 'unverified'])) }],
  };
  return { data, actual: new Map([['scripts/router.py', hash]]) };
}
test('consistent inventory is not migration acceptance', () => {
  const { data, actual } = fixture();
  assert.deepEqual(validateInventory(data, actual), []);
  assert.match(validateInventory(data, actual, { acceptance: true }).join('\n'), /acceptance is open/);
});
test('deleting, adding or altering inventory records cannot silently shrink coverage', () => {
  const hash = 'a'.repeat(64);
  const lock = { schemaVersion: 1, files: [{ path: 'http-read-surfaces.json', sha256: hash }] };
  assert.deepEqual(validateReviewLock(lock, new Map([['http-read-surfaces.json', hash]])), []);
  for (const actual of [new Map(), new Map([['http-read-surfaces.json', 'b'.repeat(64)]]),
    new Map([['http-read-surfaces.json', hash], ['new-surfaces.json', hash]])]) {
    assert.ok(validateReviewLock(lock, actual).length);
  }
  assert.ok(validateReviewLock({ schemaVersion: 1, files: [{ path: 'missing-surfaces.json' }] }, new Map()).length);
});
test('source edits, additions, deletions and renames require reconciliation', () => {
  for (const change of [
    (actual) => actual.set('scripts/router.py', 'b'.repeat(64)),
    (actual) => actual.set('scripts/new_router.py', 'a'.repeat(64)),
    (actual) => actual.delete('scripts/router.py'),
    (actual) => { actual.delete('scripts/router.py'); actual.set('scripts/renamed.py', 'a'.repeat(64)); },
  ]) {
    const { data, actual } = fixture(); change(actual);
    assert.ok(validateInventory(data, actual).length);
  }
});
test('unknown owners, duplicate identities, missing sources and malformed methods fail', () => {
  for (const change of [
    (data) => { data.surfaces[0].node = 'UNKNOWN'; },
    (data) => data.surfaces.push({ ...data.surfaces[0], id: 'different-id' }),
    (data) => { data.surfaces[0].sources = []; },
    (data) => { data.surfaces[0].method = 'AUTO'; },
    (data) => { delete data.surfaces[0].scenarios.privacy; },
    (data) => data.sources.push({ ...data.sources[0] }),
  ]) {
    const { data, actual } = fixture(); change(data);
    assert.ok(validateInventory(data, actual).length);
  }
});
test('cycles and unknown dependencies fail', () => {
  for (const dependency of ['AUTH', 'MISSING']) {
    const { data, actual } = fixture(); data.nodes[0].dependencies.push(dependency);
    assert.ok(validateInventory(data, actual).length);
  }
});
test('persisted artifacts and journal variants require valid paths, types and document bindings', () => {
  const make = () => {
    const { data, actual } = fixture();
    const common = { node: 'I', sources: ['scripts/router.py'], effects: 'unclassified',
      scenarios: Object.fromEntries(SCENARIOS.map((name) => [name, 'unverified'])) };
    data.surfaces = [
      { ...common, id: 'document', kind: 'document', path: 'journal.json', artifact: 'json' },
      { ...common, id: 'empty', kind: 'journal', path: 'journal.json', discriminator: 'operation', value: null },
      { ...common, id: 'stage', kind: 'journal', path: 'journal.json', discriminator: 'operation.stage', value: 'prepared' },
    ];
    return { data, actual };
  };
  const valid = make();
  assert.deepEqual(validateInventory(valid.data, valid.actual), []);
  for (const change of [
    (items) => { items[0].path = '../escape'; },
    (items) => { items[0].path = 'C:/outside.json'; },
    (items) => { items[0].path = 'bad\0.json'; },
    (items) => { items[0].path = '   '; },
    (items) => { items[0].discriminator = 'operation.kind'; },
    (items) => { items[0].artifact = 'unknown'; },
    (items) => { items[1].discriminator = 'operation.kind'; },
    (items) => { items[2].discriminator = 'operation.unknown'; },
    (items) => { items[2].value = ''; },
    (items) => { items[2].path = 'missing.json'; },
    (items) => items.push({ ...items[2], id: 'duplicate' }),
    (items) => { items[0].artifact = 'binary'; },
  ]) {
    const { data, actual } = make(); change(data.surfaces);
    assert.ok(validateInventory(data, actual).length);
  }
});
test('invented passing, skipped or inapplicable evidence cannot close a cell', () => {
  for (const status of ['passed', 'skipped', 'inapplicable', 'mocked']) {
    const { data, actual } = fixture(); data.surfaces[0].scenarios.platform = status;
    assert.match(validateInventory(data, actual).join('\n'), /evidence/);
  }
  const { data, actual } = fixture(); data.nodes[0].status = 'accepted';
  assert.match(validateInventory(data, actual).join('\n'), /acceptance claim/);
});
test('source discovery includes new runtime and boundary files, excludes test fixture data', () => {
  for (const path of ['scripts/new_cli.py', 'workspace/new.js', 'native/macos/helper.swift', 'native/posix/flock.c', 'native/posix/flock.h',
    'runtime/new.js', 'src/new.ts', 'package.json', '.agents/plugins/marketplace.json']) assert.equal(inSourceScope(path), true);
  for (const path of ['tests/test_x.py', 'docs/note.md', 'qa/fixtures/data.json', 'node_modules/x.js']) {
    assert.equal(inSourceScope(path), false);
  }
});

test('real checkout detects untracked modules and source drift without changing files', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'migration-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  execFileSync('git', ['init', '-q', root], { env });
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'config/migration'), { recursive: true });
  const code = '# synthetic route source\n';
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  await writeFile(join(root, 'scripts/router.py'), code);
  const { data } = fixture();
  data.sources[0].sha256 = hash(code);
  const shards = {
    'nodes.json': { schemaVersion: 1, nodes: data.nodes },
    'source-catalog-01.json': { schemaVersion: 1, sources: data.sources },
    'http-test-surfaces.json': { schemaVersion: 1, surfaces: data.surfaces },
  };
  const lock = { schemaVersion: 1, files: [] };
  for (const [path, value] of Object.entries(shards)) {
    const text = JSON.stringify(value);
    await writeFile(join(root, 'config/migration', path), text);
    lock.files.push({ path, sha256: hash(text) });
  }
  await writeFile(join(root, 'config/migration/review-lock.json'), JSON.stringify(lock));
  assert.equal((await checkInventory(root)).status, 'inventory-consistent');
  await writeFile(join(root, 'scripts/new_route.py'), '# new untracked handler\n');
  assert.match((await checkInventory(root)).errors.join('\n'), /Uninventoried source scripts\/new_route.py/);
  await rm(join(root, 'scripts/new_route.py'));
  await writeFile(join(root, 'scripts/router.py'), '# changed route semantics\n');
  assert.match((await checkInventory(root)).errors.join('\n'), /Source changed/);
  await writeFile(join(root, 'scripts/router.py'), code);
  await writeFile(join(root, 'config/migration/http-test-surfaces.json'), JSON.stringify({ schemaVersion: 1, surfaces: [] }));
  assert.match((await checkInventory(root)).errors.join('\n'), /Inventory shard changed/);
});
