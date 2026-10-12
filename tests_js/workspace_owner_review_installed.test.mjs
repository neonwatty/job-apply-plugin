import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerReviewFixture,reviewSession} from './workspace_owner_review_support.mjs';

test('installed owner review rejects incomplete evidence then commits durable manual handoff and exact replay', {timeout:90000},async t=>{
  const fixture=await ownerReviewFixture();t.after(fixture.cleanup);
  assert.equal((await fixture.guard()).ok,true);
  const context=await fixture.context();
  const descriptor=context.result.hostBrowser.reports.find(r=>r.input.outcome==='awaiting_review');
  assert.ok(descriptor);assert.deepEqual(descriptor.requiredFields,['operationId','session']);
  const base={...descriptor.input,operationId:'owner-review',session:reviewSession(descriptor.input.jobRevision)};
  const before=await fixture.snapshot();
  const invalid=[
    {...base,operationId:'missing-upload',session:reviewSession(base.jobRevision,i=>{
      i.verifiedStates=i.verifiedStates.filter(c=>c.id!=='resume.file');})},
    {...base,operationId:'rejected-upload',session:reviewSession(base.jobRevision,i=>{
      i.verifiedStates.find(c=>c.id==='resume.file').state='rejected';})},
    {...base,operationId:'incomplete-control',session:reviewSession(base.jobRevision,i=>{
      i.verifiedStates=i.verifiedStates.filter(c=>c.id!=='work.preference');})},
    {...base,operationId:'final-activated',session:reviewSession(base.jobRevision,i=>{i.finalControlState='activated';})},
    {...base,operationId:'stale-attempt',session:reviewSession('1')},
    {...base,operationId:'stale-task',expectedRevision:'999'},
    {...base,operationId:'wrong-job',jobId:'other'},
    {...base,operationId:'saved-shortcut',savedSessionFingerprint:'a'.repeat(64)},
  ];
  for(const input of invalid){
    assert.equal((await fixture.send(input)).ok,false,input.operationId);
    assert.deepEqual(await fixture.snapshot(),before,input.operationId);
  }
  const result=await fixture.send(base);
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.equal(result.result.receipt.outcome,'awaiting_review');
  assert.equal(result.result.receipt.task.status,'finished');
  assert.deepEqual(await fixture.waitForExit(),{code:0,signal:null});
  const after=await fixture.snapshot(),job=(await fixture.read('jobs.json')).jobs.job;
  assert.equal(job.status,'awaiting_review');
  assert.equal((await fixture.read('coordinator.json')).claim,null);
  const session=await fixture.read('sessions/job.json');
  assert.equal(session.status,'review');assert.equal(session.readiness.status,'ready');
  assert.deepEqual(session.readiness.optionalUnansweredControlIds,['portfolio.url']);
  assert.equal(session.browserHandoff.state,'ready_for_owner');
  for(const file of ['profile.json','resumes.json','resume-facts.json'])assert.equal(after[file],before[file],file);
  assert.deepEqual(JSON.parse(after['jobs.json']).jobs.other,JSON.parse(before['jobs.json']).jobs.other);
  assert.doesNotMatch(JSON.stringify(session),/PRIVATE|owner-store|resume\.txt|Fictional Review Applicant/);
  assert.equal((await fixture.context()).ok,false);
  const replay=await fixture.send(base,'receipt');
  assert.equal(replay.ok,true);assert.equal(replay.result.replayed,true);
  assert.deepEqual(replay.result.receipt,result.result.receipt);
  assert.equal((await fixture.send({...base,jobRevision:'999'},'receipt')).ok,false);
  assert.deepEqual(await fixture.snapshot(),after);
});
