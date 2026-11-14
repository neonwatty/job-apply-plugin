import assert from 'node:assert/strict';
import { chmod, cp, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import test from 'node:test';
import { packageNativeLock } from '../scripts/smoke/package_native_lock.mjs';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { assertRejections, assertSuccess, cliStore, invokeCli } from './native_cli_contract_support.mjs';
import { snapshotFiles } from './legacy_store_migration_support.mjs';

const id = ['--id', 'job'];
const rev = revision => ['--expected-revision', String(revision)];

async function inputs(home) {
  const create = join(home, 'job.json'), update = join(home, 'job-update.json');
  await writeFile(create, JSON.stringify({ id: 'job', url: 'https://example.invalid/job', role: 'Engineer' }), { mode: 0o600 });
  await writeFile(update, JSON.stringify({ role: 'Senior Engineer' }), { mode: 0o600 });
  return { create: ['--input', create], update: ['--input', update] };
}

async function jobLifecycle(root, home, call) {
  const { create, update } = await inputs(home);
  assert.equal(await call('job-get', id), null);
  assert.deepEqual(await call('job-list'), []);
  const created = await call('job-create', create);
  assert.deepEqual([created.id, created.revision, created.role], ['job', 1, 'Engineer']);
  assert.deepEqual(await call('job-get', id), created);
  assert.deepEqual(await call('job-list'), [created]);
  const updated = await call('job-update', [...id, ...update, ...rev(1)]);
  assert.deepEqual([updated.revision, updated.role, updated.normalizedUrl], [2, 'Senior Engineer', created.normalizedUrl]);
  const transitioned = await call('job-transition', [...id, '--status', 'needs_info', ...rev(2)]);
  assert.deepEqual([transitioned.revision, transitioned.status], [3, 'needs_info']);
  const trashed = await call('job-trash', [...id, ...rev(3)]);
  assert.equal(trashed.revision, 4);
  assert.ok(trashed.deletedAt);
  assert.equal(await call('job-get', id), null);
  assert.deepEqual(await call('job-get', [...id, '--include-trashed']), trashed);
  assert.deepEqual(await call('job-list', ['--trashed-only']), [trashed]);
  const restored = await call('job-restore', [...id, ...rev(4)]);
  assert.deepEqual([restored.revision, restored.deletedAt], [5, null]);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8')).jobs.job, restored);
  assert.equal((await call('job-trash', [...id, ...rev(5)])).revision, 6);
  assert.deepEqual(await call('job-delete', [...id, ...rev(6)]), { id: 'job', deleted: true });
  assert.deepEqual(await call('job-list', ['--include-trashed']), []);
}

test('Store job CLI completes the full lifecycle across independent processes', async t => {
  const { root, home, call } = await cliStore(t);
  const before = await snapshotFiles(root);
  await jobLifecycle(root, home, call);
  const after = await snapshotFiles(root);
  delete before['jobs.json'];
  delete after['jobs.json'];
  assert.deepEqual(after, before);
});

test('Store job CLI rejects conflicts and invalid transitions and preserves bytes on no-ops', async t => {
  const store = await cliStore(t);
  const { create, update } = await inputs(store.home);
  const original = await store.call('job-create', create);
  await assertRejections(store, [
    ['job-create', create, /already exists|conflict/i],
    ['job-update', [...id, ...update, ...rev(99)], /revision conflict/i],
    ['job-transition', [...id, '--status', 'bogus', ...rev(1)], /status|transition/i],
    ['job-transition', [...id, '--status', 'needs_info', ...rev(99)], /revision conflict/i],
    ['job-trash', [...id, ...rev(99)], /revision conflict/i],
    ['job-delete', [...id, ...rev(1)], /trash/i],
  ]);
  const before = await snapshotFiles(store.root);
  assert.deepEqual(await store.call('job-restore', [...id, ...rev(1)]), original);
  assert.deepEqual(await snapshotFiles(store.root), before);
  const trashed = await store.call('job-trash', [...id, ...rev(1)]);
  const afterTrash = await snapshotFiles(store.root);
  assert.deepEqual(await store.call('job-trash', [...id, ...rev(2)]), trashed);
  assert.deepEqual(await snapshotFiles(store.root), afterTrash);
  await assertRejections(store, [
    ['job-restore', [...id, ...rev(1)], /revision conflict/i],
    ['job-delete', [...id, ...rev(1)], /revision conflict/i],
  ]);
  await store.call('job-delete', [...id, ...rev(2)]);
  const afterDelete = await snapshotFiles(store.root);
  const missing = await store.call('job-delete', [...id, ...rev(2)]);
  assert.equal(missing.deleted, false);
  assert.deepEqual(await snapshotFiles(store.root), afterDelete);
});

async function competingWriters(invoke, command, args, diagnostic) {
  const calls = await Promise.all(Array.from({ length: 4 }, () => invoke(command, args)));
  const successful = calls.filter(result => result.status === 0);
  assert.equal(successful.length, 1, command);
  for (const rejected of calls.filter(result => result.status !== 0)) {
    assert.equal(rejected.status, 2, command);
    assert.equal(rejected.stdout, '', command);
    assert.match(rejected.stderr, diagnostic, command);
  }
  return assertSuccess(successful[0], command);
}

test('Store job CLI serializes concurrent creation, update, and trash by revision', async t => {
  const { home, invoke, call } = await cliStore(t);
  const { create, update } = await inputs(home);
  assert.equal((await competingWriters(invoke, 'job-create', create, /already exists|conflict/i)).revision, 1);
  assert.equal((await competingWriters(invoke, 'job-update', [...id, ...update, ...rev(1)], /revision conflict/i)).revision, 2);
  assert.equal((await competingWriters(invoke, 'job-trash', [...id, ...rev(2)], /revision conflict/i)).revision, 3);
  const saved = await call('job-get', [...id, '--include-trashed']);
  assert.deepEqual([saved.role, saved.revision], ['Senior Engineer', 3]);
  assert.ok(saved.deletedAt);
  assert.deepEqual(await call('job-list', ['--include-trashed']), [saved]);
});

test('Store job-get repairs interrupted coordinator history exactly once', async t => {
  const { root, call } = await cliStore(t);
  const at = '2026-09-15T18:00:00Z';
  const claim = { claimId: 'claim-one', jobId: 'job', ownerLabel: 'Owner',
    tokenHash: createHash('sha256').update('synthetic token').digest('hex'), acquiredAt: at, heartbeatAt: at,
    expiresAt: '2026-09-15T18:05:00Z' };
  const event = { schemaVersion: 1, eventId: 'event-one', applicationId: 'job',
    event: 'claim-recovered', company: null, role: null, ats: null, status: 'in_progress', answerKeys: [], at };
  const journal = { schemaVersion: 1, operation: { kind: 'recover', operationId: 'recover-one',
    jobId: 'job', at, historyEvent: event, resultClaim: claim } };
  const journalFile = join(root, 'coordinator-journal.json');
  const historyFile = join(root, 'applications.jsonl');
  const jobsBefore = await readFile(join(root, 'jobs.json'));
  await writeFile(journalFile, JSON.stringify(journal), { mode: 0o600 });
  await writeFile(historyFile, '{"torn"', { mode: 0o600 });

  assert.equal(await call('job-get', id), null);
  const history = (await readFile(historyFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(history, [event]);
  assert.deepEqual(JSON.parse(await readFile(journalFile, 'utf8')), { schemaVersion: 1, operation: null });
  const coordinator = JSON.parse(await readFile(join(root, 'coordinator.json'), 'utf8'));
  assert.deepEqual(coordinator, { schemaVersion: 1, claim });
  assert.deepEqual(await readFile(join(root, 'jobs.json')), jobsBefore);
  const recovered = await snapshotFiles(root);
  assert.equal(await call('job-get', id), null);
  assert.deepEqual(await snapshotFiles(root), recovered);
});

async function privateCopy(source, target) {
  await cp(source, target, { recursive: true });
  await chmod(target, 0o700);
  for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
    await chmod(join(entry.parentPath, entry.name), entry.isDirectory() ? 0o700 : 0o600);
  }
}

test('Installed Store runs the job lifecycle without changing the historical rollback bytes', async t => {
  const fixture = await nativeFixture();
  t.after(fixture.cleanup);
  const home = await realpath(fixture.root);
  const plugin = join(home, 'plugin'), root = join(home, 'store');
  await mkdir(plugin);
  for (const path of ['apps/companion', 'runtime', 'native', 'package.json']) {
    await cp(new URL('../' + path, import.meta.url), join(plugin, path), { recursive: true });
  }
  await packageNativeLock(plugin);
  await privateCopy(new URL('../test/fixtures/python-store-v1.1.0/store/', import.meta.url), root);
  const before = await snapshotFiles(root);
  const call = async (command, args = []) => {
    const result = await invokeCli(home, 'apps/companion/command.mjs', ['store', '--root', root, command, ...args], plugin);
    const output = assertSuccess(result, command);
    for (const [path, content] of Object.entries(before)) {
      assert.deepEqual(await readFile(join(root + '.python-rollback', path)), content, path);
    }
    return output;
  };
  await jobLifecycle(root, home, call);
});
