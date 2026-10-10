import type { BrowserOperation, BrowserOperationLedger } from '../../contracts/workspace/browser-operations.js';

export interface BrowserOperationHistory {
  operation(id: string): BrowserOperation | null;
}
export interface BrowserOperationArchiveService {
  validate(ledger: BrowserOperationLedger): Promise<void>;
  prepare(ledger: BrowserOperationLedger): Promise<{
    ledger: BrowserOperationLedger;
    history: BrowserOperationHistory;
    flush(): Promise<void>;
  }>;
}
/** Implementations serialize canonical reads and commits. The callback never calls an adapter. */
export interface BrowserOperationTransaction {
  readonly ledger: BrowserOperationLedger;
  readonly history?: BrowserOperationHistory;
  commit(next: BrowserOperationLedger): Promise<void>;
}
export interface BrowserOperationStore {
  transaction<T>(operation: (transaction: BrowserOperationTransaction) => Promise<T>): Promise<T>;
}
export function browserOperationHistory(tx: BrowserOperationTransaction): BrowserOperationHistory {
  return tx.history ?? { operation: id => Object.hasOwn(tx.ledger.operations, id) ? tx.ledger.operations[id]! : null };
}
