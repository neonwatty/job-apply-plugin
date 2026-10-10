import { WorkflowRegistry } from '../../harness/registry.js';
import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';
import type { AllowedAction } from '../../harness/contracts.js';
import type { JobWorkflowTask } from '../../contracts/workspace/workflow-tasks.js';

export const preparationIdentity = Object.freeze({ id: 'application.prepare', version: 1 });
export const preparationProfile = 'application_preparation';
export const confirmationQuestion = 'confirm_job_selection';
export const selectionConfirmation = Object.freeze({
  questionId: confirmationQuestion, confirmOutcome: 'job_ready', declineOutcome: 'declined',
  prompt: 'Confirm saving this job selection as Ready? Confirm marks the job Ready; decline cancels this pending preparation. Filling and submission will not start.',
});
export interface PreparationInput { jobId: string; jobRevision: string }
export interface PreparationReply { requestId: string; jobRevision: string; decision: 'confirm' | 'decline' }
export function preparationInput(raw: unknown): PreparationInput {
  const value = record(snapshot(raw), 'invalid_arguments');
  exact(value, ['jobId', 'jobRevision'], 'invalid_arguments');
  return Object.freeze({ jobId: identifier(value.jobId, 'invalid_arguments'), jobRevision: revision(value.jobRevision, 'invalid_arguments') });
}
export function preparationReply(raw: unknown): PreparationReply {
  const value = record(snapshot(raw), 'invalid_event');
  exact(value, ['requestId', 'jobRevision', 'decision'], 'invalid_event');
  requireCondition(value.decision === 'confirm' || value.decision === 'decline', 'invalid_event');
  return Object.freeze({ requestId: identifier(value.requestId, 'invalid_event'),
    jobRevision: revision(value.jobRevision, 'invalid_event'), decision: value.decision });
}
export function preparationRegistry(): WorkflowRegistry {
  return new WorkflowRegistry([{ id: preparationProfile,
    tools: [{ id: 'application.select', inputSchema: { parse: preparationInput } }],
    limits: { maxSteps: 3, maxToolCalls: 1, maxChildDepth: 0 } }],
  [{ ...preparationIdentity, routeDescription: 'Prepare one exact job for an application attempt after a scoped owner reply.',
    requiredProfiles: [preparationProfile], startInputSchema: { parse: preparationInput }, userEventSchema: { parse: preparationReply } }]);
}
export function preparationActions(task: JobWorkflowTask, canLeave: boolean, jobRevision: string | null, inputRevision: string | null): readonly AllowedAction[] {
  return task.status === 'active' && canLeave && task.subject.jobRevision === jobRevision && task.subject.inputRevision === inputRevision
    ? [Object.freeze({ kind: 'askUser', id: 'application.confirm_selection', questionId: confirmationQuestion })] : [];
}
