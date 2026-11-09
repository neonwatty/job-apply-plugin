import { exact } from './automation.js';
import { fromJSON, get, int, object, string, JobsError } from './values.js';
const stages = new Set(['prepared', 'credential_provisioned', 'signup_in_progress']);
const outcomes = new Set([
    'success', 'reuse', 'verification', 'challenge', 'consent', 'reset',
    'definitive_failure', 'ambiguity', 'observed_pending',
]);
const operationFields = [
    'operationId', 'jobId', 'jobRevision', 'claimId', 'realmRef',
    'accountRevision', 'settingsRevision', 'stage', 'outcomeCode', 'startedAt',
];
export function emptyAccountOperationJournal() {
    return object(fromJSON({ schemaVersion: 1, operation: null }), 'account operation journal');
}
export function validateAccountOperationJournal(value) {
    const journal = object(value, 'account operation journal');
    exact(journal, ['schemaVersion', 'operation'], 'account operation journal contains unsupported fields');
    if (int(get(journal, 'schemaVersion')) !== 1n)
        throw new JobsError('account operation journal schema version is unsupported');
    const raw = get(journal, 'operation');
    if (raw === null)
        return journal;
    const operation = object(raw, 'account operation journal operation');
    exact(operation, operationFields, 'account operation journal is invalid');
    for (const field of ['operationId', 'jobId', 'claimId', 'realmRef', 'stage', 'outcomeCode', 'startedAt']) {
        if (!string(get(operation, field)))
            throw new JobsError('account operation journal binding is invalid');
    }
    for (const field of ['jobRevision', 'accountRevision', 'settingsRevision']) {
        const revision = int(get(operation, field));
        if (revision === null || revision < 1n)
            throw new JobsError('account operation journal revision is invalid');
    }
    if (!stages.has(string(get(operation, 'stage'))))
        throw new JobsError('account operation journal stage is invalid');
    if (!outcomes.has(string(get(operation, 'outcomeCode'))))
        throw new JobsError('account operation journal outcome is invalid');
    return journal;
}
export function accountOperation(value) {
    const raw = get(validateAccountOperationJournal(value), 'operation');
    return raw === null ? null : object(raw, 'account operation');
}
