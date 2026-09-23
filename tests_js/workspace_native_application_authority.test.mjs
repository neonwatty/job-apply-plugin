import assert from 'node:assert/strict';
import test from 'node:test';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, plain, read, write, snapshot, readyPacket, cli } from './workspace_native_claims_support.mjs';
import { ApplicationAuthorityService } from '../runtime/workspace-core/application-authority.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { JobsService } from '../runtime/workspace-core/jobs.js';
import { ProfileService } from '../runtime/workspace-core/profile.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';

const interrupts = overrides => ({missingOrUncertainData:false,captcha:false,mfa:false,emailVerification:false,
  providerLegalConsent:false,unsupportedControls:false,unexpectedDestination:false,ambiguity:false,finalAction:false,...overrides});
const authorityInput = (mode='autofill_to_review',ids=['job']) => ({mode,runId:'run-fixture',jobIds:ids,
  sensitiveAnswerRefs:[],durationMinutes:120});
const evaluation = (token,overrides={}) => ({jobId:'job',claimToken:token,destinationUrl:'https://example.invalid/application/page-2',
  operations:['fill_canonical_profile','upload_managed_resume','navigate_non_final'],answerRefs:[],sensitiveAnswerRefs:[],
  interrupts:interrupts(),...overrides});

test('native application authority is revisioned, claim-bound, redacted, and final-action safe', {timeout:60000}, async t => {
  const fixture=await nativeFixture(); t.after(()=>fixture.cleanup());
  const state=await setup(fixture,'application-authority'), service=new ApplicationAuthorityService(state.repository,()=>state.clock.now);

  await t.test('missing document is Guided without a write',async()=>{
    const before=await snapshot(state.root),status=plain(await service.status());
    assert.deepEqual(status,{mode:'guided',status:'active',authorizationId:null,expiresAt:null,runId:null,jobIds:[],sensitiveAnswerRefs:[],revision:0});
    assert.deepEqual(await snapshot(state.root),before);
    await assert.rejects(access(join(state.root,'application-authority.json')),{code:'ENOENT'});
  });

  await t.test('legacy Python authority is fail-closed to Guided and replaced only on approval',async()=>{
    const other=await setup(fixture,'application-authority-legacy');
    await write(other.root,'application-authority.json',{schemaVersion:1,activeAuthorityId:'application-authority-00000000-0000-4000-8000-000000000001',
      authorities:{'application-authority-00000000-0000-4000-8000-000000000001':{
        authorizationId:'application-authority-00000000-0000-4000-8000-000000000001',mode:'fill_to_review',status:'active',revision:1,
        issuedAt:'2026-09-10T10:00:00Z',expiresAt:'2026-09-10T14:00:00Z',revokedAt:null,
        jobBindings:[{jobId:'job',approvedJobRevision:1,destinationOrigin:'https://example.invalid',resumeId:'resume',resumeRevision:1}],
        workerIds:['legacy-worker'],sensitiveFieldClasses:[]}},
      metadata:{revision:4,createdAt:'2026-09-10T10:00:00Z',updatedAt:'2026-09-10T10:00:00Z'}});
    const authority=new ApplicationAuthorityService(other.repository,()=>other.clock.now);
    assert.deepEqual(plain(await authority.status()),{mode:'guided',status:'active',authorizationId:null,expiresAt:null,
      runId:null,jobIds:[],sensitiveAnswerRefs:[],revision:4});
    const legacy=await read(other.root,'application-authority.json');assert.equal(legacy.authorities[legacy.activeAuthorityId].mode,'fill_to_review');
    await other.claims.select('job',1n,true);
    const active=plain(await authority.set(fromJSON(authorityInput()),4n));assert.equal(active.mode,'autofill_to_review');assert.equal(active.revision,5);
    assert.equal(JSON.stringify(await read(other.root,'application-authority.json')).includes('workerIds'),false);
  });

  let token;
  await t.test('one exact Ready job authorizes only its live claim and destination',async()=>{
    await state.claims.select('job',1n,true);
    const active=plain(await service.set(fromJSON(authorityInput()),0n));
    assert.equal(active.mode,'autofill_to_review');assert.equal(active.revision,1);assert.deepEqual(active.jobIds,['job']);
    assert.doesNotMatch(JSON.stringify(await read(state.root,'application-authority.json')),/PRIVATE-|claimToken|tokenHash/);
    const acquired=plain(await state.claims.acquire('job',text('Authority worker'),2n));token=acquired.token;
    const allowed=plain(await service.evaluate(fromJSON(evaluation(token))));
    assert.equal(allowed.authorized,true);assert.equal(allowed.mode,'autofill_to_review');
    const wrongClaim=plain(await service.evaluate(fromJSON(evaluation('wrong'))));
    assert.deepEqual({authorized:wrongClaim.authorized,reasonCode:wrongClaim.reasonCode},{authorized:false,reasonCode:'claim_missing_or_expired'});
    const wrongOrigin=plain(await service.evaluate(fromJSON(evaluation(token,{destinationUrl:'https://other.invalid/application'}))));
    assert.equal(wrongOrigin.reasonCode,'unexpected_destination');
  });

  await t.test('every final action interrupts before authority use and revocation restores Guided',async()=>{
    const before=await readFile(join(state.root,'application-authority.json'),'utf8');
    const denied=plain(await service.evaluate(fromJSON(evaluation(token,{interrupts:interrupts({finalAction:true})}))));
    assert.deepEqual(denied,{authorized:false,mode:'guided',reasonCode:'final_action_manual',interrupt:true});
    assert.equal(await readFile(join(state.root,'application-authority.json'),'utf8'),before);
    const guided=plain(await service.revoke(1n));assert.equal(guided.mode,'guided');assert.equal(guided.revision,2);
    await assert.rejects(()=>service.revoke(1n),/revision conflict/);
  });

  await t.test('canonical profile changes invalidate previously granted authority',async()=>{
    const other=await setup(fixture,'application-authority-profile-revision');
    const authority=new ApplicationAuthorityService(other.repository,()=>other.clock.now);
    await other.claims.select('job',1n,true);await authority.set(fromJSON(authorityInput()),0n);
    const acquired=plain(await other.claims.acquire('job',text('Profile revision worker'),2n));
    await new ProfileService(other.repository,()=>other.clock.now).patch(fromJSON({name:'Updated owner'}),1n,'user');
    const status=plain(await authority.status());assert.equal(status.mode,'guided');assert.equal(status.status,'stale');
    const denied=plain(await authority.evaluate(fromJSON(evaluation(acquired.token))));
    assert.deepEqual({authorized:denied.authorized,reasonCode:denied.reasonCode},{authorized:false,reasonCode:'canonical_data_changed'});
  });

  await t.test('Autofill to Review is consumed in the durable review handoff journal',async()=>{
    const other=await setup(fixture,'application-authority-consumption');
    const authority=new ApplicationAuthorityService(other.repository,()=>other.clock.now);
    await other.claims.select('job',1n,true);await authority.set(fromJSON(authorityInput()),0n);
    const acquired=plain(await other.claims.acquire('job',text('Review worker'),2n));
    const review={status:'review',readinessInput:readyPacket(3)};
    const handed=plain(await other.claims.handoff('job',text(acquired.token),'awaiting_review',fromJSON(review),3n));
    assert.equal(handed.job.status,'awaiting_review');
    const status=plain(await authority.status());assert.equal(status.mode,'guided');assert.equal(status.revision,2);
    const stored=await read(other.root,'application-authority.json');
    assert.equal(stored.authorities[stored.activeAuthorityId]?.status,undefined);
    assert.equal(Object.values(stored.authorities)[0].status,'consumed');
    assert.equal((await read(other.root,'coordinator-journal.json')).operation,null);
  });

  await t.test('Campaign to Review exposes deterministic sequential progress and stop controls',async()=>{
    const other=await setup(fixture,'application-authority-campaign');
    const authority=new ApplicationAuthorityService(other.repository,()=>other.clock.now);
    await other.claims.select('job',1n,true);await other.claims.select('other',1n,true);
    const active=plain(await authority.set(fromJSON(authorityInput('campaign_to_review',['other','job'])),0n));
    assert.equal(active.mode,'campaign_to_review');assert.deepEqual(active.jobIds,['job','other']);
    let progress=plain(await authority.progress());assert.equal(progress.counts.ready,2);assert.equal(progress.nextJob.jobId,'job');
    const paused=plain(await authority.control('pause',1n));assert.equal(paused.status,'paused');assert.equal(paused.revision,2);
    await assert.rejects(()=>authority.control('pause',2n),/current state/);
    const resumed=plain(await authority.control('resume',2n));assert.equal(resumed.status,'active');assert.equal(resumed.revision,3);
    const acquired=plain(await other.claims.acquire('job',text('Campaign worker'),2n));
    progress=plain(await authority.progress());assert.equal(progress.counts.inProgress,1);assert.equal(progress.nextJob.jobId,'other');
    const decision=plain(await authority.evaluate(fromJSON(evaluation(acquired.token))));assert.equal(decision.authorized,true);
    const stopped=plain(await authority.control('stop',3n));assert.equal(stopped.mode,'guided');assert.equal(stopped.revision,4);
    assert.equal(plain(await authority.progress()).nextJob,null);
  });

  await t.test('campaign progress fails closed when its application run changes or completes',async()=>{
    const updated=await setup(fixture,'application-authority-run-update');
    const updatedAuthority=new ApplicationAuthorityService(updated.repository,()=>updated.clock.now);
    await updated.claims.select('job',1n,true);await updated.claims.select('other',1n,true);
    await updatedAuthority.set(fromJSON(authorityInput('campaign_to_review',['job','other'])),0n);
    const runs=new ApplicationRunsService(updated.repository,()=>updated.clock.now);
    await runs.update('run-fixture',1n,fromJSON({jobIds:['other']}));
    const stale=plain(await updatedAuthority.progress());
    assert.equal(stale.mode,'guided');assert.equal(stale.status,'stale');assert.deepEqual(stale.jobs,[]);assert.equal(stale.nextJob,null);

    const completed=await setup(fixture,'application-authority-run-complete');
    const completedAuthority=new ApplicationAuthorityService(completed.repository,()=>completed.clock.now);
    await completed.claims.select('job',1n,true);await completedAuthority.set(fromJSON(authorityInput('campaign_to_review',['job'])),0n);
    await new ApplicationRunsService(completed.repository,()=>completed.clock.now).complete('run-fixture',1n);
    const ended=plain(await completedAuthority.progress());
    assert.equal(ended.mode,'guided');assert.equal(ended.status,'stale');assert.deepEqual(ended.jobs,[]);assert.equal(ended.nextJob,null);
  });

  await t.test('expired authority exposes no runnable campaign queue',async()=>{
    const other=await setup(fixture,'application-authority-expired');
    const authority=new ApplicationAuthorityService(other.repository,()=>other.clock.now);
    await other.claims.select('job',1n,true);await authority.set(fromJSON(authorityInput('campaign_to_review',['job'])),0n);
    other.clock.now='2026-09-11T12:00:01Z';
    const progress=plain(await authority.progress());assert.equal(progress.mode,'guided');assert.equal(progress.status,'expired');
    assert.deepEqual(progress.jobs,[]);assert.equal(progress.nextJob,null);assert.equal(progress.counts.ready,0);
  });

  await t.test('HTTP and CLI expose the same optimistic concurrency contract',async()=>{
    const other=await setup(fixture,'application-authority-transports');
    await other.claims.select('job',1n,true);
    const jobs=new JobsService(other.repository,()=>other.clock.now);
    const call=(method,path,payload)=>jobsHttp(jobs,other.repository,method,path,payload===undefined?'':JSON.stringify(payload));
    const projection=JSON.parse((await call('GET','/api/automation')).body);
    assert.equal(projection.applicationAuthority.mode,'guided');
    const set=await call('POST','/api/application-authority',{authority:authorityInput(),expectedRevision:0});
    assert.equal(set.status,200,set.body);assert.equal(JSON.parse(set.body).revision,1);
    const conflict=await call('POST','/api/application-authority',{authority:authorityInput(),expectedRevision:0});
    assert.equal(conflict.status,409);
    const status=await cli(fixture,other.root,'application-authority-status');assert.equal(status.mode,'autofill_to_review');
    const revoked=await cli(fixture,other.root,'application-authority-revoke',['--expected-revision','1']);
    assert.equal(revoked.mode,'guided');assert.equal(revoked.revision,2);
  });
});
