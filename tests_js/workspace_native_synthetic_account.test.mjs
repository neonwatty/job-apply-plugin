import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { plain, read, setup, snapshot } from './workspace_native_claims_support.mjs';
import { AccountsService } from '../runtime/workspace-core/accounts.js';
import { AutomationService } from '../runtime/workspace-core/automation.js';
import { SyntheticAccountService } from '../runtime/workspace-core/synthetic-account.js';
import { jobsHttp } from '../runtime/workspace-core/jobs-http.js';
import { fingerprint, operationFingerprint, syntheticProofs } from '../runtime/contracts/workspace/synthetic-account.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const portal = 'https://example.wd1.myworkdayjobs.com/en-US/careers/job/42';
const credentialRef = `credential_${'a'.repeat(64)}`;

async function prepared(fixture, name) {
  const state = await setup(fixture, name);
  const created = plain(await state.jobs.create(fromJSON({ id: 'account-job', url: portal,
    role: 'Engineer', company: 'Synthetic', ats: 'workday' })));
  await state.claims.select('account-job', BigInt(created.revision), true);
  const selected = plain(await state.jobs.get('account-job'));
  const acquired = plain(await state.claims.acquire('account-job', fromJSON('Synthetic owner'), BigInt(selected.revision)));
  const accounts = new AccountsService(state.repository, () => state.clock.now);
  const account = plain(await accounts.create(portal));
  await new AutomationService(state.repository, () => state.clock.now).update(fromJSON({
    enabled: true, automaticAccountCreation: true, signupEmail: 'private@example.invalid',
  }), 1n);
  const proofs = plain(syntheticProofs('http://127.0.0.1:43123/synthetic-account'));
  const operation = operationFingerprint('http://127.0.0.1:43123/synthetic-account', account.realmRef, proofs.secureControlFingerprint);
  const target = `http://127.0.0.1:43123/synthetic-account?operation=${operation.slice(7)}`;
  return { ...state, packet: {
    jobId: 'account-job', expectedJobRevision: acquired.job.revision,
    expectedClaimId: acquired.claim.claimId, realmRef: account.realmRef,
    realmDescriptor: account.descriptor, expectedSettingsRevision: 2,
    expectedAccountRevision: account.revision, syntheticTargetUrl: target,
    syntheticTargetFingerprint: fingerprint(target),
    observedFormFingerprint: proofs.observedFormFingerprint,
    observedControlFingerprint: proofs.observedControlFingerprint,
    secureControlFingerprint: proofs.secureControlFingerprint,
  } };
}

test('native synthetic protected account execution is journaled, redacted, and fail closed', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());

  await t.test('an injected synthetic executor can complete one non-final active lifecycle', async () => {
    const state = await prepared(fixture, 'synthetic-success');
    let calls = 0;
    const executor = { providerId: 'synthetic-protected', execute: async (request, strategy, existing, privateEmail) => {
      calls += 1;
      assert.equal(strategy, 'unique_per_realm');
      assert.equal(existing, null);
      assert.equal(privateEmail(), 'private@example.invalid');
      assert.doesNotMatch(serialize(request), /private@example/);
      return fromJSON({ lifecycleState: 'active', providerId: 'synthetic-protected',
        credentialRef, credentialVersion: 1, reused: false, retryAllowed: false,
        finalActionAuthorized: false, secureControlCleared: true });
    } };
    const result = plain(await new SyntheticAccountService(state.repository, executor, () => state.clock.now).execute(fromJSON(state.packet)));
    assert.equal(calls, 1);
    assert.equal(result.authorized, true);
    assert.equal(result.reasonCode, 'active');
    assert.equal(result.attentionHandoff, false);
    assert.equal(result.finalActionAuthorized, false);
    assert.equal(result.account.lifecycleState, 'active');
    assert.equal(result.account.revision, 4);
    assert.equal(result.account.providerAssigned, true);
    assert.doesNotMatch(JSON.stringify(result), /private@example|credential_/);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
    assert.equal((await read(state.root, 'coordinator.json')).claim.jobId, 'account-job');
  });

  await t.test('executor failure burns the attempt, marks ambiguity, and durably hands off', async () => {
    const state = await prepared(fixture, 'synthetic-ambiguous');
    const service = new SyntheticAccountService(state.repository, { providerId: 'synthetic-protected', execute: async () => { throw new Error('private failure'); } }, () => state.clock.now);
    const result = plain(await service.execute(fromJSON(state.packet)));
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode, retryAllowed: result.retryAllowed,
      attentionHandoff: result.attentionHandoff }, { authorized: false, reasonCode: 'ambiguous', retryAllowed: false, attentionHandoff: true });
    assert.equal(result.account.lifecycleState, 'ambiguous');
    assert.equal(result.job.status, 'needs_info');
    assert.doesNotMatch(JSON.stringify(result), /private failure|private@example|credential_/);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    const session = await read(state.root, 'sessions/account-job.json');
    assert.equal(session.step, 'account_automation_denied:ambiguous');
    assert.deepEqual(session.blockers, [{ type: 'browser_handoff', code: 'browser-state-uncertain' }]);
  });

  await t.test('a verified non-active outcome keeps the credential metadata private and requests attention', async () => {
    const state = await prepared(fixture, 'synthetic-verification');
    const executor = { providerId: 'synthetic-protected', execute: async () => fromJSON({ lifecycleState: 'verification_required',
      providerId: 'synthetic-protected', credentialRef, credentialVersion: 1, reused: false,
      retryAllowed: false, finalActionAuthorized: false, secureControlCleared: true }) };
    const result = plain(await new SyntheticAccountService(state.repository, executor, () => state.clock.now).execute(fromJSON(state.packet)));
    assert.equal(result.authorized, false);
    assert.equal(result.reasonCode, 'verification_required');
    assert.equal(result.job.status, 'needs_info');
    assert.doesNotMatch(JSON.stringify(result), /credential_/);
    const session = await read(state.root, 'sessions/account-job.json');
    assert.equal(session.step, 'account_automation_denied:verification_required');
    assert.deepEqual(session.blockers, [{ type: 'browser_handoff', code: 'mfa-required' }]);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
  });

  await t.test('the public HTTP surface cannot inject a protected provider or mutate the fixture', async () => {
    const state = await prepared(fixture, 'synthetic-http-denied');
    const before = await snapshot(state.root);
    const response = await jobsHttp(state.jobs, state.repository, 'POST', '/api/account-operation/execute-synthetic', JSON.stringify(state.packet));
    assert.equal(response.status, 400);
    assert.match(response.body, /native protected provider injection is required/);
    assert.deepEqual(await snapshot(state.root), before);
  });

  await t.test('malformed loopback bindings fail before the injected executor or journal write', async () => {
    const state = await prepared(fixture, 'synthetic-invalid');
    let called = false;
    const service = new SyntheticAccountService(state.repository, { providerId: 'synthetic-protected', execute: async () => { called = true; } }, () => state.clock.now);
    const before = await snapshot(state.root);
    await assert.rejects(service.execute(fromJSON({ ...state.packet, syntheticTargetUrl: 'https://example.invalid/synthetic-account' })), /loopback synthetic/);
    assert.equal(called, false);
    assert.deepEqual(await snapshot(state.root), before);
  });
});
