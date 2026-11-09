import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { nativeFixture } from './exclusive_file_lock_support.mjs';
import { addToRun, plain, read, setup } from './workspace_native_claims_support.mjs';
import { AccountsService } from '../runtime/workspace-core/accounts.js';
import { AutomationService } from '../runtime/workspace-core/automation.js';
import { LiveEmailOnlyAccountService } from '../runtime/workspace-core/email-only-account.js';
import { DurableT007ApprovalLedger, OneAttemptCanaryAuthority } from '../runtime/native/macos/canary-authority.js';
import { fingerprint } from '../runtime/contracts/workspace/synthetic-account.js';
import { fromJSON, serialize } from '../runtime/contracts/workspace/values.js';

const portal = 'https://tenant.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobsearch/job/7/apply/email';
const approvalRef = `approval_${'a'.repeat(64)}`;

async function prepared(fixture, name) {
  const state = await setup(fixture, name);
  const created = plain(await state.jobs.create(fromJSON({ id: 'oracle-live', url: portal,
    role: 'Engineer', company: 'Oracle test', ats: 'oracle' })));
  await addToRun(state, created.id);
  await state.claims.select('oracle-live', BigInt(created.revision), true);
  const selected = plain(await state.jobs.get('oracle-live'));
  const acquired = plain(await state.claims.acquire('oracle-live', fromJSON('Private canary owner'), BigInt(selected.revision)));
  const account = plain(await new AccountsService(state.repository, () => state.clock.now).create(portal));
  await new AutomationService(state.repository, () => state.clock.now).update(fromJSON({
    enabled: true, automaticAccountCreation: true, signupEmail: 'private@example.invalid',
  }), 1n);
  const names = ['accountForm', 'emailControl', 'termsControl', 'termsDocument', 'nextControl'];
  const controls = Object.fromEntries(names.map(item => [item, fingerprint(`oracle-${item}`)]));
  const aggregate = fingerprint(names.map(item => controls[item]).join(':'));
  const portalName = 'Oracle Recruiting';
  const binding = {
    jobId: 'oracle-live', jobRevision: acquired.job.revision, claimId: acquired.claim.claimId,
    realmRef: account.realmRef, accountRevision: account.revision, settingsRevision: 2,
    portalFingerprint: fingerprint(portal), portalNameFingerprint: fingerprint(portalName),
    accountCreationControlsFingerprint: aggregate, approvalRevision: 1,
    flowKind: 'email_only_candidate_profile', termsDocumentFingerprint: controls.termsDocument,
    accountFormFingerprint: controls.accountForm, emailControlFingerprint: controls.emailControl,
    termsControlFingerprint: controls.termsControl, nextControlFingerprint: controls.nextControl,
    passwordControlFingerprint: null, createAccountControlFingerprint: null,
  };
  const request = { capabilityRef: null, binding, portalName, portalUrl: portal,
    accountFormFingerprint: controls.accountForm, emailControlFingerprint: controls.emailControl,
    termsControlFingerprint: controls.termsControl, termsDocumentFingerprint: controls.termsDocument,
    nextControlFingerprint: controls.nextControl, passwordControlFingerprint: null,
    createAccountControlFingerprint: null };
  const ledgerPath = join(fixture.root, `${name}-t007.json`);
  const ledger = new DurableT007ApprovalLedger(ledgerPath, state.provider);
  const authority = new OneAttemptCanaryAuthority(ledger);
  await ledger.recordExactApproval(approvalRef, fromJSON(binding));
  request.capabilityRef = await authority.issue(fromJSON(binding), approvalRef, new Date(state.clock.now));
  return { ...state, ledgerPath, authority, request };
}

function receipt(outcome = 'active') {
  return fromJSON({ providerId: 'macos-accessibility', outcome, retryAllowed: false,
    finalActionAuthorized: false, emailRemoved: true, termsAccepted: true,
    nextActivations: 1, credentialProviderInvocations: 0 });
}

test('private native email canary composition preserves one-attempt authority ordering', { timeout: 60000 }, async t => {
  const fixture = await nativeFixture();
  t.after(() => fixture.cleanup());

  await t.test('journal and capability burns precede the sole native effect', async () => {
    const state = await prepared(fixture, 'live-canary-success');
    let calls = 0;
    const executor = { providerId: 'macos-accessibility', execute: async (packet, privateEmail) => {
      calls += 1;
      const journal = await read(state.root, 'account-operation-journal.json');
      const account = Object.values((await read(state.root, 'employer-accounts.json')).accounts)[0];
      const ledger = JSON.parse(await readFile(state.ledgerPath, 'utf8'));
      assert.equal(journal.operation.stage, 'signup_in_progress');
      assert.equal(account.lifecycleState, 'signup_in_progress');
      assert.equal(Object.values(ledger.attempts)[0].attempted, true);
      assert.match(plain(packet).operationFingerprint, /^sha256:[0-9a-f]{64}$/);
      assert.equal(privateEmail(), 'private@example.invalid');
      assert.doesNotMatch(serialize(packet), /private@example|approval_|canary_/);
      return receipt();
    } };
    const result = plain(await new LiveEmailOnlyAccountService(state.repository, executor, state.authority,
      () => state.clock.now).execute(fromJSON(state.request)));
    assert.equal(calls, 1);
    assert.equal(result.authorized, true);
    assert.equal(result.account.lifecycleState, 'active');
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation, null);
    const durable = await readFile(state.ledgerPath, 'utf8');
    assert.doesNotMatch(durable, /approval_|canary_|private@example/);
  });

  await t.test('binding drift burns authority and leaves the prepared journal for recovery', async () => {
    const state = await prepared(fixture, 'live-canary-drift');
    const drifted = structuredClone(state.request);
    drifted.binding.approvalRevision = 2;
    let called = false;
    const executor = { providerId: 'macos-accessibility', execute: async () => { called = true; return receipt(); } };
    await assert.rejects(new LiveEmailOnlyAccountService(state.repository, executor, state.authority,
      () => state.clock.now).execute(fromJSON(drifted)), /binding drifted/);
    assert.equal(called, false);
    assert.equal((await read(state.root, 'account-operation-journal.json')).operation.stage, 'prepared');
    const attempt = Object.values(JSON.parse(await readFile(state.ledgerPath, 'utf8')).attempts)[0];
    assert.equal(attempt.attempted, true);
  });

  await t.test('expired and replayed capabilities remain permanently unavailable', async () => {
    const state = await prepared(fixture, 'live-canary-expiry');
    await assert.rejects(state.authority.issue(fromJSON(state.request.binding), approvalRef,
      new Date(state.clock.now)), /exact private T007 approval/);
    await assert.rejects(state.authority.attempt(state.request.capabilityRef, fromJSON(state.request.binding),
      new Date('2026-09-10T12:06:00Z')), /expired/);
    await assert.rejects(state.authority.attempt(state.request.capabilityRef, fromJSON(state.request.binding),
      new Date(state.clock.now)), /unavailable/);
  });
});
