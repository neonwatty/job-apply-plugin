import { taskJobProjection } from './task-job-projection.js';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { claimExpired } from '../contracts/workspace/claims.js';
import { currentClaimApprovals } from '../contracts/workspace/claim-session-pending.js';
import { pendingResolutionProjection, sessionRevision } from '../contracts/workspace/answer-resolution.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { fromJSON, get, has, int, integer, keys, object, same, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { ClaimTransaction } from './claims.js';
import { preflightJobRecord } from './job-preflight.js';

type ProjectionTransaction = Pick<ClaimTransaction,
  'jobs' | 'coordinator' | 'profile' | 'resumes' | 'answers' | 'sessions' | 'history' | 'files'>;
export interface WorkspaceProjectionsRepository {
  claimTransaction<T>(operation: (transaction: ProjectionTransaction) => Promise<T>): Promise<T>;
}
const doc = (value: unknown): Document => object(fromJSON(value), 'projection');
const digest = (value: Value): string => createHash('sha256').update(canonicalJson(value)).digest('hex');
const label = (value: Document, key: string): string => string(get(value, key)) ?? '';
const rank = (value: Document): bigint => int(get(value, 'priority')) ?? 0n;
function select(value: Document, fields: string[]): Document {
  const result = doc({});
  for (const field of fields) if (has(value, field)) set(result, field, get(value, field));
  return result;
}
function records(document: Document, field: string): Document[] {
  return object(get(document, field), field).entries().map(([, value]) => object(value, field));
}
const active = (items: Document[]): Document[] => items.filter(item => get(item, 'deletedAt') === null);
function jobRecord(tx: ProjectionTransaction, id: string): Document {
  const result = get(object(get(tx.jobs, 'jobs'), 'jobs'), id);
  if (result === null || get(object(result, 'job'), 'deletedAt') !== null) throw new JobsError('job does not exist');
  return object(result, 'job');
}
function sessionRecord(tx: ProjectionTransaction, id: string): Document | null {
  const session = tx.sessions.find(item => label(item, 'applicationId') === id);
  // Native repository accepts only closed modern sessions. Validate again for structural repositories.
  return session === undefined ? null : validateAnswerSession(session);
}
function selectedClaim(tx: ProjectionTransaction, id: string): Document | null {
  const raw = get(tx.coordinator, 'claim');
  if (raw === null) return null;
  const claim = object(raw, 'claim');
  return label(claim, 'jobId') === id ? claim : null;
}
const sessionFields = ['attemptRevision', 'readiness', 'blockers', 'browserHandoff'];
const reasons = [
  ['expired_agent_attempt', 'Expired agent attempt', 'Resume this attempt with the CLI claim-recover command for this job.'],
  ['claimless_interrupted_attempt', 'Interrupted agent attempt', 'Reset this claimless attempt to needs_info with the revision-bound CLI job-transition command, then resolve it before starting a new attempt.'],
  ['awaiting_human_review', 'Awaiting your review', 'Open Job details. After you personally submit on the third-party site, confirm Applied, or close the job with an outcome.'],
  ['browser_action_required', 'Browser action required', 'Open Job details and continue in the visible browser. The saved information is already known; do not create or re-enter an answer in Companion.'],
  ['needs_information', 'Needs information', 'Open Job details and resolve the missing facts, resume, or answers, then run preflight and mark the job ready.'],
] as const;
function compareText(a: string, b: string): number {
  return text(a).compare(text(b));
}
function comparePriority(a: Document, b: Document): number {
  return rank(a) === rank(b) ? 0 : rank(a) > rank(b) ? -1 : 1;
}
function browserOnly(session: Document): boolean {
  const handoff = get(session, 'browserHandoff');
  if (handoff === null) return false;
  const expected = doc({state:'required', reasonCode:'unsupported-control'});
  set(expected, 'revision', get(object(handoff, 'browser handoff'), 'revision'));
  const blockers = (get(session, 'blockers') ?? []) as Document[];
  const pairs = new Set(blockers.map(item => `${label(item, 'type')}/${label(item, 'code')}`));
  return same(handoff, expected) && pairs.size === 2
    && pairs.has('browser_handoff/unsupported-control') && pairs.has('information/owner-input-required');
}
function attentionLocked(tx: ProjectionTransaction, now: string): Document {
  const rows: Document[] = [];
  for (const job of active(records(tx.jobs, 'jobs'))) {
    const id = label(job, 'id'), status = label(job, 'status');
    let reason: number | null = null, at = get(job, 'updatedAt');
    if (status === 'in_progress') {
      const claim = selectedClaim(tx, id);
      if (claim === null) reason = 1;
      else if (claimExpired(claim, now)) {
        reason = 0;
        at = get(claim, 'expiresAt');
      }
    } else if (status === 'awaiting_review') reason = 2;
    else if (status === 'needs_info') reason = 4;
    if (reason === null) continue;
    let missing = 0, revision: Value = null, projected: Value = null;
    if (reason === 2 || reason === 4) {
      const session = sessionRecord(tx, id);
      if (session !== null) {
        missing = ((get(session, 'pendingFields') ?? []) as Value[]).length;
        revision = integer(sessionRevision(session));
        projected = select(session, sessionFields);
        if (reason === 4 && missing === 0 && browserOnly(session)) reason = 3;
      }
    }
    const [code, reasonLabel, guidance] = reasons[reason]!;
    const row = doc({jobId:id, status, reasonCode:code, reasonLabel, guidance, missingInformationCount:missing});
    set(row, 'revision', get(job, 'revision'));
    set(row, 'priority', get(job, 'priority') ?? integer(0n));
    set(row, 'attentionAt', at);
    set(row, 'sessionRevision', revision);
    set(row, 'session', projected);
    rows.push(row);
  }
  rows.sort((a, b) => reasons.findIndex(item => item[0] === label(a, 'reasonCode'))
    - reasons.findIndex(item => item[0] === label(b, 'reasonCode'))
    || comparePriority(a, b) || compareText(label(a, 'attentionAt'), label(b, 'attentionAt'))
    || compareText(label(a, 'jobId'), label(b, 'jobId')));
  return set(doc({snapshotSignature:digest(rows)}), 'items', rows);
}
async function overviewLocked(tx: ProjectionTransaction, now: string): Promise<Document> {
  const jobs = active(records(tx.jobs, 'jobs')), resumes = active(records(tx.resumes, 'resumes'));
  const answers = active(records(tx.answers, 'answers')).filter(item => !has(item, 'reviewStatus') || label(item, 'reviewStatus') === 'accepted');
  const profile = object(get(tx.profile, 'profile'), 'profile');
  const hasProfileFacts = keys(profile).some(key => key !== 'preferences');
  const attentionJobs = jobs.filter(job => {
    const status = label(job, 'status');
    if (['needs_info', 'awaiting_review'].includes(status)) return true;
    const claim = selectedClaim(tx, label(job, 'id'));
    return status === 'in_progress' && (claim === null || claimExpired(claim, now));
  }).length;
  const rawClaim = get(tx.coordinator, 'claim');
  let acquirable = false;
  if (rawClaim === null || claimExpired(object(rawClaim, 'claim'), now)) {
    for (const job of jobs.filter(item => label(item, 'status') === 'ready')) {
      // Do not stop early: Python preflights every ready job, including file errors.
      if (get(await preflightJobRecord(job, tx.profile, tx.resumes, tx.files), 'ready') === true) acquirable = true;
    }
  }
  const [nextAction, targetWorkspace] = !resumes.length ? ['import_resume', 'resumes']
    : !hasProfileFacts ? ['review_facts', 'facts']
    : attentionJobs ? ['resolve_attention', 'attention']
    : acquirable ? ['handoff_ready_job', 'jobs']
    : !jobs.length ? ['capture_job', 'jobs'] : ['prepare_job', 'jobs'];
  return doc({setup:{hasProfileFacts, hasResume:resumes.length > 0},
    counts:{jobs:jobs.length, readyJobs:jobs.filter(item => label(item, 'status') === 'ready').length,
      attentionJobs, resumes:resumes.length, answers:answers.length}, nextAction, targetWorkspace});
}
/** Read-only privacy projections from a single coherent native Store transaction. */
export class WorkspaceProjectionsService {
  constructor(private readonly repository: WorkspaceProjectionsRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  overview(): Promise<Document> {
    return this.repository.claimTransaction(tx => overviewLocked(tx, this.now()));
  }
  attention(): Promise<Document> {
    return this.repository.claimTransaction(async tx => attentionLocked(tx, this.now()));
  }
  preflight(id: string): Promise<Document> {
    safeId(id);
    return this.repository.claimTransaction(tx => preflightJobRecord(jobRecord(tx, id), tx.profile, tx.resumes, tx.files));
  }
  taskSnapshot(): Promise<Document> {
    return this.repository.claimTransaction(async tx => {
      const now = this.now(), overview = await overviewLocked(tx, now), attention = attentionLocked(tx, now);
      const jobs = active(records(tx.jobs, 'jobs')).sort((a, b) => comparePriority(a, b)
        || compareText(label(a, 'createdAt'), label(b, 'createdAt')) || compareText(label(a, 'id'), label(b, 'id')))
        .map(job => taskJobProjection(job));
      const signatureInput = set(set(doc({}), 'overview', overview), 'jobs', jobs);
      set(signatureInput, 'attentionSignature', get(attention, 'snapshotSignature'));
      const result = doc({snapshotSignature:digest(signatureInput)});
      set(result, 'overview', overview);
      set(result, 'jobs', jobs);
      return set(result, 'attention', attention);
    });
  }
  activity(id: string): Promise<Document> {
    safeId(id);
    return this.repository.claimTransaction(async tx => {
      const job = jobRecord(tx, id), stored = sessionRecord(tx, id);
      let session: Value = null;
      if (stored !== null) {
        session = select(stored, ['status', 'step', ...sessionFields, 'approvals', 'createdAt', 'updatedAt']);
        const pending = (get(stored, 'pendingFields') ?? []) as Document[];
        const current = ['needs_info', 'awaiting_review'].includes(label(job, 'status'))
          || label(job, 'status') === 'in_progress' && same(get(stored, 'attemptRevision'), get(job, 'revision'));
        set(session, 'approvals', current ? currentClaimApprovals(stored, pending, tx.answers, get(stored, 'attemptRevision')) : []);
        set(session, 'revision', integer(sessionRevision(stored)));
        set(session, 'pendingInformation', pending.map(field => {
          const result = select(field, ['state', 'sensitive', 'fieldClass', 'matchConfidence', 'matchReasonCodes']);
          for (const [key, value] of pendingResolutionProjection(field, tx.answers).entries()) result.set(key, value);
          return result;
        }));
      }
      const persisted = selectedClaim(tx, id);
      const claim = persisted === null ? doc({state:label(job, 'status') === 'in_progress' ? 'interrupted' : 'none'})
        : set(select(persisted, ['acquiredAt', 'heartbeatAt', 'expiresAt']), 'state', text(claimExpired(persisted, this.now()) ? 'expired' : 'active'));
      if (label(claim, 'state') === 'expired') set(claim, 'recoveryGuidance', text(reasons[0][2]));
      else if (label(claim, 'state') === 'interrupted') set(claim, 'recoveryGuidance', text(
        `Reset this claimless attempt with the CLI job-transition command to needs_info using revision ${int(get(job, 'revision'))}; resolve any missing information, then mark it ready for a new agent attempt.`));
      const result = set(doc({}), 'job', select(job, ['status', 'revision']));
      set(result, 'session', session);
      set(result, 'claim', claim);
      return set(result, 'history', tx.history.filter(event => label(event, 'applicationId') === id)
        .map(event => select(event, ['event', 'status', 'ats', 'at'])));
    });
  }
}
