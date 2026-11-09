import { PythonObject } from '../python-object.js';
import { get, has, int, keys, object, string, serialize, JobsError } from './values.js';
import type { Document, Value } from './values.js';
import { safeId } from './jobs.js';
import { contentRevision, exact } from './extraction-requests.js';
import { compareText, decodePointer, segment } from './extraction-pointers.js';
export const proposalStatuses = new Set(['pending','completed','superseded']);
export const extractionDecisions = new Set(['use_extracted','keep_current']);
export function validatedCandidate(value: Value): [Document, string[]] {
  const candidate = object(value, 'proposal candidate');
  if (!candidate.size) throw new JobsError('proposal candidate must not be empty');
  function encodedSize(item: Value): number {
    const value = string(item);
    if (value !== null) {
      if ([...value].some(char => char.codePointAt(0)! >= 0xd800 && char.codePointAt(0)! <= 0xdfff)) throw new JobsError('proposal candidate must contain JSON values');
      return Buffer.byteLength(JSON.stringify(value));
    }
    if (item instanceof PythonObject) return 2 + Math.max(0,item.size-1) + item.entries().reduce((size,[key,child]) => size + encodedSize(key) + 1 + encodedSize(child),0);
    if (Array.isArray(item)) return 2 + Math.max(0,item.length-1) + item.reduce<number>((size,child) => size + encodedSize(child),0);
    if (item !== null && typeof item === 'object' && 'kind' in item && item.kind === 'float' && !Number.isFinite(item.value)) throw new JobsError('proposal candidate must contain JSON values');
    return Buffer.byteLength(serialize(item));
  }
  const bytes = encodedSize(candidate);
  const paths: string[] = [];
  function visit(item: Value, path: string, depth: number): void {
    if (depth > 12 || (string(item) !== null && Buffer.byteLength(string(item)!) > 32768)) throw new JobsError('proposal candidate exceeds structural limits');
    if (item === null) throw new JobsError('proposal candidate values must not be null');
    if (item instanceof PythonObject && item.size) {
      for (const [key, child] of item.entries()) {
        const name = string(key)!;
        if (!name) throw new JobsError('proposal candidate keys must be non-empty strings');
        visit(child, `${path}/${segment(name)}`, depth + 1);
      }
    } else paths.push(path);
  }
  visit(candidate, '', 0);
  if (bytes > 262144 || paths.length > 512) throw new JobsError('proposal candidate exceeds structural limits');
  return [candidate, paths.sort(compareText)];
}
function paths(value: Value): string[] {
  if (!Array.isArray(value) || value.some(item => string(item) === null)) throw new JobsError('resume proposal paths are invalid');
  return value.map(item => string(item)!);
}
function validateBaseline(path: string, value: Value): void {
  const segments = decodePointer(path), record = object(value, 'resume proposal baseline');
  const ancestors = get(record, 'ancestors');
  const invalid = (): never => { throw new JobsError('resume proposal baseline is invalid'); };
  if (keys(record).some(key => !['exists','ancestors','value'].includes(key)) || typeof get(record,'exists') !== 'boolean'
    || !Array.isArray(ancestors) || get(record,'exists') !== has(record,'value') || ancestors.length !== segments.length-1) invalid();
  let expected = '';
  for (const [index, item] of (ancestors as Value[]).entries()) {
    expected += `/${segment(segments[index]!)}`;
    const ancestor = object(item,'resume proposal ancestor baseline'), exists = get(ancestor,'exists');
    if (keys(ancestor).some(key => !['path','exists','container','empty','value'].includes(key))
      || string(get(ancestor,'path')) !== expected || typeof exists !== 'boolean') invalid();
    const count = Number(has(ancestor,'container')) + Number(has(ancestor,'value'));
    if (exists ? count !== 1 : count !== 0) invalid();
    if (has(ancestor,'container')) {
      if (get(ancestor,'container') !== true || typeof get(ancestor,'empty') !== 'boolean') invalid();
    } else if (has(ancestor,'empty')) invalid();
  }
}
export function validateExtractionProposal(key: string, value: Value): Document {
  const record = object(value,'resume proposal');
  const allowed = ['id','resumeId','resumeRevision','resumeDigest','resumeContentRevision','profileRevision','resultProfileRevision','candidate','baselines','autoFilledPaths','pendingPaths','decisions','status','revision','createdAt','updatedAt','supersededBy'];
  if (keys(record).some(key => !allowed.includes(key)) || string(get(record,'id')) !== key) throw new JobsError('resume proposal record is invalid');
  safeId(key);
  safeId(string(get(record,'resumeId')));
  for (const field of ['resumeRevision','profileRevision','resultProfileRevision','revision']) {
    const revision = int(get(record,field));
    if (revision === null || revision < 1n) throw new JobsError('resume proposal revision is invalid');
  }
  if (!/^[0-9a-f]{64}$/.test(string(get(record,'resumeDigest')) ?? '')) throw new JobsError('resume proposal binding is invalid');
  if (get(record,'resumeContentRevision') !== null) contentRevision(get(record,'resumeContentRevision'));
  const [, candidatePaths] = validatedCandidate(get(record,'candidate'));
  const baselines = object(get(record,'baselines'),'resume proposal baselines');
  const auto = paths(get(record,'autoFilledPaths')), pending = paths(get(record,'pendingPaths')), all = [...auto,...pending];
  if (new Set(all).size !== all.length || all.some(path => !candidatePaths.includes(path))
    || baselines.size !== candidatePaths.length || keys(baselines).some(path => !candidatePaths.includes(path))) throw new JobsError('resume proposal paths are invalid');
  for (const [path,item] of baselines.entries()) validateBaseline(string(path)!,item);
  const decisions = object(get(record,'decisions'),'resume proposal decisions');
  for (const [path,value] of decisions.entries()) {
    decodePointer(string(path)!);
    const decision = object(value,'resume proposal decision');
    exact(decision,['decision','decidedAt'],'resume proposal decision is invalid');
    if (!extractionDecisions.has(string(get(decision,'decision'))!) || !string(get(decision,'decidedAt'))) throw new JobsError('resume proposal decision is invalid');
  }
  const decisionPaths = keys(decisions), expected = candidatePaths.filter(path => !auto.includes(path));
  if (decisionPaths.some(path => pending.includes(path)) || expected.length !== decisionPaths.length+pending.length
    || [...decisionPaths,...pending].some(path => !expected.includes(path))) throw new JobsError('resume proposal decision paths are invalid');
  const status = string(get(record,'status'))!;
  if (!proposalStatuses.has(status)) throw new JobsError('resume proposal status is invalid');
  if (status === 'pending' && !pending.length) throw new JobsError('pending resume proposal has no pending paths');
  if (status === 'completed' && pending.length) throw new JobsError('completed resume proposal has pending paths');
  if (status === 'superseded') safeId(string(get(record,'supersededBy')));
  else if (get(record,'supersededBy') !== null) throw new JobsError('resume proposal supersession is invalid');
  for (const field of ['createdAt','updatedAt']) if (!string(get(record,field))) throw new JobsError('resume proposal timestamp is invalid');
  return record;
}
export function validateExtractions(document: Document): Document {
  if (int(get(document,'schemaVersion')) !== 1n) throw new JobsError('resume proposals schema version is unsupported');
  exact(document,['schemaVersion','proposals','metadata'],'resume proposal store contains unsupported fields');
  object(get(document,'metadata'),'resume proposal metadata');
  const seen = new Set<string>();
  for (const [key,value] of object(get(document,'proposals'),'resume proposals').entries()) {
    const record = validateExtractionProposal(string(key)!,value), id = string(get(record,'resumeId'))!;
    if (string(get(record,'status')) === 'pending') {
      if (seen.has(id)) throw new JobsError('resume proposal store has multiple pending proposals');
      seen.add(id);
    }
  }
  return document;
}
