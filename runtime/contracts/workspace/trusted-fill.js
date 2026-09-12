import { randomBytes, randomUUID } from 'node:crypto';
import { exact } from './automation.js';
import { claimTime } from './claim-time.js';
import { copy, fromJSON, get, int, integer, object, same, set, string, text, JobsError } from './values.js';
export const trustedFillPolicyRevision = 1n;
export const trustedFillOperations = new Set([
    'fill_text', 'select_option', 'toggle_non_consent', 'upload_approved_resume',
]);
const fingerprints = ['urlFingerprint', 'observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint'];
const revisions = ['jobRevision', 'resumeRevision', 'profileRevision', 'vitalFactRevision',
    'automationSettingsRevision', 'policyRevision', 'approvalRevision'];
const approvalFields = ['schemaVersion', 'approvalId', 'status', 'issuedAt', 'expiresAt', 'revokedAt',
    'jobId', 'jobRevision', 'claimId', 'realmRef', 'urlFingerprint', 'resumeId', 'resumeRevision',
    'resumeContentRevision', 'profileRevision', 'vitalFactRevision', 'answerBindings',
    'observedQuestionFingerprint', 'observedControlFingerprint', 'formFingerprint',
    'automationSettingsRevision', 'employerAccountRevision', 'policyRevision', 'allowedOperations',
    'nonce', 'approvalRevision'];
