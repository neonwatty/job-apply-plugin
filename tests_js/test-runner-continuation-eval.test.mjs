import assert from 'node:assert/strict';
import test from 'node:test';
import { gradeState } from '../evals/preparation/continuation-scenarios.mjs';
const state = () => ({ job:{ status:'ready', revision:2 }, preflightReady:true, claim:null, sessions:[],
  metadata:{}, activeRun:{selection:{resumeId:'synthetic-alternate-resume'}}, hashes:{'jobs.json':'a','facts.json':'b'} });

test('continuation grading distinguishes stale canonical inputs from a stored Ready status',()=>{
  const first=state(),changed={...state(),preflightReady:false,hashes:{...state().hashes,'facts.json':'draft'}};
  assert.equal(gradeState('stale-facts',[first,changed],changed,'candidate').statePassed,true);
  assert.equal(gradeState('stale-facts',[first,{...changed,preflightReady:true}],changed,'candidate').statePassed,false);
  assert.equal(gradeState('stale-facts',[first,{...changed,hashes:{...changed.hashes,'facts.json':'confirmed'}}],changed,'candidate').statePassed,false);
  assert.equal(gradeState('fresh-context',[first,changed],first,'baseline').statePassed,false);
});
test('unresolved choice rejects premature selection, wrong resume and out-of-scope claim effects',()=>{
  const before={...state(),job:{status:'saved',revision:1},activeRun:null};
  assert.equal(gradeState('unresolved-resume',[before,state()],before,'candidate').statePassed,true);
  assert.equal(gradeState('unresolved-resume',[state(),state()],before,'candidate').statePassed,false);
  assert.equal(gradeState('unresolved-resume',[before,{...state(),activeRun:{selection:{resumeId:'wrong'}}}],before,'candidate').statePassed,false);
  assert.equal(gradeState('unresolved-resume',[before,{...state(),claim:{jobId:'job'}}],before,'candidate').statePassed,false);
});
test('cancellation must consume the persisted candidate task and preserve unrelated files',()=>{
  const before={...state(),job:{status:'saved',revision:1},metadata:{agentWorkflows:{activeTaskId:'task',tasks:{task:{status:'waiting',pending:{requestId:'request'}}}}}};
  const after={...before,metadata:{agentWorkflows:{activeTaskId:null,tasks:{task:{status:'cancelled',pending:null}}}}};
  assert.equal(gradeState('cancel-pending',[before,after],before,'candidate').statePassed,true);
  assert.equal(gradeState('cancel-pending',[before,{...after,metadata:{}}],before,'candidate').statePassed,false);
  assert.equal(gradeState('cancel-pending',[before,{...after,hashes:{...after.hashes,'facts.json':'deleted'}}],before,'candidate').statePassed,false);
  assert.equal(gradeState('cancel-pending',[before,{...after,hashes:{...after.hashes,'new-facts.json':'created'}}],before,'candidate').statePassed,false);
  assert.equal(gradeState('cancel-pending',[{...before,metadata:{}},{...after,metadata:{}}],before,'baseline').statePassed,true);
  assert.throws(()=>gradeState('cancel-pending',[before,after],before),/comparison arm/);
});
