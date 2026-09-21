import { createHash } from 'node:crypto';
import { answerStates, fallback } from './answers.js';
import { canonicalJson } from './canonical-json.js';
import { casefold } from './casefold.js';
import { copy, fromJSON, get, has, int, object, parse, same, serialize, set, string, text, JobsError } from './values.js';
import { agentCodes, fields, matches, member, optionalStrings, positive, readinessCodes, requireCondition as check, validateApprovals, validateBlockers, validatePendingFields, } from './answer-session-fields.js';
export function safeAnswerSessionId(value) {
    const id = string(value);
    check(matches(value, /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u) && !id.includes('..'), 'application id contains unsupported characters');
    return id;
}
function validateReadiness(value, attempt) {
    const readiness = object(value, 'session readiness');
    check(fields(readiness, ['status', 'evidenceKind', 'attemptRevision', 'observationRevision', 'controlSetFingerprint', 'requiredControlCount', 'assertions', 'blockerCodes', 'fallbackCode'], true), 'session readiness contains unsupported fields');
    check(member(get(readiness, 'status'), ['ready', 'blocked']) && member(get(readiness, 'evidenceKind'), ['agent_attested_current_attempt', 'repository_replay']), 'session readiness is invalid');
    check(same(get(readiness, 'attemptRevision'), attempt), 'session readiness is not bound to this attempt');
    check(positive(get(readiness, 'observationRevision')), 'session readiness observation revision is invalid');
    check(matches(get(readiness, 'controlSetFingerprint'), /^sha256:[0-9a-f]{64}$/u) && positive(get(readiness, 'requiredControlCount')), 'session readiness form manifest is invalid');
    const assertions = object(get(readiness, 'assertions'), 'session readiness assertions');
    check(fields(assertions, ['observation-current', 'adapter-accessible', 'required-controls-complete', 'required-uploads-accepted', 'validation-clear', 'final-control-available', 'final-action-untouched'], true) && assertions.entries().every(([, item]) => member(item, ['passed', 'failed'])), 'session readiness assertions are invalid');
    const blockers = get(readiness, 'blockerCodes');
    check(Array.isArray(blockers) && blockers.every(code => member(code, readinessCodes)) && new Set(blockers.map(string)).size === blockers.length, 'session readiness blockers are invalid');
    const codes = blockers.map(string);
    check(get(readiness, 'fallbackCode') === null || string(get(readiness, 'fallbackCode')) === 'owner-upload-required', 'session readiness fallback is invalid');
    const ready = string(get(readiness, 'status')) === 'ready';
    const allPassed = assertions.entries().every(([, item]) => string(item) === 'passed');
    check(ready === allPassed && (ready ? codes.length === 0 : codes.length > 0), 'session readiness state is inconsistent');
    const uploadFallback = string(get(readiness, 'fallbackCode')) === 'owner-upload-required';
    check(uploadFallback === codes.includes('external-upload-capability-unavailable') && (!uploadFallback || codes.includes('required-upload-missing')), 'session readiness fallback is inconsistent');
}
function validateHandoff(value) {
    const handoff = object(value, 'browser handoff');
    check(fields(handoff, ['state', 'reasonCode', 'revision'], true), 'browser handoff contains unsupported fields');
    const state = string(get(handoff, 'state'));
    const reason = string(get(handoff, 'reasonCode'));
    const requiredReasons = [...agentCodes, 'owner-upload-required', 'form-observation-inaccessible', 'required-control-inaccessible'];
    check((state === 'not_required' || state === 'complete') ? reason === 'none' : state === 'ready_for_owner' ? reason === 'final-review-required' : state === 'required' && requiredReasons.includes(reason), 'browser handoff is invalid');
    check(positive(get(handoff, 'revision')), 'browser handoff revision is invalid');
}
/** Preserve the existing session schema, including its optional legacy fields. */
export function validateAnswerSession(value) {
    const session = object(value, 'session');
    validateVersion(session, 'session');
    check(fields(session, ['schemaVersion', 'applicationId', 'status', 'ats', 'company', 'role', 'url', 'step', 'answerKeys', 'pendingFields', 'attemptRevision', 'readiness', 'blockers', 'approvals', 'browserHandoff', 'createdAt', 'updatedAt']), 'session contains unsupported fields');
    safeAnswerSessionId(get(session, 'applicationId'));
    check(member(get(session, 'status'), ['active', 'review', 'completed', 'abandoned']), 'session status is unsupported');
    const answerKeys = fallback(session, 'answerKeys', []);
    check(Array.isArray(answerKeys) && answerKeys.every(key => string(key) !== null), 'session answerKeys must be strings');
    validatePendingFields(fallback(session, 'pendingFields', []));
    const attempt = get(session, 'attemptRevision');
    if (attempt !== null)
        check(positive(attempt), 'session attempt revision is invalid');
    if (get(session, 'readiness') !== null)
        validateReadiness(get(session, 'readiness'), attempt);
    validateBlockers(fallback(session, 'blockers', []));
    validateApprovals(fallback(session, 'approvals', []));
    if (get(session, 'browserHandoff') !== null)
        validateHandoff(get(session, 'browserHandoff'));
    optionalStrings(session, ['applicationId', 'status', 'ats', 'company', 'role', 'url', 'step', 'createdAt', 'updatedAt'], 'session');
    return session;
}
const legacyPendingFields = ['question', 'state', 'answerKey', 'sensitive'];
const clone = (value) => parse(serialize(value));
const hash = (value) => createHash('sha256').update(value).digest('hex');
function projectLegacyPending(applicationId, value, ats) {
    let field;
    try {
        field = object(value, 'pending field');
    }
    catch {
        throw new JobsError('pending field must be a JSON object');
    }
    check(fields(field, legacyPendingFields), 'pending field reference is invalid');
    optionalStrings(field, ['question', 'state', 'answerKey'], 'pending field');
    if (has(field, 'state'))
        check(member(get(field, 'state'), answerStates), 'pending field state is unsupported');
    if (has(field, 'sensitive'))
        check(typeof get(field, 'sensitive') === 'boolean', 'pending field sensitive must be a boolean');
    const result = object(clone(field), 'pending field'), question = string(get(result, 'question'));
    result.delete(text('question'));
    if (question !== null && question.trim()) {
        const normalized = casefold(question.trim().replace(/\s+/gu, ' '));
        set(result, 'questionFingerprint', text(hash(normalized)));
    }
    if (string(ats))
        set(result, 'scopeFingerprint', text(hash(canonicalJson(object(fromJSON({ ats: string(ats) }), 'scope')))));
    const identity = canonicalJson(fromJSON({ applicationId, pendingField: JSON.parse(serialize(field)) }));
    return set(result, 'reference', text(`pending_${hash(identity).slice(0, 32)}`));
}
/** Validate a stored session after projecting the all-legacy pending-field shape in memory. */
export function projectStoredAnswerSession(value, expectedId, expectedAts) {
    const source = object(value, 'session'), raw = fallback(source, 'pendingFields', []);
    check(Array.isArray(raw), 'session pendingFields must be a list');
    const pending = raw, legacy = pending.some(item => !has(object(item, 'pending field'), 'reference'));
    if (!legacy) {
        const validated = validateAnswerSession(source);
        check(expectedId === undefined || string(get(validated, 'applicationId')) === expectedId, 'session application id does not match path');
        return validated;
    }
    check(!pending.some(item => has(object(item, 'pending field'), 'reference')), 'legacy and modern pending fields cannot be mixed');
    const id = safeAnswerSessionId(get(source, 'applicationId'));
    check(expectedId === undefined || id === expectedId, 'session application id does not match path');
    const result = copy(source), ats = expectedAts === undefined ? get(result, 'ats')
        : expectedAts === null ? null : text(expectedAts);
    if (expectedAts !== undefined)
        set(result, 'ats', ats);
    for (const key of ['company', 'role', 'url'])
        result.delete(text(key));
    set(result, 'pendingFields', pending.map(item => projectLegacyPending(id, item, ats)));
    return validateAnswerSession(result);
}
/** Validate persisted value-free history, permitting future event identifiers. */
export function validateAnswerHistory(value) {
    const event = object(value, 'history event');
    validateVersion(event, 'history');
    check(fields(event, ['schemaVersion', 'eventId', 'applicationId', 'event', 'company', 'role', 'ats', 'status', 'answerKeys', 'at']), 'history event contains unsupported fields');
    safeAnswerSessionId(get(event, 'applicationId'));
    check(matches(get(event, 'event'), /^[a-z][a-z0-9-]{0,63}$/u), 'history event type is invalid');
    check(Boolean(string(get(event, 'eventId'))), 'history event id is invalid');
    check(Boolean(string(get(event, 'at'))), 'history event timestamp is invalid');
    const answerKeys = get(event, 'answerKeys');
    check(Array.isArray(answerKeys) && answerKeys.every(key => string(key) !== null), 'history answerKeys list is invalid');
    optionalStrings(event, ['company', 'role', 'ats', 'status'], 'history event');
    return event;
}
function validateVersion(document, label) {
    const version = int(get(document, 'schemaVersion'));
    check(version !== null, `${label} has no valid schemaVersion`);
    check(version <= 1n, `${label} uses unsupported future schemaVersion ${version}`);
    check(version === 1n, `${label} uses unsupported schemaVersion ${version}`);
}
