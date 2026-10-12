import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerWorkflowStore } from '../runtime/app/owner-workflow-policy.js';
import { fixture, jobOf } from './workspace_application_policy_support.mjs';
import { fromJSON, get, object, set, text } from '../runtime/contracts/workspace/values.js';
import { emptyWorkflowLedger, encodeWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup as nativeSetup, read, write, event, pending } from './workspace_durable_claims_support.mjs';
import { ResumeFactsService } from '../runtime/workspace-core/resume-facts.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { ClaimWorkflow } from '../runtime/app/claim-workflow.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
import { serialize } from '../runtime/contracts/workspace/values.js';

function setup() {
  const state = fixture('ready');
  state.snapshot.facts = fromJSON({sets:{resume:{versions:[{revision:1,state:'confirmed',
    contentRevision:'content_'+'a'.repeat(32)}]}}});
  state.repository = {claimTransaction: async callback => callback(state.snapshot)};
  return state;
}
function ledger(state, value) {
  set(object(get(state.snapshot.jobs,'metadata')), 'agentWorkflows', encodeWorkflowLedger(value));
}
function attempt(inputRevision = 'a'.repeat(64)) {
  return {taskId:'task',revision:'1',workflow:{id:'application.attempt',version:1},
    subject:{jobId:'job',jobRevision:'3',inputRevision},status:'active',pending:null};
}
test('owner activation binds one ready job and confirmed managed run inputs', async () => {
  const state = setup();
  const {scope,store} = await createOwnerWorkflowStore(state.repository,'job');
  assert.equal(scope.jobId,'job'); assert.equal(scope.jobRevision,'3');
  assert.equal(scope.taskId,null); assert.match(scope.inputRevision,/^[a-f0-9]{64}$/);
  assert.equal(state.writes.length,0);
  await assert.rejects(store.transaction(tx => tx.domain.execute('acquire','other',3n,null)), /task_conflict/);
  await assert.rejects(store.transaction(tx => tx.domain.execute('restart','job',3n,null)), /action_unavailable/);
  await assert.rejects(store.transaction(tx => tx.domain.execute('handoff','job',3n,null,undefined,'awaiting_review')), /task_conflict/);
  set(jobOf(state),'revision',fromJSON(4));
  await assert.rejects(store.transaction(tx => tx.domain.execute('acquire','job',4n,null)), /stale_revision/);
  assert.equal(state.writes.length,0);
});
test('owner activation rejects missing confirmation, external resume and queue exclusion', async () => {
  for (const mutate of [
    s => { s.snapshot.facts = undefined; },
    s => set(object(get(object(get(s.snapshot.resumes,'resumes')),'resume')),'storageKind',text('external')),
    s => set(object(get(object(get(object(get(object(get(s.snapshot.jobs,'metadata')),'applicationRuns')),'runs')),'run')),
      'queueVersions',fromJSON([{revision:1,jobIds:[],updatedAt:'2026-09-10T12:00:00Z'}])),
  ]) {
    const state = setup(); mutate(state);
    await assert.rejects(createOwnerWorkflowStore(state.repository,'job'), /action_unavailable/);
    assert.equal(state.writes.length,0);
  }
});
test('owner resume keeps original task binding after input drift and rejects other active work', async () => {
  const state = setup(), value = emptyWorkflowLedger(), task = attempt();
  value.activeTaskId = task.taskId; value.tasks.task = task; ledger(state,value);
  set(jobOf(state),'status',text('in_progress')); state.snapshot.facts = undefined;
  const {scope} = await createOwnerWorkflowStore(state.repository,'job');
  assert.equal(scope.taskId,'task'); assert.equal(scope.inputRevision,task.subject.inputRevision);
  value.tasks.task.subject.jobId = 'other'; ledger(state,value);
  await assert.rejects(createOwnerWorkflowStore(state.repository,'job'), /task_conflict/);
});
test('v2 fails before archive preparation or publication', async () => {
  const state = setup(); let prepares = 0, flushes = 0;
  set(object(get(state.snapshot.jobs,'metadata')),'agentWorkflows',fromJSON({schemaVersion:2}));
  state.snapshot.workflowArchive = {prepare:async () => { prepares++; return {flush:async()=>{flushes++;}}; }};
  await assert.rejects(createOwnerWorkflowStore(state.repository,'job'), /action_unavailable/);
  assert.equal(prepares,0); assert.equal(flushes,0); assert.equal(state.writes.length,0);
});
test('native owner scope acquires once and preserves safe handoff after run drift', async () => {
  const fixture = await nativeFixture();
  try {
    const state = await nativeSetup(fixture,'owner-policy');
    const facts = new ResumeFactsService(state.repository);
    const plain = value => JSON.parse(serialize(value));
    const draft = plain(await facts.createDraft('resume',fromJSON({name:'Synthetic Owner'}),1n,null));
    const confirmed = plain(await facts.confirm('resume',BigInt(draft.revision),draft.contentRevision));
    const jobs = await read(state.root,'jobs.json');
    jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision = confirmed.revision;
    await write(state.root,'jobs.json',jobs);
    await state.claims.select('job',1n,true);
    const {store,scope} = await createOwnerWorkflowStore(state.repository,'job');
    const workflow = new ClaimWorkflow(store,new ClaimsService(state.repository),
      () => ({enabled:[attemptProfile],authorized:[attemptProfile]}));
    const acquire = event('acquire');
    const started = await workflow.execute(acquire,acquire);
    assert.equal(started.receipt.task.subject.inputRevision,scope.inputRevision);
    const changed = await read(state.root,'jobs.json');
    changed.metadata.applicationRuns.runs['run-fixture'].revision = 2;
    changed.metadata.applicationRuns.runs['run-fixture'].queueVersions.push({
      revision:2,jobIds:['other'],updatedAt:state.clock.now});
    await write(state.root,'jobs.json',changed);
    const bytes = await read(state.root,'coordinator.json');
    await assert.rejects(workflow.execute(event('progress',started.receipt.task)),/stale_revision/);
    assert.deepEqual(await read(state.root,'coordinator.json'),bytes);
    const resumed = await createOwnerWorkflowStore(state.repository,'job');
    assert.equal(resumed.scope.inputRevision,scope.inputRevision);
    const cancel = event('cancel',started.receipt.task,{session:pending});
    const done = await workflow.execute(cancel,cancel);
    assert.equal(done.receipt.outcome,'cancelled');
    await assert.rejects(store.transaction(tx => tx.domain.execute('acquire','job',4n,null)),/broker_unavailable/);
    assert.equal((await read(state.root,'coordinator.json')).claim,null);
    await workflow.close();
  } finally { await fixture.cleanup(); }
});
