import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {join} from 'node:path';
import {ownerReviewFixture,reviewSession} from './workspace_owner_review_support.mjs';

async function reopen(fixture,t) {
  const child=spawn(process.execPath,[join(fixture.plugin,'apps/companion/command.mjs'),
    'owner-workflow','serve','--root',fixture.root,'--job-id','job','--host-user-event'],
  {env:{PATH:'',HOME:fixture.directory},stdio:['ignore','pipe','pipe']});
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
  let output='';
  child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exited;});
  let context;
  for(let n=0;n<100;n++) {
    context=await fixture.context();
    if(context.ok||child.exitCode!==null)break;
    await delay(25);
  }
  assert.equal(context?.ok,true,JSON.stringify({context,output}));
  return {context,exited};
}

test('installed owner restart requires explicit approval and fresh review after a terminal handoff',
  {timeout:90000},async t=>{
    const fixture=await ownerReviewFixture();t.after(fixture.cleanup);
    const initial=await fixture.context();
    const first={...initial.result.hostBrowser.reports.find(r=>r.input.outcome==='awaiting_review').input,
      operationId:'first-review'};
    first.session=reviewSession(first.jobRevision);
    const review=await fixture.send(first);
    assert.equal(review.ok,true);await fixture.waitForExit();
    const historicalSession=await fixture.read('sessions/job.json');
    const {context,exited}=await reopen(fixture,t);
    const action=context.result.guidance.actions.find(a=>a.kind==='restart');
    assert.ok(action,'reviewed job exposes an explicit restart descriptor');
    assert.equal(action.requiresExplicitUserEvent,true);
    const restart={...action.input,operationId:'review-restart'};
    const before=await fixture.snapshot();
    assert.equal((await fixture.send(restart,'event')).ok,false);
    assert.deepEqual(await fixture.snapshot(),before);
    const started=await fixture.send(restart,'event',true);
    assert.equal(started.ok,true,JSON.stringify(started));
    assert.notEqual(started.result.receipt.task.taskId,review.result.receipt.task.taskId);
    assert.equal(started.result.receipt.task.subject.inputRevision,review.result.receipt.task.subject.inputRevision);
    assert.deepEqual(await fixture.read('sessions/job.json'),historicalSession);
    const current=await fixture.context();
    const fresh={...current.result.hostBrowser.reports.find(r=>r.input.outcome==='awaiting_review').input,
      operationId:'fresh-review'};
    const afterRestart=await fixture.snapshot();
    assert.equal((await fixture.send({...fresh,operationId:'copied-review',session:first.session})).ok,false);
    assert.deepEqual(await fixture.snapshot(),afterRestart);
    fresh.session=reviewSession(fresh.jobRevision);
    const completed=await fixture.send(fresh);
    assert.equal(completed.ok,true,JSON.stringify(completed));
    assert.equal(completed.result.receipt.outcome,'awaiting_review');
    assert.deepEqual(await Promise.race([exited,delay(5000).then(()=>{throw Error('restart broker did not exit');})]),
      {code:0,signal:null});
    assert.equal((await fixture.read('coordinator.json')).claim,null);
    assert.equal((await fixture.read('jobs.json')).jobs.job.status,'awaiting_review');
    const after=await fixture.snapshot();
    for(const file of ['profile.json','resumes.json','resume-facts.json'])assert.equal(after[file],before[file],file);
    assert.deepEqual((await fixture.send(fresh,'receipt')).result.receipt,completed.result.receipt);
    assert.deepEqual((await fixture.send(first,'receipt')).result.receipt,review.result.receipt);
    assert.deepEqual(await fixture.snapshot(),after);
  });
