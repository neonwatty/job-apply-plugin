import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, event, pending, snapshot } from './workspace_durable_claims_support.mjs';
import { createOwnerWorkflowStore } from '../runtime/app/owner-workflow-policy.js';
import { ClaimWorkflow } from '../runtime/app/claim-workflow.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
import { makeLiveFormManifest, makeLiveReadinessObservation } from '../runtime/contracts/workspace/claim-session-readiness.js';
const plain = value => JSON.parse(serialize(value));
function driftRun(jobs) {
  const run=jobs.metadata.applicationRuns.runs['run-fixture'];
  run.revision++;
  run.queueVersions.push({...run.queueVersions.at(-1),revision:run.revision});
}
async function owner(state) {
  const {store,scope} = await createOwnerWorkflowStore(state.repository,'job');
  return {scope,workflow:new ClaimWorkflow(store,new ClaimsService(state.repository),
    () => ({enabled:[attemptProfile],authorized:[attemptProfile]}))};
}
async function prepared(fixture,name) {
  const state = await setup(fixture,name), facts = new ResumeFactsService(state.repository);
  const draft = plain(await facts.createDraft('resume',fromJSON({name:'Synthetic Owner'}),1n,null));
  const confirmed = plain(await facts.confirm('resume',BigInt(draft.revision),draft.contentRevision));
  const jobs = await read(state.root,'jobs.json');
  jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision=confirmed.revision;
  await write(state.root,'jobs.json',jobs);
  await state.claims.select('job',1n,true);
  const active = await owner(state), request=event('acquire');
  const task=(await active.workflow.execute(request,request)).receipt.task;
  return {...state,...active,task};
}
function reviewSession(task) {
  const form=fromJSON({schemaVersion:1,platformFamily:'greenhouse',observationRevision:7,complete:true,
    controls:[{id:'resume.file',role:'file',required:true}]});
  return {status:'review',step:'final_review',readinessInput:{attemptRevision:Number(task.subject.jobRevision),
    evidenceKind:'agent_attested_current_attempt',observedForm:plain(form),expectedObservationRevision:7,
    formManifest:plain(makeLiveFormManifest(form,fromJSON(7))),
    observation:plain(makeLiveReadinessObservation(form,{'resume.file':'accepted'},fromJSON(7),
      {adapterState:'accessible',uploadCapability:'available',validationErrorControlIds:[],finalControlState:'available'}))}};
}
async function reviewed(fixture,name) {
  const state=await prepared(fixture,name), session=reviewSession(state.task);
  const done=await state.workflow.execute(event('handoff',state.task,{status:'awaiting_review',session}));
  await state.workflow.close();
  return {...state,task:done.receipt.task,session};
}
test('owner reviewed restart is explicit, preserves scope, and requires fresh readiness', async () => {
  const fixture=await nativeFixture();
  try {
    const state=await reviewed(fixture,'restart'), resumed=await owner(state);
    const context=await resumed.workflow.inspect('job');
    assert.ok(context.guidance.actions.some(action=>action.kind==='restart'));
    const restart=event('restart',null,{jobRevision:state.task.subject.jobRevision});
    const before=await snapshot(state.root);
    await assert.rejects(resumed.workflow.execute(restart),/user_event_required/);
    assert.deepEqual(await snapshot(state.root),before);
    const fresh=(await resumed.workflow.execute(restart,restart)).receipt.task;
    assert.notEqual(fresh.taskId,state.task.taskId);
    assert.equal(fresh.subject.inputRevision,state.task.subject.inputRevision);
    assert.notEqual(fresh.subject.jobRevision,state.task.subject.jobRevision);
    await assert.rejects(resumed.workflow.execute(event('handoff',fresh,{operationId:'stale-review',status:'awaiting_review',session:state.session})));
    const done=await resumed.workflow.execute(event('handoff',fresh,{operationId:'new-review',status:'awaiting_review',session:reviewSession(fresh)}));
    assert.equal(done.receipt.outcome,'awaiting_review');
    assert.equal((await read(state.root,'coordinator.json')).claim,null);
    await resumed.workflow.close();
  } finally {await fixture.cleanup();}
});
test('owner reviewed restart rejects ambiguous, incompatible, stale and changed-input workflow evidence', async () => {
  const fixture=await nativeFixture();
  try {
    for(const [name,mutate] of [
      ['wrong-workflow',(jobs,id)=>{jobs.metadata.agentWorkflows.tasks[id].workflow.version='unknown';}],
      ['ambiguous',(jobs,id)=>{jobs.metadata.agentWorkflows.tasks.duplicate={...jobs.metadata.agentWorkflows.tasks[id],taskId:'duplicate'};}],
      ['stale',(jobs,id)=>{jobs.metadata.agentWorkflows.tasks[id].subject.jobRevision='1';}],
      ['changed-run',driftRun],
      ['changed-facts',jobs=>{jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision++;}],
    ]) {
      const state=await reviewed(fixture,name), jobs=await read(state.root,'jobs.json');
      mutate(jobs,state.task.taskId); jobs.metadata.agentWorkflows.receipts={}; await write(state.root,'jobs.json',jobs);
      const before=await snapshot(state.root);
      await assert.rejects(owner(state),/action_unavailable|invalid_task_state/);
      assert.deepEqual(await snapshot(state.root),before);
    }
  } finally {await fixture.cleanup();}
});
test('owner broker loss refuses live claims and recovers expired same task for guarded drift exit', async () => {
  const fixture=await nativeFixture();
  try {
    const state=await prepared(fixture,'expired'); await state.workflow.close();
    const resumed=await owner(state), recovery=event('recover',state.task);
    const before=await snapshot(state.root);
    await assert.rejects(resumed.workflow.execute(recovery,recovery),/live claim cannot be recovered/);
    assert.deepEqual(await snapshot(state.root),before);
    const coordinator=await read(state.root,'coordinator.json');
    coordinator.claim.expiresAt='2026-09-10T12:00:00Z';
    await write(state.root,'coordinator.json',coordinator);
    const jobs=await read(state.root,'jobs.json');
    driftRun(jobs);
    await write(state.root,'jobs.json',jobs);
    const recovered=(await resumed.workflow.execute(recovery,recovery)).receipt.task;
    assert.equal(recovered.taskId,state.task.taskId);
    assert.equal(recovered.subject.inputRevision,state.task.subject.inputRevision);
    await assert.rejects(resumed.workflow.execute(event('progress',recovered)),/stale_revision/);
    const done=await resumed.workflow.execute(event('handoff',recovered,{operationId:'drift-exit',session:pending}));
    assert.equal(done.receipt.outcome,'needs_info');
    assert.equal((await read(state.root,'coordinator.json')).claim,null);
    await resumed.workflow.close();
  } finally {await fixture.cleanup();}
});

