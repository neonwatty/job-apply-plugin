import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {ownerWorkflowReceipt} from '../runtime/app/owner-workflow-receipt.js';
import {fromJSON,object} from '../runtime/contracts/workspace/values.js';
import {canonicalJson} from '../runtime/contracts/workspace/canonical-json.js';
import {emptyWorkflowLedger,encodeWorkflowLedger} from '../runtime/contracts/workspace/workflow-tasks.js';
import {claimEvent} from '../runtime/workflows/applications/attempt.js';
const event={kind:'handoff',operationId:'terminal',taskId:'task',expectedRevision:'2',jobId:'job',jobRevision:'3',status:'needs_info',savedSessionFingerprint:'a'.repeat(64)};
function fixture() {
  const ledger=emptyWorkflowLedger();
  const task={taskId:'task',revision:'3',workflow:{id:'application.attempt',version:1},subject:{jobId:'job',jobRevision:'4',inputRevision:'b'.repeat(64)},status:'finished',pending:null};
  const receipt={operationId:'terminal',task,outcome:'needs_info'};
  ledger.tasks.task=task;
  ledger.receipts.terminal={fingerprint:createHash('sha256').update(canonicalJson(fromJSON(claimEvent(event)))).digest('hex'),receipt};
  const jobs=object(fromJSON({metadata:{agentWorkflows:JSON.parse(canonicalJson(encodeWorkflowLedger(ledger)))}}),'jobs');
  let writes=0;
  const repository={claimTransaction:async callback=>callback({jobs,commit:async()=>{writes++;},saveJobs:async()=>{writes++;}})};
  return {repository,receipt,writes:()=>writes};
}
test('owner receipt lookup confirms exact terminal event or report without writes',async()=>{
  const state=fixture();
  assert.deepEqual((await ownerWorkflowReceipt(state.repository,event)).result.receipt,state.receipt);
  const {kind,status,...report}=event;
  assert.equal((await ownerWorkflowReceipt(state.repository,{...report,outcome:'needs_info',evidenceKind:'agent_attested'})).result.replayed,true);
  assert.equal(state.writes(),0);
});
test('owner receipt lookup denies missing, changed or unknown inputs',async()=>{
  const state=fixture();
  for(const change of [{operationId:'missing'},{jobRevision:'4'},{unexpected:true}]) await assert.rejects(ownerWorkflowReceipt(state.repository,{...event,...change}));
  assert.equal(state.writes(),0);
});
