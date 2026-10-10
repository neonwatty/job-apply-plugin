import assert from 'node:assert/strict';
import test from 'node:test';
import { basename, join } from 'node:path';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { NativeJobsRepository, initializeJobsFixture } from '../runtime/store/native-jobs.js';
import { NativeBrowserOperations } from '../runtime/store/native-browser-operations.js';
import { loadPosixFlockProvider } from '../runtime/store/posix-flock.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { adapter, allow, boundary, mutation, wrapper } from './workspace_durable_browser_support.mjs';
const jobs = async root => JSON.parse(await readFile(join(root, 'jobs.json'), 'utf8'));
async function bytes(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    if (name.endsWith('.json') || name.endsWith('.jsonl')) result[name] = await readFile(join(root, name), 'utf8');
  }
  return result;
}
async function setup(fixture, name, afterWrite) {
  const root = join(await realpath(fixture.root), name);
  await initializeJobsFixture(root);
  const provider = loadPosixFlockProvider(fixture.receipt.artifact);
  const repository = new NativeJobsRepository(root, provider, async (path, value, options) => {
    await atomicWritePointJson(path, value, options);
    await afterWrite?.(path);
  });
  return { root, repository, provider, store: new NativeBrowserOperations(repository) };
}
const restore = state => new NativeBrowserOperations(new NativeJobsRepository(state.root, state.provider));
const moduleURL = path => new URL(`../runtime/${path}.js`, import.meta.url).href;

