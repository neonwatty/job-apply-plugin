import { ApplicationAuthorityService } from './application-authority.js';
import type { ClaimTransaction } from './claims.js';
import { applicationAuthorityInterrupts } from '../contracts/workspace/application-authority.js';
import { activeApplicationRun } from '../contracts/workspace/application-runs.js';
import { answerRevision, sensitiveAnswer } from '../contracts/workspace/answers.js';
import { browserValueGrant } from '../contracts/workspace/browser-authority.js';
import type { BrowserValueGrant } from '../contracts/workspace/browser-authority.js';
import { browserMutation } from '../contracts/workspace/browser-boundary.js';
import type { BrowserMutation } from '../contracts/workspace/browser-boundary.js';
import { fromJSON, get, has, int, object, set, string } from '../contracts/workspace/values.js';
import type { Value } from '../contracts/workspace/values.js';

/** Evaluate canonical authority using the caller's existing Store transaction and private claim. */
export async function checkClaimBrowserAuthority(tx: ClaimTransaction, raw: BrowserMutation,
  rawGrant: BrowserValueGrant, token: Value, now: () => string): Promise<boolean> {
  const request = browserMutation(raw), grant = browserValueGrant(rawGrant);
  if (request.kind !== grant.kind || !tx.facts || !tx.requests) return false;
  if (int(get(object(get(tx.authority, 'metadata'), 'authority metadata'), 'revision'))?.toString()
    !== request.scope.authorizationRevision) return false;
  const answerRefs: string[] = [], sensitiveAnswerRefs: string[] = [];
  let operation: string;
  if (grant.source === 'profile') {
    const metadata = object(get(tx.profile, 'metadata'), 'profile metadata');
    const revision = has(metadata, 'revision') ? int(get(metadata, 'revision')) : 1n;
    if (revision?.toString() !== grant.profileRevision || !string(get(object(get(tx.profile, 'profile'), 'profile'), grant.field))?.trim()) return false;
    operation = 'fill_canonical_profile';
  } else if (grant.source === 'answer') {
    const rawAnswer = get(object(get(tx.answers, 'answers'), 'answers'), grant.answerRef);
    if (rawAnswer === null) return false;
    const answer = object(rawAnswer, 'answer');
    if (answerRevision(answer).toString() !== grant.answerRevision) return false;
    (sensitiveAnswer(answer) ? sensitiveAnswerRefs : answerRefs).push(grant.answerRef);
    operation = 'fill_confirmed_answer';
  } else {
    const run = activeApplicationRun(tx.jobs);
    if (!run) return false;
    const selection = object(get(run, 'selection'), 'selection');
    const rawResume = get(object(get(tx.resumes, 'resumes'), 'resumes'), grant.resumeId);
    if (!rawResume) return false;
    const resume = object(rawResume, 'resume');
    if (string(get(selection, 'resumeId')) !== grant.resumeId
      || string(get(selection, 'contentRevision')) !== grant.contentRevision
      || int(get(resume, 'revision'))?.toString() !== grant.resumeRevision
      || string(get(resume, 'contentRevision')) !== grant.contentRevision
      || string(get(resume, 'storageKind')) !== 'managed' || get(resume, 'deletedAt') !== null) return false;
    operation = 'upload_managed_resume';
  }
  // Only the synthetic adapter is supported. Its trusted host must gate interrupts at the write boundary.
  const input = object(fromJSON({ jobId: request.scope.jobId, claimToken: null,
    destinationUrl: request.scope.form.origin, operations: [operation], answerRefs, sensitiveAnswerRefs,
    interrupts: Object.fromEntries([...applicationAuthorityInterrupts.keys()].map(key => [key, false])) }), 'evaluation');
  set(input, 'claimToken', token);
  const service = new ApplicationAuthorityService({ applicationAuthorityTransaction: callback => callback({ ...tx,
    facts: tx.facts!, requests: tx.requests!, saveAuthority: async () => { throw new Error('read-only authority'); } }) }, now);
  const decision = await service.evaluate(input);
  return get(decision, 'authorized') === true && int(get(decision, 'revision'))?.toString() === request.scope.authorizationRevision;
}
