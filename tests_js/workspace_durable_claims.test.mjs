import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup,read,write,snapshot,readyPacket,host,event,acquire,pending } from './workspace_durable_claims_support.mjs';
async function unchanged(state,run,pattern) {
  const before=await snapshot(state.root);
  await assert.rejects(run,pattern);assert.deepEqual(await snapshot(state.root),before);
}
test('durable claim workflow preserves the broker capability and canonical lifecycle',async t=>{
  const fixture=await nativeFixture();
  try {
    await t.test('acquire, progress replay, needs-info handoff and a new preparation cycle',async()=>{
      const state=await setup(fixture,'claim-lifecycle'),{workflow}=host(state);
      const first=await acquire(state,workflow);
      assert.equal(first.subject.jobRevision,'3');
      const p=event('progress',first),result=await workflow.execute(p);
      assert.equal(result.receipt.outcome,'progress_saved');
      const bytes=await snapshot(state.root);
      assert.equal((await workflow.execute(p)).replayed,true);assert.deepEqual(await snapshot(state.root),bytes);
      const handoff=event('handoff',result.receipt.task),done=await workflow.execute(handoff);
      assert.equal(done.receipt.outcome,'needs_info');assert.equal(done.receipt.task.status,'finished');
      assert.equal((await read(state.root,'coordinator.json')).claim,null);
      assert.deepEqual((await read(state.root,'sessions/job.json')).handoffChecklist,pending.handoffChecklist);
      assert.equal((await host(state).workflow.execute(handoff)).replayed,true);
      await state.claims.select('job',4n,true);
      const next=event('acquire',null,{operationId:'next',jobRevision:'5'});
      const resumed=await workflow.execute(next,next);
      assert.equal(resumed.receipt.task.subject.jobRevision,'6');
      assert.notEqual(resumed.receipt.task.taskId,first.taskId);
      const progress=await workflow.execute(event('progress',resumed.receipt.task,{operationId:'resumed-progress',session:{status:'active',step:'resumed'}}));
      assert.deepEqual((await read(state.root,'sessions/job.json')).handoffChecklist,pending.handoffChecklist);
      const cancel=event('cancel',progress.receipt.task);await workflow.execute(cancel,cancel);
      const ledger=(await read(state.root,'jobs.json')).metadata.agentWorkflows;
      assert.doesNotMatch(JSON.stringify(ledger),/claim_[A-Za-z0-9_-]{43}|token|PRIVATE|owner-input-required|resume_upload/);
      await workflow.close();
    });
    await t.test('broker loss cannot replay a bearer; explicit expiry recovery is scoped',async()=>{
      const state=await setup(fixture,'claim-loss'),old=host(state).workflow;
      const task=await acquire(state,old);await old.close();
      const next=host(state).workflow, request=event('acquire');
      assert.equal((await next.execute(request,request)).replayed,true);
      assert.equal((await next.inspect()).brokerAvailable,false);
      await unchanged(state,()=>next.execute(event('progress',task)),/broker_unavailable/);
      const recovery=event('recover',task);
      await unchanged(state,()=>next.execute(recovery),/user_event_required/);
      await unchanged(state,()=>next.execute(recovery,recovery),/live claim/);
      state.clock.now='2026-09-10T12:05:00Z';
      const beforeClaim=(await read(state.root,'coordinator.json')).claim;
      const recovered=await next.execute(recovery,recovery);
      assert.equal(recovered.receipt.outcome,'claim_recovered');
      assert.equal((await next.inspect()).brokerAvailable,true);
      assert.notEqual((await read(state.root,'coordinator.json')).claim.tokenHash,beforeClaim.tokenHash);
      const cancel=event('cancel',recovered.receipt.task);await next.execute(cancel,cancel);await next.close();
    });
    await t.test('duplicate concurrent acquisition executes once; another broker gets no capability',async()=>{
      const state=await setup(fixture,'claim-race');await state.claims.select('job',1n,true);
      const a=host(state).workflow,b=host(state).workflow,request=event('acquire');
      const results=await Promise.all([a.execute(request,request),b.execute(request,request)]);
      assert.equal(results.filter(x=>x.replayed).length,1);
      assert.equal((await a.inspect()).brokerAvailable!== (await b.inspect()).brokerAvailable,true);
      assert.equal((await read(state.root,'jobs.json')).jobs.job.revision,3);
      await a.close();await b.close();
    });
    await t.test('host attestation, exact revisions, changed IDs and revocation are enforced',async()=>{
      const state=await setup(fixture,'claim-guards'),{workflow,access}=host(state);
      await state.claims.select('job',1n,true);
      const request=event('acquire');
      await unchanged(state,()=>workflow.execute(request),/user_event_required/);
      await unchanged(state,()=>workflow.execute({...request,jobRevision:'1'},request),/user_event_required/);
      const task=(await workflow.execute(request,request)).receipt.task;
      await unchanged(state,()=>workflow.execute(event('progress',task,{expectedRevision:'99'})),/stale_revision/);
      await unchanged(state,()=>workflow.execute(event('progress',task,{operationId:'acquire'})),/operation_conflict/);
      access.authorized=[];
      await unchanged(state,()=>workflow.execute(event('progress',task)),/profile_unavailable/);
      await unchanged(state,()=>workflow.execute(request,request),/profile_unavailable/);
      const cancel=event('cancel',task);await workflow.execute(cancel,cancel);
      assert.equal((await read(state.root,'jobs.json')).jobs.job.status,'needs_info');
      await workflow.close();
    });
    await t.test('review requires current readiness; explicit restart keeps review history',async()=>{
      const state=await setup(fixture,'claim-review'),{workflow}=host(state),task=await acquire(state,workflow);
      await unchanged(state,()=>workflow.execute(event('handoff',task,{status:'awaiting_review',session:{status:'review'}})),/fresh current live/);
      const review=event('handoff',task,{status:'awaiting_review',session:{status:'review',handoffChecklist:[],readinessInput:readyPacket(3)}});
      const done=await workflow.execute(review);assert.equal(done.receipt.outcome,'awaiting_review');
      const restart=event('restart',null,{jobRevision:'4'});
      await unchanged(state,()=>workflow.execute(restart),/user_event_required/);
      const again=await workflow.execute(restart,restart);assert.equal(again.receipt.task.subject.jobRevision,'5');
      assert.equal((await read(state.root,'jobs.json')).jobs.job.status,'in_progress');
      await workflow.close();
    });
    await t.test('revocation during staging aborts before journal writes',async()=>{
      const state=await setup(fixture,'claim-revoke');await state.claims.select('job',1n,true);
      const original=state.repository.claimTransaction.bind(state.repository);
      const {ClaimWorkflow}=await import('../runtime/app/claim-workflow.js');
      const {NativeClaimWorkflowTasks}=await import('../runtime/store/native-claim-workflow-tasks.js');
      const access={enabled:['application_attempt'],authorized:['application_attempt']};
      const repository={claimTransaction:cb=>original(tx=>{
        const observation=tx.files.observation.bind(tx.files);
        tx.files.observation=async value=>{const result=await observation(value);access.authorized=[];return result;};
        return cb(tx);
      })};
      const workflow=new ClaimWorkflow(new NativeClaimWorkflowTasks(repository,()=>state.clock.now),state.claims,()=>access);
      const request=event('acquire');await unchanged(state,()=>workflow.execute(request,request),/profile_unavailable/);
      await workflow.close();
    });
    await t.test('routine progress reserves recovery and handoff capacity without evicting replay history',async()=>{
      const state=await setup(fixture,'claim-capacity'),{workflow}=host(state),task=await acquire(state,workflow);
      const jobs=await read(state.root,'jobs.json'),ledger=jobs.metadata.agentWorkflows;
      for(let i=0;i<253;i++) {
        const key=`historical-${i}`;
        ledger.receipts[key]={fingerprint:'a'.repeat(64),receipt:{...ledger.receipts.acquire.receipt,operationId:key}};
      }
      await write(state.root,'jobs.json',jobs);
      await unchanged(state,()=>workflow.execute(event('progress',task)),/history_full/);
      const request=event('acquire');assert.equal((await workflow.execute(request,request)).replayed,true);
      const cancel=event('cancel',task);await workflow.execute(cancel,cancel);
      assert.equal((await read(state.root,'coordinator.json')).claim,null);await workflow.close();
    });
    await t.test('input changes reject progress while cancellation preserves the existing handoff',async()=>{
      const state=await setup(fixture,'claim-inputs'),{workflow}=host(state),task=await acquire(state,workflow);
      const jobs=await read(state.root,'jobs.json');jobs.metadata.applicationRuns.activeRunId=null;
      jobs.metadata.applicationRuns.runs[state.run.runId].status='completed';
      jobs.metadata.applicationRuns.runs[state.run.runId].completedAt=state.clock.now;
      await write(state.root,'jobs.json',jobs);
      await unchanged(state,()=>workflow.execute(event('progress',task)),/stale_revision/);
      const cancel=event('cancel',task);await workflow.execute(cancel,cancel);
      assert.deepEqual((await read(state.root,'sessions/job.json')).handoffChecklist,pending.handoffChecklist);
      await workflow.close();
    });
    await t.test('failed journal publication leaves no receipt or claim',async()=>{
      const state=await setup(fixture,'claim-fault');await state.claims.select('job',1n,true);
      const {workflow}=host(state,{before:async()=>{throw Error('write failed');}}),request=event('acquire');
      await unchanged(state,()=>workflow.execute(request,request),/write failed/);await workflow.close();
    });
  } finally {await fixture.cleanup();}
});
