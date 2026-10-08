import { createHash } from 'node:crypto';
import { canonicalJson } from './canonical-json.js';
import { decodeWorkflowLedger, encodeWorkflowLedger, workflowMetadataKey } from './workflow-tasks.js';
import { fromJSON, get, has, keys, object, set, string, JobsError } from './values.js';
import type { Document } from './values.js';
import type { WorkflowLedger } from './workflow-tasks.js';

export function workflowFingerprint(jobs: Document): string {
  const metadata = object(get(jobs, 'metadata'), 'metadata');
  return createHash('sha256').update(canonicalJson(get(metadata, workflowMetadataKey))).digest('hex');
}
export function workflowCommit(jobs: Document, ledger: WorkflowLedger): Document {
  return object(fromJSON({ before: workflowFingerprint(jobs), after: ledger }), 'workflow commit');
}
export function validateWorkflowCommit(operation: Document): void {
  const value = object(get(operation, 'workflow'), 'workflow commit');
  if (keys(value).sort().join(',') !== 'after,before' || !/^[a-f0-9]{64}$/.test(string(get(value, 'before')) ?? '')) {
    throw new JobsError('invalid workflow journal');
  }
  decodeWorkflowLedger(get(value, 'after'));
}
/** Apply the ledger only to its exact predecessor, or recognize its already committed result. */
export function projectWorkflowCommit(operation: Document, jobs: Document): boolean {
  if (!has(operation, 'workflow')) return false;
  validateWorkflowCommit(operation);
  const value = object(get(operation, 'workflow'), 'workflow commit');
  const after = encodeWorkflowLedger(decodeWorkflowLedger(get(value, 'after')));
  const digest = createHash('sha256').update(canonicalJson(after)).digest('hex');
  const current = workflowFingerprint(jobs);
  if (current === digest) return false;
  if (current !== string(get(value, 'before'))) throw new JobsError('workflow journal predecessor changed');
  set(object(get(jobs, 'metadata'), 'metadata'), workflowMetadataKey, after);
  return true;
}
