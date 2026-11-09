import assert from 'node:assert/strict';
import test from 'node:test';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { addToRun, plain, read, setup, snapshot } from './workspace_native_claims_support.mjs';
import { AccountsService } from '../runtime/workspace-core/accounts.js';
import { AutomationService } from '../runtime/workspace-core/automation.js';
import { EmailOnlyAccountService } from '../runtime/workspace-core/email-only-account.js';
import { fingerprint } from '../runtime/contracts/workspace/synthetic-account.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const portal = 'https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/7/apply/email';
const controlNames = ['form', 'email', 'terms', 'document', 'next'];

async function prepared(fixture, name) {
  const state = await setup(fixture, name);
  const created = plain(await state.jobs.create(fromJSON({ id: 'oracle-job', url: portal,
    role: 'Engineer', company: 'Synthetic', ats: 'oracle' })));
  await addToRun(state, created.id);
  await state.claims.select('oracle-job', BigInt(created.revision), true);
  const selected = plain(await state.jobs.get('oracle-job'));
  const acquired = plain(await state.claims.acquire('oracle-job', fromJSON('Synthetic owner'), BigInt(selected.revision)));
  const account = plain(await new AccountsService(state.repository, () => state.clock.now).create(portal));
  await new AutomationService(state.repository, () => state.clock.now).update(fromJSON({
    enabled: true, automaticAccountCreation: true, signupEmail: 'private@example.invalid',
  }), 1n);
  const controls = Object.fromEntries(controlNames.map(name => [name, fingerprint(`oracle-${name}`)]));
  return { ...state, packet: {
    jobId: 'oracle-job', jobRevision: acquired.job.revision, expectedClaimId: acquired.claim.claimId,
    realmRef: account.realmRef, realmDescriptor: account.descriptor,
    flowKind: 'email_only_candidate_profile', accountRevision: account.revision, settingsRevision: 2,
    portalUrl: `http://127.0.0.1:43123/oracle?operation=${'a'.repeat(64)}`,
    accountFormFingerprint: controls.form, emailControlFingerprint: controls.email,
    termsControlFingerprint: controls.terms, termsDocumentFingerprint: controls.document,
    nextControlFingerprint: controls.next, passwordControlFingerprint: null,
    createAccountControlFingerprint: null,
    accountCreationControlsFingerprint: fingerprint(controlNames.map(name => controls[name]).join(':')),
  } };
}

function receipt(outcome = 'active') {
  return fromJSON({ providerId: 'synthetic-email-only', outcome, retryAllowed: false,
    finalActionAuthorized: false, emailRemoved: true, termsAccepted: true,
    nextActivations: 1, credentialProviderInvocations: 0 });
}

