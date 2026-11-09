import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createEvidenceIO } from '../tools/migration/evidence-io.mjs';
import { firstActivations, historicalJson, preservesHistory, recordKeys } from '../tools/migration/history-records.mjs';
import { maintenancePaths, MAINTENANCE_FILES } from '../tools/migration/snapshot-maintenance.mjs';
import { validateTaskReceipts } from '../tools/migration/task-receipts.mjs';
import { fixture } from './migration_task_support.mjs';

test('history indexing agrees with exhaustive ancestry checks on small branch and merge DAGs', () => {
  const vertices = [0, 1, 2, 3];
  const edges = vertices.flatMap(a => vertices.filter(b => b > a).map(b => [a, b]));
  for (let graph = 0; graph < 64; graph++) {
    const reach = vertices.map(a => new Set([a]));
    for (let i = 3; i >= 0; i--) for (const [n, [a, b]] of edges.entries()) {
      if (a === i && graph & (1 << n)) for (const child of reach[b]) reach[a].add(child);
    }
    const ancestor = (a, b) => reach[a].has(b);
    for (let mask = 0; mask < 16; mask++) {
      for (const order of [vertices, [...vertices].reverse(), [2, 0, 3, 1]]) {
        const candidates = order.filter(id => mask & (1 << id));
        const expected = candidates.filter(id => !candidates.some(other => other !== id && ancestor(other, id)));
        assert.deepEqual(firstActivations(candidates, ancestor).sort(), expected.sort());
        const rows = order.map(revision => ({ revision, records: recordKeys([
          { id: 'stable', nested: { b: 2, a: 1 } }, ...(mask & (1 << revision) ? [{ id: 'optional' }] : []),
        ]) }));
        const valid = rows.every(row => rows.every(prior => !ancestor(prior.revision, row.revision)
          || [...prior.records].every(item => row.records.has(item))));
        assert.equal(preservesHistory(rows, ancestor), valid);
        const sorted = [...rows].sort((a, b) => a.revision - b.revision);
        assert.equal(preservesHistory(sorted, ancestor, { topological: true }), valid);
      }
    }
  }
});

test('append-only histories avoid quadratic ancestry queries and retain ambiguous activation', () => {
  let calls = 0;
  const ancestor = (a, b) => { calls++; return a <= b; };
  const rows = Array.from({ length: 600 }, (_, revision) => ({ revision,
    records: recordKeys(Array.from({ length: revision + 1 }, (_, id) => ({ id }))),
  }));
  assert.equal(preservesHistory(rows, ancestor, { topological: true }), true);
  assert.equal(calls, 0);
  assert.deepEqual(firstActivations(rows.map(row => row.revision), ancestor), [0]);
  assert.equal(calls, 599);
  assert.deepEqual(firstActivations(['left', 'right', 'merge'], (a, b) => a === b || b === 'merge'), ['left', 'right']);
  const erased = [{ revision: 0, records: recordKeys([{ a: 1 }]) }, { revision: 1, records: recordKeys([]) }];
  assert.equal(preservesHistory(erased, ancestor, { topological: true }), false);
});

test('historical JSON caches successful reads only and evicts bounded entries', () => {
  const reads = new Map();
  let malformed = true;
  const json = historicalJson({ fileAt: (revision, path) => {
    const key = `${revision}:${path}`; reads.set(key, (reads.get(key) ?? 0) + 1);
    if (path === 'invalid' && malformed) return Buffer.from('{');
    if (path === 'absent') return null;
    return Buffer.from(JSON.stringify({ revision }));
  } });
  assert.throws(() => json('invalid', 'a'));
  malformed = false;
  assert.deepEqual(json('invalid', 'a'), { revision: 'a' });
  assert.equal(reads.get('a:invalid'), 2);
  assert.equal(json('absent', 'a'), null); assert.equal(json('absent', 'a'), null);
  assert.equal(reads.get('a:absent'), 1);
  for (let i = 0; i < 4097; i++) json('file', String(i));
  json('file', '4096'); assert.equal(reads.get('4096:file'), 1);
  json('file', '0'); assert.equal(reads.get('0:file'), 2);
});

test('maintenance cannot claim current acceptance or rescue invalid historical evidence', () => {
  const path = 'tools/migration/evidence-io.mjs';
  function checkerFixture() {
    const f = fixture();
    // Rename the fixture's subject path consistently, preserving all evidence.
    const rename = value => typeof value === 'string' ? value.replaceAll('src/example.ts', path) : value;
    function walk(value) {
      if (value instanceof Map) return new Map([...value].map(([k, v]) => [rename(k), walk(v)]));
      if (value instanceof Set) return new Set([...value].map(walk));
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      return rename(value);
    }
    return walk(f);
  }
  const f = checkerFixture();
  assert.deepEqual(validateTaskReceipts([f.receipt], f.receiptContext).errors, []);
  const fact = f.receiptContext.facts.get(f.receipt.id);
  fact.currentFiles.set(path, '0'.repeat(64));
  assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.length);
  f.receiptContext.maintenancePaths = new Set([path]);
  const result = validateTaskReceipts([f.receipt], f.receiptContext);
  assert.deepEqual(result.errors, []); assert.equal(result.currentAcceptance, 'open');
  assert.equal(result.acceptedTasks.size, 0); assert.equal(result.acceptedPackages.size, 0);
  assert.equal(result.historicalAcceptedTasks.has(f.receipt.id), true);
  fact.subjectFiles.delete(path);
  assert.ok(validateTaskReceipts([f.receipt], f.receiptContext).errors.length);
  const product = fixture(); product.fact.currentFiles.set('src/example.ts', '0'.repeat(64));
  product.receiptContext.maintenancePaths = new Set(['src/example.ts']);
  assert.ok(validateTaskReceipts([product.receipt], product.receiptContext).errors.length);
});

