import { get, has, int, integer, keys, object, parse, serialize, set, string } from '../../../src/contracts/workspace/values';
import type { Document } from '../../../src/contracts/workspace/values';

export interface PendingQuestion {
  reference: string;
  question?: string;
  state?: string;
  sensitive?: boolean;
  resolutionEligible: boolean;
  answerRevision?: bigint;
  answerKey?: string;
  answerSensitivity?: 'none' | 'personal' | 'high';
}
export interface PendingJob {
  id: string;
  role: string;
  company: string;
  status: string;
  jobRevision: bigint;
  sessionRevision: bigint;
  pendingInformation: PendingQuestion[];
}
function closed(record: Document, required: string[], optional: string[] = []): void {
  if (required.some(key => !has(record, key)) || keys(record).some(key => !required.includes(key) && !optional.includes(key))) {
    throw Error('Invalid pending questions response');
  }
}
function requiredString(record: Document, field: string): string {
  const value = string(get(record, field));
  if (value === null) throw Error('Invalid pending questions response');
  return value;
}
function revision(record: Document, field: string): bigint {
  const value = int(get(record, field));
  if (value === null || value < 1n) throw Error('Invalid pending questions revision');
  return value;
}
function question(value: Parameters<typeof object>[0]): PendingQuestion {
  const record = object(value, 'pending question');
  closed(record, ['reference', 'resolutionEligible'], ['question', 'state', 'sensitive', 'answerRevision', 'answerKey', 'answerSensitivity']);
  const eligible = get(record, 'resolutionEligible');
  if (typeof eligible !== 'boolean') throw Error('Invalid pending questions eligibility');
  const result: PendingQuestion = { reference: requiredString(record, 'reference'), resolutionEligible: eligible };
  for (const field of ['question', 'state', 'answerKey'] as const) {
    // Persisted pending questions permit a null question; render the fallback.
    if (field === 'question' && get(record, field) === null) continue;
    if (has(record, field)) result[field] = requiredString(record, field);
  }
  if (has(record, 'sensitive')) {
    const sensitive = get(record, 'sensitive');
    if (typeof sensitive !== 'boolean') throw Error('Invalid pending questions sensitivity');
    result.sensitive = sensitive;
  }
  if (has(record, 'answerRevision')) result.answerRevision = revision(record, 'answerRevision');
  if (has(record, 'answerSensitivity')) {
    const sensitivity = requiredString(record, 'answerSensitivity');
    if (sensitivity !== 'none' && sensitivity !== 'personal' && sensitivity !== 'high') throw Error('Invalid answer sensitivity');
    result.answerSensitivity = sensitivity;
  }
  if (eligible && (result.answerRevision === undefined || !result.answerKey || result.sensitive === true || result.answerSensitivity === 'high')) {
    throw Error('Invalid pending questions eligibility');
  }
  return result;
}
export function pendingAnswers(raw: string): PendingJob[] {
  const response = object(parse(raw), 'pending questions');
  closed(response, ['jobs', 'mutated']);
  const jobs = get(response, 'jobs');
  if (get(response, 'mutated') !== false || !Array.isArray(jobs)) throw Error('Invalid pending questions response');
  return jobs.map(value => {
    const record = object(value, 'pending job');
    closed(record, ['id', 'role', 'company', 'status', 'jobRevision', 'sessionRevision', 'pendingInformation']);
    const pending = get(record, 'pendingInformation');
    if (!Array.isArray(pending) || requiredString(record, 'status') !== 'needs_info') throw Error('Invalid pending job');
    return {
      id: requiredString(record, 'id'), role: requiredString(record, 'role'), company: requiredString(record, 'company'),
      status: 'needs_info', jobRevision: revision(record, 'jobRevision'), sessionRevision: revision(record, 'sessionRevision'),
      pendingInformation: pending.map(question),
    };
  });
}
export function pendingAnswerResolution(job: PendingJob, field: PendingQuestion): string {
  if (!job.pendingInformation.includes(field) || !field.resolutionEligible || field.answerRevision === undefined) {
    throw Error('Question is not eligible for resolution');
  }
  const body = object(parse(JSON.stringify({ reference: field.reference, ownerConfirmed: true })), 'pending resolution');
  set(body, 'expectedJobRevision', integer(job.jobRevision));
  set(body, 'expectedSessionRevision', integer(job.sessionRevision));
  set(body, 'expectedAnswerRevision', integer(field.answerRevision));
  return serialize(body);
}
export function pendingAnswerResolved(raw: string): boolean {
  const result = object(parse(raw), 'pending resolution response');
  closed(result, ['job', 'session', 'resolved', 'ready']);
  if (get(result, 'resolved') !== true || typeof get(result, 'ready') !== 'boolean') throw Error('Invalid pending resolution response');
  const job = object(get(result, 'job'), 'job');
  closed(job, ['id', 'status', 'revision']);
  requiredString(job, 'id');
  requiredString(job, 'status');
  revision(job, 'revision');
  const session = object(get(result, 'session'), 'session');
  closed(session, ['revision', 'pendingInformation']);
  revision(session, 'revision');
  const pending = get(session, 'pendingInformation');
  if (!Array.isArray(pending)) throw Error('Invalid pending resolution response');
  for (const field of pending) question(field);
  return get(result, 'ready') === true;
}