test('native email-only account execution is credential-free, journaled, and fail closed', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());

  await t.test('exact Oracle bindings complete one non-final active lifecycle', async () => {
    const state = await prepared(fixture, 'email-only-success');
    let calls = 0;
    const executor = { providerId: 'synthetic-email-only', execute: async (request, privateEmail) => {
      calls += 1;
      assert.equal(privateEmail(), 'private@example.invalid');
      assert.doesNotMatch(serialize(request), /private@example/);
      return receipt();
    } };
    const result = plain(await new EmailOnlyAccountService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.packet)));
    assert.equal(calls, 1);
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode,
      retryAllowed: result.retryAllowed, attentionHandoff: result.attentionHandoff,
      finalActionAuthorized: result.finalActionAuthorized }, {
      authorized: true, reasonCode: 'active', retryAllowed: false,
      attentionHandoff: false, finalActionAuthorized: false,
    });
    assert.equal(result.account.lifecycleState, 'active');
    assert.equal(result.account.revision, 3);
    assert.equal(result.account.providerAssigned, false);
    assert.equal(result.account.credentialRequired, false);
    assert.doesNotMatch(JSON.stringify(result), /private@example|credential_/);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
    assert.equal((await read(state.root, 'coordinator.json')).claim.jobId, 'oracle-job');
  });

  await t.test('provider failure burns the attempt and creates durable attention', async () => {
    const state = await prepared(fixture, 'email-only-ambiguous');
    const executor = { providerId: 'synthetic-email-only', execute: async () => { throw new Error('PRIVATE failure'); } };
    const result = plain(await new EmailOnlyAccountService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.packet)));
    assert.deepEqual({ authorized: result.authorized, reasonCode: result.reasonCode,
      retryAllowed: result.retryAllowed, attentionHandoff: result.attentionHandoff },
    { authorized: false, reasonCode: 'ambiguous', retryAllowed: false, attentionHandoff: true });
    assert.equal(result.account.lifecycleState, 'ambiguous');
    assert.equal(result.account.revision, 3);
    assert.equal(result.job.status, 'needs_info');
    assert.doesNotMatch(JSON.stringify(result), /PRIVATE|private@example|credential_/);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
    assert.equal((await read(state.root, 'coordinator.json')).claim, null);
    const session = await read(state.root, 'sessions/oracle-job.json');
    assert.equal(session.step, 'account_automation_denied:ambiguous');
    assert.deepEqual(session.blockers, [{ type: 'browser_handoff', code: 'browser-state-uncertain' }]);
  });

  await t.test('verification outcome persists without credential metadata and hands off', async () => {
    const state = await prepared(fixture, 'email-only-verification');
    const executor = { providerId: 'synthetic-email-only', execute: async () => receipt('verification_required') };
    const result = plain(await new EmailOnlyAccountService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.packet)));
    assert.equal(result.reasonCode, 'verification_required');
    assert.equal(result.job.status, 'needs_info');
    assert.equal(result.credentialProviderInvocations, 0);
    const session = await read(state.root, 'sessions/oracle-job.json');
    assert.deepEqual(session.blockers, [{ type: 'browser_handoff', code: 'mfa-required' }]);
  });

  await t.test('widened attestations fail closed after the durable burn', async () => {
    const state = await prepared(fixture, 'email-only-widened');
    const executor = { providerId: 'synthetic-email-only', execute: async () => fromJSON({
      providerId: 'synthetic-email-only', outcome: 'active', retryAllowed: true,
      finalActionAuthorized: false, emailRemoved: true, termsAccepted: true,
      nextActivations: 1, credentialProviderInvocations: 0,
    }) };
    const result = plain(await new EmailOnlyAccountService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON(state.packet)));
    assert.equal(result.reasonCode, 'ambiguous');
    assert.equal(result.account.lifecycleState, 'ambiguous');
    assert.equal(result.job.status, 'needs_info');
  });

  await t.test('concurrent attempts serialize and invoke the provider once', async () => {
    const state = await prepared(fixture, 'email-only-concurrent');
    let calls = 0;
    const executor = { providerId: 'synthetic-email-only', execute: async () => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 25));
      return receipt();
    } };
    const services = [1, 2].map(() => new EmailOnlyAccountService(state.repository, executor, () => state.clock.now));
    const outcomes = await Promise.allSettled(services.map(service => service.execute(fromJSON(state.packet))));
    assert.equal(calls, 1);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter(item => item.status === 'rejected').length, 1);
    assert.match(outcomes.find(item => item.status === 'rejected').reason.message, /revision conflict/);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
  });

  await t.test('malformed bindings reject before provider invocation or mutation', async () => {
    const state = await prepared(fixture, 'email-only-invalid');
    let called = false;
    const executor = { providerId: 'synthetic-email-only', execute: async () => { called = true; return receipt(); } };
    const before = await snapshot(state.root);
    await assert.rejects(new EmailOnlyAccountService(state.repository, executor, () => state.clock.now)
      .execute(fromJSON({ ...state.packet, accountCreationControlsFingerprint: fingerprint('wrong') })), /aggregate control binding/);
    assert.equal(called, false);
    assert.deepEqual(await snapshot(state.root), before);
  });
});
