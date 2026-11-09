import { PythonObject } from '../../../src/contracts/python-object';
import { get, int, integer, object, parse, serialize, set, string, text } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';

export type FactVersion = { revision: bigint; contentRevision: string; state: 'draft' | 'confirmed';
  current: boolean; facts: Document; versions: Array<{ revision: bigint; state: string; facts: Document }> };

export function factVersion(raw: string): FactVersion {
  const detail = object(parse(raw), 'resume facts');
  const revision = int(get(detail, 'revision')), contentRevision = string(get(detail, 'contentRevision'));
  const state = string(get(detail, 'state')), current = get(detail, 'current'), history = get(detail, 'versions');
  if (revision === null || revision < 1n || !contentRevision || (state !== 'draft' && state !== 'confirmed')
    || typeof current !== 'boolean' || !Array.isArray(history)) throw Error('Unable to read resume facts.');
  const versions = history.map(value => {
    const item = object(value, 'fact version'), revision = int(get(item, 'revision')), state = string(get(item, 'state'));
    if (revision === null || revision < 1n || (state !== 'draft' && state !== 'confirmed')) throw Error('Invalid fact history.');
    return { revision, state, facts: object(get(item, 'facts'), 'historical facts') };
  });
  return { revision, contentRevision, state, current, facts: object(get(detail, 'facts'), 'facts'), versions };
}

export function draftBody(facts: Document, resumeRevision: number, factRevision: bigint): string {
  const body = new PythonObject<Value>();
  set(body, 'facts', facts);
  set(body, 'expectedResumeRevision', integer(BigInt(resumeRevision)));
  set(body, 'expectedFactRevision', integer(factRevision));
  return serialize(body);
}

export function confirmationBody(version: FactVersion): string {
  const body = new PythonObject<Value>();
  set(body, 'expectedFactRevision', integer(version.revision));
  set(body, 'expectedContentRevision', text(version.contentRevision));
  return serialize(body);
}
