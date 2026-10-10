import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, join } from 'node:path';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { NativeBrowserOperations } from '../runtime/store/native-browser-operations.js';
import { browserRecoveryGuidance } from '../runtime/app/browser-recovery-guidance.js';
import { browserArchiveDirectory } from '../runtime/store/native-browser-archive-files.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { adapter, boundary, mutation, wrapper } from './workspace_durable_browser_support.mjs';
const jobs = async root => JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8'));
async function snapshot(root) {
  const result = {};
  for (const entry of (await readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && /\.jsonl?$/.test(entry.name)) result[entry.name] = await readFile(join(root, entry.name), 'utf8');
    if (entry.isDirectory() && entry.name === browserArchiveDirectory) {
      for (const name of (await readdir(join(root, entry.name))).sort()) {
        result[`${entry.name}/${name}`] = await readFile(join(root, entry.name, name), 'utf8');
      }
    }
  }
  return result;
}
async function setup(fixture, name, writeHook) {
  const root = join(await realpath(fixture.root), name);
  await initializeJobsFixture(root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const repository = new NativeJobsRepository(root, provider, async (path, value, options) => {
    await writeHook?.(path, value);
    await atomicWritePointJson(path, value, options);
  });
  return { root, provider, repository, store: new NativeBrowserOperations(repository) };
}
const restored = state => new NativeBrowserOperations(new NativeJobsRepository(state.root, state.provider));
async function fill(app, count) {
  let first;
  for (let index = 0; index < count; index++) {
    const request = mutation(await app.observe(), { operationId: `native-${index}` });
    first ??= request;
    assert.equal((await app.execute(request)).status, 'verified');
  }
  return first;
}

test('native archive rollover, replay, uncertainty, interrupted root and recovery corruption', { timeout: 90000 }, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('ordinary durable execution rolls over and historical replay never writes Store or browser', async () => {
      const state = await setup(fixture, 'rollover'), base = adapter(), app = boundary(state.store, base);
      const initial = await snapshot(state.root), first = await fill(app, 64);
      const document = await jobs(state.root), ledger = document.metadata.durableBrowserOperations;
      assert.equal(ledger.schemaVersion, 2);
      assert.equal(ledger.archive.segments.length, 1);
      assert.ok(ledger.archive.segments[0].operationCount > 0);
      assert.equal(Object.hasOwn(ledger.operations, first.operationId), false);
      delete document.metadata.durableBrowserOperations;
      assert.deepEqual(document, JSON.parse(initial['jobs.json']));
      const before = await snapshot(state.root), calls = base.calls;
      const fresh = boundary(restored(state), base);
      assert.equal((await fresh.execute(first)).status, 'verified');
      assert.equal((await fresh.reconcile(first.operationId)).status, 'verified');
      await assert.rejects(fresh.execute({ ...first, valueRef: 'changed' }), { code: 'operation_conflict' });
      assert.deepEqual(await snapshot(state.root), before);
      assert.deepEqual(base.calls, calls);
      const denied = boundary(restored(state), base, { check: async () => ({ authorized: false }) });
      await assert.rejects(denied.execute(first), { code: 'authority_denied' });
      assert.deepEqual(await snapshot(state.root), before);
      const uncertain = boundary(restored(state), wrapper(base, { mutate: async request => {
        await base.mutate(request); throw Error('lost response');
      } }));
      const request = mutation(await uncertain.observe(), { operationId: 'uncertain' });
      assert.equal((await uncertain.execute(request)).status, 'uncertain');
      const restart = boundary(restored(state), base), observed = await restart.observe();
      await assert.rejects(restart.execute(mutation(observed, { operationId: 'replacement' })), { code: 'reconciliation_required' });
      assert.equal((await restart.reconcile(request.operationId)).status, 'verified');
      assert.equal(base.calls.writes, 65);
    });
    await t.test('segment published before failed canonical root is ignored and safely reused on restart', async () => {
      let armed = false;
      const state = await setup(fixture, 'root-interrupted', path => {
        if (armed && basename(path) === 'jobs.json') { armed = false; throw Error('root interruption'); }
      });
      const base = adapter(), app = boundary(state.store, base);
      await fill(app, 62);
      const request = mutation(await app.observe(), { operationId: 'will-rollover' });
      const interrupted = boundary(state.store, wrapper(base, { mutate: async item => {
        const result = await base.mutate(item); armed = true; return result;
      } }));
      await interrupted.observe();
      await assert.rejects(interrupted.execute(request), { code: 'storage_unavailable' });
      const stored = (await jobs(state.root)).metadata.durableBrowserOperations;
      assert.equal(stored.schemaVersion, 1);
      assert.equal(stored.operations[request.operationId].state, 'pending');
      assert.equal((await readdir(join(state.root, browserArchiveDirectory))).length, 1);
      const originalBytes = await snapshot(state.root), store = restored(state);
      const inspected = await store.inspect(), guidance = browserRecoveryGuidance(inspected);
      assert.equal(inspected.schemaVersion, 1);
      assert.equal(guidance.hotOperationCount, 63);
      assert.equal(guidance.archivedOperationCount, 0);
      assert.equal(guidance.archiveSegmentsRemaining, 32);
      assert.equal(guidance.unresolvedOperationId, request.operationId);
      assert.deepEqual(await snapshot(state.root), originalBytes);
      const restarted = boundary(store, base);
      assert.equal((await restarted.execute(request)).status, 'uncertain');
      assert.equal((await restarted.reconcile(request.operationId)).status, 'verified');
      assert.equal(base.calls.writes, 63);
      assert.equal((await jobs(state.root)).metadata.durableBrowserOperations.schemaVersion, 2);
    });
    await t.test('referenced archive corruption blocks canonical and pending extraction recovery before any write', async () => {
      for (const destination of ['canonical', 'pending']) {
        const state = await setup(fixture, `corrupt-${destination}`), base = adapter(), app = boundary(state.store, base);
        await fill(app, 64);
        const document = await jobs(state.root);
        if (destination === 'pending') {
          const pending = { schemaVersion: 1, operation: { kind: 'workflow-extraction', operationId: 'pending-archive',
            jobsDocument: document, profileDocument: null, proposalsDocument: null, requestsDocument: null,
            resumesDocument: null, factsDocument: null } };
          await writeFile(join(state.root, 'resume-extraction-journal.json'), JSON.stringify(pending), { mode: 0o600 });
          const canonical = structuredClone(document);
          delete canonical.metadata.durableBrowserOperations;
          await writeFile(join(state.root, 'jobs.json'), JSON.stringify(canonical));
        }
        const digest = document.metadata.durableBrowserOperations.archive.segments[0].digest;
        await writeFile(join(state.root, browserArchiveDirectory, `${digest}.json`), '{}');
        const before = await snapshot(state.root);
        await assert.rejects(new NativeJobsRepository(state.root, state.provider).transaction(async () => {}), { code: 'invalid_browser_state' });
        assert.deepEqual(await snapshot(state.root), before);
      }
    });
  } finally { await fixture.cleanup(); }
});
