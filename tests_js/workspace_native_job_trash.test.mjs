import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, write, snapshot, cli, at, differential, unchanged } from './workspace_native_job_trash_support.mjs';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { atomicWritePointJson, createNativePointAtomicWriteIO } from '../runtime/store/point-persistence.js';

test('native Trash listing and job lifecycle preserve Python contracts and persistence',{timeout:60000},async t=>{
  const fixture=await nativeFixture();
  let serial=0;
  const isolated=()=>setup(fixture,`trash-${++serial}`);
  try {
    await t.test('trash, restore, noops, stale revisions and missing identities match Python',async()=>{
      const state=await isolated();
      await differential(state,join(fixture.root,'python-lifecycle'),[
        {kind:'list'},{kind:'restore',revision:1},{kind:'trash',revision:1},
        {kind:'trash',revision:2},{kind:'trash',revision:1},{kind:'list'},
        {kind:'restore',revision:2},{kind:'restore',revision:3},{kind:'list'},
        {kind:'trash',id:'missing',revision:1},{kind:'trash',id:'../private',revision:1},
      ]);
      assert.equal(plain(await state.jobs.get('job')).revision,3);
    });
    await t.test('trash samples deletion and update clocks separately; restore samples once; noops never sample',async()=>{
      const state=await isolated();
      const times=['2026-09-10T15:00:01Z','2026-09-10T15:00:02Z','2026-09-10T15:00:03Z'];
      let calls=0;
      const service=new TrashService(state.repository,()=>times[calls++]);
      const trashed=plain(await service.trashJob('job',1n));
      assert.equal(trashed.deletedAt,times[0]); assert.equal(trashed.updatedAt,times[1]);
      const before=await snapshot(state.root);
      await service.trashJob('job',2n);
      assert.deepEqual(await snapshot(state.root),before); assert.equal(calls,2);
      const restored=plain(await service.restoreJob('job',2n));
      assert.equal(restored.deletedAt,null); assert.equal(restored.updatedAt,times[2]);
      await service.restoreJob('job',3n); assert.equal(calls,3);
    });
    await t.test('restore rejects an active duplicate and unavailable assigned resume without changes',async()=>{
      const state=await isolated();
      await state.service.trashJob('job',1n);
      const jobs=await read(state.root,'jobs.json');
      jobs.jobs.other.url=jobs.jobs.job.url; jobs.jobs.other.normalizedUrl=jobs.jobs.job.normalizedUrl;
      await write(state.root,'jobs.json',jobs);
      await differential(state,join(fixture.root,'python-duplicate'),[{kind:'restore',revision:2}]);
      await unchanged(state,()=>state.service.restoreJob('job',2n),/active job URL already exists/);
      jobs.jobs.other.deletedAt=at; jobs.jobs.job.resumeId='resume';
      await write(state.root,'jobs.json',jobs);
      const resumes=await read(state.root,'resumes.json'); resumes.resumes.resume.deletedAt=at;
      await write(state.root,'resumes.json',resumes);
      await differential(state,join(fixture.root,'python-resume'),[{kind:'restore',revision:2}]);
      await unchanged(state,()=>state.service.restoreJob('job',2n),/assigned resume does not exist/);
    });
    await t.test('claims including expired claims block both mutations before noops',async()=>{
      const state=await isolated();
      await state.claims.select('job',1n,true);
      await state.claims.acquire('job',text('Synthetic owner'),2n);
      await differential(state,join(fixture.root,'python-claimed'),[
        {kind:'trash',revision:3},{kind:'restore',revision:3},
      ]);
      const coordinator=await read(state.root,'coordinator.json');
      coordinator.claim.expiresAt='2020-01-01T00:00:00Z';
      await write(state.root,'coordinator.json',coordinator);
      await differential(state,join(fixture.root,'python-expired'),[
        {kind:'trash',revision:3},{kind:'restore',revision:3},
      ]);
    });
    await t.test('unified listing redacts private values and counts all references in deterministic Unicode order',async()=>{
      const state=await isolated();
      await state.claims.select('job',1n,true);
      const acquired=plain(await state.claims.acquire('job',text('Synthetic owner'),2n));
      await state.claims.progress('job',text(acquired.token),fromJSON({status:'active',pendingFields:[]}));
      const answers=new AnswersService(state.repository,()=>at);
      await answers.put(fromJSON({key:'answer',question:'ßeta?',state:'confirmed',value:'PRIVATE ANSWER'}));
      const answerDoc=await read(state.root,'answers.json'); answerDoc.answers.answer.deletedAt=at;
      await write(state.root,'answers.json',answerDoc);
      const jobs=await read(state.root,'jobs.json');
      for(const job of Object.values(jobs.jobs)) {job.deletedAt=at;job.resumeId='resume';job.notes='PRIVATE NOTE';}
      jobs.jobs.job.role='ßeta'; jobs.jobs.other.role='SSeta';
      await write(state.root,'jobs.json',jobs);
      const resumes=await read(state.root,'resumes.json'); resumes.resumes.resume.deletedAt=at;
      await write(state.root,'resumes.json',resumes);
      const session=await read(state.root,'sessions/job.json'); session.answerKeys=['answer'];
      await write(state.root,'sessions/job.json',session);
      await write(state.root,'sessions/other.json',{...session,applicationId:'other',status:'completed',answerKeys:[]});
      await writeFile(join(state.root,'applications.jsonl'),JSON.stringify({schemaVersion:1,eventId:'fixture-history',applicationId:'job',event:'saved',at,answerKeys:['answer','answer']})+'\n');
      const coordinator=await read(state.root,'coordinator.json'); coordinator.claim.expiresAt='2020-01-01T00:00:00Z';
      await write(state.root,'coordinator.json',coordinator);
      await differential(state,join(fixture.root,'python-projection'),[{kind:'list'}]);
      const result=plain(await state.service.list());
      assert.deepEqual(result.counts,{job:2,resume:1,answer:1}); assert.equal(result.total,4);
      assert.deepEqual(result.items.find(item=>item.id==='job').blockerCounts,{claims:1,nonterminalSessions:1});
      assert.equal(result.items.find(item=>item.type==='resume').blockerCounts.jobReferences,2);
      assert.deepEqual(result.items.find(item=>item.type==='answer').blockerCounts,{sessions:1,history:1});
      assert.deepEqual(result.items.find(item=>item.id==='other').blockerCounts,{claims:0,nonterminalSessions:0});
      assert.doesNotMatch(JSON.stringify(result),/PRIVATE|tokenHash|managedFile|originalFilename|digest|https:|resume\.txt/);
      const response=await jobsHttp(state.jobs,state.repository,'GET','/api/trash');
      assert.equal(response.status,200); assert.deepEqual(JSON.parse(response.body),result);
    });
    await t.test('independent CLI writers serialize revision checks and results survive repository restart',async()=>{
      const state=await isolated();
      const outcomes=await Promise.allSettled(Array.from({length:4},()=>cli(fixture,state.root,'job-trash',['--id','job','--expected-revision','1'])));
      assert.equal(outcomes.filter(item=>item.status==='fulfilled').length,1);
      for(const outcome of outcomes.filter(item=>item.status==='rejected')) assert.match(outcome.reason.stderr,/revision conflict/);
      const restarted=new TrashService(new NativeJobsRepository(state.root,state.provider),()=>at);
      assert.equal(plain(await restarted.list()).total,1);
      const restored=await cli(fixture,state.root,'job-restore',['--id','job','--expected-revision','2']);
      assert.equal(restored.revision,3); assert.equal(restored.deletedAt,null);
      assert.equal((await cli(fixture,state.root,'trash-list')).total,0);
    });
    await t.test('atomic write, sync and replace failures retain bytes and release the lock',async()=>{
      const state=await isolated();
      for(const stage of ['write','sync','replace']) {
        const repository=new NativeJobsRepository(state.root,state.provider,async(path,value,options)=>{
          const io=createNativePointAtomicWriteIO(options.pathProfile);
          if(stage==='replace') io.replace=async()=>{throw Error('injected trash fault');};
          else {
            const original=io.createTemporary;
            io.createTemporary=async(...args)=>{const handle=await original(...args);handle[stage]=async()=>{throw Error('injected trash fault');};return handle;};
          }
          await atomicWritePointJson(path,value,options,io);
        });
        await unchanged(state,()=>new TrashService(repository,()=>at).trashJob('job',1n),/injected trash fault/);
        assert.equal((await readdir(state.root)).some(name=>name.endsWith('.tmp')),false);
      }
      assert.equal(plain(await state.service.trashJob('job',1n)).revision,2);
    });
    await t.test('HTTP revision bodies are closed and errors retain established envelopes',async()=>{
      const state=await isolated();
      for(const body of ['{}','{"expectedRevision":true}','{"expectedRevision":1.0}','{"expectedRevision":0}','{"expectedRevision":1,"private":"secret"}']) {
        const before=await snapshot(state.root);
        const result=await jobsHttp(state.jobs,state.repository,'POST','/api/jobs/job/trash',body);
        assert.equal(result.status,400); assert.equal(JSON.parse(result.body).error.code,'request_error');
        assert.deepEqual(await snapshot(state.root),before);
      }
      const missing=await jobsHttp(state.jobs,state.repository,'POST','/api/jobs/missing/trash','{"expectedRevision":1}');
      assert.equal(missing.status,404); assert.equal(JSON.parse(missing.body).error.code,'not_found');
      const success=await jobsHttp(state.jobs,state.repository,'POST','/api/jobs/job/trash','{"expectedRevision":1}');
      assert.equal(success.status,200); assert.equal(JSON.parse(success.body).revision,2);
      const stale=await jobsHttp(state.jobs,state.repository,'POST','/api/jobs/job/restore','{"expectedRevision":1}');
      assert.equal(stale.status,409); assert.equal(JSON.parse(stale.body).error.code,'revision_conflict');
      for(const path of ['/api/resumes/resume/trash']) {
        assert.equal((await jobsHttp(state.jobs,state.repository,'POST',path,'{"expectedRevision":2}')).status,501);
      }
    });
    await t.test('unsupported fixture state fails closed without altering jobs',async()=>{
      const state=await isolated(), before=await readFile(join(state.root,'jobs.json'));
      await writeFile(join(state.root,'pending-journal.json'),'{}');
      await assert.rejects(state.service.list(),/unsupported state/);
      await assert.rejects(state.service.trashJob('job',1n),/unsupported state/);
      assert.deepEqual(await readFile(join(state.root,'jobs.json')),before);
    });
  } finally {await fixture.cleanup();}
});