test('owner restart rechecks input drift after activation without modifying the checkpoint', async () => {
  const fixture=await nativeFixture();
  try {
    const state=await reviewed(fixture,'activation-drift'), resumed=await owner(state);
    const jobs=await read(state.root,'jobs.json'); driftRun(jobs); await write(state.root,'jobs.json',jobs);
    const before=await snapshot(state.root), request=event('restart',null,{jobRevision:state.task.subject.jobRevision});
    await assert.rejects(resumed.workflow.execute(request,request),/stale_revision/);
    assert.deepEqual(await snapshot(state.root),before);
    await resumed.workflow.close();
  } finally {await fixture.cleanup();}
});


test('first owner restart adopts a modern ordinary review without manufacturing a prior workflow task', async () => {
  const fixture=await nativeFixture();
  try {
    const {state,session}=await ordinaryReview(fixture,'ordinary-review');
    const before=await snapshot(state.root), resumed=await owner(state);
    assert.deepEqual(await snapshot(state.root),before);
    const context=await resumed.workflow.inspect('job');
    const action=context.guidance.actions.find(action=>action.kind==='restart');
    assert.ok(action);
    const request={...action.input,operationId:'ordinary-owner-restart'};
    await assert.rejects(resumed.workflow.execute(request),/user_event_required/);
    assert.deepEqual(await snapshot(state.root),before);
    const fresh=(await resumed.workflow.execute(request,request)).receipt.task;
    assert.equal(Object.keys((await read(state.root,'jobs.json')).metadata.agentWorkflows.tasks).length,1);
    assert.equal((await snapshot(state.root))['sessions/job.json'],before['sessions/job.json']);
    await assert.rejects(resumed.workflow.execute(event('handoff',fresh,{status:'awaiting_review',session})));
    const done=await resumed.workflow.execute(event('handoff',fresh,{operationId:'fresh-canonical-review',status:'awaiting_review',session:reviewSession(fresh)}));
    assert.equal(done.receipt.outcome,'awaiting_review');
    assert.equal((await read(state.root,'coordinator.json')).claim,null);
    await resumed.workflow.close();
  } finally {await fixture.cleanup();}
});

