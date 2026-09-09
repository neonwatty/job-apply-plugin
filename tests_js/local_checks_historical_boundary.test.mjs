import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditHistoricalBoundary, historicalRecord } from '../tools/migration/historical-boundary.mjs';

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'historical-boundary-'));
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args],
    { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  async function put(path, value) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), value);
  }
  function commit() { git('add', '.'); git('commit', '-qm', 'fixture'); return git('rev-parse', 'HEAD'); }
  try {
    git('init', '-q'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@invalid');
    await put('docs/migration/evidence/original.json', '{}');
    await put('config/migration/task-receipts.json', '{}');
    await put('src/product.ts', 'original');
    const base = commit();
    await put('src/product.ts', 'current'); commit();
    await run({ root, git, put, commit, base });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('historical boundary preserves all evidence and permits only current inventory metadata', () => {
  for (const path of ['docs/migration/evidence/a/log.txt', 'config/migration/task-receipts.json',
    'config/migration/new-acceptance.json', 'config/migration/packages.json']) assert.equal(historicalRecord(path), true);
  for (const path of ['src/product.ts', 'config/migration/source-catalog-next.json',
    'config/migration/http-next-surfaces.json', 'config/migration/review-lock.json']) assert.equal(historicalRecord(path), false);
});

test('historical audit uses original source every time and grants no current acceptance', async () => fixture(async ({ root, git, base }) => {
  let calls = 0;
  const audit = async snapshot => {
    calls++;
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot, encoding: 'utf8' }).trim(), base);
    return { status: 'inventory-consistent', errors: [] };
  };
  const head = git('rev-parse', 'HEAD');
  for (let i = 0; i < 2; i++) assert.deepEqual(await auditHistoricalBoundary(root, audit, base),
    { revision: base, status: 'audited', currentAcceptance: 'open' });
  assert.equal(calls, 2);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(git('status', '--porcelain'), '');
  assert.equal(await auditHistoricalBoundary(root, audit, head), null);
  assert.equal(await auditHistoricalBoundary(root, audit, '0'.repeat(40)), null);
}));

test('failed, missing and thrown historical audits fail closed without cached success', async () => fixture(async ({ root, base }) => {
  for (const result of [undefined, { status: 'skipped', errors: [] },
    { status: 'inventory-consistent', errors: ['bad original receipt'] }]) {
    await assert.rejects(auditHistoricalBoundary(root, async () => result, base), /Historical audit failed/);
  }
  await assert.rejects(auditHistoricalBoundary(root, async () => { throw Error('timeout'); }, base), /timeout/);
}));

test('modified historical evidence and dirty current snapshots cannot use the boundary', async () => fixture(async ({ root, put, commit, base }) => {
  const audit = async () => { assert.fail('must reject before audit'); };
  await put('src/product.ts', 'unstaged');
  await assert.rejects(auditHistoricalBoundary(root, audit, base), /clean current snapshot/);
  commit();
  await put('docs/migration/evidence/original.json', '{"forged":true}'); commit();
  await assert.rejects(auditHistoricalBoundary(root, audit, base), /Archived migration evidence changed/);
}));
