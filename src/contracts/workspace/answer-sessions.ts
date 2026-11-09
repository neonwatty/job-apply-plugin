import { PythonObject } from '../python-object.js';
import { fallback } from './answers.js';
import { get, object, set, string, text } from './values.js';
import type { Document, Value } from './values.js';
import { validateAnswerSession } from './answer-session-validation.js';
export { validateAnswerSession, safeAnswerSessionId } from './answer-session-validation.js';

function clone(value: Value): Value {
  if (Array.isArray(value)) return value.map(clone);
  if (value instanceof PythonObject) {
    const result = new PythonObject<Value>();
    for (const [key, item] of value.entries()) result.set(key, clone(item));
    return result;
  }
  return value;
}
/** Invalidate source-bound decisions; no approval transfers to the winner. */
export function rewriteSessionAnswerKey(session: Document, source: string, winner: string, at: string): Document {
  validateAnswerSession(session);
  const rewritten = clone(session) as Document;
  const keys = (fallback(rewritten, 'answerKeys', []) as Value[]).map(key => string(key) === source ? winner : string(key)!);
  set(rewritten, 'answerKeys', [...new Set(keys)].map(text));
  for (const item of fallback(rewritten, 'pendingFields', []) as Value[]) {
    const field = object(item, 'pending field');
    if (string(get(field, 'answerKey')) === source) {
      set(field, 'answerKey', text(winner));
      for (const key of ['matchConfidence', 'matchReasonCodes', 'matchAnswerRevision']) field.delete(text(key));
    }
  }
  set(rewritten, 'approvals', (fallback(rewritten, 'approvals', []) as Value[]).filter(item => string(get(object(item, 'session approval'), 'answerKey')) !== source));
  set(rewritten, 'updatedAt', text(at));
  return validateAnswerSession(rewritten);
}
export function answerReferenceCounts(document: Document, sessions: Document[], history: Document[]): Map<string, {sessions: bigint; history: bigint}> {
  const counts = new Map<string, {sessions: bigint; history: bigint}>();
  const redirects = object(fallback(document, 'redirects', new PythonObject<Value>()), 'answer redirects');
  const add = (keys: Set<string>, kind: 'sessions' | 'history'): void => {
    for (const key of keys) {
      const redirect = get(redirects, key);
      const resolved = redirect === null ? key : string(get(object(redirect, 'answer redirect'), 'targetKey'))!;
      const count = counts.get(resolved) ?? {sessions: 0n, history: 0n};
      count[kind] += 1n;
      counts.set(resolved, count);
    }
  };
  for (const session of sessions) {
    const keys = new Set((fallback(session, 'answerKeys', []) as Value[]).map(key => string(key)!));
    for (const item of fallback(session, 'pendingFields', []) as Value[]) {
      const key = string(get(object(item, 'pending field'), 'answerKey'));
      if (key !== null) keys.add(key);
    }
    add(keys, 'sessions');
  }
  for (const event of history) add(new Set((fallback(event, 'answerKeys', []) as Value[]).map(key => string(key)!)), 'history');
  return counts;
}
