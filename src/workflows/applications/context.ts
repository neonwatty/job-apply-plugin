import { activeApplicationJob, inspectSelection, inspectAcquisition, inspectReviewRestart,
  inspectRecovery, inspectProgress, inspectHandoff, inspectJobTransition, buildJobTransition } from '../../contracts/workspace/application-policy.js';
import type { ApplicationSnapshot } from '../../contracts/workspace/application-policy.js';
import { requireClaimOwner, requireSelectionIntent, requireRestartConfirmation, requireJobRevision,
  requireHandoffTarget, requireTransitionIntent } from '../../contracts/workspace/application-intents.js';
import { safeId } from '../../contracts/workspace/jobs.js';
import { get, int, object, string, JobsError } from '../../contracts/workspace/values.js';
import type { Document, Value } from '../../contracts/workspace/values.js';
import type { AllowedAction } from '../../harness/contracts.js';

/** Already decoded by trusted host composition, not a model-controlled state/consent envelope.
 * Revision and confirmation must retain the scope of the original user intent.
 */
export type ApplicationCandidate =
  | { kind: 'select'; expectedRevision: bigint; ownerConfirmed: boolean }
  | { kind: 'acquire'; expectedRevision: bigint }
  | { kind: 'restart'; expectedRevision: bigint; ownerConfirmedNotSubmitted: boolean }
  | { kind: 'recover' }
  | { kind: 'progress'; incoming: Document }
  | { kind: 'handoff'; expectedRevision: bigint; target: string; incoming: Document }
  | { kind: 'transition'; expectedRevision: bigint; target: string; userConfirmed: boolean; closedOutcome: Value };

/** Broker-held token and label never enter returned context or a model proposal. */
export interface ApplicationInspectionAccess { token: Value; ownerLabel: Value }
export interface ApplicationContext {
  readonly jobId: string;
  readonly jobRevision: string;
  readonly status: string;
  readonly canLeave: boolean;
  readonly allowedActions: readonly AllowedAction[];
  /** Fixed action IDs only: diagnostic exceptions may contain private data. */
  readonly rejectedActionIds: readonly string[];
}

async function inspectCandidate(snapshot: ApplicationSnapshot, id: string, candidate: ApplicationCandidate,
  access: ApplicationInspectionAccess, now: () => string): Promise<void> {
  switch (candidate.kind) {
    case 'select':
      requireSelectionIntent(candidate.ownerConfirmed, candidate.expectedRevision);
      await inspectSelection(snapshot, id, candidate.expectedRevision);
      return;
    case 'acquire':
      requireClaimOwner(access.ownerLabel);
      await inspectAcquisition(snapshot, id, candidate.expectedRevision, now);
      return;
    case 'restart':
      requireRestartConfirmation(candidate.ownerConfirmedNotSubmitted);
      requireClaimOwner(access.ownerLabel);
      requireJobRevision(candidate.expectedRevision);
      await inspectReviewRestart(snapshot, id, candidate.expectedRevision, now);
      return;
    case 'recover':
      requireClaimOwner(access.ownerLabel);
      inspectRecovery(snapshot, id, now);
      return;
    case 'progress':
      await inspectProgress(snapshot, id, access.token, candidate.incoming, now);
      return;
    case 'handoff':
      requireHandoffTarget(candidate.target);
      await inspectHandoff(snapshot, id, access.token, candidate.target, candidate.incoming, candidate.expectedRevision, now);
      return;
    case 'transition': {
      requireTransitionIntent(id, candidate.target, candidate.expectedRevision, candidate.userConfirmed);
      const job = await inspectJobTransition(snapshot, id, candidate.target, candidate.expectedRevision, candidate.userConfirmed);
      buildJobTransition(job, candidate.target, candidate.closedOutcome, now);
      return;
    }
    default:
      throw new TypeError('unsupported application candidate');
  }
}

/** Run inside the canonical read transaction. Actions describe only the supplied candidate payloads.
 * This is an advisory preview, not an execution grant: services recheck policy inside their write
 * transaction. No task persistence, host consent binding, browser action, or final submission here.
 */
export async function applicationContext(snapshot: ApplicationSnapshot, id: string,
  candidates: readonly ApplicationCandidate[], access: ApplicationInspectionAccess,
  now: () => string): Promise<ApplicationContext> {
  safeId(id);
  const job = activeApplicationJob(snapshot, id), revision = int(get(job, 'revision'))!;
  const status = string(get(job, 'status'))!;
  const claim = get(snapshot.coordinator, 'claim');
  const hasClaim = claim !== null && string(get(object(claim, 'claim'), 'jobId')) === id;
  const allowedActions: AllowedAction[] = [], rejectedActionIds: string[] = [], seen = new Set<string>();
  for (const candidate of candidates) {
    // IDs are program-owned. Do not interpolate rejected arguments into diagnostics.
    const actionId = `application.${candidate.kind}`;
    if (seen.has(actionId)) throw new TypeError('duplicate application candidate');
    seen.add(actionId);
    try {
      await inspectCandidate(snapshot, id, candidate, access, now);
      allowedActions.push(Object.freeze({ kind: 'callTool', id: actionId, toolId: actionId }));
    } catch (error) {
      if (!(error instanceof JobsError)) throw error;
      rejectedActionIds.push(actionId);
    }
  }
  return Object.freeze({ jobId: id, jobRevision: revision.toString(), status,
    canLeave: !hasClaim && status !== 'in_progress',
    allowedActions: Object.freeze(allowedActions), rejectedActionIds: Object.freeze(rejectedActionIds) });
}
