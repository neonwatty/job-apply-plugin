import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { runJobsCli } from '../runtime/cli/native-jobs.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, write, snapshot, at, differential } from './workspace_native_lifecycle_answers_support.mjs';
import { AnswerLifecycleService } from '../runtime/workspace-core/answer-lifecycle.js';
import { answerLifecycleHttp } from '../runtime/workspace-core/answer-lifecycle-http.js';
import { runAnswerLifecycleCommand } from '../runtime/cli/native-answer-lifecycle.js';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

const session = (status, answerKeys = [], pendingFields = []) => ({
  schemaVersion:1, applicationId:'job', status, ats:'greenhouse', answerKeys, pendingFields,
});
test('answer lifecycle matches independent Python with legacy, redirect and protected-reference semantics', {timeout:60000}, async t => {
  const fixture = await nativeFixture();
  let serial = 0;
  const isolated = extra => setup(fixture, `answers-${++serial}`, extra);
  try {
    await t.test('legacy defaults, stale revisions, idempotence, missing and Unicode identities', async () => {
      const state = await isolated();
      await differential(state, join(fixture.root,'python-basic'), [
        {kind:'restore',revision:1}, {kind:'delete',revision:9}, {kind:'delete',revision:1},
        {kind:'trash',revision:1}, {kind:'trash',revision:2}, {kind:'trash',revision:1},
        {kind:'restore',revision:2}, {kind:'restore',revision:3}, {kind:'trash',revision:3},
        {kind:'delete',revision:4}, {kind:'delete',revision:999},
        {kind:'trash',key:'missing',revision:1}, {kind:'restore',key:'',revision:1},
      ]);
      const document = await read(state.root,'answers.json');
      const key = 'réponse/😀';
      document.answers[key] = {key,question:'Unicode?',state:'missing',value:null,updatedAt:at};
      await write(state.root,'answers.json',document);
      await differential(state,join(fixture.root,'python-unicode'),[
        {kind:'trash',key,revision:1}, {kind:'restore',key,revision:2},
      ]);
      const result = await answerLifecycleHttp(state.repository,'POST',`/api/answers/${encodeURIComponent(key)}/trash`,'{"expectedRevision":3}');
      assert.equal(result.status,200); assert.equal(JSON.parse(result.body).key,key);
    });
    await t.test('sensitive lifecycle mutation projections never expose the stored value', async () => {
      const state = await isolated({answers:{answer:{key:'answer',question:'Private?',state:'sensitive',
        value:'PRIVATE-MARKER',rememberedWithConsentAt:at,updatedAt:at}}});
      await differential(state,join(fixture.root,'python-sensitive'),[
        {kind:'trash',revision:1},{kind:'trash',revision:2},{kind:'restore',revision:2},
      ]);
      const response = await answerLifecycleHttp(state.repository,'POST','/api/answers/answer/trash','{"expectedRevision":3}');
      assert.equal(response.status,200); assert.doesNotMatch(response.body,/PRIVATE-MARKER/);
      assert.equal(JSON.parse(response.body).valueRedacted,true);
    });
    await t.test('redirect sources and targets preserve guard order and restore no-op', async () => {
      const state = await isolated({redirects:{retired:{targetKey:'answer',mergedAt:at}}});
      await differential(state,join(fixture.root,'python-redirect'),[
        {kind:'delete',key:'retired',revision:99},{kind:'trash',key:'retired',revision:1},
        {kind:'restore',key:'retired',revision:1},{kind:'trash',revision:9},
        {kind:'trash',revision:1},{kind:'restore',revision:1},{kind:'delete',revision:1},
      ]);
      const response = await answerLifecycleHttp(state.repository,'POST','/api/answers/answer/trash','{"expectedRevision":1}');
      assert.equal(response.status,409); assert.equal(JSON.parse(response.body).error.code,'redirect_target_blocked');
      const retired = await answerLifecycleHttp(state.repository,'POST','/api/answers/retired/delete','{"expectedRevision":1}');
      assert.equal(retired.status,400); assert.equal(JSON.parse(retired.body).error.code,'store_rejected');
    });
    await t.test('all session states and pending fields block deletion; history survives untouched', async () => {
      for (const status of ['active','review','completed','abandoned']) {
        for (const pending of [false,true]) {
          const state = await isolated();
          await write(state.root,'sessions/job.json',session(status,pending ? [] : ['answer','answer'],pending ? [
            {answerKey:'answer',question:'Private question?',reference:`pending_${'a'.repeat(32)}`},
          ] : []));
          await writeFile(join(state.root,'applications.jsonl'),JSON.stringify({schemaVersion:1,eventId:'history',
            applicationId:'job',event:'saved',answerKeys:['answer','answer'],at})+'\n');
          await differential(state,join(fixture.root,`python-${status}-${pending}`),[
            {kind:'trash',revision:1},{kind:'delete',revision:2},{kind:'restore',revision:2},{kind:'trash',revision:3},
          ]);
          const before = await snapshot(state.root);
          const response = await answerLifecycleHttp(state.repository,'POST','/api/answers/answer/delete','{"expectedRevision":4}');
          assert.equal(response.status,409);
          assert.deepEqual(JSON.parse(response.body).error, {code:'session_reference_blocked',
            message:'This answer is referenced by an active session and cannot be permanently deleted.',
            recordType:'answer',operation:'delete',counts:{sessions:1,history:1}});
          assert.deepEqual(await snapshot(state.root),before);
        }
      }
      const state = await isolated();
      await writeFile(join(state.root,'applications.jsonl'),JSON.stringify({schemaVersion:1,eventId:'history',
        applicationId:'job',event:'saved',answerKeys:['answer'],at})+'\n');
      await differential(state,join(fixture.root,'python-history'),[{kind:'trash',revision:1},{kind:'delete',revision:2}]);
      const response = await answerLifecycleHttp(state.repository,'POST','/api/answers/answer/delete','{"expectedRevision":2}');
      assert.equal(JSON.parse(response.body).error.code,'history_reference_blocked');
      assert.deepEqual(JSON.parse(response.body).error.counts,{sessions:0,history:1});
    });
    await t.test('noops do not sample clocks or rewrite bytes; timestamps follow Python call order', async () => {
      const state = await isolated(), times=['2026-09-11T01:00:01Z','2026-09-11T01:00:02Z','2026-09-11T01:00:03Z'];
      let calls=0;
      const service=new AnswerLifecycleService(state.repository,()=>times[calls++]);
      const before=await snapshot(state.root);
      await service.restore('answer',1n); assert.deepEqual(await snapshot(state.root),before); assert.equal(calls,0);
      const trashed=plain(await service.trash('answer',1n));
      assert.equal(trashed.deletedAt,times[0]); assert.equal(trashed.updatedAt,times[1]);
      const deleted=await snapshot(state.root);
      await service.trash('answer',2n); assert.deepEqual(await snapshot(state.root),deleted); assert.equal(calls,2);
      assert.equal(plain(await service.restore('answer',2n)).updatedAt,times[2]);
    });
    await t.test('HTTP rejects open bodies; CLI leaves preserve exact revisions and delete response', async () => {
      const state=await isolated();
      for(const body of ['{','[]','{}','{"expectedRevision":true}','{"expectedRevision":1.0}',
        '{"expectedRevision":0}','{"expectedRevision":1,"confirmation":true}']) {
        const before=await snapshot(state.root);
        const response=await answerLifecycleHttp(state.repository,'POST','/api/answers/answer/delete',body);
        assert.equal(response.status,400); assert.equal(JSON.parse(response.body).error.code,'request_error');
        assert.deepEqual(await snapshot(state.root),before);
      }
      const run=(kind,revision)=>runAnswerLifecycleCommand(`answer-${kind}`,state.repository,new Map([
        ['--key','answer'],['--expected-revision',revision],
      ]));
      assert.equal(plain(await run('trash','1')).revision,2);
      assert.throws(()=>run('delete','1.0'),/positive integer/);
      assert.deepEqual(plain(await run('delete','2')),{deleted:true,key:'answer'});
      assert.deepEqual(plain(await run('delete','999')),{deleted:false,key:'answer'});
      const missing=await answerLifecycleHttp(state.repository,'POST','/api/answers/answer/restore','{"expectedRevision":1}');
      assert.equal(missing.status,404); assert.equal(JSON.parse(missing.body).error.operation,'restore');
    });
    await t.test('shared CLI and HTTP support Unicode by-key lifecycle routes', async () => {
      const state = await isolated(), key = 'réponse/😀';
      const document = await read(state.root, 'answers.json');
      document.answers[key] = {key, question:'Unicode?', state:'missing', value:null, updatedAt:at};
      await write(state.root, 'answers.json', document);
      const cli = async (command, revision) => JSON.parse(await runJobsCli([
        '--root',state.root,'--native-lock',fixture.receipt.artifact,command,
        '--key',key,'--expected-revision',String(revision),
      ], async () => {throw Error('unexpected input');}));
      assert.equal((await cli('answer-trash',1)).revision,2);
      const base = `/api/answers/by-key/${Buffer.from(key).toString('base64url')}`;
      const request = (path, revision) => jobsHttp(new JobsService(state.repository),state.repository,
        'POST',path,`{"expectedRevision":${revision}}`);
      const restored = await request(`${base}/restore`,2);
      assert.equal(restored.status,200); assert.equal(JSON.parse(restored.body).revision,3);
      const before = await snapshot(state.root);
      for (const encoded of ['a','_w','%%%']) {
        const invalid = await request(`/api/answers/by-key/${encoded}/trash`,3);
        assert.equal(invalid.status,400);
      }
      assert.deepEqual(await snapshot(state.root),before);
      assert.equal((await request(`${base}/trash`,3)).status,200);
      assert.deepEqual(await cli('answer-delete',4),{deleted:true,key});
      assert.deepEqual(JSON.parse((await request(`${base}/delete`,4)).body),{deleted:false,key});
    });
    await t.test('atomic failures retain answer and release lock for restart; OS errors are redacted', async () => {
      const state=await isolated();
      await state.service.trash('answer',1n);
      for(const stage of ['write','sync','replace']) {
        const repository=new NativeJobsRepository(state.root,state.provider,async(path,value,options)=>{
          const io=createNativePointAtomicWriteIO(options.pathProfile);
          const fail=async()=>{throw Object.assign(Error('PRIVATE PATH'),{code:'EIO'});};
          if(stage==='replace') io.replace=fail;
          else {
            const original=io.createTemporary;
            io.createTemporary=async(...args)=>{const handle=await original(...args);handle[stage]=fail;return handle;};
          }
          await atomicWritePointJson(path,value,options,io);
        });
        const before=await snapshot(state.root);
        const response=await answerLifecycleHttp(repository,'POST','/api/answers/answer/delete','{"expectedRevision":2}');
        assert.equal(response.status,500); assert.deepEqual(JSON.parse(response.body),{error:{code:'storage_error',message:'storage operation failed'}});
        assert.deepEqual(await snapshot(state.root),before);
      }
      const restarted=new AnswerLifecycleService(new NativeJobsRepository(state.root,state.provider),()=>at);
      assert.deepEqual(plain(await restarted.delete('answer',2n)),{deleted:true,key:'answer'});
    });
  } finally {await fixture.cleanup();}
});
