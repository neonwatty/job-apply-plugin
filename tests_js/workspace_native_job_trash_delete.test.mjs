import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, write, snapshot, cli, at, differential, unchanged } from './workspace_native_job_trash_support.mjs';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

test('permanent job deletion matches Python guards, retained evidence and durable failure behavior', {timeout:60000}, async t => {
  const fixture = await nativeFixture();
  let serial = 0;
  const isolated = () => setup(fixture, `delete-${++serial}`);
  try {
    await t.test('missing, active, stale, trashed and repeated deletion match independent Python', async () => {
      const state = await isolated();
      await differential(state, join(fixture.root, 'python-delete'), [
        {kind:'delete', id:'missing', revision:99},
        {kind:'delete', revision:2}, {kind:'delete', revision:1},
        {kind:'trash', revision:1}, {kind:'delete', revision:1},
        {kind:'delete', revision:2}, {kind:'delete', revision:2},
        {kind:'delete', id:'../private', revision:1}, {kind:'list'},
      ]);
      assert.equal(await state.jobs.get('job'), null);
      const before = await snapshot(state.root);
      const restarted = new TrashService(new NativeJobsRepository(state.root, state.provider), () => {
        throw Error('missing delete must not sample clock');
      });
      assert.deepEqual(plain(await restarted.deleteJob('job', 999n)), {deleted:false, id:'job'});
      assert.deepEqual(await snapshot(state.root), before);
    });
    await t.test('claimed and expired claims win over trash and session guards', async () => {
      const state = await isolated();
      await state.claims.select('job', 1n, true);
      await state.claims.acquire('job', text('Synthetic'), 2n);
      await differential(state, join(fixture.root, 'python-delete-claim'), [
        {kind:'delete', revision:2}, {kind:'delete', revision:3},
      ]);
      const coordinator = await read(state.root, 'coordinator.json');
      coordinator.claim.expiresAt = '2020-01-01T00:00:00Z';
      await write(state.root, 'coordinator.json', coordinator);
      const jobs = await read(state.root, 'jobs.json');
      jobs.jobs.job.deletedAt = at;
      await write(state.root, 'jobs.json', jobs);
      await differential(state, join(fixture.root, 'python-delete-expired'), [{kind:'delete', revision:3}]);
    });
    await t.test('nonterminal sessions block while terminal session and history bytes survive', async () => {
      for (const status of ['active', 'completed', 'abandoned']) {
        const state = await isolated();
        await state.claims.select('job', 1n, true);
        const acquired = plain(await state.claims.acquire('job', text('Synthetic'), 2n));
        await state.claims.progress('job', text(acquired.token), fromJSON({status:'active', pendingFields:[]}));
        const coordinator = await read(state.root, 'coordinator.json');
        coordinator.claim = null;
        await write(state.root, 'coordinator.json', coordinator);
        const session = await read(state.root, 'sessions/job.json');
        session.status = status;
        await write(state.root, 'sessions/job.json', session);
        await state.service.trashJob('job', 3n);
        await differential(state, join(fixture.root, `python-delete-${status}`), [{kind:'delete', revision:4}]);
        assert.equal(Boolean((await read(state.root, 'jobs.json')).jobs.job), status === 'active');
      }
    });
    await t.test('write, fsync and replace failures preserve record and allow retry', async () => {
      const state = await isolated();
      await state.service.trashJob('job', 1n);
      for (const stage of ['write', 'sync', 'replace']) {
        const repository = new NativeJobsRepository(state.root, state.provider, async (path, value, options) => {
          const io = createNativePointAtomicWriteIO(options.pathProfile);
          if (stage === 'replace') io.replace = async () => { throw Error('injected delete fault'); };
          else {
            const original = io.createTemporary;
            io.createTemporary = async (...args) => {
              const handle = await original(...args);
              handle[stage] = async () => { throw Error('injected delete fault'); };
              return handle;
            };
          }
          await atomicWritePointJson(path, value, options, io);
        });
        await unchanged(state, () => new TrashService(repository, () => at).deleteJob('job', 2n), /injected delete fault/);
      }
      assert.deepEqual(plain(await state.service.deleteJob('job', 2n)), {deleted:true, id:'job'});
    });
    await t.test('HTTP closed bodies, operation metadata, redaction and CLI idempotence', async () => {
      const state = await isolated();
      const request = body => jobsHttp(state.jobs, state.repository, 'POST', '/api/jobs/job/delete', body);
      for (const body of ['{}', '{"expectedRevision":true}', '{"expectedRevision":1.0}', '{"expectedRevision":0}', '{"expectedRevision":1,"confirm":true}']) {
        const before = await snapshot(state.root);
        assert.equal((await request(body)).status, 400);
        assert.deepEqual(await snapshot(state.root), before);
      }
      const active = await request('{"expectedRevision":1}');
      assert.equal(active.status, 400);
      assert.deepEqual(JSON.parse(active.body).error, {
        code:'store_rejected', message:'The canonical store rejected this lifecycle operation.',
        recordType:'job', operation:'delete', counts:{},
      });
      await state.service.trashJob('job', 1n);
      const stale = await request('{"expectedRevision":1}');
      assert.equal(stale.status, 409);
      assert.equal(JSON.parse(stale.body).error.operation, 'delete');
      assert.deepEqual(await cli(fixture, state.root, 'job-delete', ['--id','job','--expected-revision','2']), {deleted:true,id:'job'});
      assert.deepEqual(JSON.parse((await request('{"expectedRevision":2}')).body), {deleted:false,id:'job'});
    });
  } finally { await fixture.cleanup(); }
});
