import { createHash } from 'node:crypto';
import { PythonObject } from '../contracts/python-object.js';
import { PythonText } from '../contracts/python-text.js';
import { serializeJsonGraph } from '../contracts/raw-json/json-serialization-core.js';
import { fallback } from '../contracts/workspace/answers.js';
import { proposeCleanup } from '../contracts/workspace/answer-match-cleanup.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { strip } from '../contracts/workspace/job-url.js';
import { copy, get, integer, object, serialize, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { semanticCandidate } from './answer-match.js';

/** Python compact, sorted, ensure_ascii=False JSON, without losing integer precision. */
function canonicalJson(value: Value): string {
  const quote = (item: PythonText): string => {
    if (item.codePoints.some(point => point >= 0xd800 && point <= 0xdfff)) {
      throw new JobsError('answer cleanup preview is invalid');
    }
    return JSON.stringify(string(item));
  };
  return serializeJsonGraph<Value>(value, current => {
    if (current instanceof PythonText) return { kind: 'scalar', text: quote(current) };
    if (Array.isArray(current)) return { kind: 'array', identity: current, items: current };
    if (current instanceof PythonObject) return { kind: 'object', identity: current,
      entries: [...current.entries()].sort(([left], [right]) => left.compare(right))
        .map(([key, item]) => [quote(key), item] as const) };
    return { kind: 'scalar', text: serialize(current) };
  }, () => new JobsError('answer cleanup preview is invalid'));
}

/** Called under the repository lock with a validated canonical Answers document. */
export function previewAnswerCleanup(document: Document): Value {
  const records = object(get(document, 'answers'), 'answers');
  const candidates = records.entries().map(([, value]) => object(value, 'answer'))
    .filter(record => string(get(record, 'key')) !== null && Boolean(strip(string(get(record, 'key'))!))
      && string(get(record, 'question')) !== null && Boolean(strip(string(get(record, 'question'))!)))
    .map(semanticCandidate);
  let proposed: Document[];
  try { proposed = proposeCleanup(candidates); }
  catch { throw new JobsError('answer cleanup preview is invalid'); }
  const revisions = emptyObject();
  for (const [key, value] of records.entries()) {
    revisions.set(key, fallback(object(value, 'answer'), 'revision', integer(1n)));
  }
  const proposals = proposed.map(proposal => {
    const result = copy(proposal);
    for (const side of ['winner', 'duplicate']) {
      const key = string(get(proposal, `${side}Key`))!;
      set(result, `${side}Revision`, get(revisions, key));
      set(result, `${side}Question`, get(object(get(records, key), 'answer'), 'question'));
    }
    return result;
  });
  const tokenInput = set(set(emptyObject(), 'proposals', proposals), 'revisions', revisions);
  const token = `answer-cleanup-v1.${createHash('sha256').update(canonicalJson(tokenInput), 'utf8').digest('hex')}`;
  return set(set(set(emptyObject(), 'proposals', proposals), 'previewToken', text(token)), 'mutated', false);
}
