import { copy, fromJSON, get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { validatedCandidate } from '../contracts/workspace/extraction-proposals.js';
import { validateResumeFacts } from '../contracts/workspace/resume-facts.js';
import { ExtractionContext, closeRequest, readyResume, records, revision, touch } from './extraction-context.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import type { ExtractionTransaction } from './extraction-context.js';

function versions(document: Document, resumeId: string): Value[] | null {
  const value = get(records(document, 'sets'), resumeId);
  return value === null ? null : get(object(value, 'resume fact set'), 'versions') as Value[];
}
function latest(document: Document, resumeId: string): Document | null {
  const entries = versions(document, resumeId);
  return entries?.length ? object(entries[entries.length - 1]!, 'resume fact version') : null;
}
function summary(record: Document, resumeId: string, currentContentRevision: string): Document {
  const result = object(fromJSON({ resumeId, revision: null,
    state: string(get(record, 'state')), current: string(get(record, 'contentRevision')) === currentContentRevision,
    contentRevision: string(get(record, 'contentRevision')) }), 'resume fact summary');
  set(result, 'revision', get(record, 'revision'));
  return result;
}
function appendDraft(tx: ExtractionTransaction, resumeId: string, contentRevision: string,
  candidate: Value, expectedFactRevision: bigint | null, now: string): Document {
  const existing = latest(tx.facts, resumeId);
  if ((existing === null ? null : int(get(existing, 'revision'))) !== expectedFactRevision)
    throw new JobsError('resume fact revision conflict');
  const next = (expectedFactRevision ?? 0n) + 1n;
  const record = object(fromJSON({ revision: null, contentRevision,
    state: 'draft', createdAt: now, confirmedAt: null }), 'resume fact version');
  set(record, 'revision', integer(next));
  set(record, 'facts', candidate);
  const entries = versions(tx.facts, resumeId);
  const setRecord = object(fromJSON({ resumeId, versions: [] }), 'resume fact set');
  set(setRecord, 'versions', [...(entries ?? []), record]);
  set(records(tx.facts, 'sets'), resumeId, setRecord);
  touch(tx.facts, now);
  validateResumeFacts(tx.facts);
  return record;
}

/** Drafts and confirmations are immutable versions scoped to one managed resume. */
export class ResumeFactsService extends ExtractionContext {
  list(): Promise<Document[]> {
    return this.repository.extractionTransaction(async tx => {
      const resumes = records(tx.resumes, 'resumes');
      return records(tx.facts, 'sets').entries().flatMap(([key]) => {
        const resumeId = string(key)!;
        const resume = get(resumes, resumeId);
        const record = latest(tx.facts, resumeId);
        return resume === null || record === null ? []
          : [summary(record, resumeId, string(get(object(resume, 'resume'), 'contentRevision'))!)];
      });
    });
  }

  get(resumeId: string): Promise<Document | null> {
    safeId(resumeId);
    return this.repository.extractionTransaction(async tx => {
      const record = latest(tx.facts, resumeId);
      if (record === null) return null;
      const result = copy(record), resume = get(records(tx.resumes, 'resumes'), resumeId);
      set(result, 'resumeId', text(resumeId));
      set(result, 'current', resume !== null
        && string(get(record, 'contentRevision')) === string(get(object(resume, 'resume'), 'contentRevision')));
      set(result, 'versions', versions(tx.facts, resumeId)!.map(value => copy(object(value, 'fact version'))));
      return result;
    });
  }

  createDraft(resumeId: string, candidate: Value, expectedResumeRevision: bigint,
    expectedFactRevision: bigint | null): Promise<Document> {
    safeId(resumeId);
    validatedCandidate(candidate);
    return this.repository.extractionTransaction(async tx => {
      const resume = await readyResume(tx, resumeId, expectedResumeRevision);
      const record = appendDraft(tx, resumeId, string(get(resume, 'contentRevision'))!, candidate, expectedFactRevision, this.now());
      await tx.commit('facts-draft', { facts: tx.facts });
      return summary(record, resumeId, string(get(resume, 'contentRevision'))!);
    });
  }

  completeRequest(id: string, candidate: Value, expectedRequest: bigint): Promise<Document> {
    safeId(id);
    validatedCandidate(candidate);
    return this.repository.extractionTransaction(async tx => {
      const value = get(records(tx.requests, 'requests'), id);
      if (value === null) throw new JobsError('resume extraction request does not exist');
      const request = object(value, 'request');
      revision(request, expectedRequest, 'request revision conflict');
      if (string(get(request, 'scope')) !== 'resume' || string(get(request, 'status')) !== 'requested')
        throw new JobsError('resume-scoped extraction request is not open');
      const resumeId = string(get(request, 'resumeId'))!;
      const resume = await readyResume(tx, resumeId);
      const content = string(get(resume, 'contentRevision'))!;
      if (content !== string(get(request, 'resumeContentRevision'))) throw new JobsError('resume content revision conflict');
      const current = latest(tx.facts, resumeId), now = this.now();
      const record = appendDraft(tx, resumeId, content, candidate, current === null ? null : int(get(current, 'revision')), now);
      const completed = closeRequest(tx.requests, id, expectedRequest, 'completed', now, null, null, int(get(record, 'revision')));
      validateExtractionRequests(tx.requests);
      await tx.commit('request-complete-scoped', { requests: tx.requests, facts: tx.facts });
      const result = summary(record, resumeId, content);
      set(result, 'requestId', get(completed, 'requestId'));
      return result;
    });
  }

  confirm(resumeId: string, expectedFactRevision: bigint, expectedContentRevision: string): Promise<Document> {
    safeId(resumeId);
    return this.repository.extractionTransaction(async tx => {
      const resume = await readyResume(tx, resumeId);
      const currentContent = string(get(resume, 'contentRevision'));
      if (currentContent !== expectedContentRevision)
        throw new JobsError('resume content revision conflict');
      const current = latest(tx.facts, resumeId);
      if (current === null || int(get(current, 'revision')) !== expectedFactRevision
        || string(get(current, 'state')) !== 'draft'
        || string(get(current, 'contentRevision')) !== currentContent)
        throw new JobsError('resume fact confirmation requires a current draft');
      const now = this.now(), next = expectedFactRevision + 1n;
      const confirmed = object(fromJSON({ revision: null, contentRevision: currentContent,
        state: 'confirmed', createdAt: now, confirmedAt: now }), 'resume fact version');
      set(confirmed, 'revision', integer(next));
      set(confirmed, 'facts', get(current, 'facts'));
      versions(tx.facts, resumeId)!.push(confirmed);
      touch(tx.facts, now);
      validateResumeFacts(tx.facts);
      await tx.commit('facts-confirm', { facts: tx.facts });
      return summary(confirmed, resumeId, currentContent!);
    });
  }
}
