import { answerRevision, fallback, validateAnswer, validateAnswers } from '../contracts/workspace/answers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { copy, get, has, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import { answerProjection } from './answers.js';
import type { AnswerReferences, AnswerRepository } from './answers.js';

export class AnswerLifecycleError extends JobsError {
  constructor(message: string, readonly counts: AnswerReferences) { super(message); }
}
function requireKey(key: string): void {
  if (typeof key !== 'string' || !key) throw new JobsError('answer key must be a non-empty string');
}
function redirects(document: Document): Document {
  return object(fallback(document, 'redirects', emptyObject()), 'answer redirects');
}
function requireNotTarget(document: Document, key: string): void {
  if (redirects(document).entries().some(([, value]) => string(get(object(value, 'redirect'), 'targetKey')) === key)) {
    throw new JobsError('answer is the target of an immutable redirect');
  }
}
export class AnswerLifecycleService {
  constructor(readonly repository: AnswerRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}

  trash(key: string, expectedRevision: bigint): Promise<Document> {
    return this.setDeleted(key, expectedRevision, false);
  }
  restore(key: string, expectedRevision: bigint): Promise<Document> {
    return this.setDeleted(key, expectedRevision, true);
  }
  private setDeleted(key: string, expectedRevision: bigint, restore: boolean): Promise<Document> {
    requireKey(key);
    return this.repository.answerTransaction(async (raw, save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      const value = get(answers, key);
      if (value === null) throw new JobsError('answer does not exist');
      const current = object(value, 'answer'), revision = answerRevision(current);
      if (revision !== expectedRevision) throw new JobsError('answer revision conflict');
      const trashed = get(current, 'deletedAt') !== null;
      if (restore === !trashed) return answerProjection(current, references, true);
      if (!restore) requireNotTarget(document, key);
      const updated = copy(current);
      set(updated, 'deletedAt', restore ? null : text(this.now()));
      set(updated, 'revision', integer(revision + 1n));
      set(updated, 'updatedAt', text(this.now()));
      validateAnswer(key, updated);
      set(answers, key, updated);
      set(object(get(document, 'metadata'), 'answers.metadata'), 'updatedAt', get(updated, 'updatedAt'));
      await save(document);
      return answerProjection(updated, references, true);
    });
  }
  delete(key: string, expectedRevision: bigint): Promise<Document> {
    requireKey(key);
    return this.repository.answerTransaction(async (raw, save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      if (has(redirects(document), key)) throw new JobsError('merged answer redirects are immutable');
      const result = set(emptyObject(), 'key', text(key)), value = get(answers, key);
      if (value === null) return set(result, 'deleted', false);
      const current = object(value, 'answer');
      if (answerRevision(current) !== expectedRevision) throw new JobsError('answer revision conflict');
      if (get(current, 'deletedAt') === null) throw new JobsError('answer must be trashed before permanent deletion');
      requireNotTarget(document, key);
      const counts = references.get(key) ?? {sessions: 0n, history: 0n};
      // The repository counts every session, including completed and abandoned ones.
      // Incoming redirects are already excluded, so resolved counts match direct references.
      if (counts.sessions) throw new AnswerLifecycleError('answer is referenced by an active session', counts);
      if (counts.history) throw new AnswerLifecycleError('answer is referenced by application history', counts);
      answers.delete(text(key));
      set(object(get(document, 'metadata'), 'answers.metadata'), 'updatedAt', text(this.now()));
      await save(document);
      return set(result, 'deleted', true);
    });
  }
}
