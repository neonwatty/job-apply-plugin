import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, snapshot, host, acquire } from './workspace_durable_claims_support.mjs';
import { WorkflowBroker } from '../runtime/integrations/host/claim-broker.js';
import { fromJSON, object, serialize } from '../runtime/contracts/workspace/values.js';
const dispatch = async (broker, value) => JSON.parse(serialize((await broker.dispatch(object(fromJSON(value), 'request'))).response)).result;
const context = broker => dispatch(broker, {command:'host-browser-context'});
const report = (ctx, kind, id) => {
  const action = ctx.guidance.actions.find(a => a.kind === kind);
  const {kind: _, status, ...input} = action.input;
  return {...input,operationId:id,evidenceKind:'agent_attested',outcome:kind === 'progress' ? 'progress' : 'needs_info'};
};
const send = (broker, value) => dispatch(broker,{command:'host-browser-report',report:value});
async function fixtureHost(t, label) {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());
  const state = await setup(fixture,label), owner = host(state);
  const broker = new WorkflowBroker(owner.workflow, () => {}); t.after(() => broker.close());
  return {...owner,state,broker};
}
test('host context is scoped read-only and reports record checkpoints with exact replay', async t => {
  const {state,workflow,broker} = await fixtureHost(t,'host-report');
  await acquire(state,workflow);
  const before = await snapshot(state.root), ctx = await context(broker);
  assert.deepEqual(await snapshot(state.root),before);
  assert.equal(ctx.hostBrowser.nextStep,'observe_and_act');
  const other = await dispatch(broker,{command:'host-browser-context',jobId:'other'});
  assert.equal(other.hostBrowser.nextStep,'resolve_workflow');
  assert.deepEqual(other.hostBrowser.reportOutcomes,[]);
  assert.deepEqual(ctx.hostBrowser.reportOutcomes,['progress','needs_info','awaiting_review']);
  const input = report(ctx,'progress','report'); input.session.step = 'questions';
  const result = await send(broker,input), saved = await snapshot(state.root);
  assert.equal(result.evidenceKind,'agent_attested');
  assert.equal(result.replayScope,'report_recording_only');
  assert.equal(result.persistenceScope,'attempt_checkpoint');
  assert.equal(result.replayed,false);
  assert.deepEqual(await send(broker,input),{...result,replayed:true});
  assert.deepEqual(await snapshot(state.root),saved);
  await assert.rejects(send(broker,{...input,session:{...input.session,step:'changed'}}),/operation_conflict/);
  await assert.rejects(send(broker,{...input,operationId:'stale'}),/stale_revision/);
  assert.deepEqual(await snapshot(state.root),saved);
  assert.equal((await read(state.root,'jobs.json')).jobs.job.status,'in_progress');
});
test('drift and revocation preserve safe exits; pending checkpoint survives Needs Info',async t => {
  const {state,workflow,broker,access} = await fixtureHost(t,'host-drift');
  await acquire(state,workflow);
  const first = report(await context(broker),'progress','pending');
  first.session.pendingFields = [{question:'PRIVATE QUESTION',state:'missing'}];
  await send(broker,first);
  const jobs = await read(state.root,'jobs.json'), run = jobs.metadata.applicationRuns.runs['run-fixture'];
  run.revision++; run.queueVersions.push({...run.queueVersions.at(-1),revision:run.revision});
  await write(state.root,'jobs.json',jobs); access.authorized = [];
  const ctx = await context(broker);
  assert.equal(ctx.hostBrowser.nextStep,'inspect_and_handoff');
  assert.deepEqual(ctx.hostBrowser.reportOutcomes,['needs_info']);
  assert.doesNotMatch(JSON.stringify(ctx),/PRIVATE QUESTION|tokenHash/);
  const handoff = report(ctx,'handoff','handoff'); assert.ok(handoff.savedSessionFingerprint);
  const prior = await read(state.root,'sessions/job.json');
  await send(broker,handoff);
  const saved = await read(state.root,'sessions/job.json');
  assert.deepEqual(saved.pendingFields,prior.pendingFields);
  assert.equal((await read(state.root,'jobs.json')).jobs.job.status,'needs_info');
});
test('privileged and unknown reports reject without mutation; replacement cannot recover claim from replay',async t => {
  const {state,workflow,broker} = await fixtureHost(t,'host-reject');
  await acquire(state,workflow);
  const input = report(await context(broker),'progress','checkpoint');
  const before = await snapshot(state.root);
  for (const patch of [{evidenceKind:'trusted'},{outcome:'submitted'},{hostUserEvent:true},{extra:true},{outcome:'acquire'},{expectedRevision:'01'},{jobRevision:3},{taskId:null}]) {
    await assert.rejects(send(broker,{...input,...patch}),/invalid_event/);
    assert.deepEqual(await snapshot(state.root),before);
  }
  await send(broker,input); await broker.close();
  const next = new WorkflowBroker(host(state).workflow,() => {}); t.after(() => next.close());
  assert.equal((await context(next)).hostBrowser.nextStep,'resolve_workflow');
  assert.equal((await send(next,input)).replayed,true);
  const lost = await context(next);
  assert.equal(lost.broker.ownsClaim,false); assert.deepEqual(lost.hostBrowser.reportOutcomes,[]);
});

test('broker dispatch inspects once and records once without a host user event',async () => {
  const calls = [];
  const current = {broker:{connected:true,ownsClaim:true},guidance:{actions:[{kind:'progress',input:{}}]}};
  const broker = new WorkflowBroker({inspect:async id => {calls.push(['inspect',id]);return current;},
    execute:async (...args) => {calls.push(['execute',...args]);return {receipt:{},replayed:false};},
    heartbeat:async () => {},close:async () => {}},() => {});
  await dispatch(broker,{command:'host-browser-context',jobId:'job'});
  await send(broker,{operationId:'record',taskId:'task',expectedRevision:'1',jobId:'job',jobRevision:'3',
    evidenceKind:'agent_attested',outcome:'progress',session:{status:'active'}});
  assert.equal(calls.length,2); assert.deepEqual(calls[0],['inspect','job']);
  assert.equal(calls[1].length,2); assert.equal(calls[1][1].kind,'progress');
  assert.equal(Object.hasOwn(calls[1][1],'evidenceKind'),false);
});
