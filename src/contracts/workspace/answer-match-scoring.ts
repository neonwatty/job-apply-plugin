import { PythonObject } from '../python-object.js';
import { fromJSON, int, integer, object, text } from './values.js';
import type { Document, Value } from './values.js';
import { AnswerMatchError, answerMatchKey, bandOrder, candidateTexts, features, fieldClass, hasNegation,
  metadataReasons, normalizedText, requireText, scopeFingerprint, sensitivity, similarity } from './answer-match-features.js';
export interface RankInput {
  question: Value; scope: Value; fieldClass: Value; sensitivity: Value; candidates: Value; limit?: Value;
}
interface Scored { key:string; band:string; reasons:string[]; score:number }
function scoreCandidate(question: string, scope: Value, observedClass: string, observedSensitivity: string, record: Document): Scored {
  const key = answerMatchKey(record), texts = candidateTexts(record);
  const observed = normalizedText(question), normalized = texts.map(normalizedText);
  const metadata = metadataReasons(record,scope,observedClass,observedSensitivity);
  let band: string, reasons: string[], score: number;
  if (observed === normalized[0]) {
    band = 'exact';
    reasons = ['match_exact_question',...metadata];
    score = 1;
  } else if (normalized.slice(1).includes(observed)) {
    band = 'exact';
    reasons = ['match_exact_alias',...metadata];
    score = 0.995;
  } else {
    const observedFeatures = features(question);
    let bestScore = 0, bestShared = 0, polarity = false;
    for (const candidate of texts) {
      const [score,shared] = similarity(observedFeatures,features(candidate));
      if (score > bestScore || score === bestScore && shared > bestShared) {
        bestScore = score;
        bestShared = shared;
        polarity = hasNegation(question) !== hasNegation(candidate);
      }
    }
    if (polarity) {
      band = 'none';
      reasons = ['polarity_mismatch','no_semantic_match',...metadata];
      score = 0;
    } else {
      band = bestShared >= 2 && bestScore >= 0.82 ? 'high' : bestShared >= 1 && bestScore >= 0.35 ? 'uncertain':'none';
      reasons = [band === 'high' ? 'match_semantic_high' : band === 'uncertain' ? 'match_semantic_uncertain':'no_semantic_match',...metadata];
      score = bestScore;
    }
  }
  if (metadata.some(reason => reason.endsWith('_mismatch'))) band = 'none';
  return {key,band,reasons,score};
}
export function rankCandidates(input: RankInput): Document[] {
  const question = requireText(input.question,'question');
  scopeFingerprint(input.scope);
  const observedClass = fieldClass(input.fieldClass), observedSensitivity = sensitivity(input.sensitivity);
  const limit = int(input.limit === undefined ? integer(5n) : input.limit);
  if (limit === null || limit < 1n || limit > 100n) throw new AnswerMatchError('candidate limit is invalid');
  if (!Array.isArray(input.candidates)) throw new AnswerMatchError('candidate collection is invalid');
  const scored: Scored[] = [], seen = new Set<string>();
  for (const value of input.candidates) {
    if (!(value instanceof PythonObject)) throw new AnswerMatchError('candidate is invalid');
    const candidate = scoreCandidate(question,input.scope,observedClass,observedSensitivity,value);
    if (seen.has(candidate.key)) throw new AnswerMatchError('candidate keys are not unique');
    seen.add(candidate.key);
    scored.push(candidate);
  }
  const compare = (a:Scored,b:Scored): number => bandOrder[b.band]! - bandOrder[a.band]! || b.score-a.score || text(a.key).compare(text(b.key));
  scored.sort(compare);
  if (scored.length) {
    const top = scored[0]!, positive = (item:Scored): boolean => ['exact','high'].includes(item.band);
    const tied = scored.filter(item => positive(top) && positive(item) && Math.abs(item.score-top.score) <= 0.02);
    if (tied.length > 1) {
      for (const item of scored) if (positive(item)) {
        item.band = 'uncertain';
        item.reasons.push('ambiguous_tie');
      }
      scored.sort(compare);
    }
  }
  return scored.slice(0,Number(limit)).map(item => object(fromJSON({answerKey:item.key,confidenceBand:item.band,reasonCodes:item.reasons}),'match'));
}
