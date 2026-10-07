import { NativeWorkflowTasks } from '../runtime/store/native-workflow-tasks.js';
import { PreparationWorkflow } from '../runtime/app/preparation-workflow.js';
import { preparationProfile } from '../runtime/workflows/applications/prepare.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { fromJSON, text } from '../runtime/contracts/workspace/values.js';
import { encodeWorkflowLedger, decodeWorkflowLedger, emptyWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';
import { setup, read, write, snapshot, runtime, start, ask, reply, cancel, waiting, rejectedUnchanged } from './workspace_durable_preparation_support.mjs';

test('durable preparation stages canonical selection, scoped intent and value-free receipts', {timeout:90000},async t=>{
  const fixture=await nativeFixture();
  try {
    await t.test('start, persisted pause, fresh-process reply, and all duplicate deliveries are byte-idempotent',async()=>{
      const state=await setup(fixture,'replay'), first=runtime(state);
      const before=await snapshot(state.root);
      assert.deepEqual(await first.workflow.inspect(),{task:null,context:null});
      assert.deepEqual(await snapshot(state.root),before);
      const started=await first.workflow.route(start()), asked=await first.workflow.action(ask(started.receipt.task));
      const bytes=await snapshot(state.root), restarted=runtime(state);
      const context=await restarted.workflow.inspect();
      assert.deepEqual(context.task,asked.receipt.task);
      assert.deepEqual(context.context.allowedActions,[]);
      const replayStart=await restarted.workflow.route(start());
      assert.deepEqual(replayStart,{receipt:started.receipt,replayed:true});
      assert.deepEqual(await snapshot(state.root),bytes);
      const event=reply(asked.receipt.task), result=await restarted.workflow.route(event.proposal,event.attestation);
      assert.equal(result.receipt.outcome,'job_ready');
      assert.equal(result.receipt.task.revision,'3');
      assert.equal(result.receipt.task.subject.jobRevision,'2');
      const jobs=await read(state.root,'jobs.json');
      assert.equal(jobs.jobs.job.status,'ready');assert.equal(jobs.jobs.job.revision,2);
      assert.equal(jobs.jobs.other.revision,1);
      assert.deepEqual(jobs.metadata.applicationRuns,state.run?JSON.parse(before['jobs.json']).metadata.applicationRuns:null);
      const after=await snapshot(state.root);
      assert.deepEqual(Object.keys(after).filter(key=>before[key]!==after[key]),['jobs.json']);
      const repeated=await restarted.workflow.route(event.proposal,event.attestation);
      assert.deepEqual(repeated,{receipt:result.receipt,replayed:true});
      assert.deepEqual(await snapshot(state.root),after);
      assert.deepEqual(await restarted.workflow.inspect(),{task:null,context:null});
      assert.doesNotMatch(JSON.stringify(jobs.metadata.agentWorkflows),/PRIVATE|token|path|name|questionText/);
      assert.deepEqual(restarted.writes,[join(state.root,'jobs.json')]);
    });
    await t.test('unattested, mismatched, stale and fabricated replies never write',async()=>{
      const state=await setup(fixture,'scope'), {workflow}=runtime(state), task=await waiting(workflow), event=reply(task);
      await rejectedUnchanged(state,()=>workflow.route(event.proposal),/user_event_required/);
      await rejectedUnchanged(state,()=>workflow.route(event.proposal,{...event.attestation,expectedRevision:'1'}),/user_event_required/);
      const forged={...event.proposal,event:{...event.proposal.event,requestId:'invented'}};
      await rejectedUnchanged(state,()=>workflow.route(forged,{...event.attestation,reply:forged.event}),/user_event_required/);
      await state.jobs.update('job',fromJSON({notes:'owner correction'}),1n);
      await rejectedUnchanged(state,()=>workflow.route(event.proposal,event.attestation),/stale_revision/);
      assert.equal((await workflow.route(cancel(task))).receipt.outcome,'cancelled');
    });
    await t.test('profile revocation rejects continuation and replay but permits safe cancellation',async()=>{
      const state=await setup(fixture,'revocation'), app=runtime(state), task=await waiting(app.workflow), event=reply(task);
      app.access.authorized=[];
      await rejectedUnchanged(state,()=>app.workflow.route(event.proposal,event.attestation),/profile_unavailable/);
      await rejectedUnchanged(state,()=>app.workflow.route(start()),/profile_unavailable/);
      assert.deepEqual((await app.workflow.inspect()).context.allowedActions,[]);
      assert.equal((await app.workflow.route(cancel(task))).receipt.task.status,'cancelled');
    });
    await t.test('a claim acquired elsewhere blocks pause, reply and cancellation until existing handoff releases it',async()=>{
      const state=await setup(fixture,'claimed'), {workflow}=runtime(state), task=await waiting(workflow), event=reply(task);
      await state.claims.select('job',1n,true);
      const acquired=await state.claims.acquire('job',text('Synthetic'),2n);
      const token=acquired.get(text('token'));
      await rejectedUnchanged(state,()=>workflow.route(event.proposal,event.attestation),/handoff_required/);
      await rejectedUnchanged(state,()=>workflow.route(cancel(task)),/handoff_required/);
      await state.claims.handoff('job',token,'needs_info',fromJSON({status:'active'}),3n);
      assert.equal((await workflow.route(cancel(task))).receipt.outcome,'cancelled');
    });
    await t.test('concurrent duplicate replies write once and competing IDs cannot consume one reply twice',async()=>{
      const state=await setup(fixture,'concurrent'), a=runtime(state), b=runtime(state), task=await waiting(a.workflow), event=reply(task);
      a.writes.length=0;
      const results=await Promise.all([a.workflow.route(event.proposal,event.attestation),b.workflow.route(event.proposal,event.attestation)]);
      assert.deepEqual(results.map(item=>item.replayed).sort(),[false,true]);
      assert.equal(a.writes.length+b.writes.length,1);
      await rejectedUnchanged(state,()=>b.workflow.route({...event.proposal,operationId:'different'},event.attestation),/task_conflict/);
      await rejectedUnchanged(state,()=>b.workflow.route({...event.proposal,event:{...event.proposal.event,decision:'decline'}},
        {...event.attestation,reply:{...event.proposal.event,decision:'decline'}}),/operation_conflict/);
    });
    await t.test('failure before commit leaves selection and ledger unchanged; failure after write replays the accepted receipt',async()=>{
      for(const phase of ['beforeWrite','afterWrite']) {
        const state=await setup(fixture,phase), normal=runtime(state), task=await waiting(normal.workflow), event=reply(task);
        const before=await snapshot(state.root);
        const failure=runtime(state,{[phase]:async()=>{throw Error('synthetic write interruption');}});
        await assert.rejects(failure.workflow.route(event.proposal,event.attestation),/synthetic write interruption/);
        if(phase==='beforeWrite') assert.deepEqual(await snapshot(state.root),before);
        const fresh=runtime(state), result=await fresh.workflow.route(event.proposal,event.attestation);
        assert.equal(result.replayed,phase==='afterWrite');
        assert.equal((await read(state.root,'jobs.json')).jobs.job.revision,2);
        assert.equal(fresh.writes.length,phase==='afterWrite'?0:1);
      }
    });
    await t.test('input drift rechecks preflight, and revocation during observation discards a staged selection',async()=>{
      const state=await setup(fixture,'input-drift'), app=runtime(state), task=await waiting(app.workflow), event=reply(task);
      const jobs=await read(state.root,'jobs.json');
      delete jobs.metadata.applicationRuns;await write(state.root,'jobs.json',jobs);
      await rejectedUnchanged(state,()=>app.workflow.route(event.proposal,event.attestation),/stale_revision/);
      const denied=reply(task,'decline');
      assert.equal((await app.workflow.route(denied.proposal,denied.attestation)).receipt.outcome,'declined');
      const revoked=await setup(fixture,'revoked-during-observation');
      let permitted=true, armed=false;
      const wrapped={claimTransaction:callback=>revoked.repository.claimTransaction(tx=>{
        const observation=tx.files.observation.bind(tx.files);
        tx.files.observation=async record=>{const result=await observation(record);if(armed)permitted=false;return result;};
        return callback(tx);
      })};
      const live=new PreparationWorkflow(new NativeWorkflowTasks(wrapped,()=>revoked.clock.now),()=>({enabled:[preparationProfile],authorized:permitted?[preparationProfile]:[]}));
      const pending=await waiting(live), accepted=reply(pending);armed=true;
      await rejectedUnchanged(revoked,()=>live.route(accepted.proposal,accepted.attestation),/profile_unavailable/);
    });
    await t.test('a new input scope invalidates an unchanged job revision',async()=>{
      const state=await setup(fixture,'scope-change'), {workflow}=runtime(state), task=await waiting(workflow), event=reply(task);
      const jobs=await read(state.root,'jobs.json');
      jobs.metadata.applicationRuns.runs['run-fixture'].revision=2;
      jobs.metadata.applicationRuns.runs['run-fixture'].queueVersions.push({revision:2,jobIds:['job','other'],updatedAt:state.clock.now});
      await write(state.root,'jobs.json',jobs);
      await rejectedUnchanged(state,()=>workflow.route(event.proposal,event.attestation),/stale_revision/);
    });
    await t.test('deleted subjects can be safely cancelled and ordinary mutations preserve task metadata',async()=>{
      const state=await setup(fixture,'deleted'), app=runtime(state), task=await waiting(app.workflow);
      const saved=(await read(state.root,'jobs.json')).metadata.agentWorkflows;
      await state.jobs.update('other',fromJSON({notes:'unrelated edit'}),1n);
      assert.deepEqual((await read(state.root,'jobs.json')).metadata.agentWorkflows,saved);
      const jobs=await read(state.root,'jobs.json');jobs.jobs.job.deletedAt=state.clock.now;await write(state.root,'jobs.json',jobs);
      assert.equal((await app.workflow.inspect()).subject.status,'unavailable');
      assert.equal((await app.workflow.route(cancel(task))).receipt.outcome,'cancelled');
    });
    await t.test('task and action state cannot be supplied or skipped by a model proposal',async()=>{
      const state=await setup(fixture,'proposals'), {workflow}=runtime(state);
      await rejectedUnchanged(state,()=>workflow.route({...start(),state:{status:'finished'}}),/invalid_proposal/);
      const task=(await workflow.route(start())).receipt.task;
      await rejectedUnchanged(state,()=>workflow.action({...ask(task),kind:'finish'}),/action_unavailable/);
      await rejectedUnchanged(state,()=>workflow.action({...ask(task),kind:'callTool',actionId:'application.select',arguments:{jobId:'job',jobRevision:'1'}}),/action_unavailable/);
      await rejectedUnchanged(state,()=>workflow.route(start('another-start')),/task_conflict/);
      await rejectedUnchanged(state,()=>workflow.action({...ask(task),expectedRevision:'9'}),/stale_revision/);
    });
    await t.test('bounded history refuses a new task without evicting replay receipts',async()=>{
      const state=await setup(fixture,'history-limit'), {workflow}=runtime(state);
      const task=(await workflow.route(start())).receipt.task;
      await workflow.route(cancel(task));
      const jobs=await read(state.root,'jobs.json'), seed=jobs.metadata.agentWorkflows;
      for(let index=1;index<64;index++) {
        const id='archived-'+index, old=structuredClone(seed.tasks[task.taskId]);old.taskId=id;
        seed.tasks[id]=old;
        for(const operationId of ['start','cancel']) {
          const value=structuredClone(seed.receipts[operationId]), key=operationId+'-'+index;
          value.receipt.operationId=key;value.receipt.task.taskId=id;seed.receipts[key]=value;
        }
      }
      await write(state.root,'jobs.json',jobs);
      await rejectedUnchanged(state,()=>workflow.route(start('overflow')),/history_full/);
      const before=await snapshot(state.root);
      assert.equal((await workflow.route(start())).replayed,true);
      assert.deepEqual(await snapshot(state.root),before);
    });
    await t.test('unsupported metadata versions fail closed without resetting durable state',async()=>{
      const state=await setup(fixture,'version'), {workflow}=runtime(state);
      const jobs=await read(state.root,'jobs.json');jobs.metadata.agentWorkflows={...emptyWorkflowLedger(),schemaVersion:2};await write(state.root,'jobs.json',jobs);
      await rejectedUnchanged(state,()=>workflow.route(start()),/invalid_task_state/);
      await rejectedUnchanged(state,()=>state.jobs.update('other',fromJSON({notes:'blocked'}),1n),/invalid_task_state/);
    });
  } finally {await fixture.cleanup();}
});

test('workflow metadata codecs reject extra values, orphan history and impossible active pointers',()=>{
  assert.deepEqual(decodeWorkflowLedger(encodeWorkflowLedger(emptyWorkflowLedger())),JSON.parse(JSON.stringify(emptyWorkflowLedger())));
  for(const invalid of [{...emptyWorkflowLedger(),schemaVersion:2},{...emptyWorkflowLedger(),activeTaskId:'absent'},
    {...emptyWorkflowLedger(),privateValue:'PRIVATE'},{...emptyWorkflowLedger(),receipts:{orphan:{fingerprint:'a'.repeat(64),receipt:{}}}}]) {
    assert.throws(()=>decodeWorkflowLedger(fromJSON(invalid)),/invalid_task_state/);
  }
});
