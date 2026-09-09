import { answerKey, answerNames, answerPatchFields, answerRevision, answerReviews, answerStates, answerView, fallback, normalizeAliases, normalizeAnswerQuestion, sameAnswerScope, sensitiveAnswer, validateAnswer, validateAnswers } from '../contracts/workspace/answers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { copy, get, has, int, integer, keys, object, same, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { AnswerMergeTransaction } from './answer-merges.js';
import { semanticLookup } from './answer-match.js';
import { previewAnswerCleanup } from './answer-cleanup.js';

export interface AnswerReferences { sessions: bigint; history: bigint }
export type AnswerReferenceCounts = ReadonlyMap<string, AnswerReferences>;
export interface AnswerRepository {
  answerMergeTransaction?<T>(operation: (transaction: AnswerMergeTransaction) => Promise<T>): Promise<T>;
  answerTransaction<T>(operation: (document: Document, save: (document: Document) => Promise<void>, references: AnswerReferenceCounts) => Promise<T>): Promise<T>;
}
export interface AnswerQuery {
  query?: string; state?: string | null; reviewStatus?: string | null;
  includeTrashed?: boolean; trashedOnly?: boolean; offset?: number; limit?: number;
}
export function answerProjection(record: Document, references: AnswerReferenceCounts, detail = false, reveal = false): Document {
  const view = answerView(record), result = emptyObject();
  for (const key of keys(view)) if (key !== 'value') set(result, key, get(view, key));
  set(result, 'hasValue', get(view, 'value') !== null);
  set(result, 'valueRedacted', sensitiveAnswer(view) && get(view, 'value') !== null);
  const count = references.get(string(get(view, 'key'))!) ?? { sessions: 0n, history: 0n };
  const counts = set(set(emptyObject(), 'sessions', integer(count.sessions)), 'history', integer(count.history));
  set(result, 'referenceCounts', set(counts, 'total', integer(count.sessions + count.history)));
  if (detail && (!sensitiveAnswer(view) || reveal)) set(result, 'value', get(view, 'value'));
  return result;
}
function canonical(document: Document, key: string): string {
  const redirects = object(fallback(document, 'redirects', emptyObject()), 'redirects');
  return has(redirects, key) ? string(get(object(get(redirects, key), 'redirect'), 'targetKey'))! : key;
}
function collision(document: Document, candidate: Document, key: string): void {
  const names = answerNames(candidate), answers = object(get(document, 'answers'), 'answers');
  const scope = object(fallback(candidate, 'scope', emptyObject()), 'scope');
  for (const otherKey of keys(answers)) {
    const other = object(get(answers, otherKey), 'answer');
    if (otherKey !== key && sameAnswerScope(fallback(other, 'scope', emptyObject()), scope) && answerNames(other).some(name => names.includes(name))) throw new JobsError('answer question or alias collides within scope');
  }
  for (const name of names) {
    const retired = answerKey(name, scope);
    if (canonical(document, retired) !== retired && canonical(document, retired) !== key) throw new JobsError('answer question or alias is a retired redirect identity');
  }
}
export class AnswersService {
  constructor(readonly repository: AnswerRepository, private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}
  cleanupPreview(): Promise<Value> {
    return this.repository.answerTransaction(async document => previewAnswerCleanup(validateAnswers(document)));
  }
  semanticLookup(incoming: Value): Promise<Value> {
    return this.repository.answerTransaction(async document => semanticLookup(validateAnswers(document), incoming));
  }
  get(key: string, reveal = false, includeTrashed = false): Promise<Value> {
    return this.repository.answerTransaction(async (raw, _save, references) => {
      const document = validateAnswers(raw), resolved = canonical(document, key);
      const answers = object(get(document, 'answers'), 'answers');
      if (!has(answers, resolved)) return null;
      const record = object(get(answers, resolved), 'answer');
      if (get(record, 'deletedAt') !== null && !includeTrashed) return null;
      const result = answerProjection(record, references, true, reveal);
      if (key !== resolved) set(result, 'redirectedFrom', text(key));
      return result;
    });
  }
  find(question: string, scope: Document = emptyObject()): Promise<Value> {
    const normalized = normalizeAnswerQuestion(question);
    return this.repository.answerTransaction(async (raw, _save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      const eligible = (record: Document): boolean => get(record, 'deletedAt') === null
        && string(fallback(record, 'reviewStatus', text('accepted'))) === 'accepted'
        && sameAnswerScope(fallback(record, 'scope', emptyObject()), scope);
      for (const key of keys(answers)) {
        const record = object(get(answers, key), 'answer');
        if (eligible(record) && answerNames(record).includes(normalized)) return answerProjection(record, references, true);
      }
      const computed = answerKey(question, scope), resolved = canonical(document, computed);
      if (!has(answers, resolved)) return null;
      const record = object(get(answers, resolved), 'answer');
      if (!eligible(record)) return null;
      const result = answerProjection(record, references, true);
      if (computed !== resolved) set(result, 'redirectedFrom', text(computed));
      return result;
    });
  }
  query(options: AnswerQuery = {}): Promise<Document> {
    const { query = '', state = null, reviewStatus = 'accepted', includeTrashed = false, trashedOnly = false, offset = 0, limit = 50 } = options;
    if (typeof query !== 'string') throw new JobsError('answer query must be a string');
    if (state !== null && !answerStates.has(state)) throw new JobsError('answer state is unsupported');
    if (reviewStatus !== null && !answerReviews.has(reviewStatus)) throw new JobsError('answer review status is unsupported');
    if (typeof includeTrashed !== 'boolean' || typeof trashedOnly !== 'boolean') throw new JobsError('answer trash filters must be booleans');
    if (trashedOnly && !includeTrashed) throw new JobsError('trashed-only query requires include trashed');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new JobsError('answer offset must be a non-negative integer');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new JobsError('answer limit must be between 1 and 200');
    const needle = query.trim() ? normalizeAnswerQuestion(query) : '';
    return this.repository.answerTransaction(async (raw, _save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      const records = keys(answers).map(key => object(get(answers, key), 'answer')).filter(record => {
        const trashed = get(record, 'deletedAt') !== null;
        return (includeTrashed || !trashed) && (!trashedOnly || trashed)
          && (state === null || string(get(record, 'state')) === state)
          && (reviewStatus === null || string(fallback(record, 'reviewStatus', text('accepted'))) === reviewStatus)
          && (!needle || answerNames(record).some(name => name.includes(needle)));
      });
      const compare = (a: string, b: string): number => {
        const left = Array.from(a, char => char.codePointAt(0)!), right = Array.from(b, char => char.codePointAt(0)!);
        for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!;
        return left.length - right.length;
      };
      records.sort((a, b) => compare(string(get(a, 'question')) ?? '', string(get(b, 'question')) ?? '') || compare(string(get(a, 'key'))!, string(get(b, 'key'))!));
      const result = set(emptyObject(), 'items', records.slice(offset, offset + limit).map(record => answerProjection(record, references)));
      set(result, 'total', integer(BigInt(records.length)));
      set(result, 'offset', integer(BigInt(offset)));
      set(result, 'limit', integer(BigInt(limit)));
      return set(result, 'hasMore', offset + Math.min(limit, Math.max(0, records.length - offset)) < records.length);
    });
  }
  update(key: string, value: Value, revision: bigint, rememberSensitive = false, review: 'accepted' | 'declined' | null = null): Promise<Document> {
    const patch = object(value, 'answer patch');
    if ((!patch.size && review === null) || keys(patch).some(field => !answerPatchFields.has(field))) throw new JobsError('answer patch contains unsupported fields');
    if (!key) throw new JobsError('answer key must be a non-empty string');
    return this.repository.answerTransaction(async (raw, save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      if (!has(answers, key)) throw new JobsError('answer does not exist');
      const current = object(get(answers, key), 'answer');
      if (get(current, 'deletedAt') !== null) throw new JobsError('answer does not exist');
      if (answerRevision(current) !== revision) throw new JobsError('answer revision conflict');
      if (review !== null && string(fallback(current, 'reviewStatus', text('accepted'))) !== 'pending') throw new JobsError('only pending answers can be reviewed');
      const updated = copy(current), now = text(this.now());
      for (const field of keys(patch)) set(updated, field, get(patch, field));
      set(updated, 'aliases', normalizeAliases(fallback(updated, 'aliases', [])));
      const state = string(get(updated, 'state'));
      set(updated, 'sensitivity', fallback(updated, 'sensitivity', text(state === 'sensitive' ? 'high' : 'none')));
      const changed = !same(get(updated, 'value'), get(current, 'value')) || !string(get(current, 'rememberedWithConsentAt'));
      if (get(updated, 'value') !== null && sensitiveAnswer(updated)) {
        if (changed && !rememberSensitive) throw new JobsError('sensitive answer value requires explicit remember consent');
        if (changed) set(updated, 'rememberedWithConsentAt', now);
      } else updated.delete(text('rememberedWithConsentAt'));
      set(updated, 'revision', integer(revision + 1n));
      set(updated, 'createdAt', get(current, 'createdAt') ?? get(current, 'updatedAt') ?? now);
      set(updated, 'updatedAt', now);
      set(updated, 'deletedAt', null);
      set(updated, 'confirmedAt', state === 'confirmed' ? (state !== string(get(current, 'state')) || !same(get(updated, 'value'), get(current, 'value')) ? now : get(current, 'confirmedAt') ?? now) : null);
      if (review !== null) {
        set(updated, 'reviewStatus', text(review));
        set(updated, 'reviewedAt', now);
      }
      await this.save(document, updated, key, save);
      return answerProjection(updated, references, true);
    });
  }
  put(value: Value, rememberSensitive = false, revision: bigint | null = null): Promise<Document> {
    const incoming = object(value, 'answer'), scope = object(fallback(incoming, 'scope', emptyObject()), 'answer scope');
    const question = string(get(incoming, 'question'));
    if (get(incoming, 'key') !== null && string(get(incoming, 'key')) === null) throw new JobsError('answer key must be a non-empty string');
    const key = string(get(incoming, 'key')) ?? (question === null ? null : answerKey(question, scope));
    if (!key || !key.trim()) throw new JobsError('answer requires a question or explicit key');
    return this.repository.answerTransaction(async (raw, save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      if (canonical(document, key) !== key) throw new JobsError('answer key was merged and cannot be resurrected');
      const current = has(answers, key) ? object(get(answers, key), 'answer') : null;
      if (current && get(current, 'deletedAt') !== null) throw new JobsError('answer is trashed');
      if (current && (revision === null || revision < 1n)) throw new JobsError('existing answer put requires expected revision');
      if (current && answerRevision(current) !== revision) throw new JobsError('answer revision conflict');
      const requestedReview = string(fallback(incoming, 'reviewStatus', text('accepted')));
      if (!answerReviews.has(requestedReview!)) throw new JobsError('answer review status is unsupported');
      if (!current && requestedReview !== 'accepted') throw new JobsError('new answers created through put must have accepted review status');
      const now = text(this.now()), updated = current ? copy(current) : emptyObject();
      for (const field of ['question', 'value', 'state']) set(updated, field, get(incoming, field));
      set(updated, 'key', text(key));
      set(updated, 'scope', scope);
      set(updated, 'source', fallback(incoming, 'source', text('user')));
      set(updated, 'aliases', normalizeAliases(fallback(incoming, 'aliases', [])));
      set(updated, 'fieldClass', fallback(incoming, 'fieldClass', current ? fallback(current, 'fieldClass', text('general')) : text('general')));
      set(updated, 'sensitivity', fallback(incoming, 'sensitivity', text(string(get(updated, 'state')) === 'sensitive' ? 'high' : 'none')));
      set(updated, 'reviewStatus', current ? fallback(current, 'reviewStatus', text('accepted')) : text(requestedReview!));
      set(updated, 'createdAt', current ? get(current, 'createdAt') ?? now : now);
      set(updated, 'updatedAt', now);
      set(updated, 'deletedAt', null);
      set(updated, 'revision', integer(current ? answerRevision(current) + 1n : 1n));
      set(updated, 'observationCount', current ? fallback(current, 'observationCount', integer(0n)) : fallback(incoming, 'observationCount', integer(0n)));
      if (!current) for (const field of ['observedAt', 'lastObservedAt', 'reviewedAt']) if (has(incoming, field)) set(updated, field, get(incoming, field));
      set(updated, 'confirmedAt', string(get(updated, 'state')) === 'confirmed' ? get(incoming, 'confirmedAt') ?? now : get(incoming, 'confirmedAt'));
      if (get(updated, 'value') !== null && sensitiveAnswer(updated)) {
        if (!rememberSensitive) throw new JobsError('sensitive answer value requires explicit remember consent');
        set(updated, 'rememberedWithConsentAt', now);
      } else updated.delete(text('rememberedWithConsentAt'));
      await this.save(document, updated, key, save);
      return answerProjection(updated, references, true);
    });
  }
  observe(value: Value): Promise<Document> {
    const incoming = object(value, 'observed answer'), question = string(get(incoming, 'question'));
    const scope = object(fallback(incoming, 'scope', emptyObject()), 'observed answer scope');
    if (question === null) throw new JobsError('observed answer requires question and object scope');
    const state = string(fallback(incoming, 'state', text(get(incoming, 'value') === null ? 'missing' : 'inferred')));
    if (!['missing', 'inferred'].includes(state!)) throw new JobsError('observed answer state must be missing or inferred');
    if (get(incoming, 'value') !== null && string(fallback(incoming, 'sensitivity', text('none'))) !== 'none') throw new JobsError('sensitive observed values require review and fresh remember consent');
    const normalized = normalizeAnswerQuestion(question);
    return this.repository.answerTransaction(async (raw, save, references) => {
      const document = validateAnswers(raw), answers = object(get(document, 'answers'), 'answers');
      let key = keys(answers).find(key => {
        const record = object(get(answers, key), 'answer');
        return sameAnswerScope(fallback(record, 'scope', emptyObject()), scope) && answerNames(record).includes(normalized);
      }) ?? canonical(document, answerKey(question, scope));
      const current = has(answers, key) ? object(get(answers, key), 'answer') : null;
      if (current && !sameAnswerScope(fallback(current, 'scope', emptyObject()), scope)) throw new JobsError('observed answer derived key is occupied by a different scope');
      if (current && get(current, 'deletedAt') !== null) throw new JobsError('observed answer is trashed');
      const now = text(this.now()), updated = current ? copy(current) : emptyObject();
      if (!current) {
        for (const [field, item] of [['key', text(key)], ['question', text(question)], ['aliases', []], ['value', get(incoming, 'value')], ['state', text(state!)], ['source', fallback(incoming, 'source', text('agent'))], ['scope', scope], ['fieldClass', fallback(incoming, 'fieldClass', text('general'))], ['sensitivity', fallback(incoming, 'sensitivity', text('none'))], ['reviewStatus', text('pending')], ['confirmedAt', null], ['createdAt', now], ['deletedAt', null]] as [string, Value][]) set(updated, field, item);
      }
      set(updated, 'reviewStatus', fallback(updated, 'reviewStatus', text('accepted')));
      set(updated, 'lastObservedAt', now);
      set(updated, 'observedAt', get(updated, 'observedAt') ?? now);
      set(updated, 'observationCount', integer((current ? int(fallback(current, 'observationCount', integer(0n)))! : 0n) + 1n));
      set(updated, 'revision', integer(current ? answerRevision(current) + 1n : 1n));
      set(updated, 'updatedAt', now);
      await this.save(document, updated, key, save);
      return answerProjection(updated, references, true);
    });
  }
  private async save(document: Document, record: Document, key: string, save: (document: Document) => Promise<void>): Promise<void> {
    validateAnswer(key, record);
    collision(document, record, key);
    const answers = set(copy(object(get(document, 'answers'), 'answers')), key, record);
    const metadata = set(copy(object(get(document, 'metadata'), 'metadata')), 'updatedAt', get(record, 'updatedAt'));
    await save(set(set(copy(document), 'answers', answers), 'metadata', metadata));
  }
}
