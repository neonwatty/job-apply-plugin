import { answerRevision } from './answers.js';
import { claimTime } from './claim-time.js';
import { contentRevision, exact } from './extraction-requests.js';
import { normalizeJobUrl } from './job-url.js';
import { safeId } from './jobs.js';
import { copy, fromJSON, get, has, int, integer, keys, object, set, string, text, JobsError } from './values.js';
export const applicationAuthorityModes = new Set(['autofill_to_review', 'campaign_to_review']);
export const applicationAuthorityStatuses = new Set(['active', 'paused', 'revoked', 'replaced', 'consumed', 'stopped']);
export const applicationAuthorityOperations = new Set([
    'fill_canonical_profile', 'upload_managed_resume', 'fill_confirmed_answer',
    'repair_cleared_field', 'navigate_non_final',
]);
export const applicationAuthorityInterrupts = new Map([
    ['missingOrUncertainData', 'missing_or_uncertain_data'], ['captcha', 'captcha'], ['mfa', 'mfa'],
    ['emailVerification', 'email_verification'], ['providerLegalConsent', 'provider_legal_consent'],
    ['unsupportedControls', 'unsupported_controls'], ['unexpectedDestination', 'unexpected_destination'],
    ['ambiguity', 'ambiguity'], ['finalAction', 'final_action_manual'],
]);
export function applicationOrigin(value) {
    const raw = string(value);
    if (raw === null)
        throw new JobsError('application destination is invalid');
    const normalized = normalizeJobUrl(raw);
    const match = /^(https?):\/\/([^/?#]+)/u.exec(normalized);
    if (!match)
        throw new JobsError('application destination is invalid');
    return `${match[1]}://${match[2]}`;
}
function positive(value, label, zero = false) {
    const result = int(value);
    if (result === null || result < (zero ? 0n : 1n))
        throw new JobsError(`${label} must be a positive integer`);
    return result;
}
function strings(value, label, allowed) {
    if (!Array.isArray(value))
        throw new JobsError(`${label} must be a list`);
    const result = value.map(item => string(item));
    if (result.some(item => item === null || !item) || new Set(result).size !== result.length
        || allowed && result.some(item => !allowed.has(item)))
        throw new JobsError(`${label} is invalid`);
    return result;
}
export function validateApplicationAuthorityBinding(value) {
    const binding = object(value, 'application authority job binding');
    exact(binding, ['jobId', 'destinationOrigin', 'resumeId', 'resumeRevision', 'contentRevision', 'factRevision'], 'application authority job binding contains unsupported fields');
    safeId(string(get(binding, 'jobId')));
    safeId(string(get(binding, 'resumeId')));
    if (applicationOrigin(get(binding, 'destinationOrigin')) !== string(get(binding, 'destinationOrigin'))) {
        throw new JobsError('application authority destination origin is invalid');
    }
    positive(get(binding, 'resumeRevision'), 'application authority resume revision');
    positive(get(binding, 'factRevision'), 'application authority fact revision');
    contentRevision(get(binding, 'contentRevision'));
    return binding;
}
export function validateSensitiveAnswerBinding(value) {
    const binding = object(value, 'sensitive answer binding');
    exact(binding, ['answerRef', 'answerRevision'], 'sensitive answer binding contains unsupported fields');
    if (!string(get(binding, 'answerRef')))
        throw new JobsError('sensitive answer reference is invalid');
    positive(get(binding, 'answerRevision'), 'sensitive answer revision');
    return binding;
}
export function validateApplicationAuthority(value) {
    const record = object(value, 'application authority');
    const required = ['authorizationId', 'mode', 'status', 'revision', 'issuedAt', 'expiresAt', 'terminalAt',
        'runId', 'runRevision', 'jobBindings', 'sensitiveAnswerBindings'];
    if (required.some(field => !has(record, field)) || keys(record).some(key => ![...required, 'profileRevision'].includes(key))) {
        throw new JobsError('application authority contains unsupported fields');
    }
    if (!/^application-authority-[0-9a-f-]{36}$/u.test(string(get(record, 'authorizationId')) ?? '')
        || !applicationAuthorityModes.has(string(get(record, 'mode')) ?? '')
        || !applicationAuthorityStatuses.has(string(get(record, 'status')) ?? '')) {
        throw new JobsError('application authority identity, mode, or status is invalid');
    }
    positive(get(record, 'revision'), 'application authority revision');
    safeId(string(get(record, 'runId')));
    positive(get(record, 'runRevision'), 'application run revision');
    if (has(record, 'profileRevision'))
        positive(get(record, 'profileRevision'), 'profile revision');
    const issued = string(get(record, 'issuedAt')), expires = string(get(record, 'expiresAt'));
    if (!issued || !expires || claimTime(expires) <= claimTime(issued))
        throw new JobsError('application authority timestamps are invalid');
    const terminal = get(record, 'terminalAt'), active = ['active', 'paused'].includes(string(get(record, 'status')));
    if (active ? terminal !== null : !string(terminal))
        throw new JobsError('application authority terminal timestamp is invalid');
    const bindings = get(record, 'jobBindings');
    if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 50)
        throw new JobsError('application authority job scope is invalid');
    const jobs = bindings.map(validateApplicationAuthorityBinding).map(item => string(get(item, 'jobId')));
    if (new Set(jobs).size !== jobs.length || string(get(record, 'mode')) === 'autofill_to_review' && jobs.length !== 1) {
        throw new JobsError('application authority job scope is invalid');
    }
    const sensitive = get(record, 'sensitiveAnswerBindings');
    if (!Array.isArray(sensitive))
        throw new JobsError('sensitive answer bindings must be a list');
    const answers = sensitive.map(validateSensitiveAnswerBinding).map(item => string(get(item, 'answerRef')));
    if (new Set(answers).size !== answers.length)
        throw new JobsError('sensitive answer bindings contain duplicates');
    return record;
}
export function initialApplicationAuthorityDocument(now) {
    claimTime(now);
    return object(fromJSON({ schemaVersion: 1, activeAuthorityId: null, authorities: {},
        metadata: { revision: 0, createdAt: now, updatedAt: now } }), 'application authorities');
}
export function validateApplicationAuthorityDocument(value) {
    const document = object(value, 'application authorities');
    exact(document, ['schemaVersion', 'activeAuthorityId', 'authorities', 'metadata'], 'application authority document contains unsupported fields');
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('application authority schema version is unsupported');
    const authorities = object(get(document, 'authorities'), 'application authorities');
    for (const [key, value] of authorities.entries()) {
        const record = validateApplicationAuthority(value);
        if (string(key) !== string(get(record, 'authorizationId')))
            throw new JobsError('application authority identity does not match');
    }
    const active = string(get(document, 'activeAuthorityId'));
    if (get(document, 'activeAuthorityId') !== null && (!active || get(authorities, active) === null
        || !['active', 'paused'].includes(string(get(object(get(authorities, active), 'active authority'), 'status'))))) {
        throw new JobsError('active application authority pointer is invalid');
    }
    const metadata = object(get(document, 'metadata'), 'application authority metadata');
    exact(metadata, ['revision', 'createdAt', 'updatedAt'], 'application authority metadata is invalid');
    positive(get(metadata, 'revision'), 'application authority document revision', true);
    for (const field of ['createdAt', 'updatedAt'])
        if (!string(get(metadata, field)))
            throw new JobsError('application authority metadata is invalid');
    return document;
}
export function activeApplicationAuthority(document) {
    const id = string(get(document, 'activeAuthorityId'));
    return id === null ? null : object(get(object(get(document, 'authorities'), 'application authorities'), id), 'active application authority');
}
export function applicationAuthorityProjection(document, now) {
    const validated = validateApplicationAuthorityDocument(document), record = activeApplicationAuthority(validated);
    const revision = get(object(get(validated, 'metadata'), 'application authority metadata'), 'revision');
    if (record === null)
        return set(object(fromJSON({ mode: 'guided', status: 'active', authorizationId: null,
            expiresAt: null, runId: null, jobIds: [], sensitiveAnswerRefs: [] }), 'application authority projection'), 'revision', revision);
    const expired = claimTime(now) >= claimTime(string(get(record, 'expiresAt')));
    const result = object(fromJSON({ mode: expired ? 'guided' : string(get(record, 'mode')),
        status: expired ? 'expired' : string(get(record, 'status')), authorizationId: string(get(record, 'authorizationId')),
        expiresAt: string(get(record, 'expiresAt')), runId: string(get(record, 'runId')), jobIds: [], sensitiveAnswerRefs: [] }), 'application authority projection');
    set(result, 'revision', revision);
    set(result, 'jobIds', get(record, 'jobBindings').map(item => get(object(item, 'job binding'), 'jobId')));
    set(result, 'sensitiveAnswerRefs', get(record, 'sensitiveAnswerBindings').map(item => get(object(item, 'answer binding'), 'answerRef')));
    return result;
}
export function parseApplicationAuthorityOperations(value) {
    return strings(value, 'application authority operations', applicationAuthorityOperations);
}
export function applicationAuthorityInterrupt(value) {
    const interrupts = object(value, 'application authority interrupts');
    if (interrupts.size !== applicationAuthorityInterrupts.size || keys(interrupts).some(key => !applicationAuthorityInterrupts.has(key))
        || keys(interrupts).some(key => typeof get(interrupts, key) !== 'boolean'))
        throw new JobsError('application authority interrupts are invalid');
    for (const [field, reason] of applicationAuthorityInterrupts)
        if (get(interrupts, field) === true)
            return reason;
    return null;
}
export function validateBoundSensitiveAnswer(record, binding) {
    return answerRevision(record) === int(get(binding, 'answerRevision'));
}
export function replaceAuthority(document, record, now) {
    const result = copy(document), previous = activeApplicationAuthority(result);
    if (previous !== null) {
        set(previous, 'status', text('replaced'));
        set(previous, 'terminalAt', text(now));
        set(previous, 'revision', integer(int(get(previous, 'revision')) + 1n));
    }
    const authorities = object(get(result, 'authorities'), 'application authorities');
    set(authorities, string(get(record, 'authorizationId')), record);
    set(result, 'activeAuthorityId', get(record, 'authorizationId'));
    return result;
}
export function consumeAutofillAuthority(document, jobId, now) {
    const validated = validateApplicationAuthorityDocument(document), record = activeApplicationAuthority(validated);
    if (record === null || string(get(record, 'mode')) !== 'autofill_to_review'
        || !get(record, 'jobBindings').some(item => string(get(object(item, 'job binding'), 'jobId')) === jobId))
        return null;
    set(record, 'status', text('consumed'));
    set(record, 'terminalAt', text(now));
    set(record, 'revision', integer(int(get(record, 'revision')) + 1n));
    set(validated, 'activeAuthorityId', null);
    const metadata = object(get(validated, 'metadata'), 'application authority metadata');
    set(metadata, 'revision', integer(int(get(metadata, 'revision')) + 1n));
    set(metadata, 'updatedAt', text(now));
    return validateApplicationAuthorityDocument(validated);
}
