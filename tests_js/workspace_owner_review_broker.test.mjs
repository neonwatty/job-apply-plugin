import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerClaimBroker } from '../runtime/integrations/host/owner-claim-broker.js';
import { fromJSON, object, serialize } from '../runtime/contracts/workspace/values.js';
const doc = value => object(fromJSON({...value,ownerWorkflow:1}), 'request');
const plain = value => JSON.parse(serialize(value));
const scope = {jobId:'job-1',jobRevision:'1',inputRevision:'inputs',taskId:null,taskRevision:null};
const identity = {taskId:'current',expectedRevision:'2',jobId:'job-1',jobRevision:'3'};
const reviewAction = {kind:'handoff',requiresExplicitUserEvent:false,
  input:{...identity,kind:'handoff',status:'awaiting_review'},requiredFields:['operationId','session']};

test('owner projects current review action as a fresh-session host report',async t=>{
  const workflow={inspect:async()=>({task:{taskId:'current'},broker:{connected:true,ownsClaim:true},
    guidance:{actions:[reviewAction]}}),execute:async()=>assert.fail('context must not write'),
    heartbeat:async()=>{},close:async()=>{}};
  const broker=new OwnerClaimBroker(workflow,scope,()=>{});t.after(()=>broker.close());
  const response=plain(await broker.acquire(doc({command:'host-browser-context'})));
  assert.deepEqual(response.result.hostBrowser.reportOutcomes,['awaiting_review']);
  assert.equal(response.result.hostBrowser.nextStep,'inspect_and_handoff');
  assert.deepEqual(response.result.hostBrowser.reports,[{
    args:['owner-workflow','host-browser-report'],requiredFields:['operationId','session'],
    input:{...identity,evidenceKind:'agent_attested',outcome:'awaiting_review'},
  }]);
  assert.equal(response.result.finalSubmission,'manual');
});

test('review outcome is unavailable without the current claim',async t=>{
  for (const brokerState of [{connected:false,ownsClaim:true},{connected:true,ownsClaim:false}]) {
    const workflow={inspect:async()=>({task:{taskId:'current'},broker:brokerState,guidance:{actions:[]}}),
      execute:async()=>assert.fail('context must not write'),heartbeat:async()=>{},close:async()=>{}};
    const broker=new OwnerClaimBroker(workflow,scope,()=>{});t.after(()=>broker.close());
    const response=plain(await broker.acquire(doc({command:'host-browser-context'})));
    assert.deepEqual(response.result.hostBrowser.reportOutcomes,[]);
    assert.deepEqual(response.result.hostBrowser.reports,[]);
  }
});

test('review report completes the current owner task and preserves exact report mapping',async t=>{
  let received;
  const workflow={inspect:async()=>({task:{taskId:'current'},guidance:{actions:[]}}),
    execute:async event=>{received=event;return {receipt:{task:{taskId:'current',status:'finished'},outcome:'awaiting_review'}};},
    heartbeat:async()=>{},close:async()=>{}};
  const broker=new OwnerClaimBroker(workflow,scope,()=>{});t.after(()=>broker.close());
  await broker.acquire(doc({command:'context'}));
  const result=await broker.dispatch(doc({command:'host-browser-report',report:{...identity,
    operationId:'review',evidenceKind:'agent_attested',outcome:'awaiting_review',session:{status:'review'}}}));
  assert.equal(result.complete,true);
  assert.equal(received.kind,'handoff');
  assert.equal(received.status,'awaiting_review');
  assert.deepEqual(JSON.parse(JSON.stringify(received.session)),{status:'review'});
  assert.equal(plain(result.response).result.replayScope,'report_recording_only');
});

test('exact review report replay closes after lost response but cannot retire a newer task',async t=>{
  for (const newerTask of [false,true]) {
    let task={taskId:'current'}, first=true;
    const workflow={inspect:async()=>({task,guidance:{actions:[]}}),
      execute:async()=>{if(first){first=false;task=newerTask ? {taskId:'newer'} : null;throw Error('review response lost');}
        return {receipt:{task:{taskId:'current',status:'finished'},outcome:'awaiting_review'},replayed:true};},
      heartbeat:async()=>{},close:async()=>{}};
    const broker=new OwnerClaimBroker(workflow,scope,()=>{});t.after(()=>broker.close());
    await broker.acquire(doc({command:'context'}));
    const request=doc({command:'host-browser-report',report:{...identity,operationId:'review',
      evidenceKind:'agent_attested',outcome:'awaiting_review',session:{status:'review'}}});
    await assert.rejects(broker.dispatch(request),/review response lost/);
    await broker.dispatch(doc({command:'context'}));
    const result=await broker.dispatch(request);
    assert.equal(result.complete,!newerTask);
    assert.equal(plain(result.response).result.replayed,true);
  }
});
