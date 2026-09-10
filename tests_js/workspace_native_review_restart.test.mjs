import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, snapshot, readyPacket, cli } from './workspace_native_claims_support.mjs';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

async function reviewed(fixture,name) {
  const state=await setup(fixture,name);
  await state.claims.select('job',1n,true);
  const acquired=plain(await state.claims.acquire('job',text('First owner'),2n));
  await state.claims.handoff('job',text(acquired.token),'awaiting_review',fromJSON({status:'review',readinessInput:readyPacket(3)}),3n);
  return {...state,oldToken:acquired.token};
}
async function denied(state,operation,pattern) {
  const before=await snapshot(state.root);
  await assert.rejects(async()=>operation(),pattern);
  assert.deepEqual(await snapshot(state.root),before);
}

test('reviewed restart requires owner confirmation and preserves evidence for a fresh attempt',{timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const state=await reviewed(fixture,'restart'),{root,claims,oldToken}=state;
    await denied(state,()=>claims.restart('job',text('Owner'),4n,false),/explicit owner confirmation/);
    await denied(state,()=>claims.restart('job',text('Owner'),3n,true),/revision conflict/);
    await denied(state,()=>claims.restart('job',text(' '),4n,true),/owner label/);
    await denied(state,()=>claims.restart('job',text('Owner'),0n,true),/revision is invalid/);
    const evidence=await readFile(join(root,'sessions/job.json'),'utf8');
    const result=plain(await claims.restart('job',text(' New owner '),4n,true));
    assert.equal(result.job.status,'in_progress');assert.equal(result.job.revision,5);
    assert.equal(result.claim.ownerLabel,'New owner');assert.notEqual(result.token,oldToken);
    assert.equal(await readFile(result.resume.path,'utf8'),'PRIVATE-RESUME');
    assert.equal(await readFile(join(root,'sessions/job.json'),'utf8'),evidence);
    assert.doesNotMatch(JSON.stringify(plain(await claims.status())),/token/i);
    await denied(state,()=>claims.heartbeat('job',text(oldToken)),/token is invalid/);
    await denied(state,()=>claims.handoff('job',text(result.token),'awaiting_review',fromJSON({status:'review'}),5n),/fresh current live/);
    await claims.handoff('job',text(result.token),'awaiting_review',fromJSON({status:'review',readinessInput:readyPacket(5)}),5n);
    assert.equal(plain(await claims.restart('job',text('Again'),6n,true)).job.revision,7);
    const history=await readFile(join(root,'applications.jsonl'),'utf8');
    assert.deepEqual(history.trim().split('\n').map(line=>JSON.parse(line).event),['job-started','reviewed','job-restarted','reviewed','job-restarted']);
    assert.ok(!history.includes(result.token));
  } finally {await fixture.cleanup();}
});

test('restart preflight and claim arbitration reject without modifying canonical bytes',{timeout:60000},async t=>{
  const fixture=await nativeFixture();
  try {
    await t.test('current managed resume required',async()=>{
      const state=await reviewed(fixture,'resume');
      const resumes=await read(state.root,'resumes.json');
      await unlink(join(state.root,'resume-files',resumes.resumes.resume.managedFile));
      await denied(state,()=>state.claims.restart('job',text('Owner'),4n,true),/current managed resume/);
    });
    await t.test('one concurrent restart wins and expiry requires explicit recovery',async()=>{
      const state=await reviewed(fixture,'race');
      const results=await Promise.allSettled([state.claims.restart('job',text('One'),4n,true),state.claims.restart('job',text('Two'),4n,true)]);
      assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      assert.match(results.find(result=>result.status==='rejected').reason.message,/live job claim/);
      state.clock.now='2026-09-10T12:05:00Z';
      await denied(state,()=>state.claims.restart('job',text('Three'),5n,true),/expired claim requires explicit same-job recovery/);
    });
    await t.test('missing prior evidence',async()=>{
      const state=await reviewed(fixture,'missing');await unlink(join(state.root,'sessions/job.json'));
      await denied(state,()=>state.claims.restart('job',text('Owner'),4n,true),/prior review evidence/);
    });
  } finally {await fixture.cleanup();}
});

test('restart HTTP and Python-free CLI enforce confirmation and share canonical state',{timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const state=await reviewed(fixture,'http'),{root,repository,jobs}=state;
    const http=body=>jobsHttp(jobs,repository,'POST','/api/claims/review-restart',JSON.stringify(body));
    const body={jobId:'job',ownerLabel:'HTTP owner',expectedRevision:4,ownerConfirmedNotSubmitted:false};
    const before=await snapshot(root);
    assert.equal((await http(body)).status,400);
    assert.deepEqual(await snapshot(root),before);
    assert.equal((await http({...body,ownerConfirmedNotSubmitted:true,expectedRevision:3})).status,409);
    const result=await http({...body,ownerConfirmedNotSubmitted:true});assert.equal(result.status,200);
    const acquired=JSON.parse(result.body);assert.equal(acquired.job.revision,5);
    await cli(fixture,root,'claim-handoff',['--id','job','--token',acquired.token,'--status','awaiting_review','--expected-revision','5'],{status:'review',readinessInput:readyPacket(5)});
    const cliBefore=await snapshot(root);
    await assert.rejects(()=>cli(fixture,root,'job-review-restart',['--id','job','--owner','CLI owner','--expected-revision','6']),/explicit owner confirmation/);
    assert.deepEqual(await snapshot(root),cliBefore);
    const restarted=await cli(fixture,root,'job-review-restart',['--id','job','--owner','CLI owner','--expected-revision','6','--owner-confirmed-not-submitted']);
    assert.equal(restarted.job.revision,7);assert.equal(restarted.claim.ownerLabel,'CLI owner');
  } finally {await fixture.cleanup();}
});
