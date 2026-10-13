import assert from 'node:assert/strict';
import test from 'node:test';
import { manualAttachmentDecision, manualAttachmentPause } from '../apps/companion/manual-attachment.mjs';
import { buildReadinessPacket } from '../apps/companion/readiness-packet.mjs';
import { buildClaimSession, validateClaimHandoff } from '../runtime/contracts/workspace/claim-session.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const scope = { jobId: 'job-synthetic', attemptRevision: 4, resumeId: 'resume-synthetic',
  resumeRevision: 2, contentRevision: 'content-synthetic', formInstanceId: 'form-synthetic' };
function evidence(state = 'missing') {
  return { scope: { ...scope }, currentScope: { ...scope }, uploadOutcome: 'chooser_unavailable',
    guardPassed: true, pausedObservationRevision: 1, observation: { revision: 2, state }, ownerConfirmation: null };
}
function confirmed() {
  return { ...evidence('accepted'), ownerConfirmation: { scope: { ...scope }, confirmed: true } };
}
function packet(manualAttachment) {
  return buildReadinessPacket({ attemptRevision: 4, platformFamily: 'greenhouse', observationRevision: 2,
    complete: true, inventories: [{ controls: [{ id: 'resume.file', role: 'file', required: true }] }],
    verifiedStates: [{ id: 'resume.file', state: 'accepted' }], adapterState: 'accessible',
    uploadCapability: 'external-runtime-unavailable', validationErrorControlIds: [],
    finalControlState: 'available', manualAttachment });
}

test('timeout derives an explicit manual action without retry or submission authority', () => {
  const decision = manualAttachmentDecision(evidence());
  assert.deepEqual(decision, { state: 'attachment_required', next: 'ask_owner_to_attach_selected_resume',
    automaticRetryAllowed: false, finalSubmissionAllowed: false, resumeState: 'missing' });
});

test('owner confirmation alone never establishes ATS acceptance', () => {
  for (const state of ['missing', 'progress', 'rejected', 'unobservable']) {
    const input = confirmed(); input.observation.state = state;
    assert.notEqual(manualAttachmentDecision(input).resumeState, 'accepted');
    assert.equal(packet(input).readiness.status, 'blocked');
  }
  assert.equal(manualAttachmentDecision(evidence('progress')).next, 'wait_for_ats_acceptance');
});

test('accepted attachment requires exact current owner confirmation', () => {
  assert.equal(manualAttachmentDecision(evidence('accepted')).state, 'identity_confirmation_required');
  const input = confirmed(); input.ownerConfirmation.confirmed = false;
  assert.equal(manualAttachmentDecision(input).state, 'identity_confirmation_required');
  input.ownerConfirmation.confirmed = true;
  input.ownerConfirmation.scope.formInstanceId = 'other-form';
  assert.equal(manualAttachmentDecision(input).state, 'identity_confirmation_required');
  assert.equal(packet(confirmed()).readiness.status, 'ready');
});

test('scope drift, guard failure and stale observation invalidate completion', () => {
  for (const key of Object.keys(scope)) {
    const input = confirmed();
    input.currentScope[key] = typeof scope[key] === 'number' ? scope[key] + 1 : scope[key] + '-changed';
    assert.equal(manualAttachmentDecision(input).state, 'scope_changed', key);
  }
  const input = confirmed(); input.guardPassed = false;
  assert.equal(manualAttachmentDecision(input).state, 'scope_changed');
  input.guardPassed = true; input.observation.revision = 1;
  assert.equal(manualAttachmentDecision(input).state, 'observation_required');
  assert.throws(() => packet(input));
});

test('unknown or private evidence is rejected with value-free diagnostics', () => {
  for (const change of [x => x.path = '/private/resume', x => x.uploadOutcome = 'invented',
    x => x.scope.formInstanceId = 'https://private.example', x => x.ownerConfirmation = true,
    x => x.observation.state = 'complete', x => x.scope.attemptRevision = 0]) {
    const input = evidence(); change(input);
    assert.throws(() => manualAttachmentDecision(input), /^Error: invalid manual attachment evidence$/);
  }
});

