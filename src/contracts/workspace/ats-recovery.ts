import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';

export interface RecoveryBudget { save: number; afterSignIn: number; refresh: number }
export interface RecoveryEvidence {
  ats: 'workday' | 'other';
  draft: 'present' | 'missing' | 'unknown';
  observation: 'current' | 'stale' | 'unknown';
  session: 'unknown' | 'authenticated' | 'signed_out' | 'reauthenticated';
  failure: 'none' | 'field_validation' | 'unsupported_control' | 'generic_save' | 'page_load';
  refreshApproved: boolean;
}
export interface RecoveryRequest {
  operationId: string; taskId: string; expectedRevision: string; jobId: string; jobRevision: string;
  recoveryRevision: string | null; draftId: string | null;
  mode: 'fresh_draft' | 'decide'; evidence: RecoveryEvidence;
}
export const recoveryActions = ['pause_preserve_draft', 'request_fresh_attempt', 'request_user_sign_in',
  'request_manual_control', 'inspect_field_validation', 'refresh_once', 'request_refresh_approval',
  'inspect_session_separate_tab', 'retry_after_sign_in', 'retry_save_once', 'inspect_existing_draft',
  'draft_registered'] as const;
export type RecoveryAction = typeof recoveryActions[number];
export function recoveryEvidence(raw: unknown): RecoveryEvidence {
  const v = record(snapshot(raw), 'invalid_event');
  exact(v, ['ats', 'draft', 'observation', 'session', 'failure', 'refreshApproved'], 'invalid_event');
  for (const [key, allowed] of Object.entries({ats:['workday','other'], draft:['present','missing','unknown'],
    observation:['current','stale','unknown'], session:['unknown','authenticated','signed_out','reauthenticated'],
    failure:['none','field_validation','unsupported_control','generic_save','page_load']})) {
    requireCondition(allowed.includes(v[key] as string), 'invalid_event');
  }
  requireCondition(typeof v.refreshApproved === 'boolean', 'invalid_event');
  return v as unknown as RecoveryEvidence;
}
export function recoveryBudget(raw: unknown): RecoveryBudget {
  const v = record(snapshot(raw), 'invalid_event');
  exact(v, ['save','afterSignIn','refresh'], 'invalid_event');
  requireCondition(Object.values(v).every(n => n === 0 || n === 1), 'invalid_event');
  return v as unknown as RecoveryBudget;
}
export function recoveryRequest(raw: unknown): RecoveryRequest {
  const v = record(snapshot(raw), 'invalid_event');
  exact(v, ['operationId','taskId','expectedRevision','jobId','jobRevision','recoveryRevision','draftId','mode','evidence'], 'invalid_event');
  requireCondition(v.mode === 'fresh_draft' || v.mode === 'decide', 'invalid_event');
  return {operationId:identifier(v.operationId,'invalid_event'), taskId:identifier(v.taskId,'invalid_event'),
    expectedRevision:revision(v.expectedRevision,'invalid_event'), jobId:identifier(v.jobId,'invalid_event'),
    jobRevision:revision(v.jobRevision,'invalid_event'),
    recoveryRevision:v.recoveryRevision === null ? null : revision(v.recoveryRevision,'invalid_event'),
    draftId:v.draftId === null ? null : identifier(v.draftId,'invalid_event'),
    mode:v.mode, evidence:recoveryEvidence(v.evidence)};
}
export const recoveryNeedsApproval = (r: RecoveryRequest): boolean => r.mode === 'fresh_draft' || r.evidence.refreshApproved;
