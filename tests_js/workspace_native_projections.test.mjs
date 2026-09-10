import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup as nativeSetup, snapshot, write } from './workspace_native_claims_support.mjs';
import { WorkspaceProjectionsService } from '../runtime/workspace-core/workspace-projections.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';
const plain = value => JSON.parse(serialize(value));
const now = '2026-09-10T12:00:00Z';
function setup(jobs = [], sessions = [], claim = null) {
  const tx = {
    jobs: fromJSON({jobs:Object.fromEntries(jobs.map(job=>[job.id,job]))}),
    sessions:sessions.map(fromJSON), coordinator:fromJSON({claim}), history:[],
    profile:fromJSON({profile:{}}),resumes:fromJSON({resumes:{}}),answers:fromJSON({answers:{},redirects:{}}),
    files:{externalObservation:async()=>({exists:true,size:1,modifiedAt:now})},
  };
  return {tx,service:new WorkspaceProjectionsService({claimTransaction:async operation=>operation(tx)},()=>now)};
}
const job = (id,status,extra={}) => ({id,status,revision:2,priority:0,createdAt:now,updatedAt:now,...extra});
const session = (id,extra={}) => ({schemaVersion:1,applicationId:id,status:'active',pendingFields:[],...extra});
test('attention sorts all reasons and expiry is inclusive, task snapshot hides job metadata',async()=>{
  const jobs=[job('needs','needs_info'),job('review','awaiting_review'),job('interrupted','in_progress'),job('expired','in_progress'),job('browser','needs_info'),job('deleted','needs_info',{deletedAt:now})];
  const claim={jobId:'expired',expiresAt:now,acquiredAt:now,heartbeatAt:now,ownerLabel:'PRIVATE OWNER',tokenHash:'PRIVATE TOKEN'};
  const browser=session('browser',{browserHandoff:{state:'required',reasonCode:'unsupported-control',revision:1},blockers:[{type:'browser_handoff',code:'unsupported-control'},{type:'information',code:'owner-input-required'}]});
  const {service}=setup(jobs,[browser],claim);
  const attention=plain(await service.attention());
  assert.deepEqual(attention.items.map(row=>row.jobId),['expired','interrupted','review','browser','needs']);
  assert.equal(attention.items[0].reasonCode,'expired_agent_attempt');
  assert.equal(attention.snapshotSignature.length,64);
  assert.deepEqual(plain(await service.attention()),attention);
  const snapshot=plain(await service.taskSnapshot());
  assert.equal(snapshot.overview.counts.attentionJobs,5);
  assert.equal(snapshot.jobs.length,5);
  assert.doesNotMatch(JSON.stringify(snapshot),/PRIVATE/);
  assert.equal(plain(await service.activity('expired')).claim.state,'expired');
  assert.equal(plain(await service.activity('interrupted')).claim.state,'interrupted');
});
test('activity is selected-job-only, missing sessions work and unknown/deleted jobs fail',async()=>{
  const {service,tx}=setup([job('one','saved'),job('deleted','saved',{deletedAt:now})]);
  tx.history=[fromJSON({applicationId:'other',event:'PRIVATE'}),fromJSON({applicationId:'one',event:'reviewed',status:'review',at:now,company:'PRIVATE'})];
  assert.deepEqual(plain(await service.activity('one')),{job:{status:'saved',revision:2},session:null,claim:{state:'none'},history:[{event:'reviewed',status:'review',at:now}]});
  await assert.rejects(service.activity('missing'),/job does not exist/);
  await assert.rejects(service.activity('deleted'),/job does not exist/);
  assert.throws(()=>service.activity('../escape'));
});
test('activity pending information is value-free and stale approvals are suppressed',async()=>{
  const reference=`pending_${'a'.repeat(32)}`;
  const approval={reference,answerKey:'answer',answerRevision:1,currentUse:true,remember:false,policyMode:'strict',useAuthority:'per_use',eligible:true,confidenceBand:'none',reasonCodes:[]};
  const pending={reference,answerKey:'answer',state:'missing',questionFingerprint:'b'.repeat(64)};
  const {service,tx}=setup([job('one','needs_info')],[session('one',{attemptRevision:1,pendingFields:[pending],approvals:[approval]})]);
  tx.answers=fromJSON({answers:{answer:{key:'answer',revision:1,state:'confirmed',value:'PRIVATE ANSWER',question:'PRIVATE QUESTION'}},redirects:{}});
  let output=plain(await service.activity('one'));
  assert.equal(output.session.pendingInformation[0].resolutionEligible,true);
  assert.doesNotMatch(JSON.stringify(output),/PRIVATE|Fingerprint/);
  assert.equal(output.session.approvals.length,1);
  tx.answers=fromJSON({answers:{answer:{key:'answer',revision:2,state:'confirmed',value:'PRIVATE ANSWER'}},redirects:{}});
  assert.deepEqual(plain(await service.activity('one')).session.approvals,[]);
  tx.jobs=fromJSON({jobs:{one:job('one','in_progress')}});
  assert.deepEqual(plain(await service.activity('one')).session.approvals,[]);
  tx.sessions=[fromJSON(session('one',{pendingFields:[{...pending,question:'PRIVATE QUESTION'}]}))];
  assert.doesNotMatch(JSON.stringify(plain(await service.activity('one'))),/PRIVATE QUESTION/);
  // Invalid persisted session metadata must fail closed before it reaches projection.
  tx.sessions=[fromJSON(session('one',{pendingFields:[{...pending,value:'PRIVATE ANSWER'}]}))];
  await assert.rejects(service.activity('one'),/pending field/);
});
test('overview setup precedence and accepted active counts',async()=>{
  const {service,tx}=setup([job('ready','ready')]);
  assert.equal(plain(await service.overview()).nextAction,'import_resume');
  tx.resumes=fromJSON({resumes:{r:{id:'r',default:true,path:'/synthetic',observedSize:1,observedModifiedAt:now}}});
  assert.equal(plain(await service.overview()).nextAction,'review_facts');
  tx.profile=fromJSON({profile:{name:'PRIVATE'}});
  assert.equal(plain(await service.overview()).nextAction,'handoff_ready_job');
  tx.coordinator=fromJSON({claim:{jobId:'other',expiresAt:'2026-09-10T12:00:01Z'}});
  assert.equal(plain(await service.overview()).nextAction,'prepare_job');
  tx.answers=fromJSON({answers:{a:{},b:{reviewStatus:'proposed'},c:{deletedAt:now}}});
  assert.equal(plain(await service.overview()).counts.answers,1);
});

