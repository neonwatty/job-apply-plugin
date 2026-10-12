import { activeApplicationJob, applicationPreflight } from '../contracts/workspace/application-policy.js';
import { activeApplicationRun, currentRunJobIds } from '../contracts/workspace/application-runs.js';
import type { ApplicationSnapshot } from '../contracts/workspace/application-policy.js';
import type { OwnerWorkflowScope } from '../contracts/workspace/owner-workflow.js';
import type { ClaimWorkflowDomain } from '../contracts/workspace/claim-workflow-domain.js';
import { decodeWorkflowLedger, isJobWorkflowTask, TaskProtocolError, workflowMetadataKey } from '../contracts/workspace/workflow-tasks.js';
import type { WorkflowLedger } from '../contracts/workspace/workflow-tasks.js';
import { get, has, int, object, string } from '../contracts/workspace/values.js';
import type { ClaimRepository } from '../workspace-core/claims.js';
import type { WorkflowTaskStore } from '../harness/task-store.js';
import { NativeClaimWorkflowTasks } from '../store/native-claim-workflow-tasks.js';
import { preparationScope } from '../workflows/applications/prepare-scope.js';
import { attemptIdentity } from '../workflows/applications/attempt.js';

async function ready(snapshot: ApplicationSnapshot, jobId: string): Promise<void> {
  const job = activeApplicationJob(snapshot, jobId), run = activeApplicationRun(snapshot.jobs);
  if (!run || !currentRunJobIds(run).includes(jobId) || string(get(job, 'status')) !== 'ready') {
    throw new TaskProtocolError('action_unavailable');
  }
  const selection = object(get(run, 'selection'), 'run selection');
  const resumeId = string(get(selection, 'resumeId'))!;
  const raw = get(object(get(snapshot.resumes, 'resumes'), 'resumes'), resumeId);
  const facts = snapshot.facts ? get(object(get(snapshot.facts, 'sets'), 'fact sets'), resumeId) : null;
  const versions = facts === null ? null : get(object(facts, 'facts'), 'versions');
  const latest = Array.isArray(versions) && versions.length ? object(versions[versions.length - 1]!, 'facts') : null;
  if (raw === null || string(get(object(raw, 'resume'), 'storageKind')) !== 'managed'
    || !latest || string(get(latest, 'state')) !== 'confirmed'
    || int(get(latest, 'revision')) !== int(get(selection, 'factRevision'))
    || get(await applicationPreflight(snapshot, job), 'ready') !== true) {
    throw new TaskProtocolError('action_unavailable');
  }
}

function selectedTask(ledger: WorkflowLedger, jobId: string) {
  if (ledger.activeTaskId === null) return null;
  const task = ledger.tasks[ledger.activeTaskId]!;
  if (!isJobWorkflowTask(task) || task.subject.jobId !== jobId
    || task.workflow.id !== attemptIdentity.id || task.workflow.version !== attemptIdentity.version) {
    throw new TaskProtocolError('task_conflict');
  }
  return task;
}

/** Process-local consent scope. Canonical claims and host approvals remain the write authority. */
export async function createOwnerWorkflowStore(repository: ClaimRepository, jobId: string): Promise<{
  store: WorkflowTaskStore<ClaimWorkflowDomain>; scope: OwnerWorkflowScope;
}> {
  const tasks = new NativeClaimWorkflowTasks({ claimTransaction: callback => repository.claimTransaction(original => {
    const metadata = object(get(original.jobs, 'metadata'), 'metadata');
    if (has(metadata, workflowMetadataKey)) {
      const raw = object(get(metadata, workflowMetadataKey), 'workflow metadata');
      if (int(get(raw, 'schemaVersion')) !== 1n) throw new TaskProtocolError('action_unavailable');
      decodeWorkflowLedger(raw);
    }
    // Reject before any v2 preparation, compaction or archive flush can occur.
    const { workflowArchive: _archive, ...finite } = original;
    return callback(finite);
  }) });
  const scope: OwnerWorkflowScope = await tasks.transaction(async tx => {
    const task = selectedTask(tx.ledger, jobId), job = activeApplicationJob(tx.domain.snapshot, jobId);
    if (!task) await ready(tx.domain.snapshot, jobId);
    return Object.freeze({ jobId, jobRevision: int(get(job, 'revision'))!.toString(),
      inputRevision: task?.subject.inputRevision ?? preparationScope(tx.domain.snapshot, job),
      taskId: task?.taskId ?? null, taskRevision: task?.revision ?? null });
  });
  let ownedTaskId = scope.taskId;
  let pendingTaskId: string | null = null;
  let finished = false;
  const store: WorkflowTaskStore<ClaimWorkflowDomain> = { transaction: callback => tasks.transaction(async tx => {
    const task = selectedTask(tx.ledger, jobId);
    // A commit can become durable before its response fails. Reconcile only the
    // exact generated task this process attempted; never adopt another task.
    if (ownedTaskId === null && task?.taskId === pendingTaskId
      && task?.subject.inputRevision === scope.inputRevision) ownedTaskId = task.taskId;
    if (task && task.taskId !== ownedTaskId) throw new TaskProtocolError('task_conflict');
    if (ownedTaskId !== null && task === null) finished = true;
    return callback({ ...tx, domain: { ...tx.domain, execute: async (kind, id, revision, token, session, status, saved) => {
      if (id !== jobId) throw new TaskProtocolError('task_conflict');
      if (finished) throw new TaskProtocolError('broker_unavailable');
      if (kind === 'restart') throw new TaskProtocolError('action_unavailable');
      if (kind === 'handoff' && status !== 'needs_info') throw new TaskProtocolError('action_unavailable');
      if (kind === 'acquire') {
        if (ownedTaskId !== null || task !== null) throw new TaskProtocolError('task_conflict');
        const job = activeApplicationJob(tx.domain.snapshot, jobId);
        if (revision.toString() !== scope.jobRevision || int(get(job, 'revision'))!.toString() !== scope.jobRevision
          || preparationScope(tx.domain.snapshot, job) !== scope.inputRevision) throw new TaskProtocolError('stale_revision');
        await ready(tx.domain.snapshot, jobId);
      } else if (!task || task.taskId !== ownedTaskId || task.subject.inputRevision !== scope.inputRevision) {
        throw new TaskProtocolError('task_conflict');
      }
      return tx.domain.execute(kind, id, revision, token, session, status, saved);
    } }, commit: async next => {
      const nextTask = selectedTask(next, jobId);
      if (ownedTaskId !== null && nextTask && nextTask.taskId !== ownedTaskId) throw new TaskProtocolError('task_conflict');
      pendingTaskId = nextTask?.taskId ?? null;
      await tx.commit(next);
      if (nextTask) ownedTaskId = nextTask.taskId;
      else if (ownedTaskId !== null) finished = true;
    } });
  }) };
  return { store, scope };
}
