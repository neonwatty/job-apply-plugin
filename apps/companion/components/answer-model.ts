import { PythonObject } from '../../../src/contracts/python-object';
import { veteranAnswerValues } from '../../../src/contracts/workspace/answers';
import { copy, get, has, int, keys, object, parse, serialize, set, string, text } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';
export type { Document };
export interface AnswerClient {
  answerRequest(path: string, method: string, body: string | undefined, signal: AbortSignal): Promise<string>;
}
export const answerPath = (key: string): string => {
  const bytes = new TextEncoder().encode(key);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `/api/answers/by-key/${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
};
export function answerSnapshot(raw: string): Document {
  const record = object(parse(raw), 'answer response');
  const revision = int(get(record, 'revision'));
  if (revision === null || revision < 1n) throw Error('Invalid answer revision');
  return record;
}
export function answerDraft(record: Document): Document {
  const result = new PythonObject<Value>();
  for (const key of ['question', 'aliases', 'value', 'state', 'source', 'scope', 'fieldClass', 'sensitivity', 'consentIntent', 'answerIntent']) if (has(record, key)) set(result, key, get(record, key));
  return result;
}
export function selectVeteranStatus(draft: Document, status: string): Document {
  const value = veteranAnswerValues[status];
  const intent = get(draft, 'answerIntent');
  if (value === undefined || !(intent instanceof PythonObject) || string(get(intent, 'kind')) !== 'veteran_status') {
    throw Error('Invalid veteran status selection');
  }
  const result = copy(draft);
  set(result, 'answerIntent', set(copy(intent), 'status', text(status)));
  set(result, 'value', text(value));
  return result;
}
export function answerPatch(base: Document, draft: Document): Document {
  const result = new PythonObject<Value>();
  for (const key of keys(draft)) if (!has(base, key) || serialize(get(base, key)) !== serialize(get(draft, key))) set(result, key, get(draft, key));
  return result;
}
export function reapplyAnswer(base: Document, draft: Document, latest: Document): Document {
  const result = answerDraft(latest), patch = answerPatch(base, draft);
  for (const key of keys(patch)) set(result, key, get(patch, key));
  return result;
}
export function answerMutation(base: Document, draft: Document, remember: boolean): string {
  const result = new PythonObject<Value>();
  set(result, 'patch', answerPatch(base, draft));
  set(result, 'expectedRevision', get(base, 'revision'));
  set(result, 'rememberSensitive', remember);
  return serialize(result);
}
export const cloneAnswer = (record: Document): Document => copy(record);

export function newAnswerDraft(consentOnly = false): Document {
  return object(parse(consentOnly
    ? '{"question":"","aliases":[],"value":null,"state":"sensitive","source":"user","scope":{},"fieldClass":"general","sensitivity":"high","consentIntent":{"kind":"opt_in","purpose":""}}'
    : '{"question":"","aliases":[],"value":"","state":"confirmed","source":"user","scope":{},"fieldClass":"general","sensitivity":"none"}'), 'new answer');
}
export function answerCreateMutation(draft: Document, remember: boolean): string {
  const result = new PythonObject<Value>();
  // Omitting expectedRevision makes put reject an existing key atomically.
  set(result, 'answer', answerDraft(draft));
  set(result, 'rememberSensitive', remember);
  return serialize(result);
}