const reference = /^[a-z][a-z0-9._-]{0,127}$/;
const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const contentRevisionPattern = /^content_[A-Za-z0-9_-]{32,128}$/;
function positive(value, label) {
    const result = int(value);
    if (result === null || result < 1n)
        throw new JobsError(`${label} must be a positive integer`);
    return result;
}
function time(value, label) {
    const raw = string(value);
    if (!raw)
        throw new JobsError(`${label} is invalid`);
    try {
        return claimTime(raw);
    }
    catch {
        throw new JobsError(`${label} is invalid`);
    }
}
function fingerprint(value, label) {
    const result = string(value);
    if (!result || !fingerprintPattern.test(result))
        throw new JobsError(`${label} must be a sha256 fingerprint`);
    return result;
}
export function trustedFillContentRevision(value) {
    const result = string(value);
    if (!result || !contentRevisionPattern.test(result))
        throw new JobsError('resume content revision is unverifiable');
    return result;
}
export function trustedFillOperationList(value, label = 'allowed operations') {
    if (!Array.isArray(value) || !value.length || value.some(item => string(item) === null)) {
        throw new JobsError(`${label} are invalid or include a final action`);
    }
    const result = value.map(item => string(item));
    if (new Set(result).size !== result.length || result.some(item => !trustedFillOperations.has(item))) {
        throw new JobsError(`${label} are invalid or include a final action`);
    }
    return result.sort();
}
export function validateTrustedFillApproval(value) {
    const approval = object(value, 'trusted fill approval');
    exact(approval, approvalFields, 'approval contains unsupported fields');
    if (int(get(approval, 'schemaVersion')) !== 1n)
        throw new JobsError('approval contains unsupported fields');
    for (const field of ['approvalId', 'jobId', 'resumeId']) {
        if (!reference.test(string(get(approval, field)) ?? ''))
            throw new JobsError('approval reference is invalid');
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(string(get(approval, 'claimId')) ?? '')) {
        throw new JobsError('approval claim binding is invalid');
    }
    const status = string(get(approval, 'status'));
    if (!['active', 'revoked'].includes(status ?? ''))
        throw new JobsError('approval status is invalid');
    const issued = time(get(approval, 'issuedAt'), 'approval issuedAt');
    const expires = time(get(approval, 'expiresAt'), 'approval expiresAt');
    if (expires <= issued || expires - issued > 3600000000n)
        throw new JobsError('approval duration is invalid');
    if (status === 'revoked')
        time(get(approval, 'revokedAt'), 'approval revokedAt');
    else if (get(approval, 'revokedAt') !== null)
        throw new JobsError('active approval cannot have revokedAt');
    if (!/^[0-9a-f]{64}$/.test(string(get(approval, 'realmRef')) ?? ''))
        throw new JobsError('approval realm reference is invalid');
    for (const field of fingerprints)
        fingerprint(get(approval, field), field);
    for (const field of revisions)
        positive(get(approval, field), field);
    if (int(get(approval, 'policyRevision')) !== trustedFillPolicyRevision)
        throw new JobsError('approval policy revision is unsupported');
    trustedFillContentRevision(get(approval, 'resumeContentRevision'));
    if (get(approval, 'employerAccountRevision') !== null)
        positive(get(approval, 'employerAccountRevision'), 'employerAccountRevision');
    const bindings = get(approval, 'answerBindings');
    if (!Array.isArray(bindings))
        throw new JobsError('answer bindings must be a list');
    const refs = bindings.map(value => {
        const binding = object(value, 'answer binding');
        exact(binding, ['answerRef', 'questionRevision', 'answerRevision'], 'answer binding is invalid');
        const answerRef = string(get(binding, 'answerRef'));
        if (!answerRef || !reference.test(answerRef))
            throw new JobsError('answer binding reference is invalid');
        positive(get(binding, 'questionRevision'), 'questionRevision');
        positive(get(binding, 'answerRevision'), 'answerRevision');
        return answerRef;
    });
    if (new Set(refs).size !== refs.length || refs.some((item, index) => index > 0 && refs[index - 1] > item)) {
        throw new JobsError('answer bindings must be unique and sorted');
    }
    trustedFillOperationList(get(approval, 'allowedOperations'));
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(string(get(approval, 'nonce')) ?? ''))
        throw new JobsError('approval nonce is invalid');
    return approval;
}
export function validateTrustedFillDocument(value) {
    const document = object(value, 'trusted fill approvals');
    exact(document, ['schemaVersion', 'approvals', 'metadata'], 'trusted fill approval document contains unsupported fields');
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('trusted fill approval schema version is unsupported');
    const approvals = object(get(document, 'approvals'), 'trusted fill approvals');
    for (const [jobId, value] of approvals.entries())
        if (string(jobId) !== string(get(validateTrustedFillApproval(value), 'jobId'))) {
            throw new JobsError('trusted fill approval job identity is invalid');
        }
    const metadata = object(get(document, 'metadata'), 'trusted fill metadata');
    exact(metadata, ['createdAt', 'updatedAt'], 'trusted fill metadata is invalid');
    for (const field of ['createdAt', 'updatedAt'])
        if (!string(get(metadata, field)))
            throw new JobsError('trusted fill metadata timestamp is invalid');
    return document;
}
export function trustedFillApproval(bindings, durationMinutes, approvalRevision, now) {
    if (durationMinutes < 1n || durationMinutes > 60n)
        throw new JobsError('approval duration must be between 1 and 60 minutes');
    const issued = claimTime(now), expires = issued + durationMinutes * 60000000n;
    const approval = copy(bindings);
    for (const [key, value] of Object.entries({ schemaVersion: 1, approvalId: `trusted-fill-${randomUUID()}`,
        status: 'active', issuedAt: now, expiresAt: new Date(Number(expires / 1000n)).toISOString().replace('.000Z', 'Z'),
        revokedAt: null, policyRevision: 1, nonce: randomBytes(32).toString('base64url') }))
        set(approval, key, fromJSON(value));
    set(approval, 'approvalRevision', integer(approvalRevision));
    return validateTrustedFillApproval(approval);
}
export function revokeTrustedFillApproval(value, expectedRevision, now) {
    const current = validateTrustedFillApproval(value);
    if (int(get(current, 'approvalRevision')) !== expectedRevision)
        throw new JobsError('approval revision conflict');
    if (string(get(current, 'status')) !== 'active')
        throw new JobsError('approval is not active');
    const updated = copy(current);
    set(updated, 'status', text('revoked'));
    set(updated, 'revokedAt', text(now));
    set(updated, 'approvalRevision', integer(expectedRevision + 1n));
    return validateTrustedFillApproval(updated);
}
export function publicTrustedFillStatus(value, now) {
    if (value === null)
        return object(fromJSON({ status: 'missing', approvalRevision: null }), 'trusted fill public status');
    const record = validateTrustedFillApproval(value), active = string(get(record, 'status')) === 'active';
    const result = object(fromJSON({ status: active && claimTime(now) >= time(get(record, 'expiresAt'), 'approval expiresAt') ? 'expired' : string(get(record, 'status')),
        jobId: string(get(record, 'jobId')), realmRef: string(get(record, 'realmRef')), expiresAt: string(get(record, 'expiresAt')),
        approvalRevision: null }), 'trusted fill public status');
    set(result, 'approvalRevision', get(record, 'approvalRevision'));
    return set(result, 'allowedOperations', trustedFillOperationList(get(record, 'allowedOperations')).map(text));
}
export function trustedFillDecision(record, current, observed, now) {
    if (string(get(record, 'status')) !== 'active')
        return object(fromJSON({ authorized: false, reasonCode: 'approval_revoked', retryAllowed: false }), 'decision');
    if (claimTime(now) >= time(get(record, 'expiresAt'), 'approval expiresAt'))
        return object(fromJSON({ authorized: false, reasonCode: 'approval_expired', retryAllowed: false }), 'decision');
    const flags = { authenticationRequired: 'authentication_required', consentRequired: 'consent_required',
        credentialFieldsPresent: 'credential_fields_present', finalControlsPresent: 'final_controls_present', unseenQuestions: 'unseen_questions', unseenControls: 'unseen_controls' };
    for (const [field, reason] of Object.entries(flags))
        if (get(observed, field) === true)
            return object(fromJSON({ authorized: false, reasonCode: reason, retryAllowed: false }), 'decision');
    const bound = ['jobId', 'jobRevision', 'claimId', 'realmRef', 'urlFingerprint', 'resumeId', 'resumeRevision',
        'resumeContentRevision', 'profileRevision', 'vitalFactRevision', 'answerBindings', 'automationSettingsRevision',
        'employerAccountRevision', 'policyRevision'];
    if (bound.some(field => !same(get(record, field), get(current, field))))
        return object(fromJSON({ authorized: false, reasonCode: 'canonical_drift', retryAllowed: false }), 'decision');
    if (fingerprints.slice(1).some(field => !same(get(record, field), get(observed, field))))
        return object(fromJSON({ authorized: false, reasonCode: 'observed_drift', retryAllowed: false }), 'decision');
    const operations = trustedFillOperationList(get(observed, 'fieldOperations'), 'field operations');
    const allowed = new Set(trustedFillOperationList(get(record, 'allowedOperations')));
    if (operations.some(operation => !allowed.has(operation)))
        return object(fromJSON({ authorized: false, reasonCode: 'operation_not_approved', retryAllowed: false }), 'decision');
    const result = object(fromJSON({ authorized: true, reasonCode: 'authorized_non_final_fields', retryAllowed: false,
        approvalRevision: null, allowedOperations: operations }), 'decision');
    return set(result, 'approvalRevision', get(record, 'approvalRevision'));
}
