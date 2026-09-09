import { randomUUID } from "node:crypto";
import { normalizeJobUrl, strip } from "../contracts/workspace/job-url.js";
import { emptyObject, ingestFields, safeId, statuses, validateInput, validateJob } from "../contracts/workspace/jobs.js";
import { copy, get, has, set, object, string, int, integer, text, keys, same, truth, JobsError } from "../contracts/workspace/values.js";
import type { Document, Value } from "../contracts/workspace/values.js";
import { mayUpdate, nonempty, origin, protectMigration, stamp } from "./job-provenance.js";

export interface JobsTransaction {
  document: Document;
  requireResume(id: Value): Promise<void>;
  save(document: Document): Promise<void>;
}
export interface JobsRepository {
  transaction<T>(operation: (transaction: JobsTransaction) => Promise<T>): Promise<T>;
}
export class JobsService {
  constructor(readonly repository: JobsRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    private readonly id = () => `job-${randomUUID()}`) {}

  async create(value: Value, author = "human"): Promise<Document> {
    const input = validateInput(value, false), by = origin(author);
    const url = string(get(input, "url")), normalized = normalizeJobUrl(url);
    const id = safeId(truth(get(input, "id")) ? string(get(input, "id")) : this.id());
    if (has(input, "status") && string(get(input, "status")) !== "saved") throw new JobsError("new jobs must start with saved status");
    const now = this.now(), record = copy(input);
    const provenance = has(input, "provenance") ? object(get(input, "provenance"), "job provenance") : emptyObject();
    protectMigration(emptyObject(), provenance);
    set(record, "id", text(id));
    set(record, "url", text(strip(url!)));
    set(record, "normalizedUrl", text(normalized));
    if (!has(record, "priority")) set(record, "priority", integer(0n));
    set(record, "status", text("saved"));
    if (!has(record, "closedOutcome")) set(record, "closedOutcome", null);
    set(record, "provenance", stamp(provenance, [...ingestFields].filter(field => has(input, field) && nonempty(get(input, field))), by, input, now));
    set(record, "revision", integer(1n));
    set(record, "createdAt", text(now));
    set(record, "updatedAt", text(now));
    set(record, "deletedAt", null);
    validateJob(id, record);
    return this.repository.transaction(async transaction => {
      await transaction.requireResume(get(input, "resumeId"));
      const jobs = object(get(transaction.document, "jobs"), "jobs.jobs");
      if (has(jobs, id)) throw new JobsError("job id already exists");
      this.requireUnique(jobs, normalized);
      set(jobs, id, record);
      set(object(get(transaction.document, "metadata"), "jobs.metadata"), "updatedAt", text(now));
      await transaction.save(transaction.document);
      return record;
    });
  }

  async get(id: string, includeTrashed = false): Promise<Value> {
    safeId(id);
    return this.repository.transaction(async ({ document }) => {
      const value = get(object(get(document, "jobs"), "jobs.jobs"), id);
      if (value === null) return null;
      return !includeTrashed && get(object(value, "job record"), "deletedAt") !== null ? null : value;
    });
  }

  async list(options: { status?: string; includeTrashed?: boolean; trashedOnly?: boolean } = {}): Promise<Document[]> {
    if (options.status !== undefined && !statuses.has(options.status)) throw new JobsError("job status is unsupported");
    return this.repository.transaction(async ({ document }) => {
      const jobs = object(get(document, "jobs"), "jobs.jobs").entries().map(([, value]) => object(value, "job record"));
      const compareText = (left: string, right: string): number => {
        const a = [...left], b = [...right];
        for (let index = 0; index < Math.min(a.length, b.length); index++) {
          const difference = a[index]!.codePointAt(0)! - b[index]!.codePointAt(0)!;
          if (difference) return difference;
        }
        return a.length - b.length;
      };
      return jobs.filter(record => {
        const deleted = get(record, "deletedAt") !== null;
        return (options.includeTrashed || options.trashedOnly || !deleted) && (!options.trashedOnly || deleted)
          && (options.status === undefined || string(get(record, "status")) === options.status);
      }).sort((a, b) => Number((int(get(b, "priority")) ?? 0n) - (int(get(a, "priority")) ?? 0n))
        || compareText(string(get(a, "createdAt"))!, string(get(b, "createdAt"))!)
        || compareText(string(get(a, "id"))!, string(get(b, "id"))!));
    });
  }

  async update(id: string, value: Value, expectedRevision: bigint, author = "human"): Promise<Document> {
    const patch = validateInput(value, true), by = origin(author);
    safeId(id);
    return this.repository.transaction(async transaction => {
      const jobs = object(get(transaction.document, "jobs"), "jobs.jobs"), value = get(jobs, id);
      if (value === null || get(object(value, "job record"), "deletedAt") !== null) throw new JobsError("job does not exist");
      const current = object(value, "job record");
      if (int(get(current, "revision")) !== expectedRevision) throw new JobsError("job revision conflict");
      const currentProvenance = has(current, "provenance") ? object(get(current, "provenance"), "job provenance") : emptyObject();
      let provenance = currentProvenance;
      if (by === "human" && has(patch, "provenance")) {
        provenance = object(get(patch, "provenance"), "job provenance");
        protectMigration(currentProvenance, provenance);
      }
      const updated = copy(current), accepted: string[] = [];
      for (const field of keys(patch)) {
        const value = get(patch, field);
        if (field === "provenance" || by === "agent" && (!nonempty(value) || !mayUpdate(current, currentProvenance, field))) continue;
        set(updated, field, value);
        accepted.push(field);
      }
      if (accepted.includes("resumeId")) await transaction.requireResume(get(updated, "resumeId"));
      if (accepted.includes("url")) {
        const normalized = normalizeJobUrl(string(get(updated, "url")));
        set(updated, "normalizedUrl", text(normalized));
        set(updated, "url", text(strip(string(get(updated, "url"))!)));
        this.requireUnique(jobs, normalized, id);
      }
      const changed = accepted.filter(field => !same(get(current, field), get(updated, field)));
      if (!changed.length && same(provenance, currentProvenance)) return current;
      const now = this.now();
      set(updated, "provenance", stamp(provenance, changed, by, updated, now));
      set(updated, "revision", integer(expectedRevision + 1n));
      set(updated, "updatedAt", text(now));
      validateJob(id, updated);
      set(jobs, id, updated);
      set(object(get(transaction.document, "metadata"), "jobs.metadata"), "updatedAt", text(now));
      await transaction.save(transaction.document);
      return updated;
    });
  }

  private requireUnique(jobs: Document, normalized: string, except?: string): void {
    if (jobs.entries().some(([key, value]) => string(key) !== except
      && get(object(value, "job record"), "deletedAt") === null
      && string(get(object(value, "job record"), "normalizedUrl")) === normalized)) {
      throw new JobsError("active job URL already exists");
    }
  }
}
