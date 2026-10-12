import type { ApplicationSnapshot } from '../contracts/workspace/application-policy.js';
import { int, get, type Document } from '../contracts/workspace/values.js';
import { isJobWorkflowTask, TaskProtocolError, type WorkflowLedger } from '../contracts/workspace/workflow-tasks.js';
import { attemptIdentity } from '../workflows/applications/attempt.js';
import { preparationScope } from '../workflows/applications/prepare-scope.js';

/** A reviewed restart must retain the exact completed attempt's canonical inputs. */
export function requireOwnerReviewScope(snapshot: ApplicationSnapshot, ledger: WorkflowLedger,
  job: Document, jobId: string): void {
  const revision = int(get(job, 'revision'))!.toString();
  const candidates = Object.values(ledger.tasks).filter(task => isJobWorkflowTask(task)
    && task.workflow.id === attemptIdentity.id && task.workflow.version === attemptIdentity.version
    && task.status === 'finished' && task.subject.jobId === jobId && task.subject.jobRevision === revision);
  if (ledger.activeTaskId !== null || candidates.length !== 1
    || candidates[0]!.subject.inputRevision !== preparationScope(snapshot, job)) {
    throw new TaskProtocolError('action_unavailable');
  }
}
