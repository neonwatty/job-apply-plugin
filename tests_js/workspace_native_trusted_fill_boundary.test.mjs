import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { plain, read, setup, snapshot, write } from './workspace_native_claims_support.mjs';
import { resolveAccountRealm } from '../runtime/contracts/workspace/account-realm.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { TrustedFillService } from '../runtime/workspace-core/trusted-fill.js';
import { TrustedFillNativeService } from '../runtime/workspace-core/trusted-fill-native.js';

const fp = character => `sha256:${character.repeat(64)}`;
const portal = suffix => `https://example.wd1.myworkdayjobs.com/en-US/careers/job/${suffix}`;

async function prepared(fixture, name) {
  const state = await setup(fixture, name), id = 'native-fill-job', url = portal(name);
  await state.jobs.create(fromJSON({ id, url, role: 'Engineer', company: 'Synthetic', ats: 'workday', resumeId: 'resume' }));
  const selected = plain(await state.claims.select(id, 1n, true));
  const acquired = plain(await state.claims.acquire(id, fromJSON('Native Trusted Fill'), BigInt(selected.job.revision)));
  const realm = resolveAccountRealm(url); assert.equal(realm.status, 'resolved');
  const approval = { jobId: id, expectedJobRevision: acquired.job.revision, realmRef: realm.realmRef, answerRefs: [],
    observedQuestionFingerprint: fp('1'), observedControlFingerprint: fp('2'), formFingerprint: fp('3'),
    allowedOperations: ['fill_text', 'select_option'], durationMinutes: 30 };
  const evaluation = { jobId: id, expectedApprovalRevision: 1, observedQuestionFingerprint: fp('1'),
    observedControlFingerprint: fp('2'), formFingerprint: fp('3'), fieldOperations: ['select_option', 'fill_text'],
    authenticationRequired: false, consentRequired: false, credentialFieldsPresent: false,
    finalControlsPresent: false, unseenQuestions: false, unseenControls: false };
  await new TrustedFillService(state.repository, () => state.clock.now).approve(fromJSON(approval));
  return { ...state, id, evaluation };
}

function receipt(packet, changes = {}) {
  return fromJSON({ schemaVersion: 1, providerId: 'synthetic-trusted-fill',
    operationFingerprint: packet.operationFingerprint, appliedOperations: packet.allowedOperations,
    finalActionActivated: false, authenticationActivated: false, consentActivated: false,
    credentialFieldsTouched: false, privateValuesCleared: true, retryAllowed: false, ...changes });
}

test('native Trusted Fill boundary consumes exact non-final authority and fails closed', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());

  await t.test('exact value-free packet produces one successful non-final receipt', async () => {
    const state = await prepared(fixture, 'native-fill-success'); let calls = 0;
    const executor = { providerId: 'synthetic-trusted-fill', execute: async value => {
      calls += 1; const packet = plain(value);
      assert.deepEqual(packet.allowedOperations, ['fill_text', 'select_option']);
      assert.equal(packet.finalActionAuthorized, false);
      assert.doesNotMatch(JSON.stringify(packet), /nonce|approvalId|content_|PRIVATE|resume-files|claimId/);
      return receipt(packet);
    } };
    const result = plain(await new TrustedFillNativeService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.evaluation)));
    assert.equal(calls, 1);
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode, attentionHandoff: result.attentionHandoff,
      finalActionAuthorized: result.finalActionAuthorized, appliedOperations: result.appliedOperations },
    { authorized: true, reasonCode: 'native_fields_applied', attentionHandoff: false,
      finalActionAuthorized: false, appliedOperations: ['fill_text', 'select_option'] });
    assert.equal((await read(state.root, 'trusted-fill.json')).approvals[state.id].approvalRevision, 2);
    assert.equal((await read(state.root, 'coordinator.json')).claim.jobId, state.id);
  });

  await t.test('missing provider rejects before consuming or mutating authority', async () => {
    const state = await prepared(fixture, 'native-fill-missing'), before = await snapshot(state.root);
    await assert.rejects(new TrustedFillNativeService(state.repository, undefined, () => state.clock.now)
      .execute(fromJSON(state.evaluation)), /provider injection is required/);
    assert.deepEqual(await snapshot(state.root), before);
  });

  await t.test('native failure burns authority and hands the same live claim to attention', async () => {
    const state = await prepared(fixture, 'native-fill-failure');
    const executor = { providerId: 'synthetic-trusted-fill', execute: async () => { throw new Error('PRIVATE native failure'); } };
    const result = plain(await new TrustedFillNativeService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.evaluation)));
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode, retryAllowed: result.retryAllowed,
      attentionHandoff: result.attentionHandoff }, { authorized: false, reasonCode: 'native_execution_ambiguous',
      retryAllowed: false, attentionHandoff: true });
    assert.equal(result.job.status, 'needs_info');
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    assert.equal((await read(state.root, 'trusted-fill.json')).approvals[state.id].status, 'revoked');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  });

  await t.test('stale or authority-widening receipt cannot report success', async () => {
    for (const [name, changes] of [['stale', { operationFingerprint: fp('9') }],
      ['final', { finalActionActivated: true }]]) {
      const state = await prepared(fixture, `native-fill-${name}`);
      const executor = { providerId: 'synthetic-trusted-fill', execute: async value => receipt(plain(value), changes) };
      const result = plain(await new TrustedFillNativeService(state.repository, executor, () => state.clock.now)
        .execute(fromJSON(state.evaluation)));
      assert.equal(result.authorized, false); assert.equal(result.reasonCode, 'native_execution_ambiguous');
      assert.equal(result.attentionHandoff, true); assert.equal(result.job.status, 'needs_info');
    }
  });

  await t.test('claim replacement during native execution is left untouched', async () => {
    const state = await prepared(fixture, 'native-fill-replaced');
    const executor = { providerId: 'synthetic-trusted-fill', execute: async value => {
      const coordinator = await read(state.root, 'coordinator.json');
      coordinator.claim.claimId = '22222222-2222-4222-8222-222222222222';
      await write(state.root, 'coordinator.json', coordinator);
      return receipt(plain(value));
    } };
    const result = plain(await new TrustedFillNativeService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.evaluation)));
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode, attentionHandoff: result.attentionHandoff },
      { authorized: false, reasonCode: 'native_receipt_stale', attentionHandoff: false });
    assert.equal((await read(state.root, 'coordinator.json')).claim.claimId, '22222222-2222-4222-8222-222222222222');
    assert.equal((await read(state.root, 'jobs.json')).jobs[state.id].status, 'in_progress');
  });
});
