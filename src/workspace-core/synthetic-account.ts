import { randomUUID } from 'node:crypto';
import { publicAccount, validateAccount, validateAccountsDocument } from '../contracts/workspace/accounts.js';
import { resolveAccountRealm } from '../contracts/workspace/account-realm.js';
import { accountOperation } from '../contracts/workspace/account-operation.js';
import { validateSettingsDocument } from '../contracts/workspace/automation.js';
import { buildClaimSession } from '../contracts/workspace/claim-session.js';
import { claimExpired, validateCoordinator } from '../contracts/workspace/claims.js';
import { safeId, validateJobsDocument } from '../contracts/workspace/jobs.js';
import { terminalAccountLifecycles, validateSyntheticAccountRequest, validateSyntheticAccountResult } from '../contracts/workspace/synthetic-account.js';
import { copy, fromJSON, get, int, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { AccountOperationRepository, AccountOperationTransaction } from './account-operation.js';

export interface SyntheticAccountExecutor {
  readonly providerId: string;
  execute(request: Document, strategy: string, existingCredentialRef: Value,
    privateEmail: () => string): Promise<Value>;
}

const doc = (value: unknown): Document => object(fromJSON(value), 'synthetic account value');

function liveJob(tx: AccountOperationTransaction, request: Document, now: string): Document {
  const id = safeId(string(get(request, 'jobId'))), jobs = validateJobsDocument(tx.jobs);
  const raw = get(object(get(jobs, 'jobs'), 'jobs'), id);
  if (raw === null) throw new JobsError('account execution requires the exact live claimed job');
  const job = object(raw, 'job'), rawClaim = get(validateCoordinator(tx.coordinator), 'claim');
  if (rawClaim === null) throw new JobsError('account execution requires the exact live claimed job');
  const claim = object(rawClaim, 'claim');
  if (get(job, 'deletedAt') !== null || string(get(job, 'status')) !== 'in_progress'
    || int(get(job, 'revision')) !== int(get(request, 'expectedJobRevision'))
    || string(get(claim, 'jobId')) !== id || string(get(claim, 'claimId')) !== string(get(request, 'expectedClaimId'))
    || claimExpired(claim, now)) throw new JobsError('account execution requires the exact live claimed job');
  return job;
}

function handoff(job: Document, session: Document, at: string): Document {
  const operationId = randomUUID(), id = string(get(job, 'id'))!;
  const event = doc({ schemaVersion: 1, eventId: `coordinator-${operationId}`, applicationId: id,
    event: 'job-blocked', status: 'needs_info', answerKeys: [], at });
  for (const field of ['company', 'role', 'ats']) if (string(get(job, field)) !== null) set(event, field, get(job, field));
  const operation = doc({ kind: 'handoff', operationId, jobId: id, sourceStatus: 'in_progress',
    targetStatus: 'needs_info', expectedRevision: null, at, resultClaim: null });
  set(operation, 'expectedRevision', get(job, 'revision'));
  set(operation, 'historyEvent', event);
  return set(operation, 'session', session);
}

function blocker(reason: string): { type: string; code: string } {
  if (reason === 'reset_required' || reason === 'password_strategy') return { type: 'information', code: 'owner-input-required' };
  if (reason === 'verification_required') return { type: 'browser_handoff', code: 'mfa-required' };
  return { type: 'browser_handoff', code: 'browser-state-uncertain' };
}

async function attention(tx: AccountOperationTransaction, job: Document, reason: string, now: string): Promise<Document> {
  const blocked = blocker(reason), id = string(get(job, 'id'))!;
  const incoming = doc({ status: 'active', step: `account_automation_denied:${reason}`,
    answerKeys: [], pendingFields: [], blockers: [blocked],
    browserHandoff: { state: 'required', reasonCode: blocked.code, revision: 1 } });
  const session = buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
    existing: tx.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null, answers: tx.answers });
  await tx.commitClaim(handoff(job, session, now));
  const result = doc({ id, status: 'needs_info', revision: null });
  set(result, 'revision', integer(int(get(job, 'revision'))! + 1n));
  return result;
}

function operationFor(job: Document, claim: Document, account: Document, settings: Document, now: string): Document {
  const operation = doc({ operationId: randomUUID(), jobId: string(get(job, 'id')), jobRevision: null,
    claimId: string(get(claim, 'claimId')), realmRef: string(get(account, 'realmRef')), accountRevision: null,
    settingsRevision: null, stage: 'prepared', outcomeCode: 'observed_pending', startedAt: now });
  set(operation, 'jobRevision', get(job, 'revision'));
  set(operation, 'accountRevision', get(account, 'revision'));
  set(operation, 'settingsRevision', get(settings, 'revision'));
  return operation;
}

