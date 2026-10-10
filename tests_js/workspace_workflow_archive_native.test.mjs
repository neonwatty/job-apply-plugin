import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, read, write, snapshot, host, event, pending } from './workspace_durable_claims_support.mjs';
import { runtime, start, ask, cancel } from './workspace_durable_preparation_support.mjs';
import { experimentalArchive } from '../runtime/cli/experimental-archive.js';
import { NativeWorkflowArchive } from '../runtime/store/native-workflow-archive.js';
import { NativeStoreBootstrap } from '../runtime/store/native-store-bootstrap.js';
import { ApplicationRunsService } from '../runtime/workspace-core/application-runs.js';
import { TrashService } from '../runtime/workspace-core/trash.js';
import { fromJSON, get } from '../runtime/contracts/workspace/values.js';
import { fullLedger } from './workspace_workflow_archive_support.mjs';
const activate=(fixture,state)=>experimentalArchive(['activate','--root',state.root,'--native-lock',fixture.receipt.artifact]);
async function allBytes(root) {
  const result=await snapshot(root);
  let files;try {files=await readdir(join(root,'workflow-archive'));} catch {files=[];}
  for(const name of files)result[`workflow-archive/${name}`]=(await readFile(join(root,'workflow-archive',name))).toString('base64');
  return result;
}

test('native adapters exceed old bounds and archived claim approval survives trash', {timeout:120000},async t=>{
  const fixture=await nativeFixture();t.after(()=>fixture.cleanup());
  const state=await setup(fixture,'archive-native');
  const initial=await read(state.root,'jobs.json');assert.equal(initial.metadata.agentWorkflows,undefined);
  await state.repository.transaction(async()=>{});
  assert.equal((await read(state.root,'jobs.json')).metadata.agentWorkflows,undefined);
  await activate(fixture,state);const preparation=runtime(state).workflow;
  let first;
  for(let index=0;index<70;index++) {
    const request=start(`start-${index}`),started=await preparation.route(request);
    first??={request,result:started};
    const waiting=(await preparation.action(ask(started.receipt.task,`ask-${index}`))).receipt.task;
    await preparation.route(cancel(waiting,`cancel-${index}`));
  }
  let ledger=(await read(state.root,'jobs.json')).metadata.agentWorkflows;
  assert.ok(ledger.archive.segments.length>0);assert.ok(Object.keys(ledger.tasks).length<64);
  assert.deepEqual((await runtime(state).workflow.route(first.request)).receipt,first.result.receipt);
  await state.claims.select('job',1n,true);
  let workflow=host(state).workflow;
  const acquire=event('acquire'),acquired=await workflow.execute(acquire,acquire);
  let task=(await workflow.execute(event('progress',acquired.receipt.task))).receipt.task;
  const saved=await readFile(join(state.root,'sessions/job.json'),'utf8');
  for(let index=0;index<260;index++) {
    await workflow.close();state.clock.now=new Date(Date.parse(state.clock.now)+300000).toISOString().replace('.000Z','Z');
    workflow=host(state).workflow;
    const request=event('recover',task,{operationId:`recovery-${index}`});
    task=(await workflow.execute(request,request)).receipt.task;
  }
  assert.equal(await readFile(join(state.root,'sessions/job.json'),'utf8'),saved);
  assert.deepEqual((await read(state.root,'sessions/job.json')).handoffChecklist,pending.handoffChecklist);
  ledger=(await read(state.root,'jobs.json')).metadata.agentWorkflows;
  assert.ok(ledger.archive.segments.reduce((sum,segment)=>sum+segment.receiptCount,0)>256);
  const handoff=event('handoff',task);await workflow.execute(handoff);await workflow.close();
  await new ApplicationRunsService(state.repository,()=>state.clock.now).update('run-fixture',1n,fromJSON({jobIds:['other']}));
  await new TrashService(state.repository,()=>state.clock.now).trashJob('job',4n);
  const replacement=host(state).workflow;t.after(()=>replacement.close());
  const before=await allBytes(state.root),review=await replacement.reviewUserEvent(acquire);
  assert.equal(review.binding.inputRevision,acquired.receipt.task.subject.inputRevision);
  const replay=await replacement.execute(acquire,acquire);
  assert.deepEqual(replay.receipt,acquired.receipt);assert.equal(replay.replayed,true);
  assert.equal((await replacement.inspect()).brokerAvailable,false);
  await assert.rejects(replacement.reviewUserEvent({...acquire,jobRevision:'99'}),/operation_conflict/);
  assert.deepEqual(await allBytes(state.root),before);
  const archiveBytes=Object.entries(before).filter(([name])=>name.startsWith('workflow-archive/')).map(([,value])=>Buffer.from(value,'base64').toString()).join('');
  assert.doesNotMatch(archiveBytes,/claim_[A-Za-z0-9_-]{43}|tokenHash|PRIVATE-RESUME|PRIVATE-PROFILE/);
});

test('pending claim archive corruption blocks ordinary and bootstrap recovery before writes',async t=>{
  const fixture=await nativeFixture();t.after(()=>fixture.cleanup());
  const state=await setup(fixture,'archive-pending');await state.claims.select('job',1n,true);await activate(fixture,state);
  const jobs=await read(state.root,'jobs.json');jobs.metadata.agentWorkflows=fullLedger(new NativeWorkflowArchive(state.root));await write(state.root,'jobs.json',jobs);
  const writer=host(state,{after:async(path,value)=>{if(path.endsWith('coordinator-journal.json')&&get(value,'operation')!==null)throw Error('interrupted');}});
  const request=event('acquire');await assert.rejects(writer.workflow.execute(request,request),/interrupted/);
  const journal=await read(state.root,'coordinator-journal.json'),ref=journal.operation.workflow.after.archive.segments[0];
  const path=join(state.root,'workflow-archive',`${ref.digest}.json`),original=await readFile(path);
  await writeFile(path,'{}');const before=await allBytes(state.root),replacement=host(state);
  await assert.rejects(replacement.repository.transaction(async()=>{}),/workflow_archive_corrupt/);
  assert.deepEqual(replacement.writes,[]);assert.deepEqual(await allBytes(state.root),before);
  await assert.rejects(new NativeStoreBootstrap(state.root,join(fixture.root,'absent-legacy.json')).initialize(),/workflow_archive_corrupt/);
  assert.deepEqual(await allBytes(state.root),before);
  await writeFile(path,original);await replacement.repository.transaction(async()=>{});
  const recovered=await allBytes(state.root);
  assert.equal((await replacement.workflow.execute(request,request)).replayed,true);
  await replacement.repository.transaction(async()=>{});assert.deepEqual(await allBytes(state.root),recovered);
});
