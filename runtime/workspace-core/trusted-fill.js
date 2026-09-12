import { createHash, randomUUID } from 'node:crypto';
import { resolveAccountRealm } from '../contracts/workspace/account-realm.js';
import { validateAccountsDocument } from '../contracts/workspace/accounts.js';
import { answerRevision, fallback, validateAnswers } from '../contracts/workspace/answers.js';
import { validateSettingsDocument } from '../contracts/workspace/automation.js';
import { buildClaimSession } from '../contracts/workspace/claim-session.js';
import { claimExpired, validateCoordinator } from '../contracts/workspace/claims.js';
import { safeId, validateJobsDocument } from '../contracts/workspace/jobs.js';
import { validateProfile } from '../contracts/workspace/profile.js';
import { validateResumeReferences } from '../contracts/workspace/resume-reference.js';
import { publicTrustedFillStatus, revokeTrustedFillApproval, trustedFillApproval, trustedFillDecision, trustedFillOperationList, trustedFillPolicyRevision, validateTrustedFillApproval, validateTrustedFillDocument } from '../contracts/workspace/trusted-fill.js';
import { copy, fromJSON, get, int, integer, keys, object, same, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { preflightJobRecord } from './job-preflight.js';
const doc = (value) => object(fromJSON(value), 'trusted fill value');
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const referencePattern = /^[a-z][a-z0-9._-]{0,127}$/;
function exactFields(value, fields, label) {
    const result = object(value, label);
    if (result.size !== fields.length || keys(result).some(key => !fields.includes(key)))
        throw new JobsError(`${label} contains unsupported fields`);
    return result;
}
function positive(value, label) {
    const result = int(value);
    if (result === null || result < 1n)
        throw new JobsError(`${label} must be a positive integer`);
    return result;
}
function fingerprints(value, fields) {
    for (const field of fields)
        if (!fingerprintPattern.test(string(get(value, field)) ?? ''))
            throw new JobsError(`${field} must be a sha256 fingerprint`);
}
function live(tx, id, now) {
    const jobs = validateJobsDocument(tx.jobs), raw = get(object(get(jobs, 'jobs'), 'jobs'), id);
    if (raw === null)
        throw new JobsError('trusted fill requires an in-progress claimed job');
    const job = object(raw, 'job'), rawClaim = get(validateCoordinator(tx.coordinator), 'claim');
    if (get(job, 'deletedAt') !== null || string(get(job, 'status')) !== 'in_progress')
        throw new JobsError('trusted fill requires an in-progress claimed job');
    if (rawClaim === null)
        throw new TrustedFillClaimError();
    const claim = object(rawClaim, 'claim');
    if (string(get(claim, 'jobId')) !== id || claimExpired(claim, now))
        throw new TrustedFillClaimError();
    return { job, claim };
}
async function current(tx, job, claim, answerRefs) {
    const realm = resolveAccountRealm(string(get(job, 'url')));
    if (realm.status !== 'resolved')
        throw new JobsError('trusted fill portal realm is unresolved');
    let preflight;
    try {
        preflight = await preflightJobRecord(job, validateProfile(tx.profile), tx.resumes, tx.files);
    }
    catch {
        throw new TrustedFillCurrentError('resume_observation_failed');
    }
    if (get(preflight, 'ready') !== true) {
        const errors = get(preflight, 'errors').map(string);
        if (errors.includes('resume_file_missing') || errors.includes('resume_missing'))
            throw new TrustedFillCurrentError('resume_content_missing');
        if (errors.includes('resume_file_changed'))
            throw new TrustedFillCurrentError('resume_content_changed');
        throw new TrustedFillCurrentError('resume_preflight_not_ready');
    }
    const resumeId = string(get(preflight, 'resumeId'));
    const resumes = object(get(tx.resumes, 'resumes'), 'resumes'), rawResume = resumeId ? get(resumes, resumeId) : null;
    if (rawResume === null)
        throw new TrustedFillCurrentError('resume_content_missing');
    const resume = object(rawResume, 'resume');
    if (get(resume, 'deletedAt') !== null)
        throw new TrustedFillCurrentError('resume_content_missing');
    if (string(get(resume, 'storageKind')) !== 'managed' || !/^content_[A-Za-z0-9_-]{32,128}$/.test(string(get(resume, 'contentRevision')) ?? '')) {
        throw new TrustedFillCurrentError('resume_content_unverifiable');
    }
    validateResumeReferences(resumes);
    const answerRecords = object(get(validateAnswers(tx.answers), 'answers'), 'answers'), bindings = [];
    for (const answerRef of [...answerRefs].sort()) {
        const rawAnswer = get(answerRecords, answerRef);
        if (rawAnswer === null)
            throw new TrustedFillCurrentError('answer_binding_invalid');
        const answer = object(rawAnswer, 'answer');
        if (get(answer, 'deletedAt') !== null || string(fallback(answer, 'reviewStatus', text('accepted'))) !== 'accepted') {
            throw new TrustedFillCurrentError('answer_binding_invalid');
        }
        const revision = answerRevision(answer);
        const binding = doc({ answerRef, questionRevision: null, answerRevision: null });
        set(binding, 'questionRevision', integer(revision));
        set(binding, 'answerRevision', integer(revision));
        bindings.push(binding);
    }
    const profileRevision = int(get(object(get(validateProfile(tx.profile), 'metadata'), 'profile metadata'), 'revision')) ?? 1n;
    const settings = object(get(validateSettingsDocument(tx.settings), 'settings'), 'settings');
    const accounts = object(get(validateAccountsDocument(tx.accounts), 'accounts'), 'accounts');
    const account = get(accounts, realm.realmRef);
    const result = doc({ jobId: string(get(job, 'id')), jobRevision: null, claimId: string(get(claim, 'claimId')),
        realmRef: realm.realmRef, urlFingerprint: `sha256:${createHash('sha256').update(string(get(job, 'normalizedUrl'))).digest('hex')}`,
        resumeId, resumeRevision: null, resumeContentRevision: string(get(resume, 'contentRevision')),
        profileRevision: null, vitalFactRevision: null, answerBindings: [],
        automationSettingsRevision: null, employerAccountRevision: account === null ? null : 0, policyRevision: 1 });
    set(result, 'jobRevision', get(job, 'revision'));
    set(result, 'resumeRevision', get(resume, 'revision'));
    set(result, 'profileRevision', integer(profileRevision));
    set(result, 'vitalFactRevision', integer(profileRevision));
    set(result, 'automationSettingsRevision', get(settings, 'revision'));
    set(result, 'answerBindings', bindings);
    if (account !== null)
        set(result, 'employerAccountRevision', get(object(account, 'account'), 'revision'));
    set(result, 'policyRevision', integer(trustedFillPolicyRevision));
    return result;
}
class TrustedFillCurrentError extends JobsError {
    reasonCode;
    constructor(reasonCode) {
        super('trusted fill canonical state is unavailable');
        this.reasonCode = reasonCode;
    }
}
class TrustedFillClaimError extends JobsError {
    constructor() { super('trusted fill requires the live claimed job'); }
}
function blocker(reason) {
    if (['authentication_required', 'credential_fields_present'].includes(reason))
        return { type: 'browser_handoff', code: 'login-required' };
    if (reason === 'consent_required')
        return { type: 'browser_handoff', code: 'consent-required' };
    if (['approval_missing', 'approval_revoked', 'approval_expired', 'approval_revision_mismatch', 'answer_binding_invalid',
        'resume_content_missing', 'resume_content_unverifiable', 'resume_observation_failed', 'resume_preflight_not_ready', 'unseen_questions'].includes(reason)) {
        return { type: 'information', code: 'owner-input-required' };
    }
    return { type: 'browser_handoff', code: 'browser-state-uncertain' };
}
function handoffOperation(job, session, at) {
    const operationId = randomUUID(), id = string(get(job, 'id'));
    const event = doc({ schemaVersion: 1, eventId: `coordinator-${operationId}`, applicationId: id,
        event: 'job-blocked', status: 'needs_info', answerKeys: [], at });
    for (const field of ['company', 'role', 'ats'])
        if (string(get(job, field)) !== null)
            set(event, field, get(job, field));
    const operation = doc({ kind: 'handoff', operationId, jobId: id, sourceStatus: 'in_progress', targetStatus: 'needs_info',
        expectedRevision: null, at, resultClaim: null });
    set(operation, 'expectedRevision', get(job, 'revision'));
    set(operation, 'historyEvent', event);
    set(operation, 'session', session);
    return operation;
}
async function attention(tx, job, reason, now) {
    const blocked = blocker(reason), id = string(get(job, 'id'));
    const incoming = doc({ status: 'active', step: `trusted_fill_denied:${reason}`, answerKeys: [], pendingFields: [], blockers: [blocked],
        browserHandoff: { state: 'required', reasonCode: blocked.code, revision: 1 } });
    const session = buildClaimSession(id, incoming, { now, attemptRevision: get(job, 'revision'), ats: get(job, 'ats'),
        existing: tx.sessions.find(item => string(get(item, 'applicationId')) === id) ?? null, answers: tx.answers });
    await tx.commitClaim(handoffOperation(job, session, now));
    const result = doc({ id, status: 'needs_info', revision: null });
    return set(result, 'revision', integer(int(get(job, 'revision')) + 1n));
}
export class TrustedFillService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    approve(value) {
        const packet = exactFields(value, ['jobId', 'expectedJobRevision', 'realmRef', 'answerRefs', 'observedQuestionFingerprint',
            'observedControlFingerprint', 'formFingerprint', 'allowedOperations', 'durationMinutes'], 'trusted fill approval request');
        const id = safeId(string(get(packet, 'jobId'))), expectedJobRevision = positive(get(packet, 'expectedJobRevision'), 'expectedJobRevision');
        const realmRef = string(get(packet, 'realmRef'));
        if (!/^[0-9a-f]{64}$/.test(realmRef ?? ''))
            throw new JobsError('trusted fill realm binding mismatch');
        const rawRefs = get(packet, 'answerRefs');
        if (!Array.isArray(rawRefs) || rawRefs.some(item => !referencePattern.test(string(item) ?? '')))
            throw new JobsError('trusted fill answer references must be a list of strings');
        const answerRefs = rawRefs.map(item => string(item));
        if (new Set(answerRefs).size !== answerRefs.length)
            throw new JobsError('trusted fill answer references contain duplicates');
        fingerprints(packet, ['observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint']);
        const operations = trustedFillOperationList(get(packet, 'allowedOperations'));
        const duration = positive(get(packet, 'durationMinutes'), 'durationMinutes');
        return this.repository.trustedFillTransaction(async (tx) => {
            const now = this.now(), { job, claim } = live(tx, id, now);
            let state;
            try {
                state = await current(tx, job, claim, answerRefs);
            }
            catch (error) {
                if (!(error instanceof TrustedFillCurrentError))
                    throw error;
                const denied = await attention(tx, job, error.reasonCode, now);
                const result = doc({ authorized: false, reasonCode: error.reasonCode, retryAllowed: false, attentionHandoff: true, job: null });
                return set(result, 'job', denied);
            }
            if (int(get(state, 'jobRevision')) !== expectedJobRevision)
                throw new JobsError('job revision conflict');
            if (string(get(state, 'realmRef')) !== realmRef)
                throw new JobsError('trusted fill realm binding mismatch');
            const document = copy(validateTrustedFillDocument(tx.approvals));
            const records = copy(object(get(document, 'approvals'), 'approvals'));
            set(document, 'approvals', records);
            const previousRaw = get(records, id), previous = previousRaw === null ? null : validateTrustedFillApproval(previousRaw);
            if (previous !== null && string(get(previous, 'status')) === 'active'
                && string(get(publicTrustedFillStatus(previous, now), 'status')) === 'active')
                throw new JobsError('active trusted fill approval already exists');
            for (const field of ['observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint'])
                set(state, field, get(packet, field));
            set(state, 'allowedOperations', operations.map(text));
            const revision = previous === null ? 1n : int(get(previous, 'approvalRevision')) + 1n;
            const approval = trustedFillApproval(state, duration, revision, now);
            set(records, id, approval);
            set(object(get(document, 'metadata'), 'metadata'), 'updatedAt', text(now));
            await tx.saveApprovals(validateTrustedFillDocument(document));
            return publicTrustedFillStatus(approval, now);
        });
    }
    status(id) {
        safeId(id);
        return this.repository.trustedFillTransaction(async (tx) => {
            const raw = get(object(get(validateTrustedFillDocument(tx.approvals), 'approvals'), 'approvals'), id);
            return publicTrustedFillStatus(raw, this.now());
        });
    }
    revoke(id, expectedRevision) {
        safeId(id);
        if (expectedRevision < 1n)
            throw new JobsError('expectedApprovalRevision must be a positive integer');
        return this.repository.trustedFillTransaction(async (tx) => {
            const document = copy(validateTrustedFillDocument(tx.approvals));
            const records = copy(object(get(document, 'approvals'), 'approvals'));
            set(document, 'approvals', records);
            const raw = get(records, id);
            if (raw === null)
                throw new JobsError('trusted fill approval does not exist');
            const now = this.now(), updated = revokeTrustedFillApproval(raw, expectedRevision, now);
            set(records, id, updated);
            set(object(get(document, 'metadata'), 'metadata'), 'updatedAt', text(now));
            await tx.saveApprovals(validateTrustedFillDocument(document));
            return publicTrustedFillStatus(updated, now);
        });
    }
    evaluate(value) {
        const fields = ['jobId', 'expectedApprovalRevision', 'observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint',
            'fieldOperations', 'authenticationRequired', 'consentRequired', 'credentialFieldsPresent', 'finalControlsPresent', 'unseenQuestions', 'unseenControls'];
        const observed = exactFields(value, fields, 'trusted fill evaluation'), id = safeId(string(get(observed, 'jobId')));
        const expected = positive(get(observed, 'expectedApprovalRevision'), 'expectedApprovalRevision');
        fingerprints(observed, ['observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint']);
        trustedFillOperationList(get(observed, 'fieldOperations'), 'field operations');
        for (const field of fields.slice(6))
            if (typeof get(observed, field) !== 'boolean')
                throw new JobsError('trusted fill evaluation flags must be booleans');
        return this.repository.trustedFillTransaction(async (tx) => {
            const now = this.now();
            let job, claim;
            try {
                ({ job, claim } = live(tx, id, now));
            }
            catch (error) {
                if (!(error instanceof TrustedFillClaimError))
                    throw error;
                return doc({ authorized: false, reasonCode: 'claim_missing_or_expired', retryAllowed: false, attentionHandoff: false });
            }
            const document = validateTrustedFillDocument(tx.approvals), raw = get(object(get(document, 'approvals'), 'approvals'), id);
            if (raw === null)
                return this.denied(tx, job, 'approval_missing', now);
            const approval = validateTrustedFillApproval(raw);
            if (int(get(approval, 'approvalRevision')) !== expected)
                return this.denied(tx, job, 'approval_revision_mismatch', now);
            if (string(get(approval, 'claimId')) !== string(get(claim, 'claimId')))
                return doc({ authorized: false, reasonCode: 'claim_binding_mismatch', retryAllowed: false, attentionHandoff: false });
            let state;
            try {
                state = await current(tx, job, claim, get(approval, 'answerBindings').map(item => string(get(object(item, 'binding'), 'answerRef'))));
            }
            catch (error) {
                if (!(error instanceof TrustedFillCurrentError))
                    throw error;
                return this.denied(tx, job, error.reasonCode, now);
            }
            const decision = trustedFillDecision(approval, state, observed, now);
            if (get(decision, 'authorized') !== true)
                return this.denied(tx, job, string(get(decision, 'reasonCode')), now);
            // Evaluation is the one-shot receipt. Persist consumption before returning authority.
            const consumed = revokeTrustedFillApproval(approval, expected, now), next = copy(document);
            const records = copy(object(get(next, 'approvals'), 'approvals'));
            set(next, 'approvals', records);
            set(records, id, consumed);
            set(object(get(next, 'metadata'), 'metadata'), 'updatedAt', text(now));
            await tx.saveApprovals(validateTrustedFillDocument(next));
            set(decision, 'attentionHandoff', false);
            set(decision, 'consumedApprovalRevision', get(consumed, 'approvalRevision'));
            return decision;
        });
    }
    nativeOutcome(id, consumedRevision, successful) {
        safeId(id);
        if (consumedRevision < 2n)
            throw new JobsError('consumedApprovalRevision must identify consumed authority');
        return this.repository.trustedFillTransaction(async (tx) => {
            const now = this.now();
            let job, claim;
            try {
                ({ job, claim } = live(tx, id, now));
            }
            catch (error) {
                if (!(error instanceof TrustedFillClaimError))
                    throw error;
                return doc({ authorized: false, reasonCode: 'claim_missing_or_expired', retryAllowed: false, attentionHandoff: false });
            }
            const raw = get(object(get(validateTrustedFillDocument(tx.approvals), 'approvals'), 'approvals'), id);
            if (raw === null)
                return doc({ authorized: false, reasonCode: 'native_receipt_stale', retryAllowed: false, attentionHandoff: false });
            const approval = validateTrustedFillApproval(raw);
            if (string(get(approval, 'status')) !== 'revoked' || int(get(approval, 'approvalRevision')) !== consumedRevision
                || string(get(approval, 'claimId')) !== string(get(claim, 'claimId'))) {
                return doc({ authorized: false, reasonCode: 'native_receipt_stale', retryAllowed: false, attentionHandoff: false });
            }
            let state;
            try {
                state = await current(tx, job, claim, get(approval, 'answerBindings').map(item => string(get(object(item, 'binding'), 'answerRef'))));
            }
            catch (error) {
                if (!(error instanceof TrustedFillCurrentError))
                    throw error;
                return this.denied(tx, job, error.reasonCode, now);
            }
            const bound = ['jobId', 'jobRevision', 'claimId', 'realmRef', 'urlFingerprint', 'resumeId', 'resumeRevision',
                'resumeContentRevision', 'profileRevision', 'vitalFactRevision', 'answerBindings', 'automationSettingsRevision',
                'employerAccountRevision', 'policyRevision'];
            if (bound.some(field => !same(get(approval, field), get(state, field))))
                return this.denied(tx, job, 'canonical_drift', now);
            if (!successful)
                return this.denied(tx, job, 'native_execution_ambiguous', now);
            const result = doc({ authorized: true, reasonCode: 'native_fields_applied', retryAllowed: false,
                attentionHandoff: false, consumedApprovalRevision: null, finalActionAuthorized: false });
            return set(result, 'consumedApprovalRevision', integer(consumedRevision));
        });
    }
    async denied(tx, job, reason, now) {
        const handedOff = await attention(tx, job, reason, now);
        const result = doc({ authorized: false, reasonCode: reason, retryAllowed: false, attentionHandoff: true, job: null });
        return set(result, 'job', handedOff);
    }
}
