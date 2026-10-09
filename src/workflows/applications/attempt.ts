import { WorkflowRegistry } from '../../harness/registry.js';
import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';
import type { ClaimWorkflowKind } from '../../contracts/workspace/claim-workflow-domain.js';
export const attemptIdentity = Object.freeze({id:'application.attempt',version:1});
export const attemptProfile = 'application_attempt';
export interface ClaimEvent {
  kind: ClaimWorkflowKind;
  operationId: string;
  taskId: string | null;
  expectedRevision: string | null;
  jobId: string;
  jobRevision: string;
  session?: unknown;
  savedSessionFingerprint?: string;
  status?: 'needs_info' | 'awaiting_review';
}
const kinds = ['acquire','restart','recover','progress','handoff','cancel'] as const;
export function claimEvent(raw: unknown): ClaimEvent {
  const value = record(snapshot(raw), 'invalid_event');
  requireCondition(kinds.includes(value.kind as ClaimWorkflowKind), 'invalid_event');
  const kind = value.kind as ClaimWorkflowKind;
  const session = ['progress','handoff','cancel'].includes(kind);
  const saved = Object.hasOwn(value, 'savedSessionFingerprint');
  if (saved) {
    requireCondition(kind === 'cancel' || kind === 'handoff' && value.status === 'needs_info', 'invalid_event');
    requireCondition(typeof value.savedSessionFingerprint === 'string'
      && value.savedSessionFingerprint.length === 64 && /^[a-f0-9]{64}$/.test(value.savedSessionFingerprint), 'invalid_event');
  }
  exact(value, ['kind','operationId','taskId','expectedRevision','jobId','jobRevision',
    ...(session ? [saved ? 'savedSessionFingerprint' : 'session'] : []), ...(kind === 'handoff' ? ['status'] : [])], 'invalid_event');
  const fresh = kind === 'acquire' || kind === 'restart';
  if (fresh) requireCondition(value.taskId === null && value.expectedRevision === null, 'invalid_event');
  if (kind === 'handoff') requireCondition(value.status === 'needs_info' || value.status === 'awaiting_review', 'invalid_event');
  if (session && !saved) record(value.session, 'invalid_event');
  return { kind, operationId: identifier(value.operationId, 'invalid_event'),
    taskId: fresh ? null : identifier(value.taskId, 'invalid_event'),
    expectedRevision: fresh ? null : revision(value.expectedRevision, 'invalid_event'),
    jobId: identifier(value.jobId, 'invalid_event'), jobRevision: revision(value.jobRevision, 'invalid_event'),
    ...(saved ? {savedSessionFingerprint:value.savedSessionFingerprint as string} : session ? {session:value.session} : {}), ...(kind === 'handoff' ? {status:value.status as NonNullable<ClaimEvent['status']>} : {}) };
}
export function attemptRegistry(): WorkflowRegistry {
  return new WorkflowRegistry([{id:attemptProfile,tools:kinds.map(kind => ({id:`application.${kind}`,inputSchema:{parse:claimEvent}})),
    limits:{maxSteps:256,maxToolCalls:1,maxChildDepth:0}}],
  [{...attemptIdentity,routeDescription:'One claim-owned attempt ending at a recoverable handoff or manual review.',
    requiredProfiles:[attemptProfile],startInputSchema:{parse:claimEvent},userEventSchema:{parse:claimEvent}}]);
}
export const safeExit = (event: ClaimEvent): boolean => event.kind === 'cancel' || event.kind === 'handoff' && event.status === 'needs_info';
