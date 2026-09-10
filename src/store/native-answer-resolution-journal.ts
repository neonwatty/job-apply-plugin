import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { sessionRevision } from '../contracts/workspace/answer-resolution.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { validateJobsDocument, safeId } from '../contracts/workspace/jobs.js';
import { fromJSON, get, has, int, integer, keys, object, parse, serialize, set, string, JobsError } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';

export function validateResolutionJournal(journal: Document): Document {
  if (journal.size !== 2 || int(get(journal, 'schemaVersion')) !== 1n || !has(journal, 'operation')) throw new JobsError('invalid coordinator journal');
  const operation = object(get(journal, 'operation'), 'answer resolution operation');
  const fields = ['kind','operationId','jobId','at','answerKey','expectedJobRevision','expectedSessionRevision','expectedAnswerRevision','sourceStatus','targetStatus','session','resultClaim'];
  if (operation.size !== fields.length || keys(operation).some(key => !fields.includes(key)) || string(get(operation, 'kind')) !== 'answer_resolution' || get(operation, 'resultClaim') !== null) throw new JobsError('coordinator answer resolution operation is invalid');
  const id = safeId(string(get(operation, 'jobId')));
  for (const field of ['operationId','at','answerKey']) if (!string(get(operation, field))) throw new JobsError('coordinator answer resolution operation is invalid');
  for (const field of ['expectedJobRevision','expectedSessionRevision','expectedAnswerRevision']) {
    const value = int(get(operation, field));
    if (value === null || value < 1n) throw new JobsError('coordinator answer resolution revision is invalid');
  }
  if (string(get(operation, 'sourceStatus')) !== 'needs_info' || !['needs_info','ready'].includes(string(get(operation, 'targetStatus'))!)) throw new JobsError('coordinator answer resolution status is invalid');
  if (string(get(validateAnswerSession(get(operation, 'session')), 'applicationId')) !== id) throw new JobsError('coordinator answer resolution session identity is invalid');
  return operation;
}
function projection(journal: Document, jobs: Document, sessions: Document[]) {
  const operation = validateResolutionJournal(journal), id = string(get(operation, 'jobId'))!;
  const next = validateJobsDocument(object(parse(serialize(jobs)), 'jobs'));
  const records = object(get(next, 'jobs'), 'jobs.jobs');
  const current = get(records, id);
  if (current === null || get(object(current, 'job'), 'deletedAt') !== null) throw new JobsError('coordinator journal references a missing job');
  const job = object(current, 'job'), expected = int(get(operation, 'expectedJobRevision'))!;
  const changedJob = int(get(job, 'revision')) === expected;
  if (changedJob) {
    if (string(get(job, 'status')) !== 'needs_info') throw new JobsError('coordinator journal source status drifted');
    set(job, 'status', get(operation, 'targetStatus'));
    set(job, 'closedOutcome', null);set(job, 'revision', integer(expected + 1n));set(job, 'updatedAt', get(operation, 'at'));
    set(object(get(next, 'metadata'), 'jobs.metadata'), 'updatedAt', get(operation, 'at'));
    validateJobsDocument(next);
  } else if (int(get(job, 'revision')) !== expected + 1n || string(get(job, 'status')) !== string(get(operation, 'targetStatus'))) throw new JobsError('coordinator journal cannot be reconciled');
  const existing = sessions.find(session => string(get(session, 'applicationId')) === id);
  if (!existing) throw new JobsError('coordinator resolution references a missing session');
  const session = validateAnswerSession(get(operation, 'session'));
  const changedSession = sessionRevision(existing) === int(get(operation, 'expectedSessionRevision'));
  if (!changedSession && canonicalJson(existing) !== canonicalJson(session)) throw new JobsError('coordinator session cannot be reconciled');
  return { id, next, session, changedJob, changedSession };
}
export class NativeAnswerResolutionJournal {
  constructor(private readonly write: (name: string, document: Document) => Promise<void>) {}
  async recover(journal: Document, jobs: Document, sessions: Document[]): Promise<void> {
    // Validate both destinations before the first write; replay can resume after either.
    const plan = projection(journal, jobs, sessions);
    if (plan.changedJob) await this.write('jobs', plan.next);
    if (plan.changedSession) await this.write(`sessions/${plan.id}`, plan.session);
    await this.write('coordinator', object(fromJSON({schemaVersion:1,claim:null}), 'coordinator'));
    await this.write('coordinator-journal', object(fromJSON({schemaVersion:1,operation:null}), 'journal'));
  }
  async commit(operation: Document, jobs: Document, sessions: Document[]): Promise<void> {
    const journal = object(fromJSON({schemaVersion:1,operation:null}), 'journal');
    set(journal, 'operation', operation);
    projection(journal, jobs, sessions);
    await this.write('coordinator-journal', journal);
    await this.recover(journal, jobs, sessions);
  }
}
