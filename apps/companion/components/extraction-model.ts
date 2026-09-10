import { PythonObject } from '../../../src/contracts/python-object';
import { get, has, int, object, parse, serialize, set, string, text } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';
export type { Document };
export interface ExtractionClient {
  extractionRequest(path: string, method: string, body: string | undefined, signal: AbortSignal): Promise<string>;
}
export type Decision = 'use_extracted' | 'keep_current';
export type Choices = Record<string, Decision>;
export function extractionList(raw: string, key: string): Document[] {
  const values = get(object(parse(raw), 'extraction response'), key);
  if (!Array.isArray(values)) throw Error(`Invalid ${key} response`);
  return values.map(value => object(value, key));
}
export function proposalSnapshot(raw: string): Document {
  const result = object(parse(raw), 'proposal');
  for (const key of ['revision', 'liveProfileRevision']) {
    const revision = int(get(result, key));
    if (revision === null || revision < 1n) throw Error('Invalid proposal revision');
  }
  if (!string(get(result, 'id'))) throw Error('Invalid proposal identity');
  pendingPaths(result);
  for (const key of ['candidate', 'currentValues', 'replacementScopes']) object(get(result, key), key);
  return result;
}
export function pendingPaths(proposal: Document): string[] {
  const paths = get(proposal, 'pendingPaths');
  if (!Array.isArray(paths) || paths.some(path => !string(path)?.startsWith('/'))) throw Error('Invalid proposal paths');
  return paths.map(path => string(path)!);
}
export function candidateValue(proposal: Document, pointer: string): Value {
  let value = get(proposal, 'candidate');
  for (const segment of pointer.slice(1).split('/')) {
    const key = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    const container = object(value, 'candidate path');
    if (!has(container, key)) throw Error('Candidate path is missing');
    value = get(container, key);
  }
  return value;
}
export function replacementScope(proposal: Document, pointer: string): Document | null {
  const scopes = object(get(proposal, 'replacementScopes'), 'replacement scopes');
  return has(scopes, pointer) ? object(get(scopes, pointer), 'replacement scope') : null;
}
export function reapplyChoices(choices: Choices, latest: Document): Choices {
  const pending = new Set(pendingPaths(latest));
  return Object.fromEntries(Object.entries(choices).filter(([path]) => pending.has(path)));
}
export function reviewMutation(proposal: Document, choices: Choices, confirmed: string[]): string {
  const decisions = new PythonObject<Value>(), confirmations = new PythonObject<Value>();
  const pending = new Set(pendingPaths(proposal));
  if (!Object.keys(choices).length) throw Error('Choose at least one decision.');
  for (const [path, decision] of Object.entries(choices)) {
    if (!pending.has(path) || !['use_extracted', 'keep_current'].includes(decision)) throw Error('Invalid review choice');
    set(decisions, path, text(decision));
    const scope = replacementScope(proposal, path);
    if (decision === 'use_extracted' && scope) {
      if (!confirmed.includes(path)) throw Error(`Confirm replacement for ${path}.`);
      set(confirmations, path, get(scope, 'path'));
    }
  }
  const body = new PythonObject<Value>();
  set(body, 'decisions', decisions);
  set(body, 'replacementConfirmations', confirmations);
  set(body, 'expectedRevision', get(proposal, 'revision'));
  set(body, 'expectedProfileRevision', get(proposal, 'liveProfileRevision'));
  return serialize(body);
}
export function requestMutation(resume: Document, request?: Document, action?: string): string {
  const body = new PythonObject<Value>();
  if (request) set(body, 'expectedRevision', get(request, 'revision'));
  else set(body, 'resumeId', get(resume, 'id'));
  if (action !== 'cancel') set(body, 'expectedResumeRevision', get(resume, 'revision'));
  return serialize(body);
}
