import { validateJob } from './jobs.js';
import { claimExpired, requireClaim, requireJobUnclaimed } from './claims.js';
import { buildClaimSession, validateClaimHandoff } from './claim-session.js';
import { validateReviewRestartEvidence } from './review-restart.js';
import { preflightJobRecord } from './application-preflight.js';
import type { ResumeObservationPort } from './application-preflight.js';
import { copy, get, int, integer, object, set, string, text, JobsError } from './values.js';
import type { Document, Value } from './values.js';

/** Canonical documents held by a transaction. No persistence or browser authority lives here. */
export interface ApplicationSnapshot {
  jobs: Document;
  coordinator: Document;
  profile: Document;
  resumes: Document;
  facts?: Document;
  requests?: Document;
  answers: Document;
  sessions: Document[];
  history: Document[];
  files: ResumeObservationPort;
}

export function activeApplicationJob(snapshot: ApplicationSnapshot, id: string,
  error = 'job does not exist'): Document {
  const value = get(object(get(snapshot.jobs, 'jobs'), 'jobs'), id);
  if (value === null || get(object(value, 'job'), 'deletedAt') !== null) throw new JobsError(error);
  return object(value, 'job');
}
export function applicationPreflight(snapshot: ApplicationSnapshot, job: Document): Promise<Document> {
  return preflightJobRecord(job, snapshot.profile, snapshot.resumes, snapshot.files,
    snapshot.facts, snapshot.requests, snapshot.jobs);
}
function requireRevision(job: Document, expected: bigint, error = 'job revision conflict'): void {
  if (int(get(job, 'revision')) !== expected) throw new JobsError(error);
}
function requireFreeCoordinator(snapshot: ApplicationSnapshot, now: () => string): void {
  const current = get(snapshot.coordinator, 'claim');
  if (current !== null) throw new JobsError(claimExpired(object(current, 'claim'), now())
    ? 'expired claim requires explicit same-job recovery' : 'another live job claim already exists');
}
export async function inspectSelection(snapshot: ApplicationSnapshot, id: string, expected: bigint): Promise<Document> {
  const job = activeApplicationJob(snapshot, id, 'task selection job is unavailable');
  requireRevision(job, expected, 'task selection revision conflict');
  requireJobUnclaimed(snapshot.coordinator, id);
  if (!['saved', 'needs_info', 'ready'].includes(string(get(job, 'status'))!)) throw new JobsError('task selection job is unavailable');
  if (get(await applicationPreflight(snapshot, job), 'ready') !== true) throw new JobsError('task selection preflight failed');
  return job;
}
export async function inspectAcquisition(snapshot: ApplicationSnapshot, id: string, expected: bigint,
  now: () => string): Promise<{ job: Document; preflight: Document }> {
  requireFreeCoordinator(snapshot, now);
  const job = activeApplicationJob(snapshot, id);
  requireRevision(job, expected);
  if (string(get(job, 'status')) !== 'ready') throw new JobsError('only a ready job can be acquired');
  const preflight = await applicationPreflight(snapshot, job);
  if (get(preflight, 'ready') !== true) throw new JobsError('job is not ready');
  return { job, preflight };
}
export async function inspectReviewRestart(snapshot: ApplicationSnapshot, id: string, expected: bigint,
  now: () => string): Promise<{ job: Document; resume: Document; event: string }> {
  requireFreeCoordinator(snapshot, now);
  const job = activeApplicationJob(snapshot, id);
  requireRevision(job, expected);
  if (string(get(job, 'status')) !== 'awaiting_review') throw new JobsError('review restart requires an awaiting_review job');
  const session = snapshot.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null;
  const event = validateReviewRestartEvidence(job, session, snapshot.history);
  const preflight = await applicationPreflight(snapshot, job);
  const rawResume = get(object(get(snapshot.resumes, 'resumes'), 'resumes'), string(get(preflight, 'resumeId')) ?? '');
  if (get(preflight, 'ready') !== true || rawResume === null || string(get(object(rawResume, 'resume'), 'storageKind')) !== 'managed') {
    throw new JobsError('job is not ready with a current managed resume');
  }
  return { job, resume: object(rawResume, 'resume'), event };
}
export function inspectRecovery(snapshot: ApplicationSnapshot, id: string, now: () => string): Document {
  const old = get(snapshot.coordinator, 'claim');
  if (old === null || string(get(object(old, 'claim'), 'jobId')) !== id) throw new JobsError('explicit recovery must name the expired claimed job');
  const raw = get(object(get(snapshot.jobs, 'jobs'), 'jobs'), id);
  if (raw === null || string(get(object(raw, 'job'), 'status')) !== 'in_progress') throw new JobsError('expired claim job is not in progress');
  if (!claimExpired(object(old, 'claim'), now())) throw new JobsError('live claim cannot be recovered');
  return object(raw, 'job');
}
function sessionFor(snapshot: ApplicationSnapshot, job: Document, incoming: Document, now: string): Document {
  const id = string(get(job, 'id'))!;
  return buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
    existing: snapshot.sessions.find(session => string(get(session, 'applicationId')) === id) ?? null,
    answers: snapshot.answers });
}
export async function inspectProgress(snapshot: ApplicationSnapshot, id: string, token: Value,
  incoming: Document, now: () => string): Promise<Document> {
  requireClaim(snapshot.coordinator, snapshot.jobs, id, token, now());
  const job = activeApplicationJob(snapshot, id);
  if (get(await applicationPreflight(snapshot, job), 'ready') !== true) throw new JobsError('confirmed application inputs changed');
  const at = now(), session = sessionFor(snapshot, job, incoming, at);
  if (string(get(session, 'status')) !== 'active') throw new JobsError('claim progress session must remain active');
  return session;
}
export async function inspectHandoff(snapshot: ApplicationSnapshot, id: string, token: Value,
  status: string, incoming: Document, expected: bigint, now: () => string): Promise<{ job: Document; session: Document; at: string }> {
  requireClaim(snapshot.coordinator, snapshot.jobs, id, token, now());
  const job = activeApplicationJob(snapshot, id);
  if (status === 'awaiting_review' && get(await applicationPreflight(snapshot, job), 'ready') !== true) {
    throw new JobsError('confirmed application inputs changed');
  }
  requireRevision(job, expected);
  const at = now(), session = sessionFor(snapshot, job, incoming, at);
  validateClaimHandoff(session, incoming, status, get(job, 'revision'));
  return { job, session, at };
}

