import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON, get, int, object, string, JobsError } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import type { WorkflowTask } from '../contracts/workspace/workflow-tasks.js';
import { TaskProtocolError } from '../contracts/workspace/workflow-tasks.js';
import type { ResumeExtractionDomain } from '../contracts/workspace/resume-extraction-domain.js';
import type { ActionContext } from '../harness/contracts.js';
import { WorkflowError } from '../harness/contracts.js';
import { readyResume, records } from '../workspace-core/extraction-context.js';
import { extractionActions, extractionIdentity } from '../workflows/resumes/extract.js';

export const extractionFingerprint = (value: unknown): string => createHash('sha256').update(canonicalJson(fromJSON(value))).digest('hex');
export type ResumeTask = WorkflowTask & { subject: { kind: 'resume'; resumeId: string; resumeRevision: string;
  inputRevision: string; requestId: string; requestRevision: string; factRevision: string | null } };
export function resumeTask(task: WorkflowTask): asserts task is ResumeTask {
  if (task.workflow.id !== extractionIdentity.id || task.workflow.version !== extractionIdentity.version
    || !('kind' in task.subject) || task.subject.kind !== 'resume') throw new WorkflowError('workflow_unavailable');
}
export function requestRecord(domain: ResumeExtractionDomain, requestId: string): Document {
  const raw = get(records(domain.snapshot.requests, 'requests'), requestId);
  if (raw === null) throw new TaskProtocolError('stale_revision');
  return object(raw, 'request');
}
export function latestFact(domain: ResumeExtractionDomain, resumeId: string): Document | null {
  const raw = get(records(domain.snapshot.facts, 'sets'), resumeId);
  if (raw === null) return null;
  const versions = get(object(raw, 'set'), 'versions');
  if (!Array.isArray(versions) || !versions.length) throw new TaskProtocolError('invalid_task_state');
  return object(versions[versions.length - 1]!, 'fact');
}
export function sourceContent(domain: ResumeExtractionDomain, resumeId: string): string {
  return string(get(object(get(records(domain.snapshot.resumes, 'resumes'), resumeId), 'resume'), 'contentRevision'))!;
}
export function extractionScope(domain: ResumeExtractionDomain, task: ResumeTask): string {
  const resume = get(records(domain.snapshot.resumes, 'resumes'), task.subject.resumeId);
  const request = get(records(domain.snapshot.requests, 'requests'), task.subject.requestId);
  return createHash('sha256').update(canonicalJson([resume, request, latestFact(domain, task.subject.resumeId)])).digest('hex');
}
export async function requireFresh(domain: ResumeExtractionDomain, task: ResumeTask): Promise<void> {
  try {
    await readyResume(domain.snapshot, task.subject.resumeId, BigInt(task.subject.resumeRevision));
    const request = requestRecord(domain, task.subject.requestId);
    if (string(get(request, 'resumeId')) !== task.subject.resumeId || string(get(request, 'scope')) !== 'resume'
      || int(get(request, 'revision'))!.toString() !== task.subject.requestRevision
      || string(get(request, 'resumeContentRevision')) !== sourceContent(domain, task.subject.resumeId)
      || extractionScope(domain, task) !== task.subject.inputRevision) throw new TaskProtocolError('stale_revision');
    if (task.subject.factRevision === null) {
      if (string(get(request, 'status')) !== 'requested') throw new TaskProtocolError('stale_revision');
    } else {
      const fact = latestFact(domain, task.subject.resumeId);
      if (!fact || string(get(fact, 'state')) !== 'draft' || int(get(fact, 'revision'))!.toString() !== task.subject.factRevision
        || string(get(fact, 'contentRevision')) !== sourceContent(domain, task.subject.resumeId)
        || string(get(request, 'status')) !== 'completed' || int(get(request, 'factRevision'))!.toString() !== task.subject.factRevision)
        throw new TaskProtocolError('stale_revision');
    }
  } catch (error) { if (error instanceof JobsError) throw new TaskProtocolError('stale_revision'); throw error; }
}
export async function extractionContext(domain: ResumeExtractionDomain, task: ResumeTask): Promise<ActionContext> {
  const terminal = task.status === 'finished' || task.status === 'cancelled';
  let phase: Parameters<typeof extractionActions>[0] = terminal ? 'terminal'
    : task.status === 'waiting' ? 'waiting' : task.subject.factRevision === null ? 'requested' : 'draft';
  if (!terminal) {
    try { await requireFresh(domain, task); }
    catch (error) { if (!(error instanceof TaskProtocolError)) throw error; phase = 'stale'; }
  }
  return { taskId: task.taskId, revision: task.revision, workflow: task.workflow, canLeave: true,
    allowedActions: extractionActions(phase), complete: task.status === 'finished', terminal, childDepth: 0 };
}
