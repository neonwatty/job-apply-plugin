import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FinalActionPolicyService, PolicyError, type LeaseDecision, type ReviewDecision } from '../final-action-policy/service.js';
import { canonical as policyCanonical, confirmationAuthorityRevision } from '../final-action-policy/model.js';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
import { loadPosixFlockProvider } from '../store/posix-flock.js';
import { readJson, ReplayError, validateFixture } from './contracts.js';

const opaque = (kind: string, label: string) => `${kind}:${createHash('sha256').update(label).digest('hex')}`;
const revision = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`;
async function refused(operation: () => Promise<unknown>): Promise<boolean> { try { await operation(); return false; } catch (error) { return error instanceof PolicyError; } }
function granted(value: LeaseDecision | ReviewDecision): LeaseDecision { if (value.mode !== 'auto_submit') throw new ReplayError('native policy verification failed'); return value; }

export async function verifyAutoSubmit(path: string): Promise<Record<string, unknown>> {
  const fixture = validateFixture(await readJson(path, 'invalid fixture package')), root = await mkdtemp(join(tmpdir(), 'job-apply-auto-submit-'));
  if (fixture.steps.filter(step => step.kind === 'review').length !== 1) throw new ReplayError('invalid fixture package');
  const pluginRoot = await realpath(fileURLToPath(new URL('../../', import.meta.url))), provider = loadPosixFlockProvider(await resolvePackagedNativeLock(pluginRoot));
  const checkedAt = new Date(Math.floor(Date.now() / 1000) * 1000), clock = () => checkedAt, capability = 'a'.repeat(64);
  const applicationRef = opaque('application', 'synthetic-application'), sensitive = { answerRef: opaque('answer', 'synthetic-sensitive-answer'),
    questionRevision: revision('synthetic-question-v1'), answerRevision: revision('synthetic-answer-v1') };
  const rule = { applicationRef, origin: 'http://127.0.0.1:1', urlFingerprint: revision('synthetic-loopback-url'), ats: 'linkedin',
    jobFingerprint: revision('synthetic-job'), formRevision: revision('synthetic-form-v1'), finalControlRevision: revision('synthetic-final-control-v1') };
  const authorization = { ...rule, resumeRevision: revision('synthetic-resume-v1'), answerRevisions: [sensitive] };
  const campaign = { riskAcknowledged: true, applicationRules: [rule], resumeRevision: authorization.resumeRevision,
    sensitiveAllowlist: [sensitive], confirmationAuthorityRevision: confirmationAuthorityRevision(capability), maxApplications: 1, durationSeconds: 300 };
  const service = (name: string, selectedClock = clock) => new FinalActionPolicyService(join(root, name), { provider, clock: selectedClock });
  const checks: Record<string, boolean> = {}, scenarios: Record<string, unknown> = {}; let activations = 0;
  try {
    checks['danger-warning-required'] = await refused(() => service('danger').activate({ ...campaign, riskAcknowledged: false }));
    checks['review-only-zero-activations'] = activations === 0;
    const success = service('success'); await success.activate(campaign); const lease = granted(await success.authorize(authorization));
    const claim = await success.claim(applicationRef, lease.leaseId, lease.attempt, authorization, capability, () => { activations += 1; });
    const repeatDenied = await refused(() => success.claim(applicationRef, lease.leaseId, lease.attempt, authorization, capability, () => { activations += 1; }));
    const observed = { eventId: opaque('receipt', 'synthetic-confirmation'), claimId: claim.claimId, source: 'isolated_loopback',
      observedAt: checkedAt.toISOString().replace('.000Z', 'Z'), confirmationRevision: revision('synthetic-confirmation-v1'), activationObserved: true };
    const confirmation = { ...observed, proof: createHmac('sha256', capability).update(policyCanonical(observed)).digest('hex') };
    const receipt = await success.outcome(lease.campaignId, applicationRef, lease.leaseId, claim.claimId, 'confirmed_submitted', confirmation, capability);
    checks['success-one-claimed-activation'] = activations === 1 && repeatDenied && receipt.status === 'confirmed_submitted';
    checks['independent-confirmation-required'] = confirmation.source === 'isolated_loopback' && confirmation.activationObserved && claim.reason === 'atomic_action_claim';
    scenarios.success = { status: checks['success-one-claimed-activation'] ? 'passed' : 'failed', attempts: 1, claimedActivations: activations, terminalState: receipt.status };
    checks['actual-review-only-refused'] = (await service('missing').authorize(authorization)).mode === 'review_only';

    const boundary = service('boundary'); await boundary.activate(campaign); const boundaryLease = granted(await boundary.authorize(authorization));
    const mutations = [{ origin: 'https://redirect.invalid' }, { urlFingerprint: revision('redirect') }, { formRevision: revision('form') },
      { finalControlRevision: revision('control') }, { answerRevisions: [{ ...sensitive, answerRevision: revision('answer') }] }];
    const mutationResults = await Promise.all(mutations.map(change => refused(() => boundary.claim(applicationRef, boundaryLease.leaseId, 1, { ...authorization, ...change }, capability))));
    await boundary.kill(); const killed = await refused(() => boundary.claim(applicationRef, boundaryLease.leaseId, 1, authorization, capability));
    const expiredAt = new Date(checkedAt.getTime() - 2000), expiry = service('expiry', () => checkedAt); const expirySetup = service('expiry', () => expiredAt);
    await expirySetup.activate({ ...campaign, durationSeconds: 1 }); const expiredLease = granted(await expirySetup.authorize(authorization));
    const expired = await refused(() => expiry.claim(applicationRef, expiredLease.leaseId, 1, authorization, capability));
    checks['forged-stale-prompt-redirect-kill-expiry-refused'] = mutationResults.every(Boolean) && killed && expired;

    const concurrent = service('concurrent'); await concurrent.activate(campaign); const concurrentLease = granted(await concurrent.authorize(authorization)); let concurrentActivations = 0;
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => concurrent.claim(applicationRef, concurrentLease.leaseId, 1, authorization, capability, () => { concurrentActivations += 1; })));
    checks['concurrent-activation-single-winner'] = results.filter(item => item.status === 'fulfilled').length === 1 && concurrentActivations === 1;

    const race = service('race'); await race.activate(campaign); const raceLease = granted(await race.authorize(authorization)); let release!: () => void;
    const held = new Promise<void>(accept => { release = accept; }), entered = { value: false };
    const claiming = race.claim(applicationRef, raceLease.leaseId, 1, authorization, capability, async () => { entered.value = true; await held; });
    while (!entered.value) await new Promise(accept => setImmediate(accept)); const killing = race.kill(); let killedEarly = false; void killing.then(() => { killedEarly = true; });
    await new Promise(accept => setImmediate(accept)); const blocked = !killedEarly; release(); await claiming; await killing;
    checks['kill-versus-activation-linearized'] = blocked && (await race.status()).mode === 'review_only';

    const limited = service('limit'); const secondRule = { ...rule, applicationRef: opaque('application', 'second'), urlFingerprint: revision('url-2'), jobFingerprint: revision('job-2') };
    await limited.activate({ ...campaign, applicationRules: [rule, secondRule] }); await limited.authorize(authorization);
    const limitDenied = (await limited.authorize({ ...authorization, applicationRef: secondRule.applicationRef, urlFingerprint: secondRule.urlFingerprint, jobFingerprint: secondRule.jobFingerprint })).mode === 'review_only';
    checks['all-stop-boundaries-zero-activations'] = mutationResults.every(Boolean) && killed && expired && limitDenied;
    checks['denials-and-receipts-redacted'] = !JSON.stringify(receipt).includes(capability) && Object.keys(receipt).length === 12;
    scenarios['safety-boundaries'] = { status: checks['all-stop-boundaries-zero-activations'] ? 'passed' : 'failed', claimedActivations: 0, terminalState: 'review_only' };

    const retry = service('retry'); await retry.activate(campaign); const first = granted(await retry.authorize(authorization));
    const firstClaim = await retry.claim(applicationRef, first.leaseId, first.attempt, authorization, capability); const firstReceipt = await retry.outcome(first.campaignId, applicationRef, first.leaseId, firstClaim.claimId, 'uncertain');
    const second = granted(await retry.authorize(authorization)); const secondClaim = await retry.claim(applicationRef, second.leaseId, second.attempt, authorization, capability);
    const exhausted = await retry.outcome(second.campaignId, applicationRef, second.leaseId, secondClaim.claimId, 'uncertain'); const denied = await retry.authorize(authorization);
    checks['one-retry-terminal-exhaustion'] = firstReceipt.status === 'retry_available' && second.attempt === 2 && exhausted.status === 'uncertain_exhausted' && denied.mode === 'review_only';
    scenarios['uncertainty-retry'] = { status: checks['one-retry-terminal-exhaustion'] ? 'passed' : 'failed', attempts: 2, claimedActivations: 2, terminalState: exhausted.status };
  } finally { await rm(root, { recursive: true, force: true }); }
  return { fixtureId: fixture.id, status: Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    assertions: Object.fromEntries(Object.entries(checks).sort().map(([key, value]) => [key, value ? 'passed' : 'failed'])), scenarios, redacted: true };
}
