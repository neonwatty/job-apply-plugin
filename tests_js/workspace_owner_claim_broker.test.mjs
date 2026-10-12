import test from 'node:test';
import assert from 'node:assert/strict';
import { OwnerClaimBroker } from '../runtime/integrations/host/owner-claim-broker.js';
import { hostBrowserReport } from '../runtime/workflows/applications/host-browser-report.js';
import { parseOwnerClaimOptions } from '../runtime/cli/owner-claim-workflow.js';
import { fromJSON, object, serialize } from '../runtime/contracts/workspace/values.js';
const doc = value => object(fromJSON({...value,ownerWorkflow:1}), 'request');
const plain = value => JSON.parse(serialize(value));
const scope = {jobId:'job-1',jobRevision:'1',inputRevision:'inputs',taskId:null,taskRevision:null};
function fixture() {
  const calls = [];
  const workflow = {inspect:async jobId => {calls.push(jobId);return {task:{taskId:'current'},guidance:{actions:[{args:['workflow','attempt','event'],requiresExplicitUserEvent:true}]}};},
    execute:async event => ({receipt:{task:{taskId:event.old ? 'old' : 'current',status:event.kind === 'cancel' ? 'cancelled' : 'active'}}}),
    heartbeat:async () => {},close:async () => {calls.push('closed');}};
  return {calls, broker:new OwnerClaimBroker(workflow,scope,()=>{})};
}
test('owner broker pins context to activated job and rewrites installed actions', async t => {
  const {calls,broker}=fixture();t.after(()=>broker.close());
  const response=plain(await broker.acquire(doc({command:'context'})));
  assert.deepEqual(calls,['job-1']);
  assert.deepEqual(response.result.ownerScope,scope);
  assert.deepEqual(response.result.guidance.actions[0].args,['owner-workflow','event','--host-user-event']);
  assert.equal(response.result.evidenceKind,'agent_attested');
  assert.equal(response.result.finalSubmission,'manual');
  await assert.rejects(broker.dispatch(doc({command:'context',jobId:'job-2'})));
  await assert.rejects(broker.dispatch(doc({command:'event',event:{jobId:'job-2'},hostUserEvent:true})));
});
test('owner cancellation completes broker lifecycle after response', async t => {
  const {broker}=fixture();t.after(()=>broker.close());
  await broker.acquire(doc({command:'context'}));
  const result=await broker.dispatch(doc({command:'event',event:{jobId:'job-1',kind:'cancel'},hostUserEvent:true}));
  assert.equal(result.complete,true);
});
test('owner parser requires explicit activation and rejects duplicates before IO',()=>{
  const flags=['--root','/tmp/owner','--native-lock','/tmp/flock'];
  assert.throws(()=>parseOwnerClaimOptions(['serve',...flags,'--job-id','job-1']));
  assert.throws(()=>parseOwnerClaimOptions(['serve',...flags,'--job-id','job-1','--host-user-event','--host-user-event']));
  assert.throws(()=>parseOwnerClaimOptions(['context',...flags,'--root','/tmp/other']));
  assert.equal(parseOwnerClaimOptions(['serve',...flags,'--job-id','job-1','--host-user-event']).jobId,'job-1');
});

test('first owner request requires context handshake before any event', async t => {
  const {broker,calls}=fixture();t.after(()=>broker.close());
  await assert.rejects(broker.acquire(doc({command:'event',event:{jobId:'job-1',kind:'cancel'},hostUserEvent:true})));
  assert.deepEqual(calls,[]);
});

test('foreign owner protocol is rejected before delegation', async t => {
  const {broker,calls}=fixture();t.after(()=>broker.close());
  for (const ownerWorkflow of [undefined,2]) {
    await assert.rejects(broker.acquire(object(fromJSON({command:'context',...(ownerWorkflow === undefined ? {} : {ownerWorkflow})}),'request')));
  }
  assert.deepEqual(calls,[]);
});

