export interface BrowserRecoveryGuidance {
  status: 'ready' | 'reconciliation_required' | 'capacity_reached';
  hotOperationCount: number;
  archivedOperationCount: number;
  archiveSegmentsRemaining: number;
  unresolvedOperationId: string | null;
  nextAction: 'continue' | 'reconcile_or_handoff' | 'handoff_capacity';
}

/** Display-only state. It grants no browser or workflow authority. */
export type BrowserRecoveryProjection =
  | { available: false; reason: 'unsupported_store' }
  | { available: true; guidance: Omit<BrowserRecoveryGuidance, 'unresolvedOperationId'> };
