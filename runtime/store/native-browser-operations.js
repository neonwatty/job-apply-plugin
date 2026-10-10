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
    transaction(operation) {
        return this.repository.claimTransaction(async (original) => {
            const jobs = object(parse(serialize(original.jobs)), 'staged jobs');
            const metadata = object(get(jobs, 'metadata'), 'jobs metadata');
            const ledger = has(metadata, browserOperationsMetadataKey)
                ? decodeBrowserOperationLedger(get(metadata, browserOperationsMetadataKey)) : emptyBrowserOperationLedger();
            let committed = false;
            return operation({ ledger, commit: async (next) => {
                    if (committed)
                        throw new BrowserBoundaryError('invalid_browser_state');
                    validateBrowserOperationTransition(ledger, next);
                    set(metadata, browserOperationsMetadataKey, encodeBrowserOperationLedger(next));
                    committed = true;
                    await original.saveJobs(jobs);
                } });
        });
    }
}
