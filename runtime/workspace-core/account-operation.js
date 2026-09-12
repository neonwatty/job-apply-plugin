import { randomUUID } from 'node:crypto';
import { publicAccount, validateAccountsDocument } from '../contracts/workspace/accounts.js';
import { accountOperation } from '../contracts/workspace/account-operation.js';
import { buildClaimSession } from '../contracts/workspace/claim-session.js';
import { claimExpired, validateCoordinator } from '../contracts/workspace/claims.js';
import { safeId, validateJobsDocument } from '../contracts/workspace/jobs.js';
import { copy, fromJSON, get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
const doc = (value) => object(fromJSON(value), 'account operation result');
function activeJob(jobs, id) {
    safeId(id);
    const raw = get(object(get(jobs, 'jobs'), 'jobs'), id);
    if (raw === null || get(object(raw, 'job'), 'deletedAt') !== null)
        throw new JobsError('account operation job is unavailable');
    return object(raw, 'job');
}
function handoffOperation(job, session, at) {
    const operationId = randomUUID(), id = string(get(job, 'id'));
    const event = doc({ schemaVersion: 1, eventId: `coordinator-${operationId}`, applicationId: id,
        event: 'job-blocked', status: 'needs_info', answerKeys: [], at });
    for (const field of ['company', 'role', 'ats'])
        if (string(get(job, field)) !== null)
            set(event, field, get(job, field));
    const result = doc({ kind: 'handoff', operationId, jobId: id, sourceStatus: 'in_progress',
        targetStatus: 'needs_info', expectedRevision: null, at, resultClaim: null });
    set(result, 'expectedRevision', get(job, 'revision'));
    set(result, 'historyEvent', event);
    return set(result, 'session', session);
}
export class AccountOperationService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    status() {
        return this.repository.accountOperationTransaction(async (tx) => {
            const operation = accountOperation(tx.journal);
            if (operation === null)
                return fromJSON({ status: 'idle', operation: null });
            return fromJSON({ status: 'recovery_required', operation: {
                    operationId: string(get(operation, 'operationId')), jobId: string(get(operation, 'jobId')),
                    realmRef: string(get(operation, 'realmRef')), stage: string(get(operation, 'stage')),
                    outcomeCode: string(get(operation, 'outcomeCode')),
                } });
        });
    }
    recover() {
        return this.repository.accountOperationTransaction(async (tx) => {
            const operation = accountOperation(tx.journal);
            if (operation === null)
                return fromJSON({ status: 'idle', recovered: false });
            const realm = string(get(operation, 'realmRef')), accounts = validateAccountsDocument(tx.accounts);
            const records = object(get(accounts, 'accounts'), 'employer accounts');
            const rawAccount = get(records, realm);
            if (rawAccount === null)
                throw new JobsError('account operation realm is unavailable');
            let account = object(rawAccount, 'employer account');
            if (string(get(account, 'lifecycleState')) !== 'ambiguous') {
                account = copy(account);
                set(account, 'lifecycleState', text('ambiguous'));
                set(account, 'revision', integer(int(get(account, 'revision')) + 1n));
                set(account, 'updatedAt', text(this.now()));
                set(records, realm, account);
                set(object(get(accounts, 'metadata'), 'employer account metadata'), 'updatedAt', get(account, 'updatedAt'));
                await tx.saveAccounts(validateAccountsDocument(accounts));
            }
            const job = activeJob(validateJobsDocument(tx.jobs), string(get(operation, 'jobId')));
            let recoveredJob = null;
            if (string(get(job, 'status')) === 'in_progress') {
                const coordinator = validateCoordinator(tx.coordinator), rawClaim = get(coordinator, 'claim');
                if (rawClaim === null)
                    throw new JobsError('account operation recovery requires a live same-job claim');
                const claim = object(rawClaim, 'claim');
                if (string(get(claim, 'jobId')) !== string(get(job, 'id')) || claimExpired(claim, this.now())) {
                    throw new JobsError('account operation recovery requires a live same-job claim');
                }
                const now = this.now();
                const incoming = doc({ status: 'active', step: 'account_automation_denied:ambiguous_recovery',
                    answerKeys: [], pendingFields: [], blockers: [{ type: 'browser_handoff', code: 'browser-state-uncertain' }],
                    browserHandoff: { state: 'required', reasonCode: 'browser-state-uncertain', revision: 1 } });
                const id = string(get(job, 'id'));
                const session = buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
                    existing: tx.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null, answers: tx.answers });
                await tx.commitClaim(handoffOperation(job, session, now));
                recoveredJob = doc({ id, status: 'needs_info', revision: null });
                set(recoveredJob, 'revision', integer(int(get(job, 'revision')) + 1n));
            }
            else if (string(get(job, 'status')) !== 'needs_info')
                throw new JobsError('account operation job cannot be reconciled');
            await tx.clearOperation(string(get(operation, 'operationId')));
            const result = doc({ status: 'ambiguous', recovered: true, retryAllowed: false });
            set(result, 'account', publicAccount(account));
            if (recoveredJob !== null)
                set(result, 'job', recoveredJob);
            return result;
        });
    }
}
