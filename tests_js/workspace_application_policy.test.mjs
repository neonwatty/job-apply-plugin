import assert from 'node:assert/strict';
import test from 'node:test';
import { applicationContext } from '../runtime/workflows/applications/context.js';
import { fromJSON, get, integer, set, text, JobsError } from '../runtime/contracts/workspace/values.js';
import { fixture, hold, jobOf, bytes, execute, readyPacket } from './workspace_application_policy_support.mjs';

async function inspect(state,candidates) {
  const before=bytes(state);
  const context=await applicationContext(state.snapshot,'job',candidates,state.access,()=>state.clock.at);
  assert.deepEqual(bytes(state),before,'inspection must not mutate canonical data');
  assert.equal(state.writes.length,0,'inspection must not persist anything');
  assert.doesNotMatch(JSON.stringify(context),/PRIVATE|tokenHash|claim_|readinessInput/);
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.allowedActions));
  return context;
}
async function parity(state,candidate,accepted) {
  const context=await inspect(state,[candidate]);
  assert.equal(context.allowedActions.length,accepted?1:0,JSON.stringify({status:context.status,kind:candidate.kind}));
  const before=bytes(state);
  if(accepted) await execute(state,candidate);
  else {
    await assert.rejects(async()=>execute(state,candidate),JobsError);
    assert.equal(state.writes.length,0);
    assert.deepEqual(bytes(state),before);
  }
  return context;
}

test('all direct status edges agree with the existing transition contract and command',async()=>{
  const permitted={saved:['needs_info','ready','closed'],needs_info:['saved','ready','closed'],
    ready:['saved','needs_info','closed'],in_progress:['needs_info','awaiting_review','closed'],
    awaiting_review:['applied','closed'],applied:['closed'],closed:['saved']};
  for(const source of Object.keys(permitted)) for(const target of Object.keys(permitted)) {
    const state=fixture(source);
    await parity(state,{kind:'transition',target,expectedRevision:3n,userConfirmed:true,closedOutcome:text('withdrawn')},
      source===target || permitted[source].includes(target));
  }
  await parity(fixture('awaiting_review'),{kind:'transition',target:'applied',expectedRevision:3n,userConfirmed:false,closedOutcome:null},false);
  await parity(fixture(),{kind:'transition',target:'closed',expectedRevision:3n,userConfirmed:false,closedOutcome:null},false);
  await parity(fixture(),{kind:'transition',target:'saved',expectedRevision:3n,userConfirmed:false,closedOutcome:text('ignored')},true);
});

test('selection and acquisition obey phase, explicit intent, exact revision and global claim rules',async()=>{
  for(const status of ['saved','needs_info','ready','in_progress','awaiting_review','applied','closed']) {
    await parity(fixture(status),{kind:'select',expectedRevision:3n,ownerConfirmed:true},['saved','needs_info','ready'].includes(status));
    await parity(fixture(status),{kind:'acquire',expectedRevision:3n},status==='ready');
  }
  for(const candidate of [{kind:'select',expectedRevision:3n,ownerConfirmed:false},
    {kind:'select',expectedRevision:2n,ownerConfirmed:true},{kind:'acquire',expectedRevision:2n}]) await parity(fixture('ready'),candidate,false);
  for(const id of ['job','other']) for(const expired of [false,true]) {
    const state=fixture('ready'); hold(state,id);
    if(expired) state.clock.at='2026-09-10T12:05:00Z';
    await parity(state,{kind:'acquire',expectedRevision:3n},false);
  }
  const state=fixture('ready'), revision=9007199254740999n;
  set(jobOf(state),'revision',integer(revision));
  const context=await parity(state,{kind:'select',expectedRevision:revision,ownerConfirmed:true},true);
  assert.equal(context.jobRevision,revision.toString());
  assert.equal(state.writes.length,0,'already ready selection is a no-op');
});

