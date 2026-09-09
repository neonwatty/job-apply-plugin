import { fallback } from './answers.js';
import { get, int, object, same, string } from './values.js';
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
