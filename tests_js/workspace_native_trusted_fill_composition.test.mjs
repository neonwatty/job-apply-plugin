import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { addToRun, plain, read, setup, snapshot } from './workspace_native_claims_support.mjs';
import { resolveAccountRealm } from '../runtime/contracts/workspace/account-realm.js';
import { fromJSON } from '../runtime/contracts/workspace/values.js';
import { TrustedFillService } from '../runtime/workspace-core/trusted-fill.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';

const fp = character => `sha256:${character.repeat(64)}`;
const portal = suffix => `https://example.wd1.myworkdayjobs.com/en-US/careers/job/${suffix}`;

async function prepared(fixture, name) {
  const state = await setup(fixture, name), id = 'composed-fill-job', url = portal(name);
  await state.jobs.create(fromJSON({ id, url, role: 'Engineer', company: 'Synthetic', ats: 'workday', resumeId: 'resume' }));
  await addToRun(state, id);
  const selected = plain(await state.claims.select(id, 1n, true));
  const acquired = plain(await state.claims.acquire(id, fromJSON('Composed Trusted Fill'), BigInt(selected.job.revision)));
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

function receipt(packet) {
  return fromJSON({ schemaVersion: 1, providerId: 'composed-trusted-fill',
    operationFingerprint: packet.operationFingerprint, appliedOperations: packet.allowedOperations,
    finalActionActivated: false, authenticationActivated: false, consentActivated: false,
    credentialFieldsTouched: false, privateValuesCleared: true, retryAllowed: false });
}

test('Trusted Fill HTTP composition reaches only an injected protected provider', { timeout: 60_000 }, async t => {
  const fixture = await nativeFixture(); t.after(() => fixture.cleanup());

  await t.test('configured dispatcher consumes authority through the native boundary', async () => {
    const state = await prepared(fixture, 'composition-success');
    const privateContext = { value: 'PRIVATE-CANONICAL-VALUE' }; let calls = 0;
    const executor = { providerId: 'composed-trusted-fill', execute: async value => {
      calls += 1;
      const packet = plain(value), ephemeral = privateContext.value;
      assert.equal(ephemeral, 'PRIVATE-CANONICAL-VALUE');
      assert.deepEqual(packet.allowedOperations, ['fill_text', 'select_option']);
      assert.equal(packet.finalActionAuthorized, false);
      assert.doesNotMatch(JSON.stringify(packet), /PRIVATE|claimId|approvalId|nonce|content_/);
      privateContext.value = '';
      return receipt(packet);
    } };
    const response = await jobsHttp(state.jobs, state.repository, 'POST', '/api/trusted-fill/evaluate',
      JSON.stringify(state.evaluation), { trustedFill: { executor, now: () => state.clock.now } });
    assert.equal(response.status, 200, String(response.body));
    const result = JSON.parse(response.body);
    assert.equal(calls, 1); assert.equal(privateContext.value, '');
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode,
      finalActionAuthorized: result.finalActionAuthorized, privateValuesCleared: result.privateValuesCleared },
    { authorized: true, reasonCode: 'native_fields_applied', finalActionAuthorized: false, privateValuesCleared: true });
    assert.equal((await read(state.root, 'trusted-fill.json')).approvals[state.id].status, 'revoked');
  });

  await t.test('ordinary dispatcher rejects before consuming approval when no provider is configured', async () => {
    const state = await prepared(fixture, 'composition-missing'), before = await snapshot(state.root);
    const response = await jobsHttp(state.jobs, state.repository, 'POST', '/api/trusted-fill/evaluate',
      JSON.stringify(state.evaluation));
    assert.equal(response.status, 400);
    assert.deepEqual(JSON.parse(response.body), { error: { code: 'store_rejected',
      message: 'native trusted fill provider injection is required' } });
    assert.deepEqual(await snapshot(state.root), before);
  });
});
