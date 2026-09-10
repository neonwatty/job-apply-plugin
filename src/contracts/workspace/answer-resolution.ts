import { createHash } from 'node:crypto';
import { answerRevision, fallback, sensitiveAnswer } from './answers.js';
import { canonicalJson } from './canonical-json.js';
import { emptyObject } from './jobs.js';
import { matches, pendingReference } from './answer-session-fields.js';
import { safeAnswerSessionId, validateAnswerSession } from './answer-session-validation.js';
import { copy, get, integer, object, parse, serialize, set, string, text, JobsError } from './values.js';
import type { Document, Value } from './values.js';

/** Hash the persisted session, not its UI projection, using Python canonical JSON. */
export function sessionRevision(session: Document): bigint {
  return BigInt(`0x${createHash('sha256').update(canonicalJson(session)).digest('hex').slice(0, 13)}`) + 1n;
}
function resolveKey(answers: Document, key: string): string {
  const redirect = get(object(fallback(answers, 'redirects', emptyObject()), 'answer redirects'), key);
  return redirect === null ? key : string(get(object(redirect, 'answer redirect'), 'targetKey'))!;
}
function confirmed(answer: Document): boolean {
  return string(fallback(answer, 'reviewStatus', text('accepted'))) === 'accepted'
    && string(get(answer, 'state')) === 'confirmed' && get(answer, 'value') !== null;
}
function sensitiveField(field: Document): boolean {
  return get(field, 'sensitive') === true || string(get(field, 'state')) === 'sensitive';
}
/** Expose only identity, revision and eligibility; answer values never leave this leaf. */
export function pendingResolutionProjection(field: Document, answers: Document): Document {
  const projection = set(emptyObject(), 'reference', get(field, 'reference'));
  set(projection, 'resolutionEligible', false);
  const key = string(get(field, 'answerKey'));
  if (!key) return projection;
  const resolved = resolveKey(answers, key);
  const value = get(object(get(answers, 'answers'), 'answers'), resolved);
  if (value === null) return projection;
  const answer = object(value, 'answer');
  if (get(answer, 'deletedAt') !== null) return projection;
  set(projection, 'answerRevision', integer(answerRevision(answer)));
  set(projection, 'answerKey', text(resolved));
  set(projection, 'answerSensitivity', fallback(answer, 'sensitivity', text('none')));
  return set(projection, 'resolutionEligible', !sensitiveField(field) && confirmed(answer) && !sensitiveAnswer(answer));
}
export interface AnswerResolutionInput {
  jobId: string;
  reference: string;
  expectedJobRevision: bigint;
  expectedSessionRevision: bigint;
  expectedAnswerRevision: bigint;
  ownerConfirmed: boolean;
  at: string;
  operationId: string;
}
/** Prepare a disposable operation under the caller's Store lock after claim checks. */
export function prepareAnswerResolution(
  jobs: Document, answers: Document, session: Document, input: AnswerResolutionInput, preflightReady: boolean,
): { operation: Document; result: Document } {
  const { jobId, reference, expectedJobRevision, expectedSessionRevision, expectedAnswerRevision, at } = input;
  safeAnswerSessionId(text(jobId));
  if (!input.ownerConfirmed) throw new JobsError('answer resolution requires explicit owner confirmation');
  if (!matches(text(reference), pendingReference)) throw new JobsError('pending question reference is invalid');
  for (const revision of [expectedJobRevision, expectedSessionRevision, expectedAnswerRevision]) {
    if (typeof revision !== 'bigint' || revision < 1n) throw new JobsError('answer resolution revision is invalid');
  }
  const jobValue = get(object(get(jobs, 'jobs'), 'jobs'), jobId);
  if (jobValue === null || get(object(jobValue, 'job'), 'deletedAt') !== null) throw new JobsError('job does not exist');
  const job = object(jobValue, 'job');
  if (answerRevision(job) !== expectedJobRevision) throw new JobsError('job revision conflict');
  if (string(get(job, 'status')) !== 'needs_info') throw new JobsError('answer resolution requires a needs_info job');
  if (sessionRevision(session) !== expectedSessionRevision) throw new JobsError('session revision conflict');
  const pending = fallback(session, 'pendingFields', []) as Value[];
  const matching = pending.map((value, index) => ({ field: object(value, 'pending field'), index }))
    .filter(({ field }) => string(get(field, 'reference')) === reference);
  if (matching.length !== 1) throw new JobsError('pending question reference is stale');
  const { field, index } = matching[0]!;
  const key = string(get(field, 'answerKey'));
  if (!key) throw new JobsError('pending question has no referenced answer');
  if (sensitiveField(field)) throw new JobsError('sensitive pending answers require reconfirmation');
  const resolved = resolveKey(answers, key);
  const answerValue = get(object(get(answers, 'answers'), 'answers'), resolved);
  if (answerValue === null || get(object(answerValue, 'answer'), 'deletedAt') !== null) throw new JobsError('referenced answer does not exist');
  const answer = object(answerValue, 'answer');
  if (answerRevision(answer) !== expectedAnswerRevision) throw new JobsError('answer revision conflict');
  if (!confirmed(answer)) throw new JobsError('referenced answer is not accepted and confirmed');
  if (sensitiveAnswer(answer)) throw new JobsError('sensitive pending answers require reconfirmation');
  const updated = object(parse(serialize(session)), 'session');
  const remaining = (get(updated, 'pendingFields') as Value[]).filter((_, position) => position !== index);
  set(updated, 'pendingFields', remaining);
  const blockers = (fallback(updated, 'blockers', []) as Value[])
    .filter(value => string(get(object(value, 'blocker'), 'reference')) !== reference);
  set(updated, 'blockers', blockers);
  const answerKeys = [...fallback(updated, 'answerKeys', []) as Value[]];
  if (!answerKeys.some(value => string(value) === resolved)) answerKeys.push(text(resolved));
  set(updated, 'answerKeys', answerKeys);
  set(updated, 'updatedAt', text(at));
  validateAnswerSession(updated);
  const handoff = get(updated, 'browserHandoff');
  const handoffState = handoff === null ? null : string(get(object(handoff, 'browser handoff'), 'state'));
  const ready = remaining.length === 0 && blockers.length === 0 && !['required', 'ready_for_owner'].includes(handoffState!);
  if (ready && !preflightReady) throw new JobsError('job preflight failed after answer resolution');
  const target = ready ? 'ready' : 'needs_info';
  const operation = emptyObject();
  for (const [key, value] of Object.entries({ kind: 'answer_resolution', operationId: input.operationId, jobId, at,
    answerKey: resolved, sourceStatus: 'needs_info', targetStatus: target })) set(operation, key, text(value));
  set(operation, 'expectedJobRevision', integer(expectedJobRevision));
  set(operation, 'expectedSessionRevision', integer(expectedSessionRevision));
  set(operation, 'expectedAnswerRevision', integer(expectedAnswerRevision));
  set(operation, 'session', updated);
  set(operation, 'resultClaim', null);
  const resultJob = set(set(set(emptyObject(), 'id', text(jobId)), 'status', text(target)), 'revision', integer(expectedJobRevision + 1n));
  const pendingInformation = remaining.map(value => {
    const item = object(value, 'pending field');
    const projection = copy(pendingResolutionProjection(item, answers));
    for (const name of ['question', 'state', 'sensitive']) if (item.has(text(name))) set(projection, name, get(item, name));
    return projection;
  });
  const resultSession = set(set(emptyObject(), 'revision', integer(sessionRevision(updated))), 'pendingInformation', pendingInformation);
  const result = set(set(set(set(emptyObject(), 'job', resultJob), 'session', resultSession), 'resolved', true), 'ready', ready);
  return { operation, result };
}
