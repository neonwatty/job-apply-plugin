import { fromJSON, serialize } from './values.js';
import { validateWorkflowArchiveRoot } from './workflow-archive.js';
import type { WorkflowArchiveRoot } from './workflow-archive.js';
import type { Value } from './values.js';

export type TaskStatus = 'active' | 'waiting' | 'finished' | 'cancelled';
export type TaskOutcome = 'started' | 'question_pending' | 'job_ready' | 'cancelled' | 'declined' | 'claim_acquired' | 'claim_recovered' | 'progress_saved' | 'needs_info' | 'awaiting_review'
  | 'extraction_requested' | 'extraction_proposed' | 'extraction_review_pending' | 'extraction_accepted'
  | 'extraction_rejected' | 'extraction_interrupted';
export interface JobWorkflowSubject { jobId: string; jobRevision: string; inputRevision: string }
export interface ResumeWorkflowSubject {
  kind: 'resume'; resumeId: string; resumeRevision: string; inputRevision: string;
  requestId: string; requestRevision: string; factRevision: string | null;
}
export type WorkflowSubject = JobWorkflowSubject | ResumeWorkflowSubject;
export interface WorkflowTask {
  taskId: string;
  workflow: { id: string; version: number };
  revision: string;
  subject: WorkflowSubject;
  status: TaskStatus;
  pending: { requestId: string; questionId: string } | null;
}
export type JobWorkflowTask = WorkflowTask & { subject: JobWorkflowSubject };
export type ResumeWorkflowTask = WorkflowTask & { subject: ResumeWorkflowSubject };
export function isJobWorkflowTask(task: WorkflowTask): task is JobWorkflowTask { return 'jobId' in task.subject; }
export function workflowSubjectIdentity(subject: WorkflowSubject): string {
  return 'jobId' in subject ? `job:${subject.jobId}` : `resume:${subject.resumeId}`;
}
export interface WorkflowReceipt {
  operationId: string;
  task: WorkflowTask;
  outcome: TaskOutcome;
}
export interface WorkflowLedger {
  schemaVersion: 1 | 2;
  archive?: WorkflowArchiveRoot;
  activeTaskId: string | null;
  tasks: Record<string, WorkflowTask>;
  receipts: Record<string, { fingerprint: string; receipt: WorkflowReceipt }>;
}
export class TaskProtocolError extends Error {
  constructor(readonly code: 'invalid_task_state' | 'operation_conflict' | 'task_conflict' | 'stale_revision'
    | 'history_full' | 'handoff_required' | 'user_event_required' | 'action_unavailable' | 'broker_unavailable') {
    super(code); this.name = 'TaskProtocolError';
  }
}
export const workflowMetadataKey = 'agentWorkflows';
export const taskLimit = 64, receiptLimit = 256;
const statuses = ['active', 'waiting', 'finished', 'cancelled'];
const outcomes = ['started', 'question_pending', 'job_ready', 'cancelled', 'declined', 'claim_acquired', 'claim_recovered', 'progress_saved', 'needs_info', 'awaiting_review'];
const extractionOutcomes = ['extraction_requested', 'extraction_proposed', 'extraction_review_pending',
  'extraction_accepted', 'extraction_rejected', 'extraction_interrupted'];