test('native browser operations survive publication interruption and fail closed before recovery writes', { timeout: 90000 }, async t => {
  const fixture = await nativeFixture();
  try {
    await t.test('canonical metadata preserves unrelated records and replay across repository replacement', async () => {
      const state = await setup(fixture, 'native-replay'), base = adapter(), app = boundary(state.store, base);
      const before = await bytes(state.root), request = mutation(await app.observe());
      assert.equal((await app.execute(request)).status, 'verified');
      const after = await bytes(state.root), currentJobs = await jobs(state.root);
      assert.equal(currentJobs.metadata.durableBrowserOperations.operations[request.operationId].state, 'verified');
      const previousJobs = JSON.parse(before['jobs.json']);
      delete currentJobs.metadata.durableBrowserOperations;
      assert.deepEqual(currentJobs, previousJobs);
      for (const [name, contents] of Object.entries(before)) if (name !== 'jobs.json') assert.equal(after[name], contents);
      assert.equal((await boundary(restore(state), base).execute(request)).status, 'verified');
      assert.deepEqual(await bytes(state.root), after);
      assert.equal(base.calls.writes, 1);
      assert.doesNotMatch(after['jobs.json'], /PRIVATE/);
    });
    await t.test('published pending intent with lost acknowledgement cannot dispatch on reconstruction', async () => {
      let armed = true;
      const state = await setup(fixture, 'pending-ack', path => {
        if (armed && basename(path) === 'jobs.json') { armed = false; throw Error('PRIVATE interrupted intent'); }
      });
      const base = adapter(), app = boundary(state.store, base), request = mutation(await app.observe());
      await assert.rejects(app.execute(request), { code: 'storage_unavailable' });
      assert.equal(base.calls.mutate, 0);
      assert.equal((await jobs(state.root)).metadata.durableBrowserOperations.operations[request.operationId].state, 'pending');
      const restarted = boundary(restore(state), base), observed = await restarted.observe();
      assert.equal((await restarted.execute(request)).status, 'uncertain');
      await assert.rejects(restarted.execute(mutation(observed, { operationId: 'new-id' })), { code: 'reconciliation_required' });
      assert.equal((await restarted.reconcile(request.operationId)).status, 'uncertain');
      assert.equal(base.calls.mutate, 0);
    });
    await t.test('write success followed by lost result commit acknowledgement never dispatches twice', async () => {
      let count = 0;
      const state = await setup(fixture, 'result-ack', path => {
        if (basename(path) === 'jobs.json' && ++count === 2) throw Error('PRIVATE interrupted receipt');
      });
      const base = adapter(), app = boundary(state.store, base), request = mutation(await app.observe());
      await assert.rejects(app.execute(request), { code: 'storage_unavailable' });
      assert.equal((await jobs(state.root)).metadata.durableBrowserOperations.operations[request.operationId].state, 'verified');
      const before = base.calls;
      assert.equal((await boundary(restore(state), base).execute(request)).status, 'verified');
      assert.deepEqual(base.calls, before);
      assert.equal(base.calls.writes, 1);
    });
    await t.test('a killed process leaves durable pending intent and a Store-wide restart barrier', async () => {
      const state = await setup(fixture, 'killed-pending');
      const script = `
        import { NativeJobsRepository } from ${JSON.stringify(moduleURL('store/native-jobs'))};
        import { NativeBrowserOperations } from ${JSON.stringify(moduleURL('store/native-browser-operations'))};
        import { loadPosixFlockProvider } from ${JSON.stringify(moduleURL('store/posix-flock'))};
        import { adapter, boundary, mutation, wrapper } from ${JSON.stringify(new URL('./workspace_durable_browser_support.mjs', import.meta.url).href)};
        const repository = new NativeJobsRepository(process.argv[1], loadPosixFlockProvider(process.argv[2]));
        const base = adapter();
        const app = boundary(new NativeBrowserOperations(repository), wrapper(base, { mutate: async () => {
          console.log('pending-durable');
          await new Promise(() => { setInterval(() => {}, 1000); });
        } }));
        await app.execute(mutation(await app.observe()));
      `;
      const process = child(script, [state.root, fixture.receipt.artifact]);
      try {
        await process.line('pending-durable');
        assert.equal((await jobs(state.root)).metadata.durableBrowserOperations.operations['operation-one'].state, 'pending');
      } finally { await process.stop(); }
      const base = adapter(), app = boundary(restore(state), base), observed = await app.observe();
      await assert.rejects(app.execute(mutation(observed, { operationId: 'new-id' })), { code: 'reconciliation_required' });
      assert.equal((await app.reconcile('operation-one')).status, 'uncertain');
      assert.equal(base.calls.mutate, 0);
    });
    await t.test('canonical and pending extraction corruption prevent every recovery write, including history', async () => {
      for (const destination of ['canonical', 'pending']) {
        const state = await setup(fixture, `corrupt-${destination}`), base = adapter(), app = boundary(state.store, base);
        const request = mutation(await app.observe()); await app.execute(request);
        const document = await jobs(state.root);
        document.metadata.durableBrowserOperations.operations[request.operationId].state = ['verified'];
        const target = destination === 'canonical' ? 'jobs.json' : 'resume-extraction-journal.json';
        const value = destination === 'canonical' ? document : { schemaVersion: 1, operation: {
          kind: 'workflow-extraction', operationId: 'pending-corruption', jobsDocument: document,
          profileDocument: null, proposalsDocument: null, requestsDocument: null, resumesDocument: null, factsDocument: null,
        } };
        await writeFile(join(state.root, target), JSON.stringify(value), { mode: 0o600 });
        const before = await bytes(state.root), calls = base.calls;
        await assert.rejects(new NativeJobsRepository(state.root, state.provider).transaction(async () => {}), { code: 'invalid_browser_state' });
        await assert.rejects(boundary(restore(state), base).execute(request), { code: 'invalid_browser_state' });
        assert.deepEqual(await bytes(state.root), before);
        assert.deepEqual(base.calls, calls);
      }
    });
    await t.test('authority can inspect canonical Store after intent without deadlock; uncertain replay stays read-only', async () => {
      const state = await setup(fixture, 'authority-store'), base = adapter(); let checks = 0;
      const authority = { check: async request => {
        await state.repository.claimTransaction(async () => { checks++; });
        return allow.check(request);
      } };
      const app = boundary(state.store, wrapper(base, { mutate: async request => {
        await base.mutate(request); throw Error('lost response');
      } }), authority), request = mutation(await app.observe());
      assert.equal((await app.execute(request)).status, 'uncertain');
      assert.equal(checks, 2);
      const fresh = boundary(restore(state), base, authority);
      assert.equal((await fresh.reconcile(request.operationId)).status, 'verified');
      assert.equal(base.calls.writes, 1);
      assert.equal((await base.observe()).finalAction, 'untouched');
    });
  } finally { await fixture.cleanup(); }
});