async function repository(t) {
  const root = await mkdtemp(join(tmpdir(), 'checker-maintenance-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd: root, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
  }).trim();
  const write = async (path, value) => { await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value); };
  const commit = () => { git('add', '.'); git('commit', '-qm', 'synthetic'); return git('rev-parse', 'HEAD'); };
  git('init', '-q'); git('config', 'user.name', 'Synthetic'); git('config', 'user.email', 'synthetic@invalid');
  await write('initial', 'fixture'); const base = commit();
  return { root, git, write, commit, base };
}

test('maintenance admits only exact single-parent checker snapshots and preserves later product separation', async t => {
  const repo = await repository(t);
  const file = 'tools/migration/history-records.mjs';
  await repo.write(file, 'export const synthetic = 1;'); repo.commit();
  let io = await createEvidenceIO(repo.root);
  assert.deepEqual([...maintenancePaths(io, io.head(), repo.base)], [file]);
  assert.equal(maintenancePaths(io, io.head()).size, 0, 'unapproved repository has no production exception');
  await repo.write('src/product.ts', 'product'); repo.commit();
  io = await createEvidenceIO(repo.root);
  assert.deepEqual([...maintenancePaths(io, io.head(), repo.base)], [file]);
  assert.equal(maintenancePaths(io, io.head(), repo.base).has('src/product.ts'), false);
  await repo.write(file, 'export const synthetic = 2;');
  await repo.write('src/product.ts', 'changed product'); repo.commit();
  io = await createEvidenceIO(repo.root);
  assert.equal(maintenancePaths(io, io.head(), repo.base).size, 0);
  await repo.write(file, 'export const synthetic = 1;'); repo.commit();
  io = await createEvidenceIO(repo.root);
  assert.equal(maintenancePaths(io, io.head(), repo.base).size, 0, 'restoration cannot conceal mixed commit');
});

test('maintenance rejects deletes renames merge snapshots and missing base evidence', async t => {
  const repo = await repository(t), file = 'tools/migration/history-records.mjs';
  assert.equal(MAINTENANCE_FILES.some(path => path.startsWith('src/') || path.startsWith('config/')), false);
  await repo.write(file, 'synthetic'); const added = repo.commit();
  repo.git('mv', file, 'tools/migration/not-allowed.mjs'); repo.commit();
  let io = await createEvidenceIO(repo.root);
  assert.equal(maintenancePaths(io, io.head(), repo.base).size, 0);
  repo.git('checkout', '--detach', added);
  await rm(join(repo.root, file)); repo.commit();
  io = await createEvidenceIO(repo.root);
  assert.equal(maintenancePaths(io, io.head(), repo.base).size, 0);
  repo.git('checkout', '--detach', added);
  await repo.write('other', 'branch'); const branch = repo.commit();
  repo.git('checkout', '--detach', added);
  await repo.write(file, 'merge'); const tree = (() => { repo.git('add', '.'); return repo.git('write-tree'); })();
  const merge = repo.git('commit-tree', tree, '-p', added, '-p', branch, '-m', 'synthetic merge');
  repo.git('reset', '--hard', merge);
  io = await createEvidenceIO(repo.root);
  assert.equal(maintenancePaths(io, io.head(), repo.base).size, 0);
  assert.equal(maintenancePaths(io, io.head(), 'f'.repeat(40)).size, 0);
});

test('maintenance rejects changes merged from a branch outside the approved boundary', async t => {
  const repo = await repository(t), file = 'tools/migration/history-records.mjs';
  await repo.write('boundary', 'approved'); const base = repo.commit();
  await repo.write(file, 'maintained'); const maintenance = repo.commit();
  repo.git('checkout', '--detach', repo.base);
  await repo.write(file, 'foreign branch'); const foreign = repo.commit();
  const tree = repo.git('rev-parse', foreign + '^{tree}');
  const merged = repo.git('commit-tree', tree, '-p', maintenance, '-p', foreign, '-m', 'synthetic merge');
  repo.git('reset', '--hard', merged);
  const io = await createEvidenceIO(repo.root);
  assert.equal(maintenancePaths(io, io.head(), base).size, 0);
});
