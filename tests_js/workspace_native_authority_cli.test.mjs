import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { addToRun, plain, read, setup } from './workspace_native_claims_support.mjs';
import { resolveAccountRealm } from '../runtime/contracts/workspace/account-realm.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { runNativeAuthorityCommand } from '../runtime/cli/native-authority.js';
import { setup as groupedSetup, revisions } from './workspace_native_grouped_approvals_support.mjs';

const portal = suffix => `https://example.wd1.myworkdayjobs.com/en-US/careers/job/${suffix}`;
const fingerprint = character => `sha256:${character.repeat(64)}`;

async function trusted(fixture, name) {
  const state = await setup(fixture, name), id = 'authority-job';
  await state.jobs.create(fromJSON({ id, url: portal(name), role: 'Engineer', company: 'Synthetic', ats: 'workday', resumeId: 'resume' }));
  await addToRun(state, id);
  const selected = plain(await state.claims.select(id, 1n, true));
  const claimed = plain(await state.claims.acquire(id, fromJSON('Owner'), BigInt(selected.job.revision)));
  const realm = resolveAccountRealm(portal(name));
  assert.equal(realm.status, 'resolved');
  const packet = { jobId: id, expectedJobRevision: claimed.job.revision, realmRef: realm.realmRef, answerRefs: [],
    observedQuestionFingerprint: fingerprint('1'), observedControlFingerprint: fingerprint('2'), formFingerprint: fingerprint('3'),
    allowedOperations: ['fill_text'], durationMinutes: 30 };
  const evaluation = { jobId: id, expectedApprovalRevision: 1, observedQuestionFingerprint: fingerprint('1'),
    observedControlFingerprint: fingerprint('2'), formFingerprint: fingerprint('3'), fieldOperations: ['fill_text'],
    authenticationRequired: false, consentRequired: false, credentialFieldsPresent: false,
    finalControlsPresent: false, unseenQuestions: false, unseenControls: false };
  return { ...state, id, packet, evaluation };
}

function context(state, payload) {
  return { repository: state.repository, now: () => state.clock.now, readInput: async path => {
    if (path !== 'input') throw Error('unexpected input path');
    return fromJSON(payload);
  } };
}

test('native authority CLI keeps private Store projections and non-consuming evaluation', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await trusted(fixture, 'authority-cli');
    const approved = plain(await runNativeAuthorityCommand('trusted-fill-approve', ['--input', 'input'], context(state, state.packet)));
    assert.equal(approved.approvalId.startsWith('trusted-fill-'), true);
    assert.equal(approved.claimId, (await read(state.root, 'coordinator.json')).claim.claimId);
    const decision = plain(await runNativeAuthorityCommand('trusted-fill-evaluate', ['--input', 'input'], context(state, state.evaluation)));
    assert.equal(decision.authorized, true);
    assert.equal((await read(state.root, 'trusted-fill.json')).approvals[state.id].status, 'active');
    const status = plain(await runNativeAuthorityCommand('trusted-fill-status', ['--id', state.id], context(state, {})));
    assert.equal(status.approvalRevision, 1);
    const revoked = plain(await runNativeAuthorityCommand('trusted-fill-revoke', ['--id', state.id, '--expected-approval-revision', '+1'], context(state, {})));
    assert.equal(revoked.status, 'revoked');
  } finally { await fixture.cleanup(); }
});

test('native attention approval aliases delegate approval semantics with Python integer spellings', { timeout: 60_000 }, async () => {
  const fixture = await nativeFixture();
  try {
    const state = await groupedSetup(fixture, 'authority-alias'), [jobRevision, sessionRevision] = await revisions(state);
    const spelling = value => `+${String(value).split('').join('_')}`;
    const options = ['--id', 'job', '--expected-job-revision', spelling(jobRevision),
      '--expected-session-revision', spelling(sessionRevision), '--input', 'input'];
    const context = { repository: state.repository, readInput: async () => fromJSON({ decisions: state.decisions }) };
    const preview = plain(await runNativeAuthorityCommand('attention-approval-preview', options, context));
    assert.equal(preview.approvals.length, state.decisions.length);
    const stale = options.map((item, index) => options[index - 1] === '--expected-session-revision' ? '999' : item);
    await assert.rejects(runNativeAuthorityCommand('attention-approval-approve', [
      ...stale, '--preview-token', preview.previewToken, '--owner-confirmed',
    ], context), /session revision conflict/);
    const approved = plain(await runNativeAuthorityCommand('attention-approval-approve', [
      ...options, '--preview-token', preview.previewToken, '--owner-confirmed',
    ], context));
    assert.equal(approved.approved, true);
  } finally { await fixture.cleanup(); }
});
