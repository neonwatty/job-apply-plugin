import { answerStates, answerSensitivities, fallback } from './answers.js';
import { reasonCodes } from './answer-match-vocabulary.js';
import { get, has, int, keys, object, string, text, JobsError } from './values.js';
import type { Document, Value } from './values.js';

export function requireCondition(condition: boolean, message: string): void {
  if (!condition) throw new JobsError(message);
}
export function member(value: Value, allowed: readonly string[] | Set<string>): boolean {
  const candidate = string(value);
  return candidate !== null && (allowed instanceof Set ? allowed.has(candidate) : allowed.includes(candidate));
}
export function fields(record: Document, allowed: string[], exact = false): boolean {
  return keys(record).every(key => allowed.includes(key)) && (!exact || record.size === allowed.length);
}
export function positive(value: Value): boolean {
  const revision = int(value);
  return revision !== null && revision >= 1n;
}
export function matches(value: Value, pattern: RegExp): boolean {
  const candidate = string(value);
  return candidate !== null && pattern.exec(candidate)?.[0] === candidate;
}
export function optionalStrings(record: Document, names: string[], label: string): void {
  for (const name of names) {
    requireCondition(get(record, name) === null || string(get(record, name)) !== null, `${label}.${name} must be a string`);
  }
}
export const pendingReference = /^pending_[a-f0-9]{32}$/u;
export const confidenceBands = ['exact', 'high', 'uncertain', 'none'];
export function validReasons(value: Value): boolean {
  return Array.isArray(value) && value.every(code => member(code, reasonCodes));
}
export function validatePendingFields(value: Value): void {
  requireCondition(Array.isArray(value), 'session pendingFields must be a list');
  const references = new Set<string>();
  for (const item of value as Value[]) {
    const field = object(item, 'pending field');
    requireCondition(fields(field, ['question', 'state', 'answerKey', 'sensitive', 'reference', 'fieldClass', 'scopeFingerprint', 'matchConfidence', 'matchReasonCodes', 'matchAnswerRevision', 'questionFingerprint']), 'pending field contains unsupported fields');
    optionalStrings(field, ['question', 'state', 'answerKey'], 'pending field');
    if (has(field, 'state')) requireCondition(member(get(field, 'state'), answerStates), 'pending field state is unsupported');
    if (has(field, 'sensitive')) requireCondition(typeof get(field, 'sensitive') === 'boolean', 'pending field sensitive must be a boolean');
    requireCondition(matches(get(field, 'reference'), pendingReference), 'pending field reference is invalid');
    const reference = string(get(field, 'reference'))!;
    requireCondition(!references.has(reference), 'pending field references must be unique');
    references.add(reference);
    if (has(field, 'fieldClass')) requireCondition(matches(get(field, 'fieldClass'), /^[a-z][a-z0-9_]{0,63}$/u), 'pending field class is invalid');
    for (const [key, label] of [['scopeFingerprint', 'scope'], ['questionFingerprint', 'question']]) {
      if (has(field, key!)) requireCondition(matches(get(field, key!), /^[0-9a-f]{64}$/u), `pending field ${label} fingerprint is invalid`);
    }
    if (has(field, 'matchConfidence')) requireCondition(member(get(field, 'matchConfidence'), confidenceBands), 'pending field confidence is invalid');
    if (has(field, 'matchAnswerRevision')) requireCondition(positive(get(field, 'matchAnswerRevision')), 'pending field match answer revision is invalid');
    if (has(field, 'matchReasonCodes')) requireCondition(validReasons(get(field, 'matchReasonCodes')), 'pending field match reasons are invalid');
  }
}
export const readinessCodes = [
  'readiness-evidence-stale', 'form-observation-inaccessible', 'required-control-evidence-missing',
  'required-upload-missing', 'required-upload-rejected', 'required-control-rejected',
  'required-control-unresolved', 'required-control-inaccessible', 'required-control-incomplete',
  'validation-error-present', 'final-action-activated', 'final-control-inaccessible',
  'final-control-unavailable', 'external-upload-capability-unavailable',
];
export const agentCodes = [
  'login-required', 'captcha-required', 'mfa-required', 'email-verification-required',
  'consent-required', 'account-creation-required', 'unsupported-control', 'owner-input-required', 'browser-state-uncertain',
];
export function validateBlockers(value: Value): void {
  requireCondition(Array.isArray(value), 'session blockers must be a list');
  for (const item of value as Value[]) {
    const blocker = object(item, 'session blocker');
    requireCondition(fields(blocker, ['type', 'code', 'reference', 'fieldClass', 'sensitivity']), 'session blocker contains unsupported fields');
    requireCondition(member(get(blocker, 'type'), ['readiness', 'information', 'upload', 'validation', 'browser_handoff', 'owner_review', 'final_action']) && member(get(blocker, 'code'), [...readinessCodes, ...agentCodes, 'answer-required', 'sensitive-answer-required', 'owner-upload-required']), 'session blocker is invalid');
    if (has(blocker, 'reference')) requireCondition(matches(get(blocker, 'reference'), pendingReference), 'session blocker reference is invalid');
    requireCondition(member(fallback(blocker, 'sensitivity', text('none')), answerSensitivities), 'session blocker sensitivity is invalid');
  }
}
export function validateApprovals(value: Value): void {
  requireCondition(Array.isArray(value), 'session approvals must be a list');
  for (const item of value as Value[]) {
    const approval = object(item, 'session approval');
    requireCondition(fields(approval, ['reference', 'answerKey', 'currentUse', 'remember', 'policyMode', 'useAuthority', 'eligible', 'confidenceBand', 'reasonCodes', 'answerRevision'], true) && matches(get(approval, 'reference'), pendingReference), 'session approval is invalid');
    requireCondition(Boolean(string(get(approval, 'answerKey'))), 'session approval answer key is invalid');
    requireCondition(['currentUse', 'remember', 'eligible'].every(key => typeof get(approval, key) === 'boolean'), 'session approval decisions must be booleans');
    requireCondition(member(get(approval, 'policyMode'), ['strict', 'bounded_loose']) && member(get(approval, 'useAuthority'), ['none', 'accepted_record', 'per_use', 'bounded_policy']), 'session approval policy is invalid');
    requireCondition(member(get(approval, 'confidenceBand'), confidenceBands), 'session approval confidence is invalid');
    requireCondition(validReasons(get(approval, 'reasonCodes')), 'session approval reasons are invalid');
    requireCondition(positive(get(approval, 'answerRevision')), 'session approval answer revision is invalid');
  }
}
