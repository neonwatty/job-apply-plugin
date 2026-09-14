import { randomUUID } from 'node:crypto';
import { emailFlow, resolveAccountRealm } from '../contracts/workspace/account-realm.js';
import { publicAccount, validateAccount, validateAccountsDocument } from '../contracts/workspace/accounts.js';
import { accountOperation } from '../contracts/workspace/account-operation.js';
import { validateSettingsDocument } from '../contracts/workspace/automation.js';
import { buildClaimSession } from '../contracts/workspace/claim-session.js';
import { claimExpired, validateCoordinator } from '../contracts/workspace/claims.js';
import { validateEmailOnlyAccountRequest, validateEmailOnlyAccountResult } from '../contracts/workspace/email-only-account.js';
import { safeId, validateJobsDocument } from '../contracts/workspace/jobs.js';
import { copy, fromJSON, get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
const doc = (value) => object(fromJSON(value), 'email-only account value');
function liveJob(tx, request, now) {
    const id = safeId(string(get(request, 'jobId'))), jobs = validateJobsDocument(tx.jobs);
    const raw = get(object(get(jobs, 'jobs'), 'jobs'), id);
    if (raw === null)
        throw new JobsError('email-only execution requires the exact live claimed job');
    const job = object(raw, 'job'), rawClaim = get(validateCoordinator(tx.coordinator), 'claim');
    if (rawClaim === null)
        throw new JobsError('email-only execution requires the exact live claimed job');
    const claim = object(rawClaim, 'claim');
    if (get(job, 'deletedAt') !== null || string(get(job, 'status')) !== 'in_progress'
        || int(get(job, 'revision')) !== int(get(request, 'jobRevision'))
        || string(get(claim, 'jobId')) !== id || string(get(claim, 'claimId')) !== string(get(request, 'expectedClaimId'))
        || claimExpired(claim, now))
        throw new JobsError('email-only execution requires the exact live claimed job');
    return job;
}
function handoff(job, session, at) {
    const operationId = randomUUID(), id = string(get(job, 'id'));
    const event = doc({ schemaVersion: 1, eventId: `coordinator-${operationId}`, applicationId: id,
        event: 'job-blocked', status: 'needs_info', answerKeys: [], at });
    for (const field of ['company', 'role', 'ats'])
        if (string(get(job, field)) !== null)
            set(event, field, get(job, field));
    const operation = doc({ kind: 'handoff', operationId, jobId: id, sourceStatus: 'in_progress',
        targetStatus: 'needs_info', expectedRevision: null, at, resultClaim: null });
    set(operation, 'expectedRevision', get(job, 'revision'));
    set(operation, 'historyEvent', event);
    return set(operation, 'session', session);
}
async function attention(tx, job, reason, now) {
    const code = reason === 'verification_required' ? 'mfa-required' : 'browser-state-uncertain';
    const id = string(get(job, 'id')), incoming = doc({ status: 'active', step: `account_automation_denied:${reason}`,
        answerKeys: [], pendingFields: [], blockers: [{ type: 'browser_handoff', code }],
        browserHandoff: { state: 'required', reasonCode: code, revision: 1 } });
    const session = buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
        existing: tx.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null, answers: tx.answers });
    await tx.commitClaim(handoff(job, session, now));
    const result = doc({ id, status: 'needs_info', revision: null });
    set(result, 'revision', integer(int(get(job, 'revision')) + 1n));
    return result;
}
async function writeStage(tx, account, operation, lifecycle, stage, at) {
    const accounts = validateAccountsDocument(tx.accounts), records = object(get(accounts, 'accounts'), 'accounts');
    const current = object(get(records, string(get(account, 'realmRef'))), 'employer account');
    if (int(get(current, 'revision')) !== int(get(account, 'revision')))
        throw new JobsError('employer account revision conflict');
    const updated = copy(current);
    set(updated, 'lifecycleState', text(lifecycle));
    set(updated, 'revision', integer(int(get(current, 'revision')) + 1n));
    set(updated, 'updatedAt', text(at));
    validateAccount(string(get(updated, 'realmRef')), updated);
    set(records, string(get(updated, 'realmRef')), updated);
    set(object(get(accounts, 'metadata'), 'account metadata'), 'updatedAt', get(updated, 'updatedAt'));
    await tx.saveAccounts(accounts);
    const next = copy(operation);
    set(next, 'stage', text(stage));
    set(next, 'accountRevision', get(updated, 'revision'));
    await tx.saveOperation(string(get(operation, 'operationId')), next);
    return { account: updated, operation: next };
}
export class EmailOnlyAccountService {
    repository;
    executor;
    now;
    constructor(repository, executor, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.executor = executor;
        this.now = now;
    }
    async execute(value) {
        const request = validateEmailOnlyAccountRequest(value);
        if (!this.executor || this.executor.providerId !== 'synthetic-email-only') {
            throw new JobsError('synthetic email-only provider is test-only');
        }
        const executor = this.executor;
        return this.repository.accountOperationTransaction(async (tx) => {
            if (accountOperation(tx.journal) !== null)
                throw new JobsError('account operation requires explicit recovery');
            const now = this.now(), job = liveJob(tx, request, now), realm = resolveAccountRealm(string(get(job, 'url')));
            if (realm.status !== 'resolved' || realm.adapterId !== 'oracle-recruiting' || realm.flowKind !== emailFlow
                || realm.realmRef !== string(get(request, 'realmRef')) || realm.descriptor !== string(get(request, 'realmDescriptor'))) {
                throw new JobsError('email-only execution realm binding mismatch');
            }
            const settings = object(get(validateSettingsDocument(tx.settings), 'settings'), 'automation settings');
            const accounts = validateAccountsDocument(tx.accounts), raw = get(object(get(accounts, 'accounts'), 'accounts'), realm.realmRef);
            if (raw === null)
                throw new JobsError('employer account does not exist');
            let account = object(raw, 'employer account');
            if (int(get(account, 'revision')) !== int(get(request, 'accountRevision'))
                || int(get(settings, 'revision')) !== int(get(request, 'settingsRevision')))
                throw new JobsError('email-only execution revision conflict');
            if (get(settings, 'enabled') !== true || get(settings, 'automaticAccountCreation') !== true)
                throw new JobsError('account automation is disabled');
            if (string(get(account, 'flowKind')) !== emailFlow || get(account, 'credentialRequired') !== false)
                throw new JobsError('email-only account metadata is invalid');
            if (get(account, 'providerId') !== null || get(account, 'credentialRef') !== null || get(account, 'credentialVersion') !== null) {
                throw new JobsError('email-only execution forbids credential metadata');
            }
            if (string(get(account, 'lifecycleState')) !== 'discovered')
                throw new JobsError('email-only account cannot be attempted again');
            const effectiveEmail = string(get(account, 'signupEmailOverride')) ?? string(get(settings, 'signupEmail'));
            if (!effectiveEmail)
                throw new JobsError('effective signup email is required');
            let operation = doc({ operationId: randomUUID(), jobId: string(get(job, 'id')), jobRevision: null,
                claimId: string(get(object(get(validateCoordinator(tx.coordinator), 'claim'), 'claim'), 'claimId')), realmRef: realm.realmRef,
                accountRevision: null, settingsRevision: null, stage: 'prepared', outcomeCode: 'observed_pending', startedAt: now });
            set(operation, 'jobRevision', get(job, 'revision'));
            set(operation, 'accountRevision', get(account, 'revision'));
            set(operation, 'settingsRevision', get(settings, 'revision'));
            await tx.saveOperation(null, operation);
            ({ account, operation } = await writeStage(tx, account, operation, 'signup_in_progress', 'signup_in_progress', now));
            let result;
            try {
                result = validateEmailOnlyAccountResult(await executor.execute(request, () => effectiveEmail), executor.providerId);
            }
            catch {
                ({ account, operation } = await writeStage(tx, account, operation, 'ambiguous', 'signup_in_progress', now));
                const denied = await attention(tx, job, 'ambiguous', now);
                await tx.clearOperation(string(get(operation, 'operationId')));
                const response = doc({ authorized: false, reasonCode: 'ambiguous', retryAllowed: false,
                    attentionHandoff: true, finalActionAuthorized: false, credentialProviderInvocations: 0,
                    account: null, job: null });
                set(response, 'account', publicAccount(account));
                set(response, 'job', denied);
                return response;
            }
            const lifecycle = string(get(result, 'outcome'));
            ({ account, operation } = await writeStage(tx, account, operation, lifecycle, 'signup_in_progress', now));
            const needsAttention = lifecycle !== 'active';
            const response = doc({ authorized: !needsAttention, reasonCode: lifecycle, retryAllowed: false,
                attentionHandoff: needsAttention, finalActionAuthorized: false, emailRemoved: true,
                termsAccepted: true, nextActivations: 1, credentialProviderInvocations: 0, account: null });
            set(response, 'account', publicAccount(account));
            if (needsAttention)
                set(response, 'job', await attention(tx, job, lifecycle, now));
            await tx.clearOperation(string(get(operation, 'operationId')));
            return response;
        });
    }
}
