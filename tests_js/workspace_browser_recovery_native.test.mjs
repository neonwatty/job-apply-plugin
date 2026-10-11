import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { NativeBrowserOperations } from '../runtime/store/native-browser-operations.js';
import { NativeBrowserRecovery } from '../runtime/store/native-browser-recovery.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { adapter, boundary, mutation, wrapper } from './workspace_durable_browser_support.mjs';

async function snapshot(root, prefix = '') {
  const result = {};
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = join(prefix, item.name);
    if (item.isDirectory()) Object.assign(result, await snapshot(root, name));
    else result[name] = (await readFile(join(root, name))).toString('base64');
  }
  return result;
}

test('recovery projection reads committed native history without changing Store state', { timeout: 90000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  async function setup(name) {
    const root = join(await realpath(fixture.root), name);
    await initializeJobsFixture(root);
    const repository = new NativeJobsRepository(root, provider);
    const recovery = new NativeBrowserRecovery(root, provider);
    const get = () => jobsHttp(null, repository, 'GET', '/api/browser-recovery', '', {
      browserRecovery: () => recovery.inspect(),
    });
    return { root, repository, recovery, get, store: new NativeBrowserOperations(repository) };
  }
  await t.test('empty ledger and unsupported transport are distinct, read-only states', async () => {
    const state = await setup('empty'), before = await snapshot(state.root);
    const response = await state.get();
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { available: true, guidance: {
      status: 'ready', hotOperationCount: 0, archivedOperationCount: 0,
      archiveSegmentsRemaining: 32, nextAction: 'continue',
    } });
    assert.deepEqual(await snapshot(state.root), before);
    const unsupported = await jobsHttp(null, null, 'GET', '/api/browser-recovery');
    assert.deepEqual(JSON.parse(unsupported.body), { available: false, reason: 'unsupported_store' });
  });
  await t.test('uncertainty is visible but operation and applicant identities are absent', async () => {
    const state = await setup('uncertain'), base = adapter();
    const app = boundary(state.store, wrapper(base, { mutate: async request => {
      await base.mutate(request); throw Error('lost response');
    } }));
    const request = mutation(await app.observe(), { operationId: 'private-operation' });
    assert.equal((await app.execute(request)).status, 'uncertain');
    const before = await snapshot(state.root), result = await state.get();
    assert.equal(result.status, 200);
    assert.equal(JSON.parse(result.body).guidance.status, 'reconciliation_required');
    assert.doesNotMatch(result.body, /private-operation|PRIVATE-FICTIONAL|profile.email|task-fictional/);
    assert.deepEqual(await snapshot(state.root), before);
    assert.equal(base.calls.writes, 1);
  });
  await t.test('archive references are validated; refresh does not roll over hot history', async () => {
    const state = await setup('archive'), app = boundary(state.store, adapter());
    for (let index = 0; index < 64; index++) {
      assert.equal((await app.execute(mutation(await app.observe(), { operationId: `op-${index}` }))).status, 'verified');
    }
    const before = await snapshot(state.root), response = await state.get();
    const guidance = JSON.parse(response.body).guidance;
    assert.equal(guidance.archiveSegmentsRemaining, 31);
    assert.equal(guidance.hotOperationCount + guidance.archivedOperationCount, 64);
    assert.deepEqual(await snapshot(state.root), before);
    const files = await readdir(join(state.root, 'browser-operation-archive'));
    await writeFile(join(state.root, 'browser-operation-archive', files[0]), 'private-corruption');
    const corrupt = await snapshot(state.root), rejected = await state.get();
    assert.equal(rejected.status, 503);
    assert.doesNotMatch(rejected.body, /private-corruption|browser-operation-archive/);
    assert.deepEqual(await snapshot(state.root), corrupt);
  });
  await t.test('pending journals and disposable files are preserved during refresh', async () => {
    const state = await setup('pending');
    await writeFile(join(state.root, '.workflow-jobs.abcdefgh.tmp'), 'unfinished', { mode: 0o600 });
    let before = await snapshot(state.root);
    assert.equal((await state.get()).status, 200);
    assert.deepEqual(await snapshot(state.root), before);
    await writeFile(join(state.root, 'coordinator-journal.json'), JSON.stringify({
      schemaVersion: 1, operation: { private: 'interrupted-commit' },
    }));
    before = await snapshot(state.root);
    assert.equal((await state.get()).status, 503);
    assert.deepEqual(await snapshot(state.root), before);
  });
});
