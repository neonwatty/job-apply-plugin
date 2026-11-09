import { createHash } from 'node:crypto';
import { PythonObject } from '../python-object.js';
import { safeAnswerSessionId, validateAnswerSession } from './answer-session-validation.js';
import { fields, member, optionalStrings, requireCondition as check } from './answer-session-fields.js';
import { answerStates } from './answers.js';
import { canonicalJson } from './canonical-json.js';
import { casefold } from './casefold.js';
import { strip } from './job-url.js';
import { copy, fromJSON, get, has, int, integer, object, same, set, string, text, truth, JobsError } from './values.js';
/** Project only in memory, retaining Python's legacy pending validation order. */
function projectReviewSession(raw, ats) {
    const pending = get(raw, 'pendingFields');
    if (!Array.isArray(pending) || !pending.some(value => value instanceof PythonObject && !has(value, 'reference'))) {
        return validateAnswerSession(raw);
    }
    const id = safeAnswerSessionId(get(raw, 'applicationId'));
    check(!pending.some(value => value instanceof PythonObject && has(value, 'reference')), 'legacy and modern pending fields cannot be mixed');
    optionalStrings(raw, ['company', 'role', 'url'], 'session');
    const projected = copy(raw);
    set(projected, 'ats', ats);
    for (const key of ['company', 'role', 'url'])
        projected.delete(text(key));
    const references = new Set();
    const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    const projectedFields = pending.map(value => {
        check(value instanceof PythonObject, 'pending field must be a JSON object');
        const field = object(value, 'pending field');
        check(fields(field, ['question', 'state', 'answerKey', 'sensitive']), 'pending field reference is invalid');
        optionalStrings(field, ['question', 'state', 'answerKey'], 'pending field');
        if (has(field, 'state'))
            check(member(get(field, 'state'), answerStates), 'pending field state is unsupported');
        if (has(field, 'sensitive'))
            check(typeof get(field, 'sensitive') === 'boolean', 'pending field sensitive must be a boolean');
        const candidate = copy(field), question = string(get(candidate, 'question'));
        candidate.delete(text('question'));
        if (question !== null && strip(question)) {
            const normalized = casefold(strip(question).replace(/[\t-\r\x1c-\x20\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu, ' '));
            set(candidate, 'questionFingerprint', text(createHash('sha256').update(normalized).digest('hex')));
        }
        if (string(ats))
            set(candidate, 'scopeFingerprint', text(digest(set(new PythonObject(), 'ats', ats))));
        const identity = set(set(new PythonObject(), 'applicationId', text(id)), 'pendingField', field);
        const reference = `pending_${digest(identity).slice(0, 32)}`;
        check(!references.has(reference), 'pending field references must be unique');
        references.add(reference);
        return set(candidate, 'reference', text(reference));
    });
    return validateAnswerSession(set(projected, 'pendingFields', projectedFields));
}
/** Validate evidence after job/claim guards and before managed-resume preflight.
 * The caller supplies validated job/history records; raw session bytes stay intact.
 */
export function validateReviewRestartEvidence(job, rawSession, history) {
    check(rawSession !== null, 'review restart requires prior review evidence');
    const raw = rawSession;
    const version = int(get(raw, 'schemaVersion'));
    check(version !== null, 'session has no valid schemaVersion');
    check(version <= 1n, `session uses unsupported future schemaVersion ${version}`);
    check(version === 1n, `session uses unsupported schemaVersion ${version}`);
    let session;
    try {
        session = projectReviewSession(raw, get(job, 'ats'));
    }
    catch (error) {
        if (error instanceof JobsError && error.message.endsWith(' must be an object')) {
            throw new JobsError(error.message.replace(' must be an object', ' must be a JSON object'));
        }
        throw error;
    }
    const legacy = !['attemptRevision', 'readiness', 'browserHandoff'].some(key => has(raw, key));
    const complete = string(get(session, 'status')) === 'review'
        && !truth(get(session, 'pendingFields')) && !truth(get(session, 'blockers'));
    const evidenceError = 'review restart requires complete prior review evidence';
    if (legacy) {
        check(complete && string(get(session, 'step')) === 'final_review', evidenceError);
    }
    else {
        const readinessValue = get(session, 'readiness');
        check(complete && same(get(session, 'attemptRevision'), integer(int(get(job, 'revision')) - 1n))
            && readinessValue !== null, evidenceError);
        const readiness = object(readinessValue, 'session readiness');
        check(string(get(readiness, 'status')) === 'ready'
            && string(get(readiness, 'evidenceKind')) === 'agent_attested_current_attempt'
            && same(get(readiness, 'attemptRevision'), get(session, 'attemptRevision'))
            && !truth(get(readiness, 'blockerCodes'))
            && object(get(readiness, 'assertions'), 'session readiness assertions').entries().every(([, value]) => string(value) === 'passed')
            && same(get(session, 'browserHandoff'), fromJSON({ state: 'ready_for_owner', reasonCode: 'final-review-required', revision: 1 })), evidenceError);
    }
    const jobHistory = history.filter(event => same(get(event, 'applicationId'), get(job, 'id')));
    const last = jobHistory.at(-1);
    check(last !== undefined && string(get(last, 'event')) === 'reviewed'
        && string(get(last, 'status')) === 'awaiting_review', 'review restart requires prior reviewed history');
    check(!legacy || !jobHistory.slice(0, -1).some(event => member(get(event, 'event'), ['job-restarted', 'legacy-review-rebuild'])), 'legacy review restart was already used');
    return legacy ? 'legacy-review-rebuild' : 'job-restarted';
}
