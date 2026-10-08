import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup, runtime, snapshot, read, write, waiting, rejectedUnchanged } from './workspace_durable_preparation_support.mjs';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { NativeWorkflowTasks } from '../runtime/store/native-workflow-tasks.js';
import { PreparationWorkflow } from '../runtime/app/preparation-workflow.js';
import { preparationProfile } from '../runtime/workflows/applications/prepare.js';

async function request(workflow, operationId='select') {
  const {selection}=await workflow.inspect('job');
  const {jobId,jobRevision,inputRevision}=selection;
  return {operationId,jobId,jobRevision,inputRevision};
}

test('explicit selection binds canonical inputs and atomically finishes with one receipt', {timeout:90000},async t=>{
  const fixture=await nativeFixture();
  t.after(()=>fixture.cleanup());
  await t.test('compact read, one write, fresh-instance replay and conflicting delivery',async()=>{
    const state=await setup(fixture,'direct'),app=runtime(state),before=await snapshot(state.root);
    const context=await app.workflow.inspect('job');
    assert.deepEqual(context.selection.allowedActions,['select']);
    assert.equal(context.selection.status,'saved');
    assert.deepEqual(await snapshot(state.root),before);
    const input=await request(app.workflow),result=await app.workflow.select(input);
    assert.equal(result.receipt.outcome,'job_ready');
    assert.equal(result.receipt.task.revision,'1');
    assert.equal(result.receipt.task.status,'finished');
    assert.equal(result.receipt.task.pending,null);
    assert.equal(result.receipt.task.subject.jobRevision,'2');
    const after=await snapshot(state.root),jobs=await read(state.root,'jobs.json');
    assert.deepEqual(Object.keys(after).filter(key=>before[key]!==after[key]),['jobs.json']);
    assert.deepEqual(jobs.jobs.other,JSON.parse(before['jobs.json']).jobs.other);
    assert.deepEqual(jobs.metadata.applicationRuns,JSON.parse(before['jobs.json']).metadata.applicationRuns);
    assert.equal(Object.keys(jobs.metadata.agentWorkflows.tasks).length,1);
    assert.equal(Object.keys(jobs.metadata.agentWorkflows.receipts).length,1);
    assert.equal(app.writes.length,1);
    const fresh=runtime(state);
    assert.deepEqual(await fresh.workflow.select(input),{...result,replayed:true});
    assert.deepEqual(await snapshot(state.root),after);
    assert.equal((await fresh.workflow.inspect('job')).selection.ready,true);
    await rejectedUnchanged(state,()=>fresh.workflow.select({...input,jobRevision:'2'}),/operation_conflict/);
    fresh.access.authorized=[];
    await rejectedUnchanged(state,()=>fresh.workflow.select(input),/profile_unavailable/);
    assert.deepEqual((await fresh.workflow.inspect('job')).selection.allowedActions,[]);
  });
  await t.test('stored Ready is not current readiness when confirmed input scope disappears',async()=>{
    const state=await setup(fixture,'stale-ready'),app=runtime(state);
    await app.workflow.select(await request(app.workflow));
    const jobs=await read(state.root,'jobs.json');
    delete jobs.metadata.applicationRuns;
    await write(state.root,'jobs.json',jobs);
    const before=await snapshot(state.root),context=await app.workflow.inspect('job');
    assert.equal(context.selection.status,'ready');
    assert.equal(context.selection.ready,false);
    assert.deepEqual(context.selection.allowedActions,[]);
    assert.deepEqual(await snapshot(state.root),before);
  });
  await t.test('stale job and unchanged-job input drift reject without writes',async()=>{
    for(const change of ['job','run']) {
      const state=await setup(fixture,change),app=runtime(state),input=await request(app.workflow);
      if(change==='job')await state.jobs.update('job',fromJSON({notes:'changed'}),1n);
      else {
        const jobs=await read(state.root,'jobs.json'),run=jobs.metadata.applicationRuns.runs['run-fixture'];
        run.revision=2;run.queueVersions.push({revision:2,jobIds:['job','other'],updatedAt:state.clock.now});
        await write(state.root,'jobs.json',jobs);
      }
      await rejectedUnchanged(state,()=>app.workflow.select(input),/stale_revision/);
    }
  });
  await t.test('active pending task cannot be bypassed and claim acquisition blocks selection',async()=>{
    const state=await setup(fixture,'pending'),app=runtime(state),input=await request(app.workflow);
    const task=await waiting(app.workflow);
    assert.deepEqual((await app.workflow.inspect('job')).selection.allowedActions,[]);
    await rejectedUnchanged(state,()=>app.workflow.select(input),/task_conflict/);
    assert.deepEqual((await app.workflow.inspect()).task,task);
    const claimed=await setup(fixture,'claimed'),live=runtime(claimed);
    await claimed.claims.select('job',1n,true);
    const current=await request(live.workflow);
    await claimed.claims.acquire('job',text('Synthetic'),2n);
    await rejectedUnchanged(claimed,()=>live.workflow.select(current),/stale_revision/);
    const held=await request(live.workflow);
    assert.deepEqual((await live.workflow.inspect('job')).selection.allowedActions,[]);
    await rejectedUnchanged(claimed,()=>live.workflow.select(held),/claim/);
  });
  await t.test('closed input rejects forged state and concurrent duplicates commit once',async()=>{
    const state=await setup(fixture,'concurrent'),a=runtime(state),b=runtime(state),input=await request(a.workflow);
    for(const extra of [{state:'finished'},{hostUserEvent:true},{inputRevision:'wrong'},{jobRevision:1}]) {
      await rejectedUnchanged(state,()=>a.workflow.select({...input,...extra}),/invalid_arguments/);
    }
    const results=await Promise.all([a.workflow.select(input),b.workflow.select(input)]);
    assert.deepEqual(results.map(item=>item.replayed).sort(),[false,true]);
    assert.equal(a.writes.length+b.writes.length,1);
    await rejectedUnchanged(state,()=>b.workflow.select({...input,operationId:'competitor'}),/stale_revision/);
  });
  await t.test('write interruptions preserve the atomic selection/receipt retry boundary',async()=>{
    for(const phase of ['beforeWrite','afterWrite']) {
      const state=await setup(fixture,phase),input=await request(runtime(state).workflow),before=await snapshot(state.root);
      const failing=runtime(state,{[phase]:async()=>{throw Error('interrupted');}});
      await assert.rejects(failing.workflow.select(input),/interrupted/);
      if(phase==='beforeWrite')assert.deepEqual(await snapshot(state.root),before);
      const fresh=runtime(state),result=await fresh.workflow.select(input);
      assert.equal(result.replayed,phase==='afterWrite');
      assert.equal((await read(state.root,'jobs.json')).jobs.job.revision,2);
      assert.equal(fresh.writes.length,phase==='afterWrite'?0:1);
    }
  });
  await t.test('revoked access during file observation discards staged selection',async()=>{
    const state=await setup(fixture,'revoked'),input=await request(runtime(state).workflow);
    let permitted=true;
    const wrapped={claimTransaction:callback=>state.repository.claimTransaction(tx=>{
      const observation=tx.files.observation.bind(tx.files);
      tx.files.observation=async record=>{const result=await observation(record);permitted=false;return result;};
      return callback(tx);
    })};
    const workflow=new PreparationWorkflow(new NativeWorkflowTasks(wrapped,()=>state.clock.now),()=>({enabled:[preparationProfile],authorized:permitted?[preparationProfile]:[]}));
    await rejectedUnchanged(state,()=>workflow.select(input),/profile_unavailable/);
  });
});
