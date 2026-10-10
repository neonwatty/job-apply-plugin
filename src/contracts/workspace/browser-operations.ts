import { exact, identifier, record, snapshot } from '../../harness/validation.js';
import { BrowserBoundaryError, browserMutation, requestFingerprint } from './browser-boundary.js';
import type { BrowserMutation, BrowserReceipt } from './browser-boundary.js';
import { fromJSON, serialize } from './values.js';
import type { Value } from './values.js';

export const browserOperationsMetadataKey = 'durableBrowserOperations';
export const browserOperationLimit = 64;
export const browserOperationCodeUnitLimit = 1024 * 1024;
export type BrowserOperationState = 'pending' | 'uncertain' | 'verified' | 'rejected';
export interface BrowserOperation {
  readonly request: BrowserMutation;
  readonly fingerprint: string;
  readonly state: BrowserOperationState;
  readonly receipt: BrowserReceipt;
}
export interface BrowserOperationLedger {
  readonly schemaVersion: 1;
  readonly operations: Readonly<Record<string, BrowserOperation>>;
}
export const unresolvedBrowserOperation = (operation: BrowserOperation): boolean =>
  operation.state === 'pending' || operation.state === 'uncertain';
const invalid = (): never => { throw new BrowserBoundaryError('invalid_browser_state'); };
function receipt(raw: unknown, operationId: string, state: BrowserOperationState): BrowserReceipt {
  const value = record(raw, 'invalid_arguments');
  exact(value, ['operationId', 'status', 'evidenceKind', 'reason'], 'invalid_arguments');
  if (value.operationId !== operationId || value.evidenceKind !== 'synthetic_adapter') return invalid();
  const valid = state === 'verified'
    ? value.status === 'verified' && value.reason === 'readback_matched'
    : state === 'rejected'
      ? value.status === 'not_applied' && typeof value.reason === 'string'
        && ['scope_changed', 'control_unavailable', 'authority_denied'].includes(value.reason)
      : value.status === 'uncertain' && value.reason === 'reconciliation_required';
  if (!valid) return invalid();
  return Object.freeze(value) as unknown as BrowserReceipt;
}
export function validateBrowserOperationLedger(raw: unknown): BrowserOperationLedger {
  try {
    const value = record(snapshot(raw, 0, { nodes: 10000, characters: browserOperationCodeUnitLimit }), 'invalid_arguments');
    exact(value, ['schemaVersion', 'operations'], 'invalid_arguments');
    if (value.schemaVersion !== 1) return invalid();
    const entries = record(value.operations, 'invalid_arguments');
    if (Object.keys(entries).length > browserOperationLimit) return invalid();
    const operations: Record<string, BrowserOperation> = Object.create(null) as Record<string, BrowserOperation>;
    let unresolved = 0;
    for (const [operationId, rawEntry] of Object.entries(entries)) {
      identifier(operationId, 'invalid_arguments');
      const entry = record(rawEntry, 'invalid_arguments');
      exact(entry, ['request', 'fingerprint', 'state', 'receipt'], 'invalid_arguments');
      const request = browserMutation(entry.request);
      if (request.operationId !== operationId || entry.fingerprint !== requestFingerprint(request)
        || typeof entry.state !== 'string' || !['pending', 'uncertain', 'verified', 'rejected'].includes(entry.state)) return invalid();
      const state = entry.state as BrowserOperationState;
      const operation = Object.freeze({ request, fingerprint: entry.fingerprint as string, state,
        receipt: receipt(entry.receipt, operationId, state) });
      if (unresolvedBrowserOperation(operation)) unresolved++;
      operations[operationId] = operation;
    }
    if (unresolved > 1 || JSON.stringify(value).length > browserOperationCodeUnitLimit) return invalid();
    return Object.freeze({ schemaVersion: 1, operations: Object.freeze(operations) });
  } catch { return invalid(); }
}
export function emptyBrowserOperationLedger(): BrowserOperationLedger {
  return validateBrowserOperationLedger({ schemaVersion: 1, operations: {} });
}
export function decodeBrowserOperationLedger(value: Value): BrowserOperationLedger {
  try { return validateBrowserOperationLedger(JSON.parse(serialize(value)) as unknown); }
  catch { return invalid(); }
}
export const encodeBrowserOperationLedger = (value: BrowserOperationLedger): Value =>
  fromJSON(validateBrowserOperationLedger(value));

/** A commit changes one operation, never erases a replay fence or replaces immutable input. */
export function validateBrowserOperationTransition(previous: BrowserOperationLedger, next: BrowserOperationLedger): void {
  validateBrowserOperationLedger(previous);
  validateBrowserOperationLedger(next);
  let changed = 0;
  for (const [id, before] of Object.entries(previous.operations)) {
    const after = next.operations[id];
    if (!after || before.fingerprint !== after.fingerprint) return invalid();
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    changed++;
    if (!unresolvedBrowserOperation(before) || after.state === 'pending') return invalid();
  }
  for (const [id, operation] of Object.entries(next.operations)) if (!Object.hasOwn(previous.operations, id)) {
    changed++;
    if (operation.state !== 'pending' || Object.values(previous.operations).some(unresolvedBrowserOperation)) return invalid();
  }
  if (changed !== 1) return invalid();
}
