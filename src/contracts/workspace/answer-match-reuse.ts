import { PythonObject } from '../python-object.js';
import { fallback } from './answers.js';
import { fromJSON, get, object, string, text } from './values.js';
import type { Document, Value } from './values.js';
import { AnswerMatchError, answerMatchKey, fieldClass, metadataReasons, scopeFingerprint, sensitivity } from './answer-match-features.js';
import { reasonCodes } from './answer-match-vocabulary.js';
export interface ReuseInput {
  match: Value; candidate: Value; scope: Value; fieldClass: Value; sensitivity: Value;
  mode: Value; useAuthority: Value; allowedSensitiveFieldClasses?: Value;
}
function policyReasons(record: Document): string[] {
  const status = string(fallback(record,'recordStatus',text('active')));
  const review = string(fallback(record,'reviewStatus',text('accepted')));
  const state = string(get(record,'state'));
  const value = string(fallback(record,'valueState',text('missing')));
  if (!['active','deleted'].includes(status!)) throw new AnswerMatchError('candidate record status is invalid');
  if (!['accepted','pending','declined'].includes(review!)) throw new AnswerMatchError('candidate review status is invalid');
  if (!['confirmed','inferred','missing','sensitive'].includes(state!)) throw new AnswerMatchError('candidate state is invalid');
  if (!['seen','unseen','missing'].includes(value!)) throw new AnswerMatchError('candidate value state is invalid');
  return [status === 'active' ? 'candidate_active':'candidate_deleted',
    review === 'accepted' ? 'candidate_accepted':'candidate_not_accepted',
    state === 'confirmed' ? 'candidate_confirmed':'candidate_not_confirmed',`value_${value}`];
}
export function evaluateReuse(input: ReuseInput): Document {
  if (!(input.match instanceof PythonObject) || !(input.candidate instanceof PythonObject)) throw new AnswerMatchError('reuse input is invalid');
  const key = answerMatchKey(input.candidate), match = input.match;
  const band = string(get(match,'confidenceBand')), reasons = get(match,'reasonCodes');
  if (string(get(match,'answerKey')) !== key || !['exact','high','uncertain','none'].includes(band!)
    || !Array.isArray(reasons) || reasons.some(value => !reasonCodes.has(string(value)!))) throw new AnswerMatchError('match result is invalid');
  scopeFingerprint(input.scope);
  const observedClass = fieldClass(input.fieldClass), observedSensitivity = sensitivity(input.sensitivity);
  const mode = string(input.mode), authority = string(input.useAuthority);
  if (!['strict','bounded_loose'].includes(mode!)) throw new AnswerMatchError('reuse mode is invalid');
  if (!['none','accepted_record','per_use','bounded_policy'].includes(authority!)) throw new AnswerMatchError('use authority is invalid');
  const allowlist = input.allowedSensitiveFieldClasses === undefined ? [] : input.allowedSensitiveFieldClasses;
  if (!Array.isArray(allowlist)) throw new AnswerMatchError('field class allowlist is invalid');
  const allowed = new Set(allowlist.map(fieldClass));
  const metadata = metadataReasons(input.candidate,input.scope,observedClass,observedSensitivity);
  const policy = policyReasons(input.candidate);
  const confidenceSafe = ['exact','high'].includes(band!) && !reasons.some(value => string(value) === 'ambiguous_tie');
  const output = [mode === 'strict' ? 'mode_strict':'mode_bounded_loose',...metadata,...policy,
    confidenceSafe ? 'confidence_eligible':'confidence_ineligible'];
  const compatible = ['scope_match','field_class_match','sensitivity_match'].every(reason => metadata.includes(reason));
  const safe = ['candidate_active','candidate_accepted','candidate_confirmed','value_seen'].every(reason => policy.includes(reason));
  let authoritySafe = false;
  if (authority === 'per_use') {
    authoritySafe = true;
    output.push('authority_per_use');
  } else if (observedSensitivity === 'none' && authority === 'accepted_record') {
    authoritySafe = true;
    output.push('authority_accepted_record');
  } else if (observedSensitivity !== 'none' && mode === 'bounded_loose' && authority === 'bounded_policy') {
    output.push('authority_bounded_policy');
    if (allowed.has(observedClass)) {
      authoritySafe = true;
      output.push('field_class_allowlisted');
    } else output.push('field_class_not_allowlisted');
  } else output.push('authority_missing');
  output.unshift(compatible && safe && confidenceSafe && authoritySafe ? 'reuse_eligible':'owner_confirmation_required');
  return object(fromJSON({answerKey:key,confidenceBand:band,reasonCodes:output}),'reuse result');
}
