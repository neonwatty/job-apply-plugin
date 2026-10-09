import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { validateAnswerSession } from './answer-session-validation.js';
import { activeApplicationJob } from './application-policy.js';
import type { ApplicationSnapshot } from './application-policy.js';
import { requireClaim } from './claims.js';
import { copy, get, int, set, string, text, JobsError } from './values.js';
import type { Document, Value } from './values.js';

/** A concurrency reference for historical state, never permission or fresh observation evidence. */
export function savedClaimSessionFingerprint(session: Document, jobId: string, revision: bigint): string | null {
  validateAnswerSession(session);
  if (string(get(session, 'applicationId')) !== jobId || string(get(session, 'status')) !== 'active'
    || int(get(session, 'attemptRevision')) !== revision) return null;
  return createHash('sha256').update(canonicalJson(session)).digest('hex');
}

/** Preserve a current attempt checkpoint for Needs Info only, under the caller's Store lock. */
export function inspectSavedClaimHandoff(snapshot: ApplicationSnapshot, id: string, token: Value,
  expectedRevision: bigint, fingerprint: string, at: string): { job: Document; session: Document; at: string } {
  requireClaim(snapshot.coordinator, snapshot.jobs, id, token, at);
  const job = activeApplicationJob(snapshot, id);
  if (int(get(job, 'revision')) !== expectedRevision) throw new JobsError('job revision conflict');
  const matches = snapshot.sessions.filter(session => string(get(session, 'applicationId')) === id);
  if (matches.length !== 1 || !/^[a-f0-9]{64}$/.test(fingerprint)
    || savedClaimSessionFingerprint(matches[0]!, id, expectedRevision) !== fingerprint) {
    throw new JobsError('saved session changed or is unavailable');
  }
  const session = copy(matches[0]!);
  set(session, 'updatedAt', text(at));
  return { job, session: validateAnswerSession(session), at };
}
