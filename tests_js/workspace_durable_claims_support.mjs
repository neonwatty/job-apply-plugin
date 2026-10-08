import { NativeJobsRepository } from '../runtime/store/native-jobs.js';
import { NativeClaimWorkflowTasks } from '../runtime/store/native-claim-workflow-tasks.js';
import { ClaimWorkflow } from '../runtime/app/claim-workflow.js';
import { ClaimsService } from '../runtime/workspace-core/claims.js';
import { atomicWritePointJson } from '../runtime/store/point-persistence.js';
import { attemptProfile } from '../runtime/workflows/applications/attempt.js';
export { setup, read, write, snapshot, readyPacket } from './workspace_native_claims_support.mjs';
export const pending={status:'active',blockers:[{type:'information',code:'owner-input-required'}],handoffChecklist:['resume_upload']};
export function host(state,options={}) {
  const access={enabled:[attemptProfile],authorized:[attemptProfile]}, writes=[];
  const repository=new NativeJobsRepository(state.root,state.provider,async(path,value,config)=>{
    if(options.before) await options.before(path,value,config);
    writes.push(path);await atomicWritePointJson(path,value,config);
    if(options.after) await options.after(path,value,config);
  },options.checkpoint);
  const now=()=>state.clock.now;
  const workflow=new ClaimWorkflow(new NativeClaimWorkflowTasks(repository,now),new ClaimsService(repository,now),()=>access,now);
  return {workflow,access,writes,repository};
}
export function event(kind,task=null,overrides={}) {
  return {kind,operationId:kind,taskId:task?.taskId??null,expectedRevision:task?.revision??null,
    jobId:'job',jobRevision:task?.subject.jobRevision??'2',
    ...(['progress','handoff','cancel'].includes(kind)?{session:pending}:{}),
    ...(kind==='handoff'?{status:'needs_info'}:{}),...overrides};
}
export async function acquire(state,workflow) {
  await state.claims.select('job',1n,true);
  const request=event('acquire');
  return (await workflow.execute(request,request)).receipt.task;
}