test('pause preserves unrelated pending work and passes canonical Needs Info validation', () => {
  const original = { status: 'active', attemptRevision: 4, step: 'resume_upload', pendingFields: [],
    answerKeys: [], blockers: [{ type: 'owner_review', code: 'consent-required' }],
    handoffChecklist: ['consent_choice'] };
  const copy = structuredClone(original);
  const paused = manualAttachmentPause(original, evidence());
  assert.deepEqual(original, copy);
  assert.deepEqual(paused.handoffChecklist, ['consent_choice', 'resume_upload']);
  assert.equal(paused.blockers.length, 2);
  assert.deepEqual(manualAttachmentPause(paused, evidence()), paused);
  const built = buildClaimSession('job-synthetic', fromJSON(paused), { now: '2026-10-13T00:00:00Z',
    attemptRevision: fromJSON(4), ats: fromJSON('greenhouse'), existing: null,
    answers: fromJSON({ schemaVersion: 1, answers: {} }) });
  validateClaimHandoff(built, fromJSON(paused), 'needs_info', fromJSON(4));
  assert.throws(() => validateClaimHandoff(built, fromJSON(paused), 'awaiting_review', fromJSON(4)));
  assert.ok(serialize(built).includes('resume_upload'));
  assert.throws(() => manualAttachmentPause(original, confirmed()));
});

test('readiness gate overrides contradictory accepted state until manual evidence is verified', () => {
  const blocked = packet(evidence('accepted'));
  assert.equal(blocked.readiness.status, 'blocked');
  assert.equal(blocked.readinessInput.observation.controls[0].state, 'unresolved');
  const verified = packet(confirmed());
  assert.equal(verified.readiness.status, 'ready');
  assert.equal(verified.readinessInput.observation.controls[0].state, 'accepted');
  // Canonical final-review gate still requires a fresh complete current-attempt packet.
  const incoming = { status: 'review', attemptRevision: 4, pendingFields: [], blockers: [], handoffChecklist: [],
    readinessInput: verified.readinessInput };
  const built = buildClaimSession('job-synthetic', fromJSON(incoming), { now: '2026-10-13T00:00:00Z',
    attemptRevision: fromJSON(4), ats: fromJSON('greenhouse'), existing: null,
    answers: fromJSON({ schemaVersion: 1, answers: {} }) });
  validateClaimHandoff(built, fromJSON(incoming), 'awaiting_review', fromJSON(4));
  const wrong = confirmed(); wrong.currentScope.attemptRevision = 5;
  assert.throws(() => packet(wrong));
});


test('canonical dotted IDs and sparse decimal-string descriptor sessions work unchanged', () => {
  const input = evidence();
  for (const key of ['scope', 'currentScope']) {
    input[key].jobId = 'sentinel.one'; input[key].resumeId = 'primary.v1';
  }
  const descriptor = { status: 'active', attemptRevision: '4' };
  const paused = manualAttachmentPause(descriptor, input);
  assert.equal(paused.attemptRevision, '4');
  assert.deepEqual(paused.handoffChecklist, ['resume_upload']);
  assert.equal(paused.blockers[0].code, 'unsupported-control');
  assert.throws(() => manualAttachmentPause({ ...descriptor, attemptRevision: '04' }, input));
  assert.throws(() => manualAttachmentPause({ ...descriptor, blockers: null }, input));
  input.scope.jobId = 'invalid..id';
  assert.throws(() => manualAttachmentDecision(input));
});


test('pause retains repeated checklist codes for separate unresolved controls', () => {
  const session = { status: 'active', attemptRevision: '4',
    handoffChecklist: ['required_question', 'required_question'] };
  const paused = manualAttachmentPause(session, evidence());
  assert.deepEqual(paused.handoffChecklist, ['required_question', 'required_question', 'resume_upload']);
  assert.deepEqual(manualAttachmentPause(paused, evidence()).handoffChecklist, paused.handoffChecklist);
});