async function writeStage(tx: AccountOperationTransaction, account: Document, operation: Document,
  lifecycle: string, stage: string, at: string, metadata?: Document): Promise<{ account: Document; operation: Document }> {
  const accounts = validateAccountsDocument(tx.accounts), records = object(get(accounts, 'accounts'), 'accounts');
  const current = object(get(records, string(get(account, 'realmRef'))!), 'employer account');
  if (int(get(current, 'revision')) !== int(get(account, 'revision'))) throw new JobsError('employer account revision conflict');
  const updated = copy(current);
  set(updated, 'lifecycleState', text(lifecycle));
  set(updated, 'revision', integer(int(get(current, 'revision'))! + 1n));
  set(updated, 'updatedAt', text(at));
  if (metadata) for (const field of ['providerId', 'credentialRef', 'credentialVersion']) set(updated, field, get(metadata, field));
  validateAccount(string(get(updated, 'realmRef'))!, updated);
  set(records, string(get(updated, 'realmRef'))!, updated);
  set(object(get(accounts, 'metadata'), 'account metadata'), 'updatedAt', get(updated, 'updatedAt'));
  await tx.saveAccounts(accounts);
  const next = copy(operation);
  set(next, 'stage', text(stage));
  set(next, 'accountRevision', get(updated, 'revision'));
  await tx.saveOperation(string(get(operation, 'operationId'))!, next);
  return { account: updated, operation: next };
}

export class SyntheticAccountService {
  constructor(private readonly repository: AccountOperationRepository, private readonly executor?: SyntheticAccountExecutor,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}

  async execute(value: Value): Promise<Value> {
    const request = validateSyntheticAccountRequest(value);
    if (!this.executor) throw new JobsError('native protected provider injection is required');
    const executor = this.executor;
    if (executor.providerId !== 'synthetic-protected') throw new JobsError('synthetic provider is test-only');
    return await this.repository.accountOperationTransaction(async tx => {
      if (accountOperation(tx.journal) !== null) throw new JobsError('account operation requires explicit recovery');
      const now = this.now(), job = liveJob(tx, request, now), realm = resolveAccountRealm(string(get(job, 'url')));
      if (realm.status !== 'resolved' || realm.realmRef !== string(get(request, 'realmRef'))
        || realm.descriptor !== string(get(request, 'realmDescriptor'))) throw new JobsError('account execution realm binding mismatch');
      const settings = object(get(validateSettingsDocument(tx.settings), 'settings'), 'automation settings');
      const accounts = validateAccountsDocument(tx.accounts), raw = get(object(get(accounts, 'accounts'), 'accounts'), realm.realmRef);
      if (raw === null) throw new JobsError('employer account does not exist');
      let account = object(raw, 'employer account');
      if (int(get(settings, 'revision')) !== int(get(request, 'expectedSettingsRevision'))
        || int(get(account, 'revision')) !== int(get(request, 'expectedAccountRevision'))) throw new JobsError('account execution revision conflict');
      if (get(settings, 'enabled') !== true || get(settings, 'automaticAccountCreation') !== true) throw new JobsError('account automation is disabled');
      const effectiveEmail = string(get(account, 'signupEmailOverride')) ?? string(get(settings, 'signupEmail'));
      if (!effectiveEmail) throw new JobsError('effective signup email is required');
      if (terminalAccountLifecycles.has(string(get(account, 'lifecycleState'))!)) throw new JobsError('account lifecycle permanently requires human attention');
      const strategy = string(get(settings, 'passwordStrategy'))!;
      if (['custom', 'ask_each_time'].includes(strategy)) {
        const denied = await attention(tx, job, 'password_strategy', now);
        return set(doc({ authorized: false, reasonCode: 'password_strategy_requires_human', retryAllowed: false,
          attentionHandoff: true, job: null }), 'job', denied);
      }
      const rawClaim = object(get(validateCoordinator(tx.coordinator), 'claim'), 'claim');
      let operation = operationFor(job, rawClaim, account, settings, now);
      await tx.saveOperation(null, operation);
      let result: Document;
      try {
        result = validateSyntheticAccountResult(await executor.execute(request, strategy, get(account, 'credentialRef'), () => effectiveEmail));
        if (string(get(result, 'providerId')) !== executor.providerId) throw new JobsError('synthetic account provider mismatch');
      } catch {
        ({ account, operation } = await writeStage(tx, account, operation, 'ambiguous', 'signup_in_progress', now));
        const denied = await attention(tx, job, 'ambiguous', now);
        await tx.clearOperation(string(get(operation, 'operationId'))!);
        const response = doc({ authorized: false, reasonCode: 'ambiguous', retryAllowed: false,
          attentionHandoff: true, account: null, job: null });
        set(response, 'account', publicAccount(account));
        set(response, 'job', denied);
        return response;
      }
      ({ account, operation } = await writeStage(tx, account, operation, 'credential_provisioned', 'credential_provisioned', now, result));
      ({ account, operation } = await writeStage(tx, account, operation, 'signup_in_progress', 'signup_in_progress', now));
      const lifecycle = string(get(result, 'lifecycleState'))!;
      ({ account, operation } = await writeStage(tx, account, operation, lifecycle, 'signup_in_progress', now));
      const needsAttention = lifecycle !== 'active', response = doc({ authorized: !needsAttention, reasonCode: lifecycle,
        retryAllowed: false, attentionHandoff: needsAttention, reused: get(result, 'reused'),
        secureControlCleared: true, finalActionAuthorized: false, account: null });
      set(response, 'account', publicAccount(account));
      if (needsAttention) set(response, 'job', await attention(tx, job, lifecycle, now));
      await tx.clearOperation(string(get(operation, 'operationId'))!);
      return response;
    });
  }
}
