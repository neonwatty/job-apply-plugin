import { answerKey, answerNames, answerRevision, answerView, fallback, normalizeAnswerQuestion, sameAnswerScope, validateAnswer, validateAnswers } from './answers.js';
import { emptyObject } from './jobs.js';
import { copy, get, has, int, integer, keys, object, set, string, text, JobsError } from './values.js';
import type { Document, Value } from './values.js';

const nonblank = (value: Value): string | null => {
  const result = string(value);
  return result !== null && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(result) ? result : null;
};

function rejectCollisions(answers: Document, redirects: Document, merged: Document, winnerKey: string, sourceKey: string): void {
  const names = answerNames(merged);
  const scope = object(fallback(merged, 'scope', emptyObject()), 'answer scope');
  for (const key of keys(answers)) {
    if (key === winnerKey || key === sourceKey) continue;
    const other = object(get(answers, key), 'answer record');
    if (sameAnswerScope(fallback(other, 'scope', emptyObject()), scope) && answerNames(other).some(name => names.includes(name))) {
      throw new JobsError('answer question or alias collides within scope');
    }
  }
  for (const name of names) {
    const retiredKey = answerKey(name, scope);
    if (!has(redirects, retiredKey)) continue;
    const target = string(get(object(get(redirects, retiredKey), 'answer redirect'), 'targetKey'));
    if (target !== winnerKey && target !== sourceKey) throw new JobsError('answer question or alias is a retired redirect identity');
  }
}

/** Apply a validated journal operation to a disposable document or replay copy. */
export function applyAnswerMerge(document: Document, operation: Document): Document {
  const winnerKey = string(get(operation, 'winnerKey'));
  const sourceKey = string(get(operation, 'sourceKey'));
  if (!winnerKey || !sourceKey) throw new JobsError('answer merge keys must be non-empty strings');
  if (winnerKey === sourceKey) throw new JobsError('answer merge requires distinct records');
  const expectedWinner = int(get(operation, 'expectedWinnerRevision'));
  const expectedSource = int(get(operation, 'expectedSourceRevision'));
  if (expectedWinner === null || expectedSource === null || expectedWinner < 1n || expectedSource < 1n) {
    throw new JobsError('answer merge expected revisions must be positive integers');
  }
  if (!has(document, 'redirects')) set(document, 'redirects', emptyObject());
  const redirects = object(get(document, 'redirects'), 'answer redirects');
  const answers = object(get(document, 'answers'), 'answers');
  const winnerValue = get(answers, winnerKey);
  const sourceValue = get(answers, sourceKey);
  if (sourceValue === null) {
    const redirectValue = get(redirects, sourceKey);
    if (redirectValue === null || string(get(object(redirectValue, 'answer redirect'), 'targetKey')) !== winnerKey
      || winnerValue === null || answerRevision(object(winnerValue, 'answer')) !== expectedWinner + 1n) {
      throw new JobsError('coordinator answer merge cannot be reconciled');
    }
    return answerView(object(winnerValue, 'answer'));
  }
  if (winnerValue === null) throw new JobsError('answer merge winner does not exist');
  const winner = object(winnerValue, 'answer');
  const source = object(sourceValue, 'answer');
  if (answerRevision(winner) !== expectedWinner || answerRevision(source) !== expectedSource) throw new JobsError('answer merge revision conflict');
  if (get(winner, 'deletedAt') !== null || get(source, 'deletedAt') !== null) throw new JobsError('answer merge records must be active');
  if (string(fallback(winner, 'reviewStatus', text('accepted'))) !== 'accepted') throw new JobsError('answer merge winner must be accepted');
  if (!sameAnswerScope(fallback(winner, 'scope', emptyObject()), fallback(source, 'scope', emptyObject()))) {
    throw new JobsError('answer merge requires exact matching scope');
  }
  const winnerQuestion = normalizeAnswerQuestion(nonblank(get(winner, 'question')) ?? winnerKey);
  const aliases: string[] = [];
  for (const value of [
    ...fallback(winner, 'aliases', []) as Value[],
    get(source, 'question'),
    ...fallback(source, 'aliases', []) as Value[],
  ]) {
    const raw = nonblank(value);
    if (raw === null) continue;
    const normalized = normalizeAnswerQuestion(raw);
    if (normalized !== winnerQuestion && !aliases.includes(normalized)) aliases.push(normalized);
  }
  const merged = copy(winner);
  set(merged, 'aliases', aliases.map(text));
  set(merged, 'observationCount', integer(int(fallback(winner, 'observationCount', integer(0n)))! + int(fallback(source, 'observationCount', integer(0n)))!));
  for (const field of ['observedAt', 'lastObservedAt']) {
    const values = [string(get(winner, field)), string(get(source, field))].filter((value): value is string => value !== null && value !== '');
    // Python orders strings by code point, including timestamps with non-ASCII text.
    values.sort((left, right) => {
      const a = Array.from(left, value => value.codePointAt(0)!);
      const b = Array.from(right, value => value.codePointAt(0)!);
      for (let index = 0; index < Math.min(a.length, b.length); index++) {
        if (a[index] !== b[index]) return a[index]! - b[index]!;
      }
      return a.length - b.length;
    });
    if (values.length === 0) merged.delete(text(field));
    else set(merged, field, text(field === 'observedAt' ? values[0]! : values[values.length - 1]!));
  }
  set(merged, 'revision', integer(expectedWinner + 1n));
  set(merged, 'updatedAt', get(operation, 'at'));
  validateAnswer(winnerKey, merged);
  rejectCollisions(answers, redirects, merged, winnerKey, sourceKey);
  set(answers, winnerKey, merged);
  answers.delete(text(sourceKey));
  for (const key of keys(redirects)) {
    const redirect = object(get(redirects, key), 'answer redirect');
    if (string(get(redirect, 'targetKey')) === sourceKey) set(redirect, 'targetKey', text(winnerKey));
  }
  set(redirects, sourceKey, set(set(emptyObject(), 'targetKey', text(winnerKey)), 'mergedAt', get(operation, 'at')));
  set(object(get(document, 'metadata'), 'answers metadata'), 'updatedAt', get(operation, 'at'));
  validateAnswers(document);
  return answerView(merged);
}