function check(value: unknown): asserts value { if (!value) throw new TaskProtocolError('invalid_task_state'); }
function record(value: unknown, fields?: string[]): Record<string, unknown> {
  check(value !== null && typeof value === 'object' && !Array.isArray(value));
  const input = value as Record<string, unknown>;
  check(Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null);
  if (fields) check(Object.keys(input).length === fields.length && fields.every(key => Object.hasOwn(input, key)));
  return input;
}
function id(value: unknown): void {
  check(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes('..'));
}
function revision(value: unknown): void { check(typeof value === 'string' && value.length <= 4300 && /^[1-9][0-9]*$/.test(value)); }
function task(value: unknown, version: 1 | 2): WorkflowTask {
  const input = record(value, ['taskId', 'workflow', 'revision', 'subject', 'status', 'pending']);
  id(input.taskId); revision(input.revision);
  const workflow = record(input.workflow, ['id', 'version']); id(workflow.id);
  check(typeof workflow.version === 'number' && Number.isSafeInteger(workflow.version) && workflow.version > 0);
  const rawSubject = record(input.subject);
  const subject = version === 2 && rawSubject.kind === 'resume'
    ? record(rawSubject, ['kind', 'resumeId', 'resumeRevision', 'inputRevision', 'requestId', 'requestRevision', 'factRevision'])
    : record(rawSubject, ['jobId', 'jobRevision', 'inputRevision']);
  if (subject.kind === 'resume') {
    id(subject.resumeId); revision(subject.resumeRevision); id(subject.requestId); revision(subject.requestRevision);
    if (subject.factRevision !== null) revision(subject.factRevision);
  } else { id(subject.jobId); revision(subject.jobRevision); }
  check(typeof subject.inputRevision === 'string' && /^[a-f0-9]{64}$/.test(subject.inputRevision));
  check(statuses.includes(input.status as string));
  if (input.pending !== null) {
    const pending = record(input.pending, ['requestId', 'questionId']); id(pending.requestId); id(pending.questionId);
  }
  check((input.status === 'waiting') === (input.pending !== null));
  return input as unknown as WorkflowTask;
}
/** Closed, bounded, value-free metadata. Unsupported versions and malformed history fail closed. */
export function validateWorkflowLedger(value: unknown): WorkflowLedger {
  const raw = record(value);
  check(raw.schemaVersion === 1 || raw.schemaVersion === 2);
  const version = raw.schemaVersion;
  const input = record(raw, ['schemaVersion', 'activeTaskId', 'tasks', 'receipts', ...(version === 2 ? ['archive'] : [])]);
  if (version === 2) validateWorkflowArchiveRoot(input.archive);
  const tasks = record(input.tasks), receipts = record(input.receipts);
  check(Object.keys(tasks).length <= taskLimit && Object.keys(receipts).length <= receiptLimit);
  const active: string[] = [];
  for (const [key, raw] of Object.entries(tasks)) {
    id(key); const item = task(raw, version); check(item.taskId === key);
    if (item.status === 'active' || item.status === 'waiting') active.push(key);
  }
  if (input.activeTaskId !== null) id(input.activeTaskId);
  check(active.length <= 1 && (active[0] ?? null) === input.activeTaskId);
  for (const [key, raw] of Object.entries(receipts)) {
    id(key); const item = record(raw, ['fingerprint', 'receipt']);
    check(typeof item.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(item.fingerprint));
    const receipt = record(item.receipt, ['operationId', 'task', 'outcome']);
    check(receipt.operationId === key && (outcomes.includes(receipt.outcome as string) || version === 2 && extractionOutcomes.includes(receipt.outcome as string)));
    const historical = task(receipt.task, version), current = tasks[historical.taskId];
    check(current !== undefined);
    const latest = task(current, version);
    check(workflowSubjectIdentity(historical.subject) === workflowSubjectIdentity(latest.subject) && historical.workflow.id === latest.workflow.id
      && historical.workflow.version === latest.workflow.version && BigInt(historical.revision) <= BigInt(latest.revision));
  }
  check(JSON.stringify(input).length <= 1024 * 1024);
  return input as unknown as WorkflowLedger;
}
export function emptyWorkflowLedger(): WorkflowLedger {
  return { schemaVersion: 1, activeTaskId: null, tasks: Object.create(null) as Record<string, WorkflowTask>,
    receipts: Object.create(null) as WorkflowLedger['receipts'] };
}
export function decodeWorkflowLedger(value: Value): WorkflowLedger {
  try { return validateWorkflowLedger(JSON.parse(serialize(value)) as unknown); }
  catch { throw new TaskProtocolError('invalid_task_state'); }
}
export function encodeWorkflowLedger(ledger: WorkflowLedger): Value {
  return fromJSON(validateWorkflowLedger(ledger));
}

/** Explicit experimental migration; decoding never changes historical byte shapes. */
export function upgradeWorkflowLedger(ledger: WorkflowLedger): WorkflowLedger {
  validateWorkflowLedger(ledger);
  return ledger.schemaVersion === 2 ? structuredClone(ledger)
    : { ...structuredClone(ledger), schemaVersion: 2, archive: { schemaVersion: 1, segments: [] } };
}
export function emptyWorkflowLedgerV2(): WorkflowLedger { return upgradeWorkflowLedger(emptyWorkflowLedger()); }
