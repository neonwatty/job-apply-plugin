import { job as decodeJob, type Job } from './contracts';

export type TransitionTarget = 'saved' | 'needs_info' | 'ready' | 'awaiting_review' | 'applied' | 'closed';
export const closedOutcomes = ['rejected', 'withdrawn', 'expired', 'duplicate', 'not_interested'] as const;
const transitions: Record<string, TransitionTarget[]> = {
  saved: ['needs_info', 'ready', 'closed'],
  needs_info: ['saved', 'ready', 'closed'],
  ready: ['saved', 'needs_info', 'closed'],
  in_progress: ['needs_info', 'awaiting_review', 'closed'],
  awaiting_review: ['applied', 'closed'],
  applied: ['closed'],
  closed: ['saved'],
};
export function transitionTargets(job: Job): TransitionTarget[] {
  return job.deletedAt != null || !Object.hasOwn(transitions, job.status) ? [] : [...transitions[job.status]!];
}
export function transitionBody(job: Job, status: string, closedOutcome = '', userConfirmed = false): string {
  if (!job.id) throw Error('The job identity is missing.');
  if (!Number.isSafeInteger(job.revision) || job.revision < 1) throw Error('The job revision is invalid.');
  if (!transitionTargets(job).includes(status as TransitionTarget)) throw Error('This status transition is unavailable.');
  if (status === 'applied' && userConfirmed !== true) throw Error('Confirm that you personally submitted this application.');
  if (status === 'closed' && !closedOutcomes.some(value => value === closedOutcome)) throw Error('Choose a closing outcome.');
  return JSON.stringify({ status, expectedRevision: job.revision,
    ...(status === 'closed' ? { closedOutcome } : {}),
    ...(status === 'applied' ? { userConfirmed: true } : {}),
  });
}
export function transitionConfirmation(job: Job, status: TransitionTarget, closedOutcome = ''): string {
  const local = 'This changes local status only and never submits an application to an employer.';
  if (status === 'applied') return `I confirm that I personally submitted this application. Mark it as applied? ${local}`;
  if (status === 'closed') return `Close this job as ${closedOutcome.replaceAll('_', ' ')}? ${local}`;
  if (status === 'ready') return `Mark this job ready? The workspace will run preflight checks first. ${local}`;
  if (status === 'saved' && job.status === 'closed') return `Reopen this job as saved? ${local}`;
  return `Change this job to ${status.replaceAll('_', ' ')}? ${local}`;
}
export function transitionAcknowledgement(raw: string, previous: Job, status: TransitionTarget): Job {
  const next = decodeJob(JSON.parse(raw));
  if (next.id !== previous.id || next.status !== status || next.revision <= previous.revision)
    throw Error('The transition response did not acknowledge the requested job change.');
  return next;
}
export function transitionFailure(failure: unknown): string {
  const conflict = typeof failure === 'object' && failure !== null && 'status' in failure && failure.status === 409;
  const detail = conflict ? 'This job changed or has an active claim.'
    : failure instanceof Error ? failure.message : 'The status change was not acknowledged.';
  return `${detail} Refresh latest values and review the current status before trying again. Your closing outcome choice is retained.`;
}
