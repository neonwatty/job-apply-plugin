import { createHmac, randomBytes } from 'node:crypto';
import { lstat, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { FinalActionPolicyService } from '../final-action-policy/service.js';
import {
  canonical as policyCanonical, confirmationAuthorityRevision, formatTime,
} from '../final-action-policy/model.js';
import { canonical, readJson, ReplayError, type Fixture } from './contracts.js';
import { browserResumeFilename, digest, labApprovalEnabled, requireLoopbackOrigin, requireSubmissionRun, revision, submissionInputs,
  submissionLockProvider, withSubmissionLifecycle } from './submission-boundary.js';
import { batchFormRevision, requireBatchPermission, reviewRevisionPattern, withBatchAction } from './submission-batch-store.js';
import { submissionJob } from './submission-jobs.js';

export const submissionActions = ['preview', 'approve', 'submit', 'cancel', 'batch-submit'] as const;
type Action = typeof submissionActions[number];
type ReviewField = { id: string; label: string; value: string };
type Review = { stepId: string; fields: ReviewField[]; resumeDigest: string };
type PortalConfirmation = {
  eventId: string;
  claimId: string;
  source: 'isolated_loopback';
  observedAt: string;
  confirmationRevision: string;
  activationObserved: true;
  proof: string;
};

class ReplayPolicy extends FinalActionPolicyService {
  async reservation() {
    return this.locked(async () => {
      if (!await fileExists(this.campaignPath)) return null;
      const campaign = await this.loadCampaign();
      const applications = await this.campaignApplications(campaign.campaignId);
      if (applications.length > 1) throw new ReplayError('invalid synthetic submission reservation');
      return { campaign, application: applications[0] ?? null };
    });
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new ReplayError('invalid synthetic submission request');
  }
  return value as Record<string, unknown>;
}

function syntheticCapability(ownerToken: string): string {
  return createHmac('sha256', ownerToken).update('job-apply/qa/synthetic-submission/v1').digest('hex');
}

async function getPolicy(root: string): Promise<ReplayPolicy> {
  return new ReplayPolicy(join(root, 'store'), { provider: await submissionLockProvider() });
}

function readReview(fixture: Fixture, request: unknown, resumeDigest: string): Review {
  const input = exactObject(request, ['stepId', 'values', 'resumeDigest']);
  const step = fixture.steps.find(candidate => candidate.kind === 'review');
  if (!step?.finalAction?.enabled || !step.finalAction.tripwire || input.stepId !== step.id
    || input.resumeDigest !== resumeDigest || !Array.isArray(input.values)) {
    throw new ReplayError('synthetic review does not match the fixture');
  }

  const controls = fixture.steps.flatMap(item => item.controls).filter(control => control.role !== 'file');
  if (input.values.length !== controls.length) throw new ReplayError('synthetic review is incomplete');
  const fields = controls.map((control, index) => {
    const field = exactObject((input.values as unknown[])[index], ['id', 'value']);
    if (field.id !== control.id || typeof field.value !== 'string' || field.value.length > 1024
      || (control.required && !field.value.trim()) || (field.value && control.choices && !control.choices.includes(field.value))) {
      throw new ReplayError('synthetic review has an invalid answer');
    }
    return { id: control.id, label: control.label, value: field.value };
  });
  return { stepId: step.id, fields, resumeDigest };
}

/** Restore only the independently recorded synthetic portal acknowledgment. */
export async function submissionStatus(root: string, ownerToken: string, formRevision?: string): Promise<Record<string, unknown>> {
  await requireSubmissionRun(root);
  const policy = await getPolicy(root);
  const state = await policy.reservation();
  if (!state || (formRevision && state.campaign.applicationRules[0]?.formRevision !== formRevision)) {
    return { status: 'awaiting_approval' };
  }
  const attempt = state.application?.attempts.at(-1);
  if (!attempt?.claimId || !state.application) {
    return { status: (await policy.status()).mode === 'auto_submit' ? 'approved' : 'blocked' };
  }

  const acceptance = join(root, 'synthetic-portal-acceptance.json');
  if (!await fileExists(acceptance)) return { status: 'submission_uncertain' };

  const event = await readJson(acceptance, 'invalid synthetic submission acknowledgment');
  const receipt = await policy.outcome(state.campaign.campaignId, state.application.applicationRef,
    attempt.leaseId, attempt.claimId, 'confirmed_submitted', event, syntheticCapability(ownerToken));
  return { status: receipt.status, receiptId: receipt.receiptId };
}

async function acceptAtSyntheticPortal(root: string, claimId: string, formRevision: string, capability: string): Promise<void> {
  const path = join(root, 'synthetic-portal-acceptance.json');
  if (await fileExists(path)) throw new ReplayError('synthetic portal already accepted the application');
  const observed = {
    eventId: `receipt:${randomBytes(32).toString('hex')}`,
    claimId,
    source: 'isolated_loopback' as const,
    observedAt: formatTime(new Date()),
    confirmationRevision: revision({ claimId, formRevision }),
    activationObserved: true as const,
  };
  const event: PortalConfirmation = { ...observed, proof: createHmac('sha256', capability).update(policyCanonical(observed)).digest('hex') };
  const temporary = join(root, `.acceptance-${randomBytes(16).toString('hex')}.tmp`);
  try {
    await writeFile(temporary, canonical(event), { mode: 0o600, flag: 'wx', flush: true });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

export function createApprovedSubmission(root: string, origin: string, fixture: Fixture, ownerToken: string,
  jobId?: string, companion = false) {
  requireLoopbackOrigin(origin);
  const capability = syntheticCapability(ownerToken);
  const job = submissionJob(jobId);
  let review: Review | undefined;
  let pending = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const current = pending.then(operation);
    pending = current.then(() => {}, () => {});
    return current;
  };

  async function currentReview() {
    if (!review) throw new ReplayError('complete the synthetic browser review first');
    const inputs = await submissionInputs(root, fixture);
    if (inputs.resumeDigest !== review.resumeDigest) throw new ReplayError('synthetic résumé changed');
    const step = fixture.steps.find(candidate => candidate.id === review!.stepId)!;
    const finalControlRevision = revision(step.finalAction);
    const reviewRevision = `sha256:${createHmac('sha256', capability).update(canonical({
      review, inputsRevision: inputs.inputsRevision, job, origin, finalControlRevision,
    })).digest('hex')}`;
    const rule = {
      applicationRef: `application:${digest(basename(root))}`,
      origin,
      urlFingerprint: revision(origin),
      ats: fixture.platformFamily,
      jobFingerprint: revision({ fixtureId: fixture.id, runId: basename(root), job }),
      formRevision: reviewRevision,
      finalControlRevision,
    };
    return {
      rule, reviewRevision, resumeRevision: `sha256:${inputs.resumeDigest}`,
      preview: { status: 'review', reviewRevision, ...job, fixtureId: fixture.id, destination: origin,
        resume: browserResumeFilename, fields: review.fields },
    };
  }

  async function ownerAction(action: Action, input: unknown): Promise<Record<string, unknown>> {
    if (await fileExists(join(root, 'completed.json')) || await fileExists(join(root, 'abandoned.json'))) {
      throw new ReplayError('run is terminal');
    }
    if (companion && (action === 'approve' || action === 'submit')) {
      throw new ReplayError('Use the Companion approval flow for this test form.');
    }
    if (action === 'preview') {
      exactObject(input, []);
      return (await currentReview()).preview;
    }
    if (action === 'cancel') {
      exactObject(input, []);
      const current = await submissionStatus(root, ownerToken);
      if (current.status === 'confirmed_submitted') return current;
      await (await getPolicy(root)).kill();
      return current.status === 'submission_uncertain' ? current : { status: 'blocked', reason: 'cancelled' };
    }

    const batchSubmit = action === 'batch-submit';
    const { reviewRevision, batchId } = exactObject(input, batchSubmit ? ['reviewRevision', 'batchId'] : ['reviewRevision']);
    if (typeof reviewRevision !== 'string' || !reviewRevisionPattern.test(reviewRevision)) {
      throw new ReplayError('an exact synthetic review revision is required');
    }
    if (batchSubmit && typeof batchId !== 'string') throw new ReplayError('invalid synthetic batch identifier');
    const checkBatch = typeof batchId === 'string'
      ? async () => {
        if (companion && !await labApprovalEnabled(dirname(root))) {
          throw new ReplayError('Submit after approval is off.');
        }
        await requireBatchPermission(batchId, root, job.jobId, reviewRevision);
      }
      : undefined;
    await checkBatch?.();
    const current = await currentReview();
    if (current.reviewRevision !== reviewRevision) throw new ReplayError('synthetic review changed; request a new preview');

    const policy = await getPolicy(root);
    const scopedRevision = typeof batchId === 'string' ? batchFormRevision(batchId, reviewRevision) : undefined;
    const rule = scopedRevision ? { ...current.rule, formRevision: scopedRevision } : current.rule;
    const activate = () => policy.activate({ riskAcknowledged: true, applicationRules: [rule],
      resumeRevision: current.resumeRevision, sensitiveAllowlist: [],
      confirmationAuthorityRevision: confirmationAuthorityRevision(capability), maxApplications: 1, durationSeconds: 300 });
    if (action === 'approve') {
      const prior = await policy.reservation();
      if (prior?.application || prior?.campaign.killSwitch) throw new ReplayError('synthetic approval cannot replace a used or cancelled approval');
      if (prior && (await policy.status()).mode === 'auto_submit') await policy.revoke();
      const approval = await activate();
      return { status: 'approved', reviewRevision, expiresAt: approval.expiresAt };
    }
    if (batchSubmit) {
      const prior = await policy.reservation();
      if (!prior) await activate();
      else if (prior.campaign.applicationRules[0]?.formRevision !== scopedRevision) {
        return { status: 'blocked', reason: 'another_approval_exists' };
      } else if (prior.application) {
        const recovered = await submissionStatus(root, ownerToken, scopedRevision);
        return recovered.status === 'approved' ? { status: 'blocked', reason: 'batch_attempt_already_started' } : recovered;
      }
    }

    const status = await submissionStatus(root, ownerToken, scopedRevision);
    if (status.status !== 'approved') return status;
    const observed = { ...rule, resumeRevision: current.resumeRevision, answerRevisions: [] };
    const lease = await policy.authorize(observed);
    if (lease.mode !== 'auto_submit' || lease.attempt !== 1) return { status: 'blocked', reason: lease.reason };
    try {
      await checkBatch?.();
      await policy.claim(lease.applicationRef, lease.leaseId, lease.attempt, observed, capability, async claim => {
        const fresh = await currentReview();
        if (fresh.reviewRevision !== reviewRevision || Date.now() >= Date.parse(lease.leaseExpiresAt)) {
          throw new ReplayError('synthetic review or lease changed before activation');
        }
        await checkBatch?.();
        await acceptAtSyntheticPortal(root, claim.claimId, fresh.reviewRevision, capability);
      });
    } catch {
      const recovered = await submissionStatus(root, ownerToken, scopedRevision);
      return recovered.status === 'approved' ? { status: 'blocked', reason: 'final_action_denied' } : recovered;
    }
    return submissionStatus(root, ownerToken, scopedRevision);
  }

  return {
    invalidate: () => serialized(async () => { review = undefined; }),
    capture: (value: unknown) => serialized(async () => {
      const { resumeDigest } = await submissionInputs(root, fixture);
      review = readReview(fixture, value, resumeDigest);
    }),
    ownerAction: (action: Action, input: unknown) => serialized(() => withSubmissionLifecycle(root, async () => {
      if (action !== 'batch-submit') return ownerAction(action, input);
      const { batchId } = exactObject(input, ['reviewRevision', 'batchId']);
      if (typeof batchId !== 'string') throw new ReplayError('invalid synthetic batch identifier');
      return withBatchAction(batchId, root, () => ownerAction(action, input));
    })),
  };
}
