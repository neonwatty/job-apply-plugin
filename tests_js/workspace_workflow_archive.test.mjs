import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, chmod, symlink, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { NativeWorkflowArchive } from '../runtime/store/native-workflow-archive.js';
import { emptyWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';
import { runDurableOperation } from '../runtime/harness/run.js';
import { archiveDigest } from '../runtime/store/native-workflow-archive-files.js';
import { fixture, task, fullLedger, hash } from './workspace_workflow_archive_support.mjs';

test('70 completed tasks and 320 active receipts preserve exact global replay after replacement',async t=>{
  const state=await fixture(t),accepted=[];
  for(let index=0;index<70;index++) {
    const request={operationId:`done-${index}`,fingerprint:hash,taskId:null,expectedRevision:null};
    const result=await runDurableOperation(state.store,request,{authorize(){},execute:async()=>({task:task(`done-${index}`),outcome:'cancelled'})});
    accepted.push([request,result.receipt]);
  }
  let current=null;
  for(let index=0;index<320;index++) {
    const request={operationId:`recover-${index}`,fingerprint:hash,taskId:current?.taskId??null,expectedRevision:current?.revision??null};
    const result=await runDurableOperation(state.store,request,{authorize(){},execute:async prior=>({task:task('long-active',prior?(BigInt(prior.revision)+1n).toString():'1','waiting'),outcome:'claim_recovered'})});
    current=result.receipt.task;accepted.push([request,result.receipt]);
  }
  assert.ok(state.ledger().archive.segments.length>=2);
  assert.deepEqual(state.ledger().tasks['long-active'].pending,{requestId:'request',questionId:'question'});
  const before=await state.read();
  for(const [request,receipt] of [accepted[0],accepted[62],accepted[70],accepted.at(-1)]) {
    const replay=await runDurableOperation(state.store,request,{authorize(){},execute:async()=>assert.fail('replay executed domain')});
    assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,receipt);
    await assert.rejects(runDurableOperation(state.store,{...request,fingerprint:'b'.repeat(64)},{authorize(){},execute:async()=>assert.fail()}),/operation_conflict/);
  }
  await assert.rejects(runDurableOperation(state.store,accepted[0][0],{authorize(){throw Error('revoked');},execute:async()=>assert.fail()}),/revoked/);
  assert.equal(await state.read(),before);
});

test('prepare is read-only and interrupted unpublished data never supplies replay evidence',async t=>{
  const state=await fixture(t),ledger=fullLedger(state.archive);
  const plan=await state.archive.prepare(ledger);
  assert.deepEqual(await readdir(state.root),['hot.json']);
  assert.equal(Object.keys(plan.ledger.tasks).length,0);
  const interrupted=new NativeWorkflowArchive(state.root,async stage=>{if(stage==='archive_file_written')throw Error('interrupted');});
  await assert.rejects((await interrupted.prepare(ledger)).flush(),/interrupted/);
  const recovered=await state.archive.prepare(ledger);
  assert.equal(recovered.history.receipt('op-task-0').receipt.operationId,'op-task-0');
  assert.equal((await state.archive.prepare(state.archive.migrate(emptyWorkflowLedger()))).history.receipt('op-task-0'),null);
  await recovered.flush();await state.archive.validate(recovered.ledger);
  assert.equal((await readdir(join(state.root,'workflow-archive'))).length,1);
});

