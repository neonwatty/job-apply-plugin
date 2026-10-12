import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerWorkflowStore } from '../runtime/app/owner-workflow-policy.js';
import { fixture, jobOf, bytes, readyPacket } from './workspace_application_policy_support.mjs';
import { fromJSON, get, object, set, text, serialize } from '../runtime/contracts/workspace/values.js';
import { makeClaim } from '../runtime/contracts/workspace/claims.js';
import { makeLiveFormManifest, makeLiveReadinessObservation } from '../runtime/contracts/workspace/claim-session-readiness.js';
import { emptyWorkflowLedger, encodeWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';
import { preparationScope } from '../runtime/workflows/applications/prepare-scope.js';

const plain = value => JSON.parse(serialize(value));
function packet(controls = [{id:'name',role:'textbox',required:true},{id:'resume.file',role:'file',required:true}]) {
  const form = fromJSON({schemaVersion:1,platformFamily:'greenhouse',observationRevision:7,complete:true,controls});
  return {attemptRevision:3,evidenceKind:'agent_attested_current_attempt',observedForm:plain(form),
    expectedObservationRevision:7,formManifest:plain(makeLiveFormManifest(form,fromJSON(7))),
    observation:plain(makeLiveReadinessObservation(form,Object.fromEntries(controls.map(c => [c.id,c.role==='file'?'accepted':'complete'])),fromJSON(7),
      {adapterState:'accessible',uploadCapability:'available',validationErrorControlIds:[],finalControlState:'available'}))};
}
async function setup() {
  const state = fixture('in_progress');
  state.snapshot.facts = fromJSON({sets:{resume:{versions:[{revision:1,state:'confirmed',contentRevision:'content_'+'a'.repeat(32)}]}}});
  const claim = makeClaim('job',text('Synthetic owner'),new Date().toISOString().replace(/\.\d{3}Z$/,'Z'));
  set(state.snapshot.coordinator,'claim',claim.claim);
  state.token = text(claim.token);
  const task = {taskId:'owner-task',revision:'1',workflow:{id:'application.attempt',version:1},
    subject:{jobId:'job',jobRevision:'3',inputRevision:preparationScope(state.snapshot,jobOf(state))},status:'active',pending:null};
  const ledger = emptyWorkflowLedger(); ledger.activeTaskId=task.taskId; ledger.tasks[task.taskId]=task;
  set(object(get(state.snapshot.jobs,'metadata')),'agentWorkflows',encodeWorkflowLedger(ledger));
  state.repository = {claimTransaction:callback=>callback(state.snapshot)};
  state.owner = await createOwnerWorkflowStore(state.repository,'job');
  return state;
}
const complete = (state, session = {status:'review',readinessInput:packet()}, saved) => state.owner.store.transaction(async tx => {
  const result = await tx.domain.execute('handoff','job',3n,state.token,fromJSON(session),'awaiting_review',saved);
  await tx.commit(emptyWorkflowLedger());
  return plain(result);
});
async function denied(state,session,saved) {
  const before = bytes(state);
  await assert.rejects(complete(state,session,saved));
  assert.deepEqual(bytes(state),before); assert.equal(state.writes.length,0);
  // A denied review must preserve the claim and its safe NeedsInfo exit.
  await state.owner.store.transaction(async tx => {
    await tx.domain.execute('handoff','job',3n,state.token,fromJSON({status:'active',
      blockers:[{type:'information',code:'owner-input-required'}]}),'needs_info');
    await tx.commit(emptyWorkflowLedger());
  });
  assert.equal(plain(state.writes[0][1]).targetStatus,'needs_info');
}
test('owner completion stages awaiting_review with fresh live selected-resume readiness', async () => {
  const state=await setup(), result=await complete(state);
  assert.equal(result.job.status,'awaiting_review'); assert.equal(result.claim,null);
  assert.equal(result.session.readiness.status,'ready');
  assert.equal(result.session.browserHandoff.state,'ready_for_owner');
  assert.equal(state.writes.length,1); assert.equal(plain(state.writes[0][1]).targetStatus,'awaiting_review');
});
test('owner review rejects input drift and invalid managed facts while retaining NeedsInfo', async () => {
  const resume = s => object(get(object(get(s.snapshot.resumes,'resumes')),'resume'));
  const run = s => object(get(object(get(object(get(object(get(s.snapshot.jobs,'metadata')),'applicationRuns')),'runs')),'run'));
  for (const mutate of [
    s=>set(run(s),'revision',fromJSON(2)),
    s=>set(run(s),'queueVersions',fromJSON([{revision:1,jobIds:[],updatedAt:'2026-09-10T12:00:00Z'}])),
    s=>set(resume(s),'storageKind',text('external')),
    s=>set(resume(s),'revision',fromJSON(2)),
    s=>{s.snapshot.facts=undefined;},
    s=>set(object(get(object(get(s.snapshot.facts,'sets')),'resume')),'versions',fromJSON([{revision:1,state:'draft',contentRevision:'content_'+'a'.repeat(32)}])),
    s=>{s.observation.digest='b'.repeat(64);},
    s=>{s.observation.exists=false;},
  ]) { const state=await setup(); mutate(state); await denied(state); }
});
test('owner review rejects absent, optional or misidentified selected resume control', async () => {
  for (const control of [null,{id:'other.file',role:'file',required:true},
    {id:'resume.file',role:'file',required:false},{id:'resume.file',role:'textbox',required:true}]) {
    const state=await setup(), controls=[{id:'name',role:'textbox',required:true},...(control?[control]:[])];
    await denied(state,{status:'review',readinessInput:packet(controls)});
  }
});
test('owner review rejects saved, replay, incomplete and unsafe final observations', async () => {
  const cases=[
    session=>{delete session.readinessInput;},
    session=>{session.readinessInput=readyPacket(3);},
    session=>{session.readinessInput.evidenceKind='repository_replay';},
    session=>{session.readinessInput.attemptRevision=2;},
    session=>{session.readinessInput.observedForm.complete=false;},
    session=>{session.readinessInput.observation.controls[1].state='rejected';},
    session=>{session.readinessInput.observation.controls[1].observationRevision=6;},
    session=>{session.readinessInput.observation.validationErrorControlIds=['name'];},
    session=>{session.readinessInput.observation.finalControlState='activated';},
    session=>{session.handoffChecklist=['resume_upload'];},
    session=>{session.blockers=[{type:'information',code:'owner-input-required'}];},
  ];
  for(const mutate of cases) {const state=await setup(), session={status:'review',readinessInput:packet()}; mutate(session); await denied(state,session);}
  await denied(await setup(),undefined,'a'.repeat(64));
});