test('all modern projection payloads and signatures match authoritative Python',async()=>{
  const {service,tx}=setup([job('α','needs_info'),job('one','awaiting_review'),job('two','in_progress'),job('deleted','saved',{deletedAt:now})]);
  // Canonical job ids are ASCII; unicode in projected labels still tests canonical hashing.
  tx.jobs=fromJSON({jobs:{one:job('one','awaiting_review',{company:'会社',notes:'PRIVATE'}),two:job('two','in_progress'),three:job('three','needs_info'),deleted:job('deleted','saved',{deletedAt:now})}});
  tx.sessions=[fromJSON(session('three',{pendingFields:[{reference:`pending_${'a'.repeat(32)}`,state:'missing',question:'PRIVATE QUESTION'}]}))];
  tx.history=[fromJSON({applicationId:'one',event:'reviewed',at:now,company:'PRIVATE'})];
  const input=Object.fromEntries(['jobs','coordinator','profile','resumes','answers'].map(key=>[key,plain(tx[key])]));
  Object.assign(input,{sessions:tx.sessions.map(plain),history:tx.history.map(plain),now});
  const result=spawnSync(process.env.JOB_APPLY_CONTRACT_PYTHON || 'python3',['tools/contracts/workspace-projections/reference.py'],{input:JSON.stringify(input),encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const expected=JSON.parse(result.stdout);
  assert.deepEqual(plain(await service.overview()),expected.overview);
  assert.deepEqual(plain(await service.attention()),expected.attention);
  assert.deepEqual(plain(await service.taskSnapshot()),expected.snapshot);
  for (const [id,activity] of Object.entries(expected.activity)) assert.deepEqual(plain(await service.activity(id)),activity);
});

test('native fixture projections are read-only and reject corrupt persisted sessions', {timeout:60000},async()=>{
  const fixture=await nativeFixture();
  try {
    const state=await nativeSetup(fixture,'projections');
    const service=new WorkspaceProjectionsService(state.repository,()=>state.clock.now);
    const before=await snapshot(state.root);
    assert.equal(plain(await service.overview()).counts.jobs,2);
    assert.deepEqual(plain(await service.attention()).items,[]);
    assert.equal(plain(await service.preflight('job')).ready,true);
    assert.equal(plain(await service.activity('job')).session,null);
    assert.equal(plain(await service.taskSnapshot()).jobs.length,2);
    assert.deepEqual(await snapshot(state.root),before);
    await write(state.root,'sessions/job.json',{schemaVersion:1,applicationId:'job',status:'active',pendingFields:[{reference:'invalid',value:'PRIVATE'}]});
    const corrupted=await snapshot(state.root);
    await assert.rejects(service.activity('job'),/pending field/);
    assert.deepEqual(await snapshot(state.root),corrupted);
  } finally { await fixture.cleanup(); }
});
