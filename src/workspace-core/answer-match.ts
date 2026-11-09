import { fallback, validateAnswers } from '../contracts/workspace/answers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { strip } from '../contracts/workspace/job-url.js';
import { get, keys, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { rankCandidates } from '../contracts/workspace/answer-match-scoring.js';
import { evaluateReuse } from '../contracts/workspace/answer-match-reuse.js';

/** Project only metadata required by matching; never copy the stored answer value. */
export function semanticCandidate(record: Document): Document {
  const candidate = emptyObject();
  set(candidate,'answerKey',get(record,'key'));
  set(candidate,'question',get(record,'question'));
  const aliases = fallback(record,'aliases',[]) as Value[];
  set(candidate,'aliases',aliases.filter(value => string(value) !== null && Boolean(strip(string(value)!))));
  set(candidate,'scope',fallback(record,'scope',emptyObject()));
  set(candidate,'fieldClass',fallback(record,'fieldClass',text('general')));
  set(candidate,'sensitivity',fallback(record,'sensitivity',text('none')));
  set(candidate,'recordStatus',text(get(record,'deletedAt') !== null ? 'deleted':'active'));
  set(candidate,'reviewStatus',fallback(record,'reviewStatus',text('accepted')));
  set(candidate,'state',get(record,'state'));
  set(candidate,'valueState',text(get(record,'value') !== null ? 'seen':'missing'));
  return candidate;
}
/** Called under the repository lock with the current canonical Answers document. */
export function semanticLookup(document: Document, incoming: Value): Value {
  const packet = object(incoming,'semantic lookup');
  const required = ['question','scope','fieldClass','sensitivity','mode','useAuthority'];
  const allowed = [...required,'allowedSensitiveFieldClasses','limit'];
  if (keys(packet).some(key => !allowed.includes(key)) || required.some(key => !packet.has(text(key)))) throw new JobsError('semantic lookup contains unsupported fields');
  validateAnswers(document);
  const candidates = object(get(document,'answers'),'answers').entries().map(([,value]) => object(value,'answer'))
    .filter(record => string(get(record,'key')) !== null && Boolean(strip(string(get(record,'key'))!))
      && string(get(record,'question')) !== null && Boolean(strip(string(get(record,'question'))!)))
    .map(semanticCandidate);
  try {
    const matches = rankCandidates({question:get(packet,'question'),scope:get(packet,'scope'),fieldClass:get(packet,'fieldClass'),
      sensitivity:get(packet,'sensitivity'),candidates,
      ...(packet.has(text('limit')) ? {limit:get(packet,'limit')} : {})});
    const indexed = new Map(candidates.map(record => [string(get(record,'answerKey')),record]));
    const decisions = matches.map(match => evaluateReuse({match,candidate:indexed.get(string(get(match,'answerKey')))! ,
      scope:get(packet,'scope'),fieldClass:get(packet,'fieldClass'),sensitivity:get(packet,'sensitivity'),
      mode:get(packet,'mode'),useAuthority:get(packet,'useAuthority'),
      ...(packet.has(text('allowedSensitiveFieldClasses')) ? {allowedSensitiveFieldClasses:get(packet,'allowedSensitiveFieldClasses')} : {})}));
    return set(set(emptyObject(),'candidates',decisions),'mutated',false);
  } catch { throw new JobsError('semantic lookup is invalid'); }
}
