import { answerReferenceCounts } from '../contracts/workspace/answer-sessions.js';
import { answerView, fallback } from '../contracts/workspace/answers.js';
import { casefold } from '../contracts/workspace/casefold.js';
import { requireJobUnclaimed } from '../contracts/workspace/claims.js';
import { emptyObject, safeId, validateJob } from '../contracts/workspace/jobs.js';
import { copy, get, int, integer, object, same, set, string, text, truth, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { ClaimRepository, ClaimTransaction } from './claims.js';
import type { JobsRepository } from './jobs.js';

export interface TrashRepository extends JobsRepository, ClaimRepository {}

function records(document: Document, field: string): Document[] {
  return object(get(document, field), field).entries().map(([, value]) => object(value, field));
}
function label(record: Document, fields: string[], defaultLabel: string): Value {
  for (const field of fields) if (truth(get(record, field))) return get(record, field);
  return text(defaultLabel);
}
function item(record: Document, type: string, idField: string, name: Value): Document {
  const result = emptyObject();
  set(result, 'type', text(type));
  set(result, 'id', get(record, idField));
  for (const field of ['revision', 'deletedAt']) set(result, field, get(record, field));
  return set(result, 'label', name);
}
function counts(values: Record<string, bigint>): Document {
  const result = emptyObject();
  for (const [key, value] of Object.entries(values)) set(result, key, integer(value));
  return result;
}
function projectTrash(tx: ClaimTransaction): Document {
  const jobs = records(tx.jobs, 'jobs'), resumes = records(tx.resumes, 'resumes');
  const sessions = new Map(tx.sessions.map(session => [string(get(session, 'applicationId')), session]));
  const claim = get(tx.coordinator, 'claim');
  const references = answerReferenceCounts(tx.answers, tx.sessions, tx.history);
  const items: Document[] = [];
  for (const record of jobs) {
    if (get(record, 'deletedAt') === null) continue;
    const id = string(get(record, 'id'))!, session = sessions.get(id);
    const result = item(record, 'job', 'id', label(record, ['role', 'company'], 'Untitled job'));
    set(result, 'secondaryLabel', label(record, ['company'], ''));
    set(result, 'status', fallback(record, 'status', text('saved')));
    set(result, 'blockerCounts', counts({
      claims: BigInt(claim !== null && string(get(object(claim, 'claim'), 'jobId')) === id),
      nonterminalSessions: BigInt(session !== undefined && !['completed', 'abandoned'].includes(string(get(session, 'status'))!)),
    }));
    items.push(result);
  }
  for (const record of resumes) {
    if (get(record, 'deletedAt') === null) continue;
    const result = item(record, 'resume', 'id', label(record, ['label'], 'Untitled resume'));
    set(result, 'blockerCounts', counts({
      jobReferences: BigInt(jobs.filter(job => same(get(job, 'resumeId'), get(record, 'id'))).length),
    }));
    items.push(result);
  }
  for (const raw of records(tx.answers, 'answers')) {
    const record = answerView(raw);
    if (get(record, 'deletedAt') === null) continue;
    const key = string(get(record, 'key'))!;
    const result = item(record, 'answer', 'key', label(record, ['question'], key));
    for (const field of ['state', 'reviewStatus']) set(result, field, get(record, field));
    set(result, 'blockerCounts', counts(references.get(key) ?? {sessions: 0n, history: 0n}));
    items.push(result);
  }
  items.sort((a, b) => {
    for (const field of ['type', 'label', 'id']) {
      const left = string(get(a, field))!, right = string(get(b, field))!;
      const difference = text(field === 'label' ? casefold(left) : left)
        .compare(text(field === 'label' ? casefold(right) : right));
      if (difference) return difference;
    }
    return 0;
  });
  const result = set(emptyObject(), 'items', items);
  set(result, 'counts', counts(Object.fromEntries(['job', 'resume', 'answer'].map(kind =>
    [kind, BigInt(items.filter(record => string(get(record, 'type')) === kind).length)]))));
  return set(result, 'total', integer(BigInt(items.length)));
}

export class TrashService {
  constructor(readonly repository: TrashRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}

  list(): Promise<Document> {
    return this.repository.claimTransaction(async transaction => projectTrash(transaction));
  }

  trashJob(id: string, expectedRevision: bigint): Promise<Document> {
    return this.setJobDeleted(id, expectedRevision, false);
  }

  restoreJob(id: string, expectedRevision: bigint): Promise<Document> {
    return this.setJobDeleted(id, expectedRevision, true);
  }

  deleteJob(id: string, expectedRevision: bigint): Promise<Document> {
    safeId(id);
    return this.repository.claimTransaction(async transaction => {
      const jobs = object(get(transaction.jobs, 'jobs'), 'jobs.jobs');
      const value = get(jobs, id);
      const result = set(emptyObject(), 'id', text(id));
      if (value === null) return set(result, 'deleted', false);
      const current = object(value, 'job record');
      if (int(get(current, 'revision')) !== expectedRevision) throw new JobsError('job revision conflict');
      requireJobUnclaimed(transaction.coordinator, id);
      if (get(current, 'deletedAt') === null) throw new JobsError('job must be trashed before permanent deletion');
      const session = transaction.sessions.find(item => string(get(item, 'applicationId')) === id);
      if (session && !['completed', 'abandoned'].includes(string(get(session, 'status'))!)) {
        throw new JobsError('job is referenced by a nonterminal application session');
      }
      // Retain session and history evidence, including answer references.
      jobs.delete(text(id));
      set(object(get(transaction.jobs, 'metadata'), 'jobs.metadata'), 'updatedAt', text(this.now()));
      await transaction.saveJobs(transaction.jobs);
      return set(result, 'deleted', true);
    });
  }

  private setJobDeleted(id: string, expectedRevision: bigint, restore: boolean): Promise<Document> {
    safeId(id);
    return this.repository.transaction(async transaction => {
      const jobs = object(get(transaction.document, 'jobs'), 'jobs.jobs'), value = get(jobs, id);
      if (value === null) throw new JobsError('job does not exist');
      const current = object(value, 'job record');
      if (int(get(current, 'revision')) !== expectedRevision) throw new JobsError('job revision conflict');
      transaction.requireUnclaimed?.(id);
      const trashed = get(current, 'deletedAt') !== null;
      if (restore === !trashed) return current;
      if (restore) {
        await transaction.requireResume(get(current, 'resumeId'));
        if (jobs.entries().some(([key, value]) => string(key) !== id
          && get(object(value, 'job record'), 'deletedAt') === null
          && same(get(object(value, 'job record'), 'normalizedUrl'), get(current, 'normalizedUrl')))) {
          throw new JobsError('active job URL already exists');
        }
      }
      const updated = copy(current);
      set(updated, 'deletedAt', restore ? null : text(this.now()));
      set(updated, 'revision', integer(expectedRevision + 1n));
      set(updated, 'updatedAt', text(this.now()));
      validateJob(id, updated);
      set(jobs, id, updated);
      set(object(get(transaction.document, 'metadata'), 'jobs.metadata'), 'updatedAt', get(updated, 'updatedAt'));
      await transaction.save(transaction.document);
      return updated;
    });
  }
}
