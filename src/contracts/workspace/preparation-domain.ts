import type { ApplicationSnapshot } from './application-policy.js';
/** Preparation operations are staged in the caller's transaction; selection repeats canonical guards. */
export interface PreparationDomain {
  snapshot: ApplicationSnapshot;
  select(id: string, expectedRevision: bigint): Promise<void>;
}
