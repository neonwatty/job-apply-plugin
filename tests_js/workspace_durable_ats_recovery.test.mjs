import test from 'node:test';
import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, host, acquire, event, read, write, snapshot, pending } from './workspace_durable_claims_support.mjs';
import { serialize, get, object } from '../runtime/contracts/workspace/values.js';
const evidence={ats:'workday',draft:'present',observation:'current',session:'authenticated',failure:'generic_save',refreshApproved:false};
function request(task,state,operationId,extra={}) {
  return {operationId,taskId:task.taskId,expectedRevision:task.revision,jobId:'job',jobRevision:task.subject.jobRevision,
    draftId:state?.draftId??null,recoveryRevision:state?.revision??null,mode:'decide',evidence,...extra};
}
async function fixture(t) {
  const native=await nativeFixture();t.after(()=>native.cleanup());
  const state=await setup(native,'recovery-budget'),owner=host(state);t.after(()=>owner.workflow.close());
  const task=await acquire(state,owner.workflow);
  return {state,owner,task};
}
async function initialize(owner,task,prior=null,id='fresh') {
  const input=request(task,prior,id,{mode:'fresh_draft',evidence:{...evidence,failure:'none'}});
  return (await owner.workflow.recovery(input,input)).state;
}

test('broker owns counters across loss, recovery and handoff; replay never reauthorizes an action', async t=>{
  const {state,owner,task}=await fixture(t);
  const before=await snapshot(state.root);
  assert.equal((await owner.workflow.recovery(request(task,null,'unknown'))).next,'pause_preserve_draft');
  assert.deepEqual(await snapshot(state.root),before);
  const initial=request(task,null,'fresh',{mode:'fresh_draft',evidence:{...evidence,failure:'none'}});
  await assert.rejects(owner.workflow.recovery(initial),/user_event_required/);
  const registered=await initialize(owner,task);
  const retry=request(task,registered,'retry');
  const reserved=await owner.workflow.recovery(retry);
  assert.equal(reserved.next,'retry_save_once'); assert.equal(reserved.actionReserved,true);
  assert.equal(reserved.state.budget.save,1);
  const saved=await snapshot(state.root);
  const replay=await owner.workflow.recovery(retry);
  assert.equal(replay.replayed,true); assert.equal(replay.actionReserved,false);
  assert.deepEqual(await snapshot(state.root),saved);
  await assert.rejects(owner.workflow.recovery({...retry,operationId:'stale'}),/stale_revision/);
  await owner.workflow.close();
  const replacement=host(state);t.after(()=>replacement.workflow.close());
  await assert.rejects(replacement.workflow.recovery(request(task,reserved.state,'foreign')),/broker_unavailable/);
  state.clock.now=new Date(Date.parse(state.clock.now)+300000).toISOString().replace('.000Z','Z');
  const recovery=event('recover',task,{operationId:'recover-broker'});
  const resumed=(await replacement.workflow.execute(recovery,recovery)).receipt.task;
  assert.deepEqual((await replacement.workflow.inspect('job')).recovery,reserved.state);
  assert.equal((await replacement.workflow.recovery(request(resumed,reserved.state,'again'))).next,'pause_preserve_draft');
  const signIn=request(resumed,reserved.state,'after-sign-in',{evidence:{...evidence,session:'reauthenticated'}});
  const signedIn=await replacement.workflow.recovery(signIn);
  assert.equal(signedIn.state.budget.afterSignIn,1);
  const refresh=request(resumed,signedIn.state,'refresh',{evidence:{...evidence,failure:'page_load',refreshApproved:true}});
  await assert.rejects(replacement.workflow.recovery(refresh),/user_event_required/);
  const refreshed=await replacement.workflow.recovery(refresh,refresh);
  assert.equal(refreshed.state.budget.refresh,1);
  const handoff=event('handoff',resumed,{operationId:'pause',session:pending});
  await replacement.workflow.execute(handoff);
  assert.deepEqual((await replacement.workflow.inspect('job')).recovery,refreshed.state);
  await assert.rejects(replacement.workflow.recovery(request(resumed,refreshed.state,'after-handoff')),/broker_unavailable/);
  const after=await snapshot(state.root);
  for(const key of ['profile.json','resumes.json','resume-facts.json']) assert.equal(after[key],before[key]);
  assert.deepEqual(JSON.parse(after['jobs.json']).jobs.other,JSON.parse(before['jobs.json']).jobs.other);
});

