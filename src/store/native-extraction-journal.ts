import { randomUUID } from 'node:crypto';
import { validateProfile } from '../contracts/workspace/profile.js';
import { validateResumeReferences } from '../contracts/workspace/resume-reference.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { validateExtractions } from '../contracts/workspace/extraction-proposals.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { fromJSON, get, int, integer, keys, object, parse, serialize, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';

export type ExtractionUpdates = { profile?: Document; proposals?: Document; requests?: Document; resumes?: Document };
const destinations = { profile: 'profile', proposals: 'resume-extractions', requests: 'resume-extraction-requests', resumes: 'resumes' } as const;
export const extractionJournalName = 'resume-extraction-journal';
const kinds = new Set(['create', 'review', 'request-create', 'request-close', 'request-retry', 'request-complete', 'resume-request-close']);
const legacy = ['kind', 'operationId', 'profileDocument', 'proposalsDocument'];
const expanded = [...legacy, 'requestsDocument', 'resumesDocument'];

export function validateExtractionResumes(document: Document): Document {
  if (int(get(document, 'schemaVersion')) !== 1n || document.size !== 3
    || keys(document).some(key => !['schemaVersion', 'resumes', 'metadata'].includes(key))) {
    throw new JobsError('resume proposal journal operation is invalid');
  }
  object(get(document, 'metadata'), 'resumes.metadata');
  validateResumeReferences(object(get(document, 'resumes'), 'resumes.resumes'));
  return document;
}

/** Validate every destination before the first write, including legacy journal shapes. */
export function validateExtractionJournal(document: Document): Document {
  if (int(get(document, 'schemaVersion')) !== 1n || document.size !== 2
    || keys(document).some(key => !['schemaVersion', 'operation'].includes(key))) {
    throw new JobsError('invalid resume extraction journal');
  }
  if (get(document, 'operation') === null) return document;
  const operation = object(get(document, 'operation'), 'resume extraction journal operation');
  const fields = keys(operation), kind = string(get(operation, 'kind'));
  const isLegacy = fields.length === legacy.length && fields.every(key => legacy.includes(key));
  if ((!isLegacy && (fields.length !== expanded.length || fields.some(key => !expanded.includes(key))))
    || !kind || !kinds.has(kind) || isLegacy && !['create', 'review'].includes(kind)) {
    throw new JobsError('resume proposal journal operation is invalid');
  }
  safeId(string(get(operation, 'operationId')));
  for (const [key, validator] of Object.entries({ profile: validateProfile, proposals: validateExtractions,
    requests: validateExtractionRequests, resumes: validateExtractionResumes })) {
    const value = get(operation, `${key}Document`);
    if (value !== null) validator(object(value, `journal ${key}`));
  }
  return document;
}

export class NativeExtractionJournal {
  constructor(private readonly read: () => Promise<Document>,
    private readonly write: (name: string, document: Document) => Promise<void>) {}

  async recover(): Promise<void> {
    const journal = validateExtractionJournal(await this.read());
    await this.replay(journal);
  }

  private async replay(journal: Document): Promise<void> {
    if (get(journal, 'operation') === null) return;
    const operation = object(get(journal, 'operation'), 'extraction operation');
    for (const [key, destination] of Object.entries(destinations)) {
      const value = get(operation, `${key}Document`);
      if (value !== null) await this.write(destination, object(value, `journal ${key}`));
    }
    await this.write(extractionJournalName, object(fromJSON({ schemaVersion: 1, operation: null }), 'journal'));
  }

  async commit(kind: string, updates: ExtractionUpdates): Promise<void> {
    if (Object.keys(updates).some(key => !(key in destinations))) throw new JobsError('unsupported extraction update');
    const operation = object(fromJSON({ kind, operationId: `extraction-${randomUUID()}`,
      profileDocument: null, proposalsDocument: null, requestsDocument: null, resumesDocument: null }), 'operation');
    for (const [key, value] of Object.entries(updates)) if (value !== undefined) set(operation, `${key}Document`, value);
    const journal = object(fromJSON({ schemaVersion: 1, operation: null }), 'journal');
    set(journal, 'operation', operation);
    validateExtractionJournal(journal);
    await this.write(extractionJournalName, journal);
    await this.replay(journal);
  }
}

/** Resume content replacement closes requests; metadata edits retain their content binding. */
export function closeRequestsForResumes(requestDocument: Document, resumeDocument: Document): Document | null {
  const requests = object(parse(serialize(requestDocument)), 'requests');
  const records = object(get(resumeDocument, 'resumes'), 'resumes.resumes');
  let changed = false;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  for (const [, value] of object(get(requests, 'requests'), 'requests.requests').entries()) {
    const request = object(value, 'request');
    if (string(get(request, 'status')) !== 'requested') continue;
    const resume = get(records, string(get(request, 'resumeId'))!);
    const record = resume === null ? null : object(resume, 'resume');
    const status = record === null || get(record, 'deletedAt') !== null ? 'cancelled'
      : string(get(record, 'contentRevision')) !== string(get(request, 'resumeContentRevision')) ? 'stale' : null;
    if (status === null) continue;
    set(request, 'status', text(status));
    set(request, 'revision', integer(int(get(request, 'revision'))! + 1n));
    set(request, 'closedAt', text(now));
    set(request, 'updatedAt', text(now));
    set(request, 'failureReason', null);
    set(request, 'proposalId', null);
    changed = true;
  }
  if (!changed) return null;
  set(object(get(requests, 'metadata'), 'requests.metadata'), 'updatedAt', text(now));
  return validateExtractionRequests(requests);
}
