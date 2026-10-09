import type { ApplicationSnapshot } from './application-policy.js';
import type { Document, Value } from './values.js';
export type ClaimWorkflowKind = 'acquire' | 'restart' | 'recover' | 'progress' | 'handoff' | 'cancel';
export interface ClaimWorkflowDomain {
  snapshot: ApplicationSnapshot;
  execute(kind: ClaimWorkflowKind, jobId: string, revision: bigint, token: Value, session?: Document,
    status?: 'needs_info' | 'awaiting_review', savedSessionFingerprint?: string): Promise<Value>;
}
