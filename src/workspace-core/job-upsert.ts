import { createHash, timingSafeEqual } from 'node:crypto';
import { PythonObject } from '../contracts/python-object.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { strip } from '../contracts/workspace/job-url.js';
import { copy, get, set, object, string, text, fromJSON, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { JobsTransaction } from './jobs.js';
import { origin } from './job-provenance.js';
import { planJobUpsert } from './job-upsert-plan.js';

export interface JobUpsertRepository {
  upsertTransaction<T>(operation: (transaction: Pick<JobsTransaction, 'document' | 'save'>) => Promise<T>): Promise<T>;
}

export function upsertItems(payload: Value): Value[] {
  if (!(payload instanceof PythonObject) || payload.size !== 1 || !payload.has(text('jobs'))) {
    throw new JobsError('job upsert input must contain only a jobs array');
  }
  const jobs = get(payload, 'jobs');
  if (!Array.isArray(jobs)) throw new JobsError('job upsert input.jobs must be an array');
  return jobs;
}

function tokenFor(document: Document, payload: Value, author: string): string {
  const by = origin(author);
  const items = upsertItems(payload).map(value => {
    if (!(value instanceof PythonObject)) return value;
    const normalized = copy(value);
    for (const [key, value] of normalized.entries()) {
      const field = string(value);
      if (field !== null) normalized.set(key, text(strip(field)));
    }
    return normalized;
  });
  const bound = object(fromJSON({version:1, origin:by, input:{}, jobsDocument:{}}), 'upsert token');
  set(bound, 'input', set(new PythonObject<Value>(), 'jobs', items));
  set(bound, 'jobsDocument', document);
  return 'job-upsert-v1.' + createHash('sha256').update(canonicalJson(bound)).digest('hex');
}

function result(token: string, decisions: Document[], committed: boolean): Value {
  const counts: Record<string, number> = {create:0, update:0, noop:0, conflict:0, invalid:0};
  for (const decision of decisions) counts[string(get(decision, 'action'))!]!++;
  const value = object(fromJSON({token, summary:counts, committed}), 'upsert result');
  set(value, 'decisions', decisions);
  return value;
}

/** Preview tokens bind all job records, the author, and trimmed input under the Store lock. */
export class JobUpsertService {
  constructor(readonly repository: JobUpsertRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}

  async preview(payload: Value, author: string): Promise<Value> {
    return this.repository.upsertTransaction(async ({document}) => {
      const token = tokenFor(document, payload, author);
      const {decisions} = planJobUpsert(document, upsertItems(payload), origin(author), this.now());
      return result(token, decisions, false);
    });
  }

  async commit(payload: Value, author: string, token: string): Promise<Value> {
    if (typeof token !== 'string' || !token) throw new JobsError('job upsert commit requires a preview token');
    return this.repository.upsertTransaction(async transaction => {
      const expected = Buffer.from(tokenFor(transaction.document, payload, author));
      const supplied = Buffer.from(token);
      if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
        throw new JobsError('job upsert preview token rejected because the store or input drifted');
      }
      const {document, decisions, changed} = planJobUpsert(transaction.document, upsertItems(payload), origin(author), this.now());
      if (changed) await transaction.save(document);
      return result(token, decisions, changed);
    });
  }
}
