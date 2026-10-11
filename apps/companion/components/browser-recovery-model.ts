export type BrowserRecoveryGuidance = {
  status: 'ready' | 'reconciliation_required' | 'capacity_reached';
  hotOperationCount: number;
  archivedOperationCount: number;
  archiveSegmentsRemaining: number;
  nextAction: 'continue' | 'reconcile_or_handoff' | 'handoff_capacity';
};
export type BrowserRecoveryProjection =
  | { available: true; guidance: BrowserRecoveryGuidance }
  | { available: false; reason: 'unsupported_store' };

function invalid(): never {
  throw Error('The workspace returned an invalid browser recovery response.');
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Pick only public counts and closed guidance; never carry operation or claim identities into the UI. */
export function browserRecoveryProjection(raw: string): BrowserRecoveryProjection {
  const value: unknown = JSON.parse(raw);
  if (!record(value)) invalid();
  if (value.available === false && value.reason === 'unsupported_store') {
    return { available: false, reason: 'unsupported_store' };
  }
  if (value.available !== true || !record(value.guidance)) invalid();
  const guidance = value.guidance;
  const { status, hotOperationCount, archivedOperationCount, archiveSegmentsRemaining, nextAction } = guidance;
  if (!count(hotOperationCount) || !count(archivedOperationCount) || !count(archiveSegmentsRemaining)) invalid();
  if (status === 'ready' && nextAction === 'continue'
    || status === 'reconciliation_required' && nextAction === 'reconcile_or_handoff'
    || status === 'capacity_reached' && nextAction === 'handoff_capacity') {
    return { available: true, guidance: {
      status, hotOperationCount, archivedOperationCount, archiveSegmentsRemaining, nextAction,
    } };
  }
  return invalid();
}
