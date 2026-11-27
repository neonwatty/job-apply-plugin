import { createHash, randomBytes } from 'node:crypto';
import { requireJobUnclaimed } from '../contracts/workspace/claims.js';
import { safeId, validateJob } from '../contracts/workspace/jobs.js';
import { liveSubmissionEnabled } from '../contracts/workspace/submission-preference.js';
import { get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { ClaimRepository, ClaimTransaction } from './claims.js';
import { preflightJobRecord, reviewedInputsFingerprint } from './job-preflight.js';

type Item = { jobId: string; jobRevision: string; reviewFingerprint: string };
type Bound = Item & { workspaceFingerprint: string };
type Approval = { expiresAt: number; profileRevision: string; items: Bound[] };
type ActionRecord = { approvalId: string; claimId: string; jobRevision: string; status: 'claimed' | 'uncertain' | 'confirmed'; confirmation?: string };
export interface SubmissionLedger {
  read(key: string): Promise<unknown>;
  write(key: string, value: unknown): Promise<void>;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const revision = (value: unknown) => `sha256:${sha(JSON.stringify(value))}`;
const opaque = () => randomBytes(32).toString('hex');
const fingerprint = (value: unknown) => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const opaqueId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const jobKey = (id: string) => `job-${sha(id)}`;
const check = (condition: unknown, reason: string) => { if (!condition) throw new JobsError(reason); };

function fields(value: unknown, names: string[]): Record<string, unknown> {
  check(typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === names.length && names.every(key => Object.hasOwn(value, key)), 'invalid submission request');
  return value as Record<string, unknown>;
}

function readItem(raw: unknown): Item {
  const item = fields(raw, ['jobId', 'jobRevision', 'reviewFingerprint']);
  const jobId = safeId(typeof item.jobId === 'string' ? item.jobId : null);
  check(typeof item.jobRevision === 'string' && /^[1-9][0-9]{0,29}$/.test(item.jobRevision)
    && fingerprint(item.reviewFingerprint), 'an exact job revision and browser review fingerprint are required');
  return { jobId, jobRevision: item.jobRevision as string, reviewFingerprint: item.reviewFingerprint as string };
}

function activeJob(tx: ClaimTransaction, id: string) {
  const value = get(object(get(tx.jobs, 'jobs'), 'jobs'), id);
  if (value === null) return null;
  const job = object(value, 'job');
  return get(job, 'deletedAt') === null ? job : null;
}

function profileRevision(tx: ClaimTransaction) {
  check(liveSubmissionEnabled(tx.profile), 'Submit after approval is off');
  return (int(get(object(get(tx.profile, 'metadata'), 'profile metadata'), 'revision')) ?? 1n).toString();
}

async function bind(tx: ClaimTransaction, item: Item): Promise<Bound> {
  const job = activeJob(tx, item.jobId);
  if (job === null) throw new JobsError('job review is no longer current');
  check(string(get(job, 'status')) === 'awaiting_review'
    && int(get(job, 'revision'))?.toString() === item.jobRevision, 'job review is no longer current');
  requireJobUnclaimed(tx.coordinator, item.jobId);
  const session = tx.sessions.find(entry => string(get(entry, 'applicationId')) === item.jobId);
  check(session && string(get(session, 'status')) === 'review' && get(session, 'readiness') !== null,
    'verified live review is required');
  const ready = object(get(session!, 'readiness'), 'review readiness');
  check(string(get(ready, 'status')) === 'ready' && string(get(ready, 'evidenceKind')) === 'agent_attested_current_attempt'
    && int(get(ready, 'attemptRevision')) === BigInt(item.jobRevision) - 1n, 'verified live review is required');
  check(!tx.history.some(event => string(get(event, 'applicationId')) === item.jobId
    && ['status', 'event'].some(key => ['completed', 'applied', 'submitted', 'confirmed_submitted'].includes(string(get(event, key)) ?? ''))),
  'application history already shows submission');
  const preflight = await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs);
  const reviewedInputs = reviewedInputsFingerprint(tx.jobs, tx.resumes);
  check(get(preflight, 'ready') === true && reviewedInputs !== null
    && reviewedInputs === string(get(session!, 'reviewedInputsFingerprint')), 'the reviewed résumé or confirmed facts are no longer verified');
  return { ...item, workspaceFingerprint: revision([
    string(get(job, 'normalizedUrl')), int(get(ready, 'attemptRevision'))?.toString(),
    int(get(ready, 'observationRevision'))?.toString(), string(get(ready, 'controlSetFingerprint')), reviewedInputs,
  ]) };
}

export class LiveSubmissionService {
  constructor(private readonly repository: ClaimRepository, private readonly ledger: SubmissionLedger,
    private readonly now = Date.now) {}

  status() {
    return this.repository.claimTransaction(async tx => ({ enabled: liveSubmissionEnabled(tx.profile) }));
  }

  preview(input: unknown, approvedId?: string) {
    const { jobs } = fields(input, ['jobs']);
    check(Array.isArray(jobs) && jobs.length >= 1 && jobs.length <= 10, 'select one to ten reviewed jobs');
    const items = (jobs as unknown[]).map(readItem);
    check(new Set(items.map(item => item.jobId)).size === items.length, 'reviewed jobs must be unique');
    return this.repository.claimTransaction(async tx => {
      const profile = profileRevision(tx);
      const bound: Bound[] = [];
      for (const item of items) {
        check(await this.ledger.read(jobKey(item.jobId)) === null, 'verify submission status before another attempt');
        bound.push(await bind(tx, item));
      }
      const previewId = revision({ profile, items: bound });
      if (approvedId === undefined) return { status: 'awaiting_approval', previewId, jobs: items.map(item => item.jobId) };
      check(approvedId === previewId, 'submission preview changed; request a fresh approval');
      const approvalId = opaque(), expiresAt = this.now() + 300_000;
      const approval: Approval = { expiresAt, profileRevision: profile, items: bound };
      await this.ledger.write(`approval-${approvalId}`, approval);
      return { status: 'approved', approvalId, expiresAt: new Date(expiresAt).toISOString() };
    });
  }

  claim(approvalId: string, input: unknown) {
    check(opaqueId(approvalId), 'invalid submission approval');
    const item = readItem(input);
    return this.repository.claimTransaction(async tx => {
      const profile = profileRevision(tx);
      const approval = await this.ledger.read(`approval-${approvalId}`) as Approval | null;
      check(approval && approval.profileRevision === profile && Number.isSafeInteger(approval.expiresAt)
        && this.now() < approval.expiresAt && Array.isArray(approval.items), 'submission approval expired or the saved setting changed');
      const permitted = approval!.items.find(row => row.jobId === item.jobId);
      check(permitted && JSON.stringify(permitted) === JSON.stringify(await bind(tx, item)), 'the application changed after approval');
      check(await this.ledger.read(jobKey(item.jobId)) === null, 'verify submission status before another attempt');
      for (const other of approval!.items) {
        const active = await this.ledger.read(jobKey(other.jobId)) as ActionRecord | null;
        check(active?.status !== 'claimed', 'check the previous application outcome before continuing');
      }
      const now = this.now();
      check(now < approval!.expiresAt, 'submission approval expired');
      const useBefore = Math.min(approval!.expiresAt, now + 15_000);
      const claimId = opaque();
      const action: ActionRecord = { approvalId, claimId, jobRevision: item.jobRevision, status: 'claimed' };
      const key = jobKey(item.jobId);
      await this.ledger.write(key, action);
      if (this.now() >= useBefore) {
        // The Store lock is still held and no caller has received the claim.
        await this.ledger.write(key, null);
        throw new JobsError('submission approval expired before the attempt was issued');
      }
      return { status: 'claimed', claimId, useBefore: new Date(useBefore).toISOString() };
    });
  }

  outcome(input: unknown) {
    const { jobId: rawId, claimId, status, confirmation } = fields(input, ['jobId', 'claimId', 'status', 'confirmation']);
    const jobId = safeId(typeof rawId === 'string' ? rawId : null);
    check(opaqueId(claimId) && (status === 'confirmed' ? fingerprint(confirmation)
      : status === 'uncertain' && confirmation === null), 'a valid attempt and portal confirmation status are required');
    return this.repository.claimTransaction(async tx => {
      const key = jobKey(jobId);
      const prior = await this.ledger.read(key) as ActionRecord | null;
      check(prior?.claimId === claimId, 'submission attempt does not match');
      const record: ActionRecord = prior!.status === 'confirmed' ? prior! : {
        ...prior!, status: status as 'confirmed' | 'uncertain',
        ...(typeof confirmation === 'string' ? { confirmation } : {}),
      };
      check(status !== 'confirmed' || record.confirmation === confirmation, 'the verified receipt cannot change');
      if (prior!.status !== 'confirmed') await this.ledger.write(key, record);
      if (record.status !== 'confirmed') return { status: 'verify_submission_status' };

      const job = activeJob(tx, jobId);
      if (job === null) return this.receipt(jobId, record, false);
      const current = int(get(job, 'revision'));
      const alreadyApplied = string(get(job, 'status')) === 'applied';
      if (current?.toString() !== record.jobRevision
        || string(get(job, 'status')) !== 'awaiting_review') {
        return this.receipt(jobId, record, alreadyApplied);
      }
      requireJobUnclaimed(tx.coordinator, jobId);
      const at = new Date(this.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
      set(job, 'status', text('applied'));
      set(job, 'revision', integer(current! + 1n));
      set(job, 'updatedAt', text(at));
      set(object(get(tx.jobs, 'metadata'), 'jobs metadata'), 'updatedAt', text(at));
      validateJob(jobId, job);
      await tx.saveJobs(tx.jobs);
      return this.receipt(jobId, record, true);
    });
  }

  inspect(jobId: string) {
    safeId(jobId);
    return this.repository.claimTransaction(async tx => {
      const action = await this.ledger.read(jobKey(jobId)) as ActionRecord | null;
      if (!action) return { status: 'no_agent_attempt' };
      if (action.status !== 'confirmed') return { status: 'verify_submission_status' };
      const job = activeJob(tx, jobId);
      return this.receipt(jobId, action, job !== null && string(get(job, 'status')) === 'applied');
    });
  }

  private receipt(jobId: string, action: ActionRecord, storeUpdated: boolean) {
    return { status: 'confirmed_submitted', evidence: 'agent_observed_portal_confirmation',
      receiptId: `receipt:${sha(`${jobId}:${action.claimId}`)}`, storeUpdated };
  }
}
