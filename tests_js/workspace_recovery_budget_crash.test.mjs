import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeFixture, child } from './exclusive_file_lock_support.mjs';
import { setup, host, event, snapshot } from './workspace_durable_claims_support.mjs';
const url=path=>new URL(path,import.meta.url).href;
const script=`
import {host,event} from ${JSON.stringify(url('./workspace_durable_claims_support.mjs'))};
import {loadPosixFlockProvider} from ${JSON.stringify(url('../runtime/store/posix-flock.js'))};
import {serialize} from ${JSON.stringify(url('../runtime/contracts/workspace/values.js'))};
const [root,artifact,boundary,now]=process.argv.slice(1);
const state={root,provider:loadPosixFlockProvider(artifact),clock:{now}};
const writer=host(state,{[boundary]:async(path,value)=>{
 const doc=JSON.parse(serialize(value));
 if(path.endsWith('jobs.json') && doc.metadata?.atsRecovery?.jobs.job.state.budget.save===1){
  console.log('budget-boundary');await new Promise(()=>setInterval(()=>{},1000));
 }
}});
const take=event('acquire'),task=(await writer.workflow.execute(take,take)).receipt.task;
const evidence={ats:'workday',draft:'present',observation:'current',session:'authenticated',failure:'none',refreshApproved:false};
const fresh={operationId:'fresh',taskId:task.taskId,expectedRevision:task.revision,jobId:'job',jobRevision:task.subject.jobRevision,
 draftId:null,recoveryRevision:null,mode:'fresh_draft',evidence};
const registered=(await writer.workflow.recovery(fresh,fresh)).state;
await writer.workflow.recovery({...fresh,operationId:'retry',mode:'decide',draftId:registered.draftId,recoveryRevision:registered.revision,
 evidence:{...evidence,failure:'generic_save'}});
throw Error('missed boundary');
`;
test('SIGKILL cannot refund a published recovery reservation or strand a partial counter', {timeout:60000},async t=>{
  const native=await nativeFixture();t.after(()=>native.cleanup());
  for(const boundary of ['before','after']) await t.test(boundary,async()=>{
    const state=await setup(native,`budget-${boundary}`);await state.claims.select('job',1n,true);
    const before=await snapshot(state.root);
    const writer=child(script,[state.root,native.receipt.artifact,boundary,state.clock.now]);
    try {
      await writer.line('budget-boundary');assert.equal(writer.process.kill('SIGKILL'),true);
      assert.deepEqual(await writer.exited,{code:null,signal:'SIGKILL'});
    } finally {await writer.stop();}
    const replacement=host(state);t.after(()=>replacement.workflow.close());
    let context=await replacement.workflow.inspect('job');
    assert.equal(context.brokerAvailable,false);
    assert.equal(context.recovery.budget.save,boundary==='after'?1:0);
    state.clock.now=new Date(Date.parse(state.clock.now)+300000).toISOString().replace('.000Z','Z');
    const recover=event('recover',context.task,{operationId:'recover'});
    const task=(await replacement.workflow.execute(recover,recover)).receipt.task;
    context=await replacement.workflow.inspect('job');
    const input={operationId:'continue',taskId:task.taskId,expectedRevision:task.revision,jobId:'job',jobRevision:task.subject.jobRevision,
      recoveryRevision:context.recovery.revision,draftId:context.recovery.draftId,mode:'decide',
      evidence:{ats:'workday',draft:'present',observation:'current',session:'authenticated',failure:'generic_save',refreshApproved:false}};
    const result=await replacement.workflow.recovery(input);
    assert.equal(result.actionReserved,boundary==='before');
    assert.equal(result.next,boundary==='before'?'retry_save_once':'pause_preserve_draft');
    const after=await snapshot(state.root);
    for(const file of ['profile.json','resumes.json','resume-facts.json']) assert.equal(after[file],before[file]);
    assert.deepEqual(JSON.parse(after['jobs.json']).jobs.other,JSON.parse(before['jobs.json']).jobs.other);
    assert.equal(result.finalSubmissionAllowed,false);
  });
});