async function ordinaryReview(fixture,name) {
    const state=await setup(fixture,name), facts=new ResumeFactsService(state.repository);
    const draft=plain(await facts.createDraft('resume',fromJSON({name:'Synthetic Owner'}),1n,null));
    const confirmed=plain(await facts.confirm('resume',BigInt(draft.revision),draft.contentRevision));
    const jobs=await read(state.root,'jobs.json');
    jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision=confirmed.revision;
    await write(state.root,'jobs.json',jobs);
    await state.claims.select('job',1n,true);
    const acquired=plain(await state.claims.acquire('job',fromJSON('ordinary'),2n));
    const revision=acquired.job.revision;
    const session=reviewSession({subject:{jobRevision:String(revision)}});
    await state.claims.handoff('job',fromJSON(acquired.token),'awaiting_review',fromJSON(session),BigInt(revision));
    return {state,session};
}

test('ordinary review adoption rejects incomplete, legacy, changed and claimed checkpoints without writes', async () => {
  const fixture=await nativeFixture();
  try {
    for (const name of ['missing','legacy','stale','pending','history','claim','resume-drift']) {
      const {state}=await ordinaryReview(fixture,name);
      const session=await read(state.root,'sessions/job.json');
      if(name==='missing')session.readiness=null;
      if(name==='legacy')for(const key of ['readiness','attemptRevision','browserHandoff'])delete session[key];
      if(name==='stale')session.attemptRevision=1;
      if(name==='pending')session.handoffChecklist=['resume_upload'];
      await write(state.root,'sessions/job.json',session);
      if(name==='history')await import('node:fs/promises').then(fs=>fs.writeFile(state.root+'/applications.jsonl',''));
      if(name==='claim')await state.claims.acquire('other',fromJSON('other'),
        BigInt(plain(await state.claims.select('other',1n,true)).job.revision));
      if(name==='resume-drift') {
        const resumes=await read(state.root,'resumes.json');resumes.resumes.resume.contentRevision='changed';
        await write(state.root,'resumes.json',resumes);
      }
      const before=await snapshot(state.root);
      await assert.rejects(owner(state),undefined,name);
      assert.deepEqual(await snapshot(state.root),before,name);
    }
    const {state}=await ordinaryReview(fixture,'late-drift'), active=await owner(state);
    const context=await active.workflow.inspect('job');
    const request={...context.guidance.actions.find(a=>a.kind==='restart').input,operationId:'late-drift'};
    const jobs=await read(state.root,'jobs.json');driftRun(jobs);await write(state.root,'jobs.json',jobs);
    const before=await snapshot(state.root);
    await assert.rejects(active.workflow.execute(request,request),/stale_revision/);
    assert.deepEqual(await snapshot(state.root),before);
    await active.workflow.close();
  } finally {await fixture.cleanup();}
});
