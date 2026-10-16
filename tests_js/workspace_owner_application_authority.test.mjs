import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFixture} from './exclusive_file_lock_support.mjs';
import {setup,host,event,acquire,read} from './workspace_durable_claims_support.mjs';
import {ApplicationAuthorityService} from '../runtime/workspace-core/application-authority.js';
import {fromJSON,serialize} from '../runtime/contracts/workspace/values.js';
import {ownerReviewFixture,reviewSession} from './workspace_owner_review_support.mjs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
const plain=v=>JSON.parse(serialize(v));
const grant={mode:'autofill_to_review',runId:'run-fixture',jobIds:['job'],sensitiveAnswerRefs:[],durationMinutes:120};
const evaluation={destinationUrl:'https://example.invalid/application',operations:['fill_canonical_profile','upload_managed_resume'],
  answerRefs:[],sensitiveAnswerRefs:[],includesDemographics:false,
  interrupts:{missingOrUncertainData:false,captcha:false,mfa:false,emailVerification:false,providerLegalConsent:false,
    unsupportedControls:false,unexpectedDestination:false,ambiguity:false,finalAction:false}};

test('owner durable approval survives pause and reconstructed broker, with no replayed authority',async t=>{
  const fixture=await nativeFixture();t.after(()=>fixture.cleanup());
  const state=await setup(fixture,'owner-approval'),first=host(state).workflow;
  t.after(()=>first.close());const task=await acquire(state,first);
  const authority=new ApplicationAuthorityService(state.repository,()=>state.clock.now);
  await authority.set(fromJSON(grant),0n);
  assert.equal((await first.evaluateApplicationAuthority(evaluation,authority)).authorized,true);
  for(const changes of [{includesDemographics:true},{interrupts:{...evaluation.interrupts,finalAction:true}},
    {destinationUrl:'https://foreign.invalid/application'},{sensitiveAnswerRefs:['unapproved']}]) {
    assert.equal((await first.evaluateApplicationAuthority({...evaluation,...changes},authority)).authorized,false);
  }
  for (const key of Object.keys(evaluation.interrupts)) {
    assert.equal((await first.evaluateApplicationAuthority({...evaluation,interrupts:{...evaluation.interrupts,[key]:true}},authority)).authorized,false);
  }
  await assert.rejects(first.evaluateApplicationAuthority({...evaluation,claimToken:'injected'},authority));
  await first.execute(event('handoff',task));await first.close();
  assert.equal(plain(await authority.status()).mode,'autofill_to_review');
  const resumed=host(state).workflow;t.after(()=>resumed.close());
  const reloaded=new ApplicationAuthorityService(state.repository,()=>state.clock.now);
  await assert.rejects(resumed.evaluateApplicationAuthority(evaluation,reloaded),/broker_unavailable/);
  await state.claims.select('job',4n,true);
  const request=event('acquire',null,{operationId:'resume-approved-job',jobRevision:'5'});
  await resumed.execute(request,request);
  assert.equal((await resumed.evaluateApplicationAuthority(evaluation,reloaded)).authorized,true);
  await reloaded.revoke(1n);
  assert.equal((await resumed.evaluateApplicationAuthority(evaluation,reloaded)).authorized,false);
  await reloaded.set(fromJSON({...grant,durationMinutes:1}),2n);
  state.clock.now='2026-09-10T12:01:01Z';
  assert.equal((await resumed.evaluateApplicationAuthority(evaluation,reloaded)).reasonCode,'authority_expired');
  assert.doesNotMatch(JSON.stringify(await read(state.root,'application-authority.json')),/claimToken|tokenHash|PRIVATE/);
});

test('installed owner evaluator uses private claim and consumes grant only at verified review', {timeout:90000},async t=>{
  const f=await ownerReviewFixture();t.after(()=>f.cleanup());
  const input=join(f.directory,'grant.json');await writeFile(input,JSON.stringify(grant),{mode:0o600});
  await promisify(execFile)(process.execPath,[join(f.plugin,'apps/companion/command.mjs'),'store','--root',f.root,
    'application-authority-set','--expected-revision','0','--input',input],{env:{PATH:'',HOME:f.directory}});
  await rm(input);
  const context=await f.context();
  assert.equal(context.result.applicationAuthority.status.mode,'autofill_to_review');
  assert.equal(context.result.applicationAuthority.demographics,'leave_blank');
  const allowed=await f.send(evaluation,'authority-evaluate');
  assert.equal(allowed.ok,true);assert.equal(allowed.result.decision.authorized,true);
  assert.equal((await f.send({...evaluation,jobId:'other'},'authority-evaluate')).ok,false);
  const denied=await f.send({...evaluation,includesDemographics:true},'authority-evaluate');
  assert.equal(denied.result.decision.reasonCode,'demographics_leave_blank');
  const final=await f.send({...evaluation,interrupts:{...evaluation.interrupts,finalAction:true}},'authority-evaluate');
  assert.equal(final.result.decision.authorized,false);
  const report=context.result.hostBrowser.reports.find(r=>r.input.outcome==='awaiting_review').input;
  assert.equal((await f.send({...report,operationId:'approved-review',session:reviewSession(report.jobRevision)})).ok,true);
  await f.waitForExit();
  const persisted=await f.read('application-authority.json');
  assert.equal(persisted.activeAuthorityId,null);
  assert.equal(Object.values(persisted.authorities)[0].status,'consumed');
});