test('missing, corrupt, unsupported, linked and unowned-mode archive state fails closed',async t=>{
  const state=await fixture(t),prepared=await state.archive.prepare(fullLedger(state.archive));
  await prepared.flush();
  const digest=prepared.ledger.archive.segments[0].digest,path=join(state.root,'workflow-archive',`${digest}.json`);
  const original=await readFile(path);
  await writeFile(path,'{}');await assert.rejects(state.archive.validate(prepared.ledger),/workflow_archive_corrupt/);
  await writeFile(path,original);await chmod(path,0o644);await assert.rejects(state.archive.validate(prepared.ledger),/workflow_archive_corrupt/);
  await chmod(path,0o600);await unlink(path);await assert.rejects(state.archive.validate(prepared.ledger),/workflow_archive_corrupt/);
  const external=join(state.root,'external');await writeFile(external,original,{mode:0o600});
  await symlink(external,path);await assert.rejects(state.archive.validate(prepared.ledger),/workflow_archive_corrupt/);
  await unlink(path);await link(external,path);await assert.rejects(state.archive.validate(prepared.ledger),/workflow_archive_corrupt/);
  await unlink(path);await writeFile(path,original,{mode:0o600});
  await assert.rejects(state.archive.validate({...prepared.ledger,schemaVersion:3}),/workflow_archive_corrupt/);
  const broken=structuredClone(prepared.ledger);broken.archive.segments[0].taskCount--;
  await assert.rejects(state.archive.validate(broken),/workflow_archive_corrupt/);
  assert.deepEqual(await readFile(external),original);
});

test('archive union rejects duplicated operation IDs and task resurrection before publication',async t=>{
  const state=await fixture(t),prepared=await state.archive.prepare(fullLedger(state.archive));await prepared.flush();
  const duplicate=structuredClone(prepared.ledger),existing=task('task-0');
  duplicate.tasks['task-0']=existing;
  duplicate.receipts['op-task-0']={fingerprint:hash,receipt:{operationId:'op-task-0',task:existing,outcome:'cancelled'}};
  await assert.rejects(state.archive.validate(duplicate),/workflow_archive_corrupt/);
  duplicate.receipts={};duplicate.tasks['task-0']=task('task-0','2','active');duplicate.activeTaskId='task-0';
  await assert.rejects(state.archive.validate(duplicate),/workflow_archive_corrupt/);
});

test('32 finite segments preserve all history and report exhausted compaction without eviction',async t=>{
  const state=await fixture(t);let ledger=state.ledger();
  for(let index=0;index<32;index++) {
    const fresh=fullLedger(state.archive,`batch-${index}`);fresh.archive=ledger.archive;
    const prepared=await state.archive.prepare(fresh);await prepared.flush();ledger=prepared.ledger;
  }
  const hot=fullLedger(state.archive,'last');hot.archive=ledger.archive;
  const names=await readdir(join(state.root,'workflow-archive'));
  const exhausted=await state.archive.prepare(hot);await exhausted.flush();
  assert.deepEqual(exhausted.ledger,hot);assert.deepEqual(await readdir(join(state.root,'workflow-archive')),names);
  assert.equal(exhausted.history.receipt('op-batch-0-0').receipt.operationId,'op-batch-0-0');
  assert.equal(exhausted.history.task('batch-31-62').taskId,'batch-31-62');
  hot.tasks.extra=task('extra');
  for(let index=Object.keys(hot.receipts).length;index<256;index++) {
    const operationId=`full-${index}`;
    hot.receipts[operationId]={fingerprint:hash,receipt:{operationId,task:hot.tasks.extra,outcome:'cancelled'}};
  }
  await state.save(hot);const before=await state.read();
  await assert.rejects(runDurableOperation(state.store,{operationId:'overflow',fingerprint:hash,taskId:null,expectedRevision:null},
    {authorize(){},execute:async()=>assert.fail('full archive executed domain')}),/history_full/);
  assert.equal(await state.read(),before);
});

test('segment schema is closed and digest replacement cannot smuggle capability material',async t=>{
  const state=await fixture(t),prepared=await state.archive.prepare(fullLedger(state.archive));await prepared.flush();
  const ref=prepared.ledger.archive.segments[0],directory=join(state.root,'workflow-archive');
  const payload=JSON.parse(await readFile(join(directory,`${ref.digest}.json`),'utf8'));
  payload.token='PRIVATE-BEARER';const bytes=JSON.stringify(payload),digest=archiveDigest(bytes);
  await writeFile(join(directory,`${digest}.json`),bytes,{mode:0o600});
  const altered=structuredClone(prepared.ledger);altered.archive.segments[0].digest=digest;
  await assert.rejects(state.archive.validate(altered),/workflow_archive_corrupt/);
});
