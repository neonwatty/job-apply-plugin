import { PythonObject } from '../python-object.js';
import { fallback } from './answers.js';
import { emptyObject } from './jobs.js';
import { fromJSON, get, object, string, text } from './values.js';
import type { Document, Value } from './values.js';
import { AnswerMatchError, answerMatchKey, candidateTexts, fieldClass, sensitivity } from './answer-match-features.js';
import { policyReasons } from './answer-match-reuse.js';
import { rankCandidates } from './answer-match-scoring.js';

/** Suggest only pending duplicates with exactly one eligible accepted winner. */
export function proposeCleanup(candidates: Value): Document[] {
  if (!Array.isArray(candidates)) throw new AnswerMatchError('candidate collection is invalid');
  if (!candidates.every((record): record is Document => record instanceof PythonObject)) {
    throw new AnswerMatchError('candidate is invalid');
  }
  const keys = candidates.map(answerMatchKey);
  if (keys.length !== new Set(keys).size) throw new AnswerMatchError('candidate keys are not unique');
  const byDuplicate = new Map<string, Document[]>();
  for (const winner of candidates) {
    const policy = policyReasons(winner);
    if (!['candidate_active', 'candidate_accepted', 'candidate_confirmed', 'value_seen'].every(reason => policy.includes(reason))) continue;
    const winnerKey = answerMatchKey(winner);
    const question = candidateTexts(winner)[0]!;
    const scope = fallback(winner, 'scope', emptyObject());
    const observedClass = fieldClass(get(winner, 'fieldClass'));
    const observedSensitivity = sensitivity(fallback(winner, 'sensitivity', text('none')));
    for (const duplicate of candidates) {
      const duplicateKey = answerMatchKey(duplicate);
      if (duplicateKey === winnerKey) continue;
      if (!policyReasons(duplicate).includes('candidate_active')) continue;
      if (string(fallback(duplicate, 'reviewStatus', text('accepted'))) !== 'pending') continue;
      const match = rankCandidates({ question: text(question), scope, fieldClass: text(observedClass),
        sensitivity: text(observedSensitivity), candidates: [duplicate], limit: fromJSON(1) })[0]!;
      const confidenceBand = string(get(match, 'confidenceBand'));
      if (confidenceBand !== 'exact' && confidenceBand !== 'high') continue;
      const reasonCodes = ['cleanup_merge_proposed', 'cleanup_winner_accepted', 'cleanup_duplicate_pending',
        ...(get(match, 'reasonCodes') as Value[]).map(value => string(value)!)];
      const proposal = object(fromJSON({ winnerKey, duplicateKey, confidenceBand, reasonCodes }), 'cleanup proposal');
      const proposals = byDuplicate.get(duplicateKey) ?? [];
      proposals.push(proposal);
      byDuplicate.set(duplicateKey, proposals);
    }
  }
  return [...byDuplicate.values()].filter(proposals => proposals.length === 1).map(proposals => proposals[0]!)
    .sort((left, right) => text(string(get(left, 'winnerKey'))!).compare(text(string(get(right, 'winnerKey'))!))
      || text(string(get(left, 'duplicateKey'))!).compare(text(string(get(right, 'duplicateKey'))!)));
}
