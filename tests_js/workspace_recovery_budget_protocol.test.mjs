import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerClaimBroker } from '../runtime/integrations/host/owner-claim-broker.js';
import { WorkflowBroker } from '../runtime/integrations/host/claim-broker.js';
import { parseOwnerClaimOptions } from '../runtime/cli/owner-claim-workflow.js';
import { fromJSON,object,serialize } from '../runtime/contracts/workspace/values.js';
const doc=value=>object(fromJSON(value),'request');
const plain=value=>JSON.parse(serialize(value));
test('owner recovery command stays exact-job scoped and forwards explicit approval without retiring broker',async t=>{
  const calls=[];
  const workflow={inspect:async()=>({task:{taskId:'task'},guidance:{actions:[]}}),
    recovery:async(input,approval)=>{calls.push(JSON.parse(JSON.stringify({input,approval})));return {next:'draft_registered',actionReserved:false};},
    close:async()=>{},heartbeat:async()=>{},execute:async()=>{throw Error('wrong route');}};
  const broker=new OwnerClaimBroker(workflow,{jobId:'job',jobRevision:'1',inputRevision:'scope',taskId:null,taskRevision:null},()=>{});
  t.after(()=>broker.close());
  await broker.acquire(doc({ownerWorkflow:1,command:'context'}));
  await assert.rejects(broker.dispatch(doc({ownerWorkflow:1,command:'recovery',event:{jobId:'other'},hostUserEvent:true})));
  assert.equal(calls.length,0);
  const result=await broker.dispatch(doc({ownerWorkflow:1,command:'recovery',event:{jobId:'job'},hostUserEvent:true}));
  assert.equal(result.complete,false);
  assert.deepEqual(calls,[{input:{jobId:'job'},approval:{jobId:'job'}}]);
  assert.equal(plain(result.response).result.finalSubmission,'manual');
});
test('brokers without recovery capability reject the route',async t=>{
  const broker=new WorkflowBroker({inspect:async()=>({}),execute:async()=>{throw Error('wrong route');},
    heartbeat:async()=>{},close:async()=>{}},()=>{});
  t.after(()=>broker.close());
  await assert.rejects(broker.dispatch(doc({command:'recovery',event:{jobId:'job'},hostUserEvent:true})),/invalid_proposal/);
});
test('recovery parser requires exact input path and accepts only explicit attestation flag',()=>{
  const args=['recovery','--root','/tmp/fictional','--native-lock','/tmp/lock','--input','/tmp/request'];
  assert.equal(parseOwnerClaimOptions(args).hostUserEvent,false);
  assert.equal(parseOwnerClaimOptions([...args,'--host-user-event']).hostUserEvent,true);
  assert.throws(()=>parseOwnerClaimOptions([...args,'--host-user-event','--host-user-event']));
  assert.throws(()=>parseOwnerClaimOptions(args.slice(0,-2)));
  assert.throws(()=>parseOwnerClaimOptions([...args,'--job-id','other']));
});
