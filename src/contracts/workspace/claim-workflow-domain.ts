import type { RecoveryRequest } from './ats-recovery.js';
import type { RecoveryResult } from './ats-recovery-ledger.js';
import type { BrowserMutation } from './browser-boundary.js';
import type { BrowserValueGrant } from './browser-authority.js';
import type { ApplicationSnapshot } from './application-policy.js';
import type { Document, Value } from './values.js';
export type ClaimWorkflowKind = 'acquire' | 'restart' | 'recover' | 'progress' | 'handoff' | 'cancel';
export interface ClaimWorkflowDomain {
  reserveRecovery?(request: RecoveryRequest, token: Value): Promise<{result: RecoveryResult; changed: boolean}>;
  checkBrowserAuthority?(request: BrowserMutation, grant: BrowserValueGrant, token: Value): Promise<boolean>;
  snapshot: ApplicationSnapshot & { authority: Document };
  execute(kind: ClaimWorkflowKind, jobId: string, revision: bigint, token: Value, session?: Document,
    status?: 'needs_info' | 'awaiting_review', savedSessionFingerprint?: string): Promise<Value>;
}