test('changed files and facts block continuation while needs_info can safely release the claim',async()=>{
  for(const change of ['file','facts','run']) for(const kind of ['select','acquire','progress','handoff']) {
    const state=fixture(['progress','handoff'].includes(kind)?'in_progress':'ready');
    if(['progress','handoff'].includes(kind)) hold(state);
    if(change==='file') state.observation.digest='b'.repeat(64);
    if(change==='facts') state.snapshot.facts=fromJSON({sets:{resume:{versions:[{revision:2,state:'confirmed',contentRevision:'content_'+'a'.repeat(32)}]}}});
    if(change==='run') set(state.snapshot.jobs,'metadata',fromJSON({updatedAt:state.clock.at}));
    const candidate={kind,expectedRevision:3n,ownerConfirmed:true,target:'awaiting_review',incoming:fromJSON({status:kind==='progress'?'active':'review',readinessInput:readyPacket(3)})};
    await parity(state,candidate,false);
    if(kind==='handoff') {
      const context=await parity(state,{kind:'handoff',expectedRevision:3n,target:'needs_info',incoming:fromJSON({status:'active'})},true);
      assert.equal(context.canLeave,false,'a preview does not release the claim');
    }
  }
});

test('progress and handoff retain claim authentication, freshness and human-only review',async()=>{
  for(const scenario of ['valid','wrong_token','expired','stale_revision','missing_readiness','replay','upload','pending']) {
    const state=fixture('in_progress'); hold(state);
    const incoming={status:'review',readinessInput:readyPacket(3)};
    if(scenario==='wrong_token') state.access.token=text('wrong');
    if(scenario==='expired') state.clock.at='2026-09-10T12:05:00Z';
    if(scenario==='missing_readiness') delete incoming.readinessInput;
    if(scenario==='replay') incoming.readinessInput.evidenceKind='repository_replay';
    if(scenario==='upload') incoming.readinessInput.observation.controls.find(item=>item.kind==='upload').state='pending';
    if(scenario==='pending') incoming.pendingFields=[{question:'PRIVATE-QUESTION',state:'missing'}];
    await parity(state,{kind:'handoff',target:'awaiting_review',expectedRevision:scenario==='stale_revision'?2n:3n,incoming:fromJSON(incoming)},scenario==='valid');
  }
  const state=fixture('in_progress'); hold(state);
  await parity(state,{kind:'progress',incoming:fromJSON({status:'active'})},true);
  const blocked=fixture('in_progress');hold(blocked);
  await parity(blocked,{kind:'transition',target:'applied',expectedRevision:3n,userConfirmed:true,closedOutcome:null},false);
});

test('recovery and review restart require their existing explicit evidence',async()=>{
  for(const status of ['ready','in_progress','awaiting_review']) for(const expired of [false,true]) {
    const state=fixture(status);hold(state);
    if(expired) state.clock.at='2026-09-10T12:05:00Z';
    await parity(state,{kind:'recover'},status==='in_progress' && expired);
  }
  await parity(fixture('in_progress'),{kind:'recover'},false);
  for(const status of ['saved','in_progress','awaiting_review']) {
    await parity(fixture(status),{kind:'restart',expectedRevision:3n,ownerConfirmedNotSubmitted:true},false);
  }
  await parity(fixture('awaiting_review'),{kind:'restart',expectedRevision:3n,ownerConfirmedNotSubmitted:false},false);
});

test('no model state is stored and fresh inspection rejects a previously eligible action',async()=>{
  const state=fixture('ready'), candidate={kind:'acquire',expectedRevision:3n};
  const first=await inspect(state,[candidate]);
  assert.equal(first.allowedActions.length,1);
  set(jobOf(state),'revision',integer(4n));
  await parity(state,candidate,false);
  assert.equal(first.jobRevision,'3','returned context is a detached projection');
  const held=fixture('in_progress');hold(held);
  assert.equal((await inspect(held,[])).canLeave,false);
  assert.equal((await inspect(fixture('awaiting_review'),[])).canLeave,true);
  assert.equal((await inspect(fixture('in_progress'),[])).canLeave,false);
});

test('unexpected observation failures propagate, while policy errors expose only action IDs',async()=>{
  const state=fixture('ready'), candidate={kind:'acquire',expectedRevision:3n};
  const failure=new Error('PRIVATE-IO-FAILURE');
  state.snapshot.files.observation=async()=>{throw failure;};
  await assert.rejects(inspect(state,[candidate]),error=>error===failure);
  state.snapshot.files.observation=async()=>{throw new JobsError('PRIVATE-POLICY-DIAGNOSTIC');};
  assert.deepEqual((await inspect(state,[candidate])).rejectedActionIds,['application.acquire']);
  await assert.rejects(inspect(fixture(),[{kind:'unregistered'}]),/unsupported application candidate/);
  await assert.rejects(inspect(fixture('ready'),[candidate,candidate]),/duplicate application candidate/);
});
