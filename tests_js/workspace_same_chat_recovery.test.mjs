import test from 'node:test';
import assert from 'node:assert/strict';
import { sameChatRecovery } from '../apps/companion/same-chat-recovery.mjs';
const evidence = { chatScope: 'same', draft: 'present', observation: 'current', formScope: 'same' };
const context = () => ({ broker: { connected: true, ownsClaim: true }, guidance: {
  claim: { state: 'live' }, selection: { inputsCurrent: true }, actions: [{ kind: 'progress' }],
} });
test('recovery cannot turn inaccessible or different drafts into current readiness', () => {
  const scenarios = [
    [{ chatScope: 'different' }, 'return_to_original_chat'],
    [{ chatScope: 'unknown' }, 'return_to_original_chat'],
    [{ draft: 'missing' }, 'preserve_checkpoint_request_fresh_attempt'],
    [{ formScope: 'different' }, 'preserve_checkpoint_request_fresh_attempt'],
    [{ draft: 'unknown' }, 'inspect_existing_draft'],
    [{ observation: 'stale' }, 'inspect_existing_draft'],
    [{ observation: 'unknown' }, 'inspect_existing_draft'],
    [{ formScope: 'unknown' }, 'inspect_existing_draft'],
    [{}, 'continue_via_current_descriptors'],
  ];
  for (const [change, next] of scenarios) {
    const result = sameChatRecovery(context(), { ...evidence, ...change });
    assert.equal(result.next, next);
    for (const key of ['navigationAllowed', 'browserMutationAllowed', 'finalSubmissionAllowed', 'currentReadinessVerified']) assert.equal(result[key], false);
  }
});
test('broker loss, actual expiry and input drift require distinct guarded actions', () => {
  const c = context(); c.broker.ownsClaim = false;
  assert.equal(sameChatRecovery(c, evidence).next, 'wait_for_claim_expiry');
  c.guidance.claim.state = 'expired';
  assert.equal(sameChatRecovery(c, evidence).next, 'resolve_workflow_blocker');
  c.guidance.actions = [{ kind: 'recover', requiresExplicitUserEvent: true }];
  assert.equal(sameChatRecovery(c, evidence).next, 'request_explicit_recovery');
  c.guidance.claim = null; c.guidance.actions = [{kind:'restart'}];
  assert.equal(sameChatRecovery(c, evidence).next, 'resolve_workflow_blocker');
  const drift = context(); drift.guidance.selection.inputsCurrent = false;
  assert.equal(sameChatRecovery(drift, evidence).next, 'guarded_needs_info');
  const noProgress = context(); noProgress.guidance.actions = [];
  assert.equal(sameChatRecovery(noProgress, evidence).next, 'guarded_needs_info');
});
test('closed host evidence rejects private payloads without echo and never mutates inputs', () => {
  for (const bad of [null, [], {}, {...evidence, url:'private'}, {...evidence, observation:true}]) {
    assert.throws(() => sameChatRecovery(context(), bad), { message:'invalid same-chat recovery input' });
  }
  assert.throws(() => sameChatRecovery({}, evidence), /invalid same-chat/);
  const c=context();const before=structuredClone(c);sameChatRecovery(c,evidence);assert.deepEqual(c,before);
});
