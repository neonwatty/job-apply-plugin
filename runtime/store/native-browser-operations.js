import { get, has, object, parse, serialize, set } from '../contracts/workspace/values.js';
import { BrowserBoundaryError } from '../contracts/workspace/browser-boundary.js';
import { browserOperationsMetadataKey, decodeBrowserOperationLedger, emptyBrowserOperationLedger, encodeBrowserOperationLedger, validateBrowserOperationTransition } from '../contracts/workspace/browser-operations.js';
/** Durable intent and receipt replacements use the same canonical Store lock as claims.
 * No adapter/authority callback runs in this transaction; only closed ledger transitions do.
 */
export class NativeBrowserOperations {
    repository;
    constructor(repository) {
        this.repository = repository;
    }
    /** Inspection reports committed counts, without staging an archive rollover. */
    inspect() {
        return this.repository.claimTransaction(async (tx) => {
            const metadata = object(get(tx.jobs, 'metadata'), 'jobs metadata');
            const ledger = has(metadata, browserOperationsMetadataKey)
                ? decodeBrowserOperationLedger(get(metadata, browserOperationsMetadataKey)) : emptyBrowserOperationLedger();
            if (ledger.schemaVersion === 2 && !tx.browserArchive) {
                throw new BrowserBoundaryError('invalid_browser_state');
            }
            await tx.browserArchive?.validate(ledger);
            return ledger;
        });
    }
    transaction(operation) {
        return this.repository.claimTransaction(async (original) => {
            const jobs = object(parse(serialize(original.jobs)), 'staged jobs');
            const metadata = object(get(jobs, 'metadata'), 'jobs metadata');
            const storedLedger = has(metadata, browserOperationsMetadataKey)
                ? decodeBrowserOperationLedger(get(metadata, browserOperationsMetadataKey)) : emptyBrowserOperationLedger();
            if (storedLedger.schemaVersion === 2 && !original.browserArchive) {
                throw new BrowserBoundaryError('invalid_browser_state');
            }
            const prepared = await original.browserArchive?.prepare(storedLedger);
            const ledger = prepared?.ledger ?? storedLedger;
            let committed = false;
            return operation({ ledger, ...(prepared ? { history: prepared.history } : {}), commit: async (next) => {
                    if (committed)
                        throw new BrowserBoundaryError('invalid_browser_state');
                    validateBrowserOperationTransition(ledger, next);
                    for (const id of Object.keys(next.operations)) {
                        if (!Object.hasOwn(ledger.operations, id) && prepared?.history.operation(id)) {
                            throw new BrowserBoundaryError('operation_conflict');
                        }
                    }
                    set(metadata, browserOperationsMetadataKey, encodeBrowserOperationLedger(next));
                    committed = true;
                    await prepared?.flush();
                    await original.saveJobs(jobs);
                } });
        });
    }
}
