import { createHash } from 'node:crypto';
import { identifier } from '../../harness/validation.js';
import { canonicalJson } from '../../contracts/workspace/canonical-json.js';
import { copy, fromJSON, get, object, set } from '../../contracts/workspace/values.js';
import { TaskProtocolError } from '../../contracts/workspace/workflow-tasks.js';
import { recoveryLedger, decodeRecoveryLedger, recoveryMetadataKey } from '../../contracts/workspace/ats-recovery-ledger.js';
import { recoveryRequest } from '../../contracts/workspace/ats-recovery.js';
import { atsRecovery, recoveryCounter } from './ats-recovery-policy.js';
export const recoveryFingerprint = (r) => createHash('sha256').update(canonicalJson(fromJSON(r))).digest('hex');
const result = (next, value, replayed = false) => ({
    next, state: value ? structuredClone(value) : null, replayed,
    actionReserved: !replayed && recoveryCounter(next) !== undefined,
    browserMutationAllowed: false, finalSubmissionAllowed: false,
});
/** Called only after broker authority checks. One jobs.json replacement contains
 * both counters and idempotency receipts. No session/browser data is copied.
 */
export function reserveRecovery(jobs, request, freshDraftId) {
    request = recoveryRequest(request);
    const stored = recoveryLedger(jobs), entries = stored.jobs;
    const entry = Object.hasOwn(entries, request.jobId) ? entries[request.jobId] : null;
    const fingerprint = recoveryFingerprint(request);
    const prior = entry && Object.hasOwn(entry.receipts, request.operationId) ? entry.receipts[request.operationId] : null;
    if (prior) {
        if (prior.fingerprint !== fingerprint)
            throw new TaskProtocolError('operation_conflict');
        return { result: result(prior.next, prior.state, true), jobs: null };
    }
    if (request.recoveryRevision !== (entry?.state.revision ?? null)
        || request.draftId !== (entry?.state.draftId ?? null))
        throw new TaskProtocolError('stale_revision');
    let next, current;
    if (request.mode === 'fresh_draft') {
        if (request.evidence.ats !== 'workday' || request.evidence.draft !== 'present'
            || request.evidence.observation !== 'current' || request.evidence.failure !== 'none'
            || request.evidence.refreshApproved)
            throw new TaskProtocolError('action_unavailable');
        identifier(freshDraftId, 'invalid_event');
        current = { draftId: freshDraftId, revision: (BigInt(entry?.state.revision ?? '0') + 1n).toString(),
            ats: 'workday', budget: { save: 0, afterSignIn: 0, refresh: 0 } };
        next = 'draft_registered';
    }
    else {
        const decision = atsRecovery(request.evidence, entry?.state.budget ?? null);
        next = decision.next;
        if (!entry || !recoveryCounter(next))
            return { result: result(next, entry?.state ?? null), jobs: null };
        current = { ...entry.state, revision: (BigInt(entry.state.revision) + 1n).toString(), budget: decision.nextBudget };
    }
    if (Object.keys(entry?.receipts ?? {}).length >= 32 || !entry && Object.keys(entries).length >= 256) {
        throw new TaskProtocolError('history_full');
    }
    const nextLedger = { schemaVersion: 1, jobs: { ...entries, [request.jobId]: { state: current,
                receipts: { ...(entry?.receipts ?? {}), [request.operationId]: { fingerprint, next, state: current } } } } };
    const encoded = fromJSON(nextLedger);
    decodeRecoveryLedger(encoded);
    const updated = copy(jobs);
    set(object(get(updated, 'metadata'), 'metadata'), recoveryMetadataKey, encoded);
    return { result: result(next, current), jobs: updated };
}
