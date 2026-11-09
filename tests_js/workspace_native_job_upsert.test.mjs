import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, plain, snapshot } from './workspace_native_claims_support.mjs';
import { fixed, item, batch, differential, unchanged } from './workspace_native_job_upsert_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { fromJSON, get, object, set, text } from '../runtime/contracts/workspace/values.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

const loaded = await import('../runtime/workspace-core/job-upsert.js').catch(() => ({}));
test('native upsert preserves Python previews, commits, identity and atomicity contracts', {timeout:60000}, async t => {
  assert.equal(typeof loaded.JobUpsertService,'function');
  const {JobUpsertService} = loaded;
  const fixture = await nativeFixture();
  try {
    let serial = 0;
    const isolated = async () => {
      const state = await setup(fixture,`upsert-${++serial}`);
      return {...state,service:new JobUpsertService(state.repository,() => fixed)};
    };
    await t.test('exact tokens and records across partial batches, duplicates and provenance',async () => {
      const state = await isolated();
      const human = batch(item('new',{source:'LinkedIn',sourceId:'42',role:'Human role',priority:4}));
      const agent = batch(item('new',{source:'linkedin',sourceId:'42',role:'Agent role',company:'Agent company'}));
      await differential(state.service,state.root,join(fixture.root,'python-sequence'),[
        {payload:human}, {payload:human}, {payload:agent,origin:'agent'},
        {payload:batch(item('new',{company:'Agent refresh'})),origin:'agent'},
        {payload:batch(item('new',{company:'Human edit'}))},
        {payload:batch(item('new',{company:'Ignored',description:'Added'})),origin:'agent'},
        {payload:batch(item('identical'),item('identical'))},
        {payload:batch(item('differing',{role:'One'}),item('differing',{role:'Two'}))},
        {payload:batch(item('partial'),null,4,[],{},item('bad',{role:[]}))},
        {payload:batch(...[true,1.5,-1,6,'2'].map(priority=>item('bad-priority',{priority})))},
        {payload:batch(item('bad',{status:'ready'}),{url:'ftp://example.invalid/x'},item('nulls',{role:null,company:' ',priority:0}))},
        {payload:batch({url:3},{url:true},item('source-invalid',{source:5}),item('ats-invalid',{ats:'not-an-ats'}))},
        {payload:batch()}, {payload:{}}, {payload:{jobs:{}}}, {payload:{jobs:[],extra:true}},
        {payload:batch(item('bad-origin')),origin:'migration'},
        {payloadJson:'{"jobs":[{"url":"https://example.invalid/float-priority","priority":1.0},{"url":"https://example.invalid/huge-priority","priority":900719925474099312345}]}'},
      ]);
    });
    await t.test('tokens trim strings but bind source case, item order, author and whole document',async () => {
      const state = await isolated();
      await differential(state.service,state.root,join(fixture.root,'python-tokens'),[
        {payload:batch(item('trim',{role:'  Engineer  '})),commitPayload:batch(item('trim',{role:'Engineer'}))},
        {payload:batch(item('case',{source:'LinkedIn'})),commitPayload:batch(item('case',{source:'linkedin'}))},
        {payload:batch(item('a'),item('b')),commitPayload:batch(item('b'),item('a'))},
        {payload:batch(item('origin')),commitOrigin:'agent'},
        {payload:batch(item('forged')),token:'job-upsert-v1.'+'0'.repeat(64)},
        {payload:batch(item('empty-token')),token:''},
      ]);
      const payload = fromJSON(batch(item('drift')));
      const preview = plain(await state.service.preview(payload,'human'));
      const document = await read(state.root,'jobs.json');
      document.metadata.unknown = 'metadata drift';
      await write(state.root,'jobs.json',document);
      await unchanged(state.root,() => state.service.commit(payload,'human',preview.token),/drifted/);
      await differential(state.service,state.root,join(fixture.root,'python-document-drift'),[
        {payload:batch(item('drift')),token:preview.token},
      ]);
    });
    await t.test('cross identities, incompatible sources, deleted matches and deterministic id collisions',async () => {
      const state = await isolated();
      const document = await read(state.root,'jobs.json');
      Object.assign(document.jobs.job,{source:'LinkedIn',sourceId:'one'});
      Object.assign(document.jobs.other,{source:'LinkedIn',sourceId:'two'});
      const collision = 'job-'+createHash('sha256').update('url\0https://example.invalid/collision').digest('hex').slice(0,24);
      document.jobs[collision] = {...document.jobs.other,id:collision,url:'https://example.invalid/occupied',normalizedUrl:'https://example.invalid/occupied',sourceId:'occupied'};
      document.jobs.deleted = {...document.jobs.other,id:'deleted',url:'https://example.invalid/deleted',normalizedUrl:'https://example.invalid/deleted',sourceId:'deleted',deletedAt:fixed};
      await write(state.root,'jobs.json',document);
      await differential(state.service,state.root,join(fixture.root,'python-identities'),[
        {payload:batch(item('job',{source:'linkedin',sourceId:'two'}))},
        {payload:batch(item('job',{source:'Other'}))},
        {payload:batch(item('job',{sourceId:'changed'}))},
        {payload:batch(item('new-url',{source:'linkedin',sourceId:'one'}))},
        {payload:batch(item('deleted'),item('collision'))},
        {payload:batch(item('source-a',{source:'LinkedIn',sourceId:'new'}),item('source-b',{source:'linkedin',sourceId:'new'}))},
      ]);
    });
    await t.test('ambiguous pre-existing URL and source identities remain conflicts',async () => {
      const state = await isolated();
      const document = await read(state.root,'jobs.json');
      document.jobs.other.normalizedUrl = document.jobs.job.normalizedUrl;
      document.jobs.other.url = document.jobs.job.url;
      Object.assign(document.jobs.job,{source:'LinkedIn',sourceId:'duplicate'});
      Object.assign(document.jobs.other,{source:'LinkedIn',sourceId:'duplicate'});
      await write(state.root,'jobs.json',document);
      await differential(state.service,state.root,join(fixture.root,'python-ambiguous'),[
        {payload:batch(item('job'),item('different-url',{source:'linkedin',sourceId:'duplicate'}))},
      ]);
    });
    await t.test('active claims do not add a guard absent from Python; unrelated files remain untouched',async () => {
      const state = await isolated();
      await state.claims.select('job',1n,true);
      await state.claims.acquire('job',text('Synthetic'),2n);
      await unchanged(state.root,() => state.jobs.update('job',fromJSON({description:'Guarded'}),3n),/claimed job requires/);
      await unchanged(state.root,() => state.repository.transaction(async transaction => {
        const record = object(get(object(get(transaction.document,'jobs'),'jobs'),'job'),'job');
        set(record,'description',text('Must remain guarded'));
        await transaction.save(transaction.document);
      }),/claimed job requires/);
      await differential(state.service,state.root,join(fixture.root,'python-claimed'),[
        {payload:batch(item('job',{description:'Observed while claimed'})),origin:'agent'},
      ]);
    });
    await t.test('large revisions and unknown numbers are preserved and included in Python token',async () => {
      const state = await isolated();
      const path = join(state.root,'jobs.json');
      const document = await read(state.root,'jobs.json');
      document.jobs.job.revision = 'EXACT';
      document.metadata.opaque = 'OPAQUE';
      await writeFile(path,JSON.stringify(document).replace('"EXACT"','900719925474099312345')
        .replace('"OPAQUE"','{"integer":900719925474099312346,"float":1.0,"negativeZero":-0.0,"text":"😀"}'));
      await differential(state.service,state.root,join(fixture.root,'python-large'),[
        {payload:batch(item('job',{description:'Exact revision increment'}))},
      ]);
      assert.match(await readFile(path,'utf8'),/900719925474099312346/);
      assert.match(await readFile(path,'utf8'),/"float": 1\.0/);
    });
    await t.test('independent repositories serialize one accepted token and reject concurrent stale commits',async () => {
      const state = await isolated();
      const payload = fromJSON(batch(item('concurrent')));
      const {token} = plain(await state.service.preview(payload,'human'));
      const outcomes = await Promise.allSettled(Array.from({length:4},() => new JobUpsertService(
        new NativeJobsRepository(state.root,state.provider),() => fixed).commit(payload,'human',token)));
      assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
      for(const result of outcomes.filter(result=>result.status==='rejected')) assert.match(result.reason.message,/drifted/);
      const replay = plain(await state.service.preview(payload,'human'));
      const before = await snapshot(state.root);
      assert.equal(plain(await state.service.commit(payload,'human',replay.token)).committed,false);
      assert.deepEqual(await snapshot(state.root),before);
    });
    await t.test('atomic save faults preserve old bytes and allow retry with the same token',async () => {
      const state = await isolated();
      const payload = fromJSON(batch(item('fault')));
      const {token} = plain(await state.service.preview(payload,'human'));
      for(const stage of ['write','sync','replace']) {
        const repository = new NativeJobsRepository(state.root,state.provider,async (path,value,options) => {
          const io = createNativePointAtomicWriteIO(options.pathProfile);
          if(stage==='replace') io.replace = async () => {throw Error('upsert injected fault');};
          else {
            const original = io.createTemporary;
            io.createTemporary = async (...args) => {
              const handle = await original(...args);
              handle[stage] = async () => {throw Error('upsert injected fault');};
              return handle;
            };
          }
          await atomicWritePointJson(path,value,options,io);
        });
        await unchanged(state.root,()=>new JobUpsertService(repository,()=>fixed).commit(payload,'human',token),/upsert injected fault/);
        assert.equal((await readdir(state.root)).some(name=>name.endsWith('.tmp')),false);
      }
      assert.equal(plain(await state.service.commit(payload,'human',token)).committed,true);
    });
  } finally {await fixture.cleanup();}
});
