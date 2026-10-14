import assert from 'node:assert/strict';
import test from 'node:test';
import { manualAttachmentGuidance } from '../apps/companion/manual-attachment-guidance.mjs';

const scope = { jobId: 'synthetic-job', attemptRevision: 4, resumeId: 'synthetic-resume',
  resumeRevision: 2, contentRevision: 'synthetic-content', formInstanceId: 'synthetic-form' };
const evidence = () => ({ scope: { ...scope }, currentScope: { ...scope },
  uploadOutcome: 'chooser_unavailable', guardPassed: true, pausedObservationRevision: 1,
  observation: { revision: 2, state: 'missing' }, ownerConfirmation: null });
const context = () => ({ helpRequested: true, pickerState: 'open', platform: 'macos',
  clipboardCapability: 'available' });

test('requested Mac help gives private guarded preparation, without claiming clipboard success', () => {
  const input = evidence();
  const before = structuredClone(input);
  const result = manualAttachmentGuidance(input, context());
  assert.equal(result.next, 'prepare_guarded_private_clipboard');
  assert.equal(result.preparePrivateClipboard, true);
  assert.equal(result.freshUploadGuardRequired, true);
  assert.equal(result.automaticRetryAllowed, false);
  assert.equal(result.finalSubmissionAllowed, false);
  assert.match(result.instructions.join(' '), /After the current guarded/);
  assert.match(result.instructions.join(' '), /Command–Shift–G/);
  assert.doesNotMatch(result.instructions.join(' '), /click Resume\/CV/);
  assert.deepEqual(input, before);
});

test('unknown picker cannot prompt another click or clipboard action', () => {
  const result = manualAttachmentGuidance(evidence(), { ...context(), pickerState: 'unknown' });
  assert.equal(result.next, 'inspect_native_picker');
  assert.equal(result.preparePrivateClipboard, false);
  const closed = manualAttachmentGuidance(evidence(), { ...context(), pickerState: 'closed' });
  assert.match(closed.instructions[0], /click Resume\/CV → Attach once/);
});

test('clipboard guidance requires help request, Mac platform and available host capability', () => {
  for (const change of [{ helpRequested: false }, { platform: 'other' }, { clipboardCapability: 'unavailable' }]) {
    const result = manualAttachmentGuidance(evidence(), { ...context(), ...change });
    assert.equal(result.preparePrivateClipboard, false);
    assert.equal(result.freshUploadGuardRequired, false);
    assert.doesNotMatch(result.instructions.join(' '), /Command–V/);
  }
});

test('upstream decision prevents upload guidance for stale, changed, pending or accepted evidence', () => {
  for (const change of [x => x.guardPassed = false, x => x.currentScope.attemptRevision++,
    x => x.observation.revision = 1, x => x.observation.state = 'progress',
    x => x.observation.state = 'unobservable', x => x.observation.state = 'accepted',
    x => { x.observation.state = 'accepted'; x.ownerConfirmation = { scope, confirmed: true }; }]) {
    const input = evidence(); change(input);
    const result = manualAttachmentGuidance(input, context());
    assert.notEqual(result.state, 'attachment_required');
    assert.equal(result.preparePrivateClipboard, false);
    assert.doesNotMatch(result.instructions.join(' '), /click Open|click Resume\/CV/);
    assert.equal(result.automaticRetryAllowed, false);
    assert.equal(result.finalSubmissionAllowed, false);
  }
});

test('private or unknown inputs produce fixed diagnostics and output contains no scope identities', () => {
  for (const change of [{ path: '/private/secret.pdf' }, { pickerState: 'probably-open' },
    { clipboardCapability: 'bypass' }, { platform: 'secret platform' }, { helpRequested: 'yes' }]) {
    assert.throws(() => manualAttachmentGuidance(evidence(), { ...context(), ...change }),
      /^Error: invalid manual attachment guidance context$/);
  }
  assert.throws(() => manualAttachmentGuidance({ ...evidence(), path: '/private/secret.pdf' }, context()),
    /^Error: invalid manual attachment evidence$/);
  const output = JSON.stringify(manualAttachmentGuidance(evidence(), context()));
  for (const value of Object.values(scope).filter(x => typeof x === 'string')) {
    assert.ok(!output.includes(value));
  }
  assert.ok(!output.includes('/private/'));
});
