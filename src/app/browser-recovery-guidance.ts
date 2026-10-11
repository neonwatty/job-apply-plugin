import { browserArchiveSegmentLimit } from '../contracts/workspace/browser-operation-archive.js';
import { browserOperationCodeUnitLimit, browserOperationLimit, unresolvedBrowserOperation,
  validateBrowserOperationLedger } from '../contracts/workspace/browser-operations.js';
import type { BrowserOperationLedger } from '../contracts/workspace/browser-operations.js';
import type { BrowserRecoveryGuidance } from '../contracts/workspace/browser-recovery.js';

/** A public summary only; callers validate referenced archives before exposing native Store state. */
export function browserRecoveryGuidance(value: BrowserOperationLedger): BrowserRecoveryGuidance {
  const ledger = validateBrowserOperationLedger(value);
  const entries = Object.entries(ledger.operations);
  const unresolvedOperationId = entries.find(([, item]) => unresolvedBrowserOperation(item))?.[0] ?? null;
  const segments = ledger.schemaVersion === 2 ? ledger.archive.segments : [];
  const archiveSegmentsRemaining = browserArchiveSegmentLimit - segments.length;
  const atCapacity = archiveSegmentsRemaining === 0 && (entries.length >= browserOperationLimit
    || JSON.stringify(ledger).length + 64 >= browserOperationCodeUnitLimit);
  return {
    status: unresolvedOperationId !== null ? 'reconciliation_required' : atCapacity ? 'capacity_reached' : 'ready',
    hotOperationCount: entries.length,
    archivedOperationCount: segments.reduce((count, segment) => count + segment.operationCount, 0),
    archiveSegmentsRemaining,
    unresolvedOperationId,
    nextAction: unresolvedOperationId !== null ? 'reconcile_or_handoff' : atCapacity ? 'handoff_capacity' : 'continue',
  };
}
