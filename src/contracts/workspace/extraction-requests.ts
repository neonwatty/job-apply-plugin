import { get, has, int, keys, object, string, JobsError } from './values.js';
import type { Document, Value } from './values.js';
import { safeId } from './jobs.js';
import { compareText } from './extraction-pointers.js';
export const requestStatuses = new Set(['requested', 'completed', 'failed', 'stale', 'cancelled']);
export const failureReasons = new Set(['content_unreadable', 'unsupported_resume', 'extraction_failed', 'candidate_invalid', 'interrupted']);
export function contentRevision(value: Value): void {
  if (!/^content_[A-Za-z0-9_-]{32,128}$/.test(string(value) ?? '')) throw new JobsError('resume content revision is unverifiable');
}
export function exact(record: Document, fields: string[], message: string): void {
  if (record.size !== fields.length || keys(record).some(key => !fields.includes(key))) throw new JobsError(message);
}
export function validateExtractionRequest(key: string, value: Value): Document {
  const record = object(value, 'resume extraction request');
  exact(record, ['requestId','resumeId','resumeContentRevision','revision','status','createdAt','updatedAt','closedAt','proposalId','failureReason','supersedesRequestId'], 'resume extraction request is invalid');
  if (string(get(record, 'requestId')) !== key) throw new JobsError('resume extraction request is invalid');
  safeId(key);
  safeId(string(get(record, 'resumeId')));
  contentRevision(get(record, 'resumeContentRevision'));
  const revision = int(get(record, 'revision')), status = string(get(record, 'status'))!;
  if (revision === null || revision < 1n) throw new JobsError('resume extraction request revision is invalid');
  if (!requestStatuses.has(status)) throw new JobsError('resume extraction request status is invalid');
  for (const field of ['createdAt','updatedAt']) if (!string(get(record, field))) throw new JobsError('resume extraction request timestamp is invalid');
  if ((status !== 'requested') !== Boolean(string(get(record, 'closedAt')))) throw new JobsError('resume extraction request closure is invalid');
  if (status === 'completed') safeId(string(get(record, 'proposalId')));
  else if (get(record, 'proposalId') !== null) throw new JobsError('resume extraction request proposal is invalid');
  if (status === 'failed' ? !failureReasons.has(string(get(record, 'failureReason'))!) : get(record, 'failureReason') !== null) throw new JobsError('resume extraction failure reason is invalid');
  if (get(record, 'supersedesRequestId') !== null) {
    if (safeId(string(get(record, 'supersedesRequestId'))) === key) throw new JobsError('resume extraction supersession is invalid');
  }
  return record;
}
export function validateExtractionRequests(document: Document): Document {
  if (int(get(document, 'schemaVersion')) !== 1n) throw new JobsError('resume extraction requests schema version is unsupported');
  exact(document, ['schemaVersion','requests','metadata'], 'resume extraction request store contains unsupported fields');
  const metadata = object(get(document, 'metadata'), 'request metadata');
  exact(metadata, ['createdAt','updatedAt'], 'resume extraction request metadata is invalid');
  for (const field of ['createdAt','updatedAt']) if (!string(get(metadata, field))) throw new JobsError('resume extraction request metadata is invalid');
  const seen = new Set<string>();
  for (const [key, value] of object(get(document, 'requests'), 'resume extraction requests').entries()) {
    const record = validateExtractionRequest(string(key)!, value), id = string(get(record, 'resumeId'))!;
    if (string(get(record, 'status')) === 'requested') {
      if (seen.has(id)) throw new JobsError('resume extraction request store has multiple open requests');
      seen.add(id);
    }
  }
  return document;
}
export function orderRequests(records: Document[], field = 'createdAt'): Document[] {
  const byId = new Map(records.map(record => [string(get(record, 'requestId')), record]));
  function depth(record: Document): number {
    const seen = new Set([string(get(record, 'requestId'))]);
    let count = 0, current = record;
    while (has(current, 'supersedesRequestId') && get(current, 'supersedesRequestId') !== null) {
      const id = string(get(current, 'supersedesRequestId')), previous = byId.get(id);
      if (seen.has(id) || !previous || string(get(previous, 'resumeId')) !== string(get(record, 'resumeId'))) break;
      seen.add(id);
      count++;
      current = previous;
    }
    return count;
  }
  return records.sort((a,b) => compareText(string(get(a, field))!, string(get(b, field))!) || depth(a)-depth(b)
    || compareText(string(get(a, 'requestId'))!, string(get(b, 'requestId'))!));
}