test('historical terminal replay cannot retire a newer owner task', async t => {
  const {broker}=fixture();t.after(()=>broker.close());
  await broker.acquire(doc({command:'context'}));
  const result=await broker.dispatch(doc({command:'event',event:{jobId:'job-1',kind:'cancel',old:true},hostUserEvent:true}));
  assert.equal(result.complete,false);
});
test('heartbeat failure stops the owner broker and close clears its timer', async () => {
  let stopped = 0, closed = 0;
  const broker = new OwnerClaimBroker({inspect:async()=>({task:null,guidance:{actions:[]}}),
    execute:async()=>assert.fail('unexpected mutation'),heartbeat:async()=>{throw new Error('lost');},
    close:async()=>{closed++;}},scope,()=>{stopped++;},5);
  await broker.acquire(doc({command:'context'}));
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.ok(stopped > 0);
  await broker.close();
  const stoppedAtClose = stopped;
  await new Promise(resolve=>setTimeout(resolve,15));
  assert.equal(stopped,stoppedAtClose);
  assert.equal(closed,1);
});

test('receipt parser requires exact input and rejects activation flags',()=>{
  const flags=['--root','/tmp/owner','--native-lock','/tmp/flock'];
  assert.throws(()=>parseOwnerClaimOptions(['receipt',...flags]));
  assert.throws(()=>parseOwnerClaimOptions(['receipt',...flags,'--input','relative.json']));
  assert.throws(()=>parseOwnerClaimOptions(['receipt',...flags,'--input','/tmp/event.json','--host-user-event']));
  assert.equal(parseOwnerClaimOptions(['receipt',...flags,'--input','/tmp/event.json']).command,'receipt');
});

test('owner host context provides exact validated report templates',async t=>{
  const base={taskId:'task',expectedRevision:'2',jobId:'job-1',jobRevision:'3'};
  const actions=[{kind:'progress',input:{...base,kind:'progress'},requiredFields:['operationId','session']},
    {kind:'handoff',input:{...base,kind:'handoff',status:'needs_info',savedSessionFingerprint:'a'.repeat(64)},requiredFields:['operationId']}];
  const workflow={inspect:async()=>({task:null,broker:{connected:true,ownsClaim:true},guidance:{actions}}),
    execute:async()=>{},heartbeat:async()=>{},close:async()=>{}};
  const broker=new OwnerClaimBroker(workflow,scope,()=>{});t.after(()=>broker.close());
  const response=plain(await broker.acquire(doc({command:'host-browser-context'})));
  const reports=response.result.hostBrowser.reports;
  assert.equal(reports.length,2);
  for (const descriptor of reports) {
    assert.deepEqual(descriptor.args,['owner-workflow','host-browser-report']);
    const input={...descriptor.input,operationId:'report',...(descriptor.requiredFields.includes('session') ? {session:{}} : {})};
    assert.equal(hostBrowserReport(input).kind,descriptor.input.outcome === 'progress' ? 'progress' : 'handoff');
    assert.equal(Object.hasOwn(descriptor.input,'kind'),false);
    assert.equal(Object.hasOwn(descriptor.input,'status'),false);
  }
});

test('terminal replay closes the owned broker after an uncertain durable commit',async t=>{
  for (const status of ['cancelled','finished']) {
    let task={taskId:'current'}, first=true;
    const workflow={inspect:async()=>({task,guidance:{actions:[]}}),
      execute:async()=>{task=null;if(first){first=false;throw Error('durable commit response lost');}
        return {receipt:{task:{taskId:'current',status}},replayed:true};},
      heartbeat:async()=>{},close:async()=>{}};
    const broker=new OwnerClaimBroker(workflow,scope,()=>{});t.after(()=>broker.close());
    await broker.acquire(doc({command:'context'}));
    const request=doc({command:'event',event:{jobId:'job-1',kind:'cancel'},hostUserEvent:true});
    await assert.rejects(broker.dispatch(request),/response lost/);
    await broker.dispatch(doc({command:'context'}));
    assert.equal((await broker.dispatch(request)).complete,true);
  }
});
