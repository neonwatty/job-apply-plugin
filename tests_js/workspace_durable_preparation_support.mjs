import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { NativeWorkflowTasks } from '../runtime/store/native-workflow-tasks.js';
import { atomicWorkflowJobsWrite } from '../runtime/store/workflow-atomic-write.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { PreparationWorkflow } from '../runtime/app/preparation-workflow.js';
import { preparationProfile, preparationIdentity } from '../runtime/workflows/applications/prepare.js';
import { setup, read, write, snapshot, plain } from './workspace_native_claims_support.mjs';
export { setup, read, write, snapshot, plain };
export function runtime(state, options={}) {
  const writes=[];
  const access={enabled:[preparationProfile],authorized:[preparationProfile]};
  const repository=new NativeJobsRepository(state.root,state.provider,async(path,value,config)=>{
    writes.push(path);
    if(options.beforeWrite) await options.beforeWrite(path,value,config);
    await (path===join(state.root,'jobs.json')?atomicWorkflowJobsWrite:atomicWritePointJson)(path,value,config);
    if(options.afterWrite) await options.afterWrite(path,value,config);
  });
  const store=new NativeWorkflowTasks(repository,()=>state.clock.now);
  return {workflow:new PreparationWorkflow(store,()=>access),store,writes,access};
}
export function start(operationId='start',jobRevision='1') {
  return {kind:'newTask',operationId,taskId:null,expectedRevision:null,workflow:preparationIdentity,input:{jobId:'job',jobRevision}};
}
export function ask(task,operationId='ask') {
  return {kind:'askUser',operationId,taskId:task.taskId,expectedRevision:task.revision,actionId:'application.confirm_selection'};
}
export function reply(task,decision='confirm',operationId='reply') {
  const proposal={kind:'continue',operationId,taskId:task.taskId,expectedRevision:task.revision,
    event:{requestId:task.pending.requestId,jobRevision:task.subject.jobRevision,decision}};
  return {proposal,attestation:{taskId:task.taskId,expectedRevision:task.revision,reply:proposal.event}};
}
export function cancel(task,operationId='cancel') {
  return {kind:'cancel',operationId,taskId:task.taskId,expectedRevision:task.revision};
}
export async function waiting(workflow) {
  const started=await workflow.route(start());
  return (await workflow.action(ask(started.receipt.task))).receipt.task;
}
export async function rejectedUnchanged(state,operation,pattern) {
  const before=await snapshot(state.root);
  await assert.rejects(operation,pattern);
  assert.deepEqual(await snapshot(state.root),before);
}