test('concurrent reservations reject stale counters; new attempt retains them until explicit fresh draft',async t=>{
  const {state,owner,task}=await fixture(t);
  const initial=await initialize(owner,task);
  const results=await Promise.allSettled(['one','two'].map(id=>owner.workflow.recovery(request(task,initial,id))));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.match(results.find(r=>r.status==='rejected').reason.message,/stale_revision/);
  const spent=(await owner.workflow.inspect('job')).recovery;
  await owner.workflow.execute(event('handoff',task,{operationId:'pause'}));
  await owner.workflow.close();
  const jobs=await read(state.root,'jobs.json');
  await state.claims.select('job',BigInt(jobs.jobs.job.revision),true);
  const replacement=host(state);t.after(()=>replacement.workflow.close());
  const current=await read(state.root,'jobs.json');
  const take=event('acquire',null,{operationId:'next-acquire',jobRevision:String(current.jobs.job.revision)});
  const next=(await replacement.workflow.execute(take,take)).receipt.task;
  assert.equal((await replacement.workflow.recovery(request(next,spent,'still-spent'))).next,'pause_preserve_draft');
  const reset=request(next,spent,'new-draft',{mode:'fresh_draft',evidence:{...evidence,failure:'none'}});
  await assert.rejects(replacement.workflow.recovery(reset),/user_event_required/);
  const fresh=await replacement.workflow.recovery(reset,reset);
  assert.notEqual(fresh.state.draftId,spent.draftId);
  assert.deepEqual(fresh.state.budget,{save:0,afterSignIn:0,refresh:0});
  await assert.rejects(replacement.workflow.recovery({...reset,operationId:'old-draft'} ,{...reset,operationId:'old-draft'}),/stale_revision/);
});

for(const when of ['before','after']) test(`atomic ${when}-publication failure cannot replenish a reservation`,async t=>{
  const {state,owner,task}=await fixture(t);
  const initial=await initialize(owner,task);
  await owner.workflow.close();
  state.clock.now=new Date(Date.parse(state.clock.now)+300000).toISOString().replace('.000Z','Z');
  let inject=true;
  const replacement=host(state,{[when]:async(path,value)=>{
    const doc=JSON.parse(serialize(value));
    if(inject && path.endsWith('jobs.json') && doc.metadata?.atsRecovery?.jobs.job.state.budget.save===1) {
      inject=false;throw Error('injected publication failure');
    }
  }});t.after(()=>replacement.workflow.close());
  const recover=event('recover',task,{operationId:'recover'});
  const current=(await replacement.workflow.execute(recover,recover)).receipt.task;
  const input=request(current,initial,'reserve');
  await assert.rejects(replacement.workflow.recovery(input),/injected publication failure/);
  const receipt=await replacement.workflow.recovery(input);
  assert.equal(receipt.state.budget.save,1);
  assert.equal(receipt.replayed,when==='after');
  assert.equal(receipt.actionReserved,when==='before');
});

test('closed requests, claim revision drift and corrupt durable counters fail without repair',async t=>{
  const {state,owner,task}=await fixture(t);
  const initial=await initialize(owner,task), before=await snapshot(state.root);
  for(const patch of [{budget:{save:0}},{jobRevision:'999'},{expectedRevision:'999'},
    {draftId:'different'},{evidence:{...evidence,errorCode:'I|private'}}]) {
    await assert.rejects(async()=>owner.workflow.recovery({...request(task,initial,'invalid'),...patch}));
    assert.deepEqual(await snapshot(state.root),before);
  }
  const jobs=await read(state.root,'jobs.json');jobs.metadata.atsRecovery.jobs.job.state.budget.save=1;
  await write(state.root,'jobs.json',jobs);
  const corrupt=await snapshot(state.root);
  await assert.rejects(owner.workflow.inspect('job'));
  assert.deepEqual(await snapshot(state.root),corrupt);
});

test('canonical input drift and revoked access reject reservations without spending budget',async t=>{
  const {state,owner,task}=await fixture(t), initial=await initialize(owner,task);
  owner.access.authorized=[];
  const before=await snapshot(state.root);
  await assert.rejects(owner.workflow.recovery(request(task,initial,'revoked')));
  assert.deepEqual(await snapshot(state.root),before);
  owner.access.authorized=['application_attempt'];
  const jobs=await read(state.root,'jobs.json');
  jobs.metadata.applicationRuns.runs['run-fixture'].selection.factRevision++;
  await write(state.root,'jobs.json',jobs);
  const changed=await snapshot(state.root);
  await assert.rejects(owner.workflow.recovery(request(task,initial,'drift')),/stale_revision/);
  assert.deepEqual(await snapshot(state.root),changed);
});


test('managed resume file drift blocks recovery reservations without changing counters',async t=>{
  const {state,owner,task}=await fixture(t), initial=await initialize(owner,task);
  const path=await state.repository.claimTransaction(async tx=>tx.files.path(
    object(get(object(get(tx.resumes,'resumes'),'resumes'),'resume'),'resume')));
  await writeFile(path,'CHANGED-FICTIONAL-RESUME');
  const before=await snapshot(state.root);
  await assert.rejects(owner.workflow.recovery(request(task,initial,'file-drift')),/stale_revision/);
  assert.deepEqual(await snapshot(state.root),before);
});
