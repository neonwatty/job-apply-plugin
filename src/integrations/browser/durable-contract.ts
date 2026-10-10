import type { BrowserOperationLedger } from '../../contracts/workspace/browser-operations.js';

/** Implementations serialize canonical reads and commits. The callback never calls an adapter. */
export interface BrowserOperationTransaction {
  readonly ledger: BrowserOperationLedger;
  commit(next: BrowserOperationLedger): Promise<void>;
}
export interface BrowserOperationStore {
  transaction<T>(operation: (transaction: BrowserOperationTransaction) => Promise<T>): Promise<T>;
}