const transitions: Readonly<Record<string, readonly string[]>> = {
  saved: ['needs_info', 'ready', 'closed'],
  needs_info: ['saved', 'ready', 'in_progress', 'closed'],
  ready: ['saved', 'needs_info', 'in_progress', 'closed'],
  in_progress: ['needs_info', 'awaiting_review', 'closed'],
  awaiting_review: ['in_progress', 'applied', 'closed'],
  applied: ['closed'],
  closed: ['saved'],
};
export async function inspectJobTransition(snapshot: ApplicationSnapshot, id: string, target: string,
  expected: bigint, userConfirmed: boolean): Promise<Document> {
  const job = activeApplicationJob(snapshot, id);
  requireRevision(job, expected);
  requireJobUnclaimed(snapshot.coordinator, id);
  const source = string(get(job, 'status'))!;
  if (target === source) return job;
  if (!transitions[source]!.includes(target)) throw new JobsError('job status transition is unsupported');
  if (target === 'in_progress') throw new JobsError('in_progress requires atomic job-acquire');
  if (target === 'applied' && !userConfirmed) throw new JobsError('applied status requires explicit user confirmation');
  if (target === 'ready' && get(await applicationPreflight(snapshot, job), 'ready') !== true) throw new JobsError('job is not ready');
  return job;
}

/** Build and validate the direct status edit without persisting it. Same-status calls are no-ops. */
export function buildJobTransition(job: Document, target: string, closedOutcome: Value, now: () => string): Document {
  if (target === string(get(job, 'status'))) return job;
  const updated = copy(job);
  set(updated, 'status', text(target));
  set(updated, 'closedOutcome', target === 'closed' ? closedOutcome : null);
  set(updated, 'revision', integer(int(get(job, 'revision'))! + 1n));
  set(updated, 'updatedAt', text(now()));
  return validateJob(string(get(job, 'id'))!, updated);
}
