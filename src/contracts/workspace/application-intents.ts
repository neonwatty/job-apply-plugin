import { safeId, statuses } from './jobs.js';
import { strip } from './job-url.js';
import { string, JobsError } from './values.js';
import type { Value } from './values.js';

/** Boundary checks shared by commands and trusted workflow inspection. Booleans are host attestations. */
export function requireClaimOwner(value: Value): void {
  const label = string(value);
  if (label === null || !strip(label)) throw new JobsError('owner label must be a non-empty string');
}
export function requireSelectionIntent(confirmed: boolean, expectedRevision: bigint): void {
  if (confirmed !== true) throw new JobsError('task selection requires owner confirmation');
  if (typeof expectedRevision !== 'bigint') throw new JobsError('task selection requires an exact revision');
}
export function requireRestartConfirmation(confirmed: boolean): void {
  if (confirmed !== true) throw new JobsError('review restart requires explicit owner confirmation that the application was not submitted');
}
export function requireJobRevision(expectedRevision: bigint): void {
  if (typeof expectedRevision !== 'bigint' || expectedRevision < 1n) throw new JobsError('job revision is invalid');
}
export function requireHandoffTarget(status: string): void {
  if (!['needs_info', 'awaiting_review'].includes(status)) throw new JobsError('claimed handoff status is unsupported');
}
export function requireTransitionIntent(id: string, status: string, expectedRevision: bigint, userConfirmed: boolean): void {
  safeId(id);
  if (!statuses.has(status)) throw new JobsError('job status is unsupported');
  requireJobRevision(expectedRevision);
  if (typeof userConfirmed !== 'boolean') throw new JobsError('user confirmation must be a boolean');
}
