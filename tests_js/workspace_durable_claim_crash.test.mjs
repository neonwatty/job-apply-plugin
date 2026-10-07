import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { setup,read,write,snapshot,host } from './workspace_durable_claims_support.mjs';
import { killClaimAt } from './workspace_durable_claim_crash_support.mjs';
import { emptyWorkflowLedger } from '../runtime/contracts/workspace/workflow-tasks.js';

test('claim and workflow receipts converge after SIGKILL at every durable boundary', {timeout:60000},async t=>{
  const fixture=await nativeFixture();
  try {
    for(const kind of ['acquire','recover','progress','handoff','cancel']) {
      const stages=['journal','jobs.json',...(['progress','handoff','cancel'].includes(kind)?['sessions/job.json']:[]),'history','coordinator.json','clear'];
      for(const stage of stages) await t.test(`${kind}:${stage}`,async()=>{
        const state=await setup(fixture,`${kind}-${stage.replaceAll('/','-')}`);
        await state.claims.select('job',1n,true);
        const request=await killClaimAt(state,fixture,kind,stage);
        const {workflow,repository}=host(state);
        // Ordinary Store access must finish both the domain state and the accepted receipt.
        await repository.transaction(async()=>{});
        const before=await snapshot(state.root),result=await workflow.execute(request,request);
        assert.equal(result.replayed,true);assert.deepEqual(await snapshot(state.root),before);
        const jobs=await read(state.root,'jobs.json');
        assert.deepEqual(jobs.metadata.agentWorkflows.receipts[request.operationId].receipt,result.receipt);
        const terminal=['handoff','cancel'].includes(kind);
        assert.equal(jobs.jobs.job.status,terminal?'needs_info':'in_progress');
        assert.equal(jobs.jobs.job.revision,terminal?4:3);
        const coordinator=await read(state.root,'coordinator.json');
        assert.equal(coordinator.claim===null,terminal);
        assert.equal((await read(state.root,'coordinator-journal.json')).operation,null);
        assert.equal((await workflow.inspect()).brokerAvailable,false);
        assert.equal(before['applications.jsonl'].trim().split('\n').length,['handoff','cancel','recover'].includes(kind)?2:1);
        assert.doesNotMatch(JSON.stringify(result),/claim_[A-Za-z0-9_-]{43}|tokenHash|PRIVATE/);
        await repository.transaction(async()=>{});assert.deepEqual(await snapshot(state.root),before);
        await workflow.close();
      });
    }
  } finally {await fixture.cleanup();}
});

test('workflow journal rejects a changed predecessor before domain writes',async()=>{
  const fixture=await nativeFixture();
  try {
    const state=await setup(fixture,'changed-ledger');await state.claims.select('job',1n,true);
    await killClaimAt(state,fixture,'acquire','journal');
    const jobs=await read(state.root,'jobs.json');jobs.metadata.agentWorkflows=emptyWorkflowLedger();await write(state.root,'jobs.json',jobs);
    const before=await snapshot(state.root),{repository,writes}=host(state);
    await assert.rejects(repository.transaction(async()=>{}),/workflow journal predecessor changed/);
    assert.deepEqual(writes,[]);assert.deepEqual(await snapshot(state.root),before);
  } finally {await fixture.cleanup();}
});
