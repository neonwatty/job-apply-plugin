import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, write, snapshot, readyPacket, cli } from './workspace_native_claims_support.mjs';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { AnswersService } from '../runtime/workspace-core/answers.js';
import { AnswerMergeService } from '../runtime/workspace-core/answer-merges.js';
import { PendingAnswersService } from '../runtime/workspace-core/pending-answers.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

async function acquire(state,id='job') {
  const selected=plain(await state.claims.select(id,1n,true));
  assert.equal(selected.job.revision,2);
  return plain(await state.claims.acquire(id,text('Synthetic owner'),2n));
}
async function unchangedFailure(root,operation,pattern) {
  const before=await snapshot(root);
  await assert.rejects(async()=>operation(),pattern);
  assert.deepEqual(await snapshot(root),before);
}

test('native active claims persist complete lifecycle, exact expiry and safe recovery', {timeout:60000}, async t=>{
  const fixture=await nativeFixture();
  try {
    await t.test('select, acquire, heartbeat, progress, both handoffs, and reopen',async()=>{
      const state=await setup(fixture,'lifecycle'), {root,claims,jobs,clock,provider}=state;
      await unchangedFailure(root,()=>claims.select('job',1n,false),/owner confirmation/);
      const first=await acquire(state), token=text(first.token);
      assert.equal(first.job.status,'in_progress');assert.equal(first.job.revision,3);
      assert.equal(await readFile(first.resume.path,'utf8'),'PRIVATE-RESUME');
      const reopened=new ClaimsService(new NativeJobsRepository(root,provider),()=>clock.now);
      const before=await snapshot(root), publicStatus=plain(await reopened.status());
      assert.equal(publicStatus.claim.jobId,'job');assert.equal(publicStatus.claim.expired,false);
      assert.equal(publicStatus.leaseSeconds,300);assert.equal(publicStatus.heartbeatSeconds,60);
      assert.doesNotMatch(JSON.stringify(publicStatus),/token|PRIVATE-/i);
      assert.deepEqual(await snapshot(root),before);
      await unchangedFailure(root,()=>claims.heartbeat('job',text('wrong')),/token is invalid/);
      await unchangedFailure(root,()=>claims.heartbeat('other',token),/not held/);
      await unchangedFailure(root,()=>jobs.update('job',fromJSON({notes:'blocked'}),3n),/coordinator operation/);
      const other=plain(await jobs.update('other',fromJSON({notes:'allowed'}),1n));assert.equal(other.revision,2);
      clock.now='2026-09-10T12:01:00Z';
      assert.equal(plain(await claims.heartbeat('job',token)).claim.expiresAt,'2026-09-10T12:06:00Z');
      const pending={status:'active',company:'EPHEMERAL',pendingFields:[{question:'PRIVATE QUESTION',state:'missing'}]};
      const session=plain(await claims.progress('job',token,fromJSON(pending)));
      assert.equal(session.attemptRevision,3);assert.equal(session.pendingFields.length,1);
      assert.doesNotMatch(JSON.stringify(session),/EPHEMERAL|PRIVATE QUESTION/);
      const blocked=plain(await claims.handoff('job',token,'needs_info',fromJSON(pending),3n));
      assert.equal(blocked.job.revision,4);assert.equal(blocked.claim,null);
      assert.equal(plain(await claims.status()).claim,null);
      await unchangedFailure(root,()=>claims.heartbeat('job',token),/not held/);
      const selected=plain(await claims.select('job',4n,true));assert.equal(selected.job.revision,5);
      const second=plain(await claims.acquire('job',text('Second owner'),5n));
      assert.notEqual(second.token,first.token);assert.equal(second.job.revision,6);
      await unchangedFailure(root,()=>claims.handoff('job',text(second.token),'awaiting_review',fromJSON({status:'review'}),6n),/fresh current live/);
      const review={status:'review',readinessInput:readyPacket(6)};
      const replay=structuredClone(review);replay.readinessInput.evidenceKind='repository_replay';
      await unchangedFailure(root,()=>claims.handoff('job',text(second.token),'awaiting_review',fromJSON(replay),6n),/agent-attested readiness/);
      const completed=plain(await claims.handoff('job',text(second.token),'awaiting_review',fromJSON(review),6n));
      assert.equal(completed.job.revision,7);assert.equal(completed.job.status,'awaiting_review');
      assert.equal((await read(root,'coordinator-journal.json')).operation,null);
      const history=await readFile(join(root,'applications.jsonl'),'utf8');
      assert.deepEqual(history.trim().split('\n').map(line=>JSON.parse(line).event),['job-started','job-blocked','job-started','reviewed']);
      for(const secret of [first.token,second.token,'tokenHash','PRIVATE QUESTION']) assert.ok(!history.includes(secret));
      assert.equal(plain(await reopened.status()).claim,null);
    });
    await t.test('exact expiry prevents reuse until explicit same-job recovery rotates bearer',async()=>{
      const state=await setup(fixture,'expiry'), {root,claims,clock}=state;
      const first=await acquire(state), token=text(first.token);
      clock.now='2026-09-10T12:04:59.999999Z';assert.equal(plain(await claims.status()).claim.expired,false);
      await unchangedFailure(root,()=>claims.recover('job',text('Recovery owner')),/live claim/);
      clock.now='2026-09-10T12:05:00Z';assert.equal(plain(await claims.status()).claim.expired,true);
      await unchangedFailure(root,()=>claims.heartbeat('job',token),/expired/);
      await unchangedFailure(root,()=>claims.acquire('other',text('Owner'),1n),/expired claim requires/);
      await unchangedFailure(root,()=>claims.recover('other',text('Owner')),/expired claimed job/);
      const jobsBefore=await readFile(join(root,'jobs.json'),'utf8');
      const recovered=plain(await claims.recover('job',text('Recovery owner')));
      assert.notEqual(recovered.token,first.token);assert.equal(recovered.job.revision,3);
      assert.equal(await readFile(join(root,'jobs.json'),'utf8'),jobsBefore);
      await unchangedFailure(root,()=>claims.heartbeat('job',token),/token is invalid/);
      assert.equal(plain(await claims.heartbeat('job',text(recovered.token))).claim.expired,false);
      const history=await readFile(join(root,'applications.jsonl'),'utf8');
      assert.ok(history.includes('claim-recovered'));assert.ok(!history.includes(recovered.token));
      const raw=await read(root,'coordinator.json');assert.ok(raw.claim.tokenHash);assert.ok(!JSON.stringify(raw).includes(recovered.token));
    });
    await t.test('concurrent acquisition has one winner and answer workflows cannot clear its claim',async()=>{
      const state=await setup(fixture,'race'),{root,claims,repository}=state;
      await claims.select('job',1n,true);await claims.select('other',1n,true);
      const results=await Promise.allSettled([claims.acquire('job',text('One'),2n),claims.acquire('other',text('Two'),2n)]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.match(results.find(result=>result.status==='rejected').reason.message,/live job claim/);
      const winner=plain(results.find(result=>result.status==='fulfilled').value);
      const answers=new AnswersService(repository);
      for(const [key,question] of [['a','Preferred city?'],['b','Preferred location?']]) await answers.put(fromJSON({key,question,state:'confirmed',value:'PRIVATE'}));
      await unchangedFailure(root,()=>new AnswerMergeService(repository).merge('a','b',1n,1n),/idle coordinator/);
      const otherId=winner.job.id==='job'?'other':'job';
      const jobs=await read(root,'jobs.json');jobs.jobs[otherId].status='needs_info';await write(root,'jobs.json',jobs);
      await write(root,`sessions/${otherId}.json`,{schemaVersion:1,applicationId:otherId,status:'active',pendingFields:[{reference:`pending_${'a'.repeat(32)}`,answerKey:'a',state:'missing'}],blockers:[],answerKeys:[]});
      const pending=new PendingAnswersService(repository), group=plain(await pending.list()).jobs[0];
      await unchangedFailure(root,()=>pending.resolve(otherId,group.pendingInformation[0].reference,BigInt(group.jobRevision),BigInt(group.sessionRevision),1n,true),/idle coordinator/);
      assert.equal(plain(await claims.status()).claim.jobId,winner.job.id);
    });
    await t.test('HTTP and CLI share persisted claims with Python absent from PATH',async()=>{
      const state=await setup(fixture,'transports'),{root,repository,jobs}=state;
      const http=async(action,body)=>jobsHttp(jobs,repository,body===undefined?'GET':'POST',`/api/claims${action?'/'+action:''}`,body===undefined?'':JSON.stringify(body));
      const selected=await cli(fixture,root,'task-select',['--id','job','--expected-revision','1','--owner-confirmed']);assert.equal(selected.job.status,'ready');
      const acquired=await http('acquire',{jobId:'job',ownerLabel:'Transport owner',expectedRevision:2});assert.equal(acquired.status,200);
      const result=JSON.parse(acquired.body);
      const status=await cli(fixture,root,'claim-status');assert.equal(status.claim.jobId,'job');assert.doesNotMatch(JSON.stringify(status),/token/i);
      const beat=await cli(fixture,root,'claim-heartbeat',['--id','job','--token',result.token]);assert.equal(beat.claim.expired,false);
      const denied=await http('heartbeat',{jobId:'job',token:'wrong'});assert.equal(denied.status,400);assert.doesNotMatch(denied.body,new RegExp(result.token));
      const bad=await http('select',{jobId:'other',expectedRevision:1,ownerConfirmed:true,extra:1});assert.equal(bad.status,400);
      const progress=await http('progress',{jobId:'job',token:result.token,session:{status:'active',step:'questions'}});assert.equal(progress.status,200);
      const completed=await cli(fixture,root,'claim-handoff',['--id','job','--token',result.token,'--status','needs_info','--expected-revision','3'],{status:'active'});
      assert.equal(completed.job.status,'needs_info');assert.equal(completed.claim,null);
      assert.equal(JSON.parse((await http('')).body).claim,null);
    });
  } finally { await fixture.cleanup(); }
});
