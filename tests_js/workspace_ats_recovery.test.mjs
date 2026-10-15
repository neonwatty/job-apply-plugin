import assert from 'node:assert/strict';
import test from 'node:test';
import { atsRecovery, applicationProgress, questionBatch } from '../apps/companion/ats-recovery.mjs';

const current = {ats:'workday', draft:'present', observation:'current', session:'unknown',
  failure:'generic_save', refreshApproved:false};
const fresh = () => ({save:0, afterSignIn:0, refresh:0});
test('expired session with stale signed-in header requires separate health check then bounded retry', () => {
  const budget = fresh();
  assert.equal(atsRecovery(current, budget).next, 'inspect_session_separate_tab');
  assert.equal(atsRecovery({...current, session:'signed_out'}, budget).next, 'request_user_sign_in');
  const recovered = {...current, session:'reauthenticated'};
  const retry = atsRecovery(recovered, budget);
  assert.equal(retry.next, 'retry_after_sign_in');
  assert.equal(atsRecovery(recovered, retry.nextBudget).next, 'pause_preserve_draft');
  assert.deepEqual(budget, fresh(), 'caller state is immutable');
});
test('generic save, broken date, page failure and lost draft stay bounded', () => {
  const e = {...current, session:'authenticated'};
  const retry = atsRecovery(e, fresh());
  assert.equal(retry.next, 'retry_save_once');
  assert.equal(atsRecovery(e, retry.nextBudget).next, 'pause_preserve_draft');
  assert.equal(atsRecovery({...e, failure:'unsupported_control'}, fresh()).next, 'request_manual_control');
  assert.equal(atsRecovery({...e, failure:'field_validation'}, fresh()).next, 'inspect_field_validation');
  const load = {...e, failure:'page_load'};
  assert.equal(atsRecovery(load, fresh()).next, 'request_refresh_approval');
  const approved = {...load, refreshApproved:true};
  const refresh = atsRecovery(approved, fresh());
  assert.equal(refresh.next, 'refresh_once');
  assert.equal(atsRecovery(approved, refresh.nextBudget).next, 'pause_preserve_draft');
  assert.equal(atsRecovery({...approved, draft:'missing'}, refresh.nextBudget).next, 'request_fresh_attempt');
  assert.equal(atsRecovery({...approved, session:'signed_out'}, refresh.nextBudget).next, 'request_user_sign_in');
});
test('unknown budget, stale evidence and unimplemented ATS fail closed', () => {
  for (const [e,b] of [[current,null],[{...current,observation:'stale'},fresh()],
    [{...current,ats:'other'},fresh()]]) {
    assert.equal(atsRecovery(e,b).next, 'pause_preserve_draft');
  }
  for (const e of [current,{...current,session:'authenticated'},
    {...current,failure:'page_load',refreshApproved:true}]) {
    const r=atsRecovery(e,fresh());
    assert.equal(r.browserMutationAllowed,false);
    assert.equal(r.finalSubmissionAllowed,false);
  }
});
test('changing opaque error IDs cannot reset or enter recovery policy', () => {
  for (const errorCode of ['I|first','I|second']) {
    assert.throws(()=>atsRecovery({...current,errorCode},fresh()), /^Error: invalid ATS recovery input$/);
  }
  assert.throws(()=>atsRecovery(current,{...fresh(),save:-1}));
  assert.throws(()=>atsRecovery(current,undefined));
});
test('page advancement and entered data never imply server persistence or review readiness', () => {
  const r=applicationProgress({entered:true,verified:true,pageAdvanced:true,persistenceConfirmed:false});
  assert.equal(r.persistence,'unknown');
  assert.equal(r.manualReviewReady,false);
  assert.equal(r.finalSubmissionAllowed,false);
  assert.throws(()=>applicationProgress({entered:false,verified:true,pageAdvanced:false,persistenceConfirmed:false}));
});
test('collects all page decisions in one pause without granting answers or blocking optional blanks', () => {
  const fields=[{required:true,state:'approved'},{required:true,state:'missing'},
    {required:true,state:'consent'},{required:false,state:'missing'}];
  assert.equal(questionBatch(fields,false).next,'ask_batch_before_acquire');
  const r=questionBatch(fields,true);
  assert.equal(r.next,'guarded_needs_info_then_ask_batch');
  assert.deepEqual(r.unresolved.map(f=>f.index),[1,2,3]);
  assert.equal(questionBatch([{required:false,state:'missing'}],true).next,'continue_with_approved_fields');
  assert.throws(()=>questionBatch([{required:true,state:'missing',answer:'private'}],true));
});
