import { createHash, randomUUID } from 'node:crypto';
import { answerRevision, fallback } from './answers.js';
import { rankCandidates } from './answer-match-scoring.js';
import { canonicalJson } from './canonical-json.js';
import { casefold } from './casefold.js';
import { strip } from './job-url.js';
import { fields, requireCondition as check } from './answer-session-fields.js';
import { copy, get, object, parse, same, serialize, set, string, text, truth, integer, JobsError } from './values.js';
const empty = () => object(parse('{}'), 'object');
const clone = (value) => parse(serialize(value));
export function claimSessionObject(value, label) {
    try {
        return object(value, label);
    }
    catch {
        throw new JobsError(`${label} must be a JSON object`);
    }
}
export function canonicalClaimAnswer(answers, key) {
    const redirect = get(object(fallback(answers, 'redirects', empty()), 'redirects'), key);
    return redirect === null ? key : string(get(object(redirect, 'redirect'), 'targetKey'));
}
function answerRecord(answers, key) {
    const identity = string(key);
    if (!identity)
        return null;
    const value = get(object(get(answers, 'answers'), 'answers'), canonicalClaimAnswer(answers, identity));
    if (value === null)
        return null;
    const record = object(value, 'answer');
    return get(record, 'deletedAt') === null ? record : null;
}
function identity(field) {
    const result = copy(field);
    for (const name of ['reference', 'matchConfidence', 'matchReasonCodes', 'matchAnswerRevision'])
        result.delete(text(name));
    return canonicalJson(result);
}
function candidate(answer) {
    const result = empty();
    for (const name of ['question', 'state'])
        set(result, name, get(answer, name));
    set(result, 'answerKey', get(answer, 'key'));
    set(result, 'aliases', fallback(answer, 'aliases', []).filter(value => string(value) !== null && Boolean(strip(string(value)))));
    set(result, 'scope', fallback(answer, 'scope', empty()));
    set(result, 'fieldClass', fallback(answer, 'fieldClass', text('general')));
    set(result, 'sensitivity', fallback(answer, 'sensitivity', text('none')));
    set(result, 'recordStatus', text(get(answer, 'deletedAt') === null ? 'active' : 'deleted'));
    set(result, 'reviewStatus', fallback(answer, 'reviewStatus', text('accepted')));
    return set(result, 'valueState', text(get(answer, 'value') !== null ? 'seen' : 'missing'));
}
export function buildClaimPending(incoming, existing, ats, answers) {
    const raw = fallback(incoming, 'pendingFields', []);
    check(Array.isArray(raw), 'session pendingFields must be a list');
    const reusable = new Map();
    for (const value of existing ? fallback(existing, 'pendingFields', []) : []) {
        const field = object(value, 'pending field'), key = identity(field);
        reusable.set(key, [...reusable.get(key) ?? [], string(get(field, 'reference'))]);
    }
    return raw.map(value => {
        const field = claimSessionObject(value, 'pending field');
        check(fields(field, ['question', 'state', 'answerKey', 'sensitive', 'fieldClass', 'scope', 'matchConfidence', 'matchReasonCodes']), 'pending field contains unsupported fields');
        const result = object(clone(field), 'pending field');
        const question = string(get(result, 'question'));
        result.delete(text('question'));
        if (question !== null && strip(question)) {
            const normalized = casefold(question.split(/[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u).filter(Boolean).join(' '));
            set(result, 'questionFingerprint', text(createHash('sha256').update(text(normalized).encodeUtf8()).digest('hex')));
        }
        const scope = get(result, 'scope') ?? (string(ats) ? set(empty(), 'ats', ats) : empty());
        result.delete(text('scope'));
        let scopeObject;
        try {
            scopeObject = object(scope, 'pending field scope');
        }
        catch {
            throw new JobsError('pending field scope must be a JSON object');
        }
        if (truth(scopeObject)) {
            try {
                set(result, 'scopeFingerprint', text(createHash('sha256').update(canonicalJson(scopeObject)).digest('hex')));
            }
            catch {
                throw new JobsError('pending field scope is invalid');
            }
        }
        result.delete(text('matchConfidence'));
        result.delete(text('matchReasonCodes'));
        const answer = answerRecord(answers, get(result, 'answerKey'));
        if (answer !== null && string(get(answer, 'question')) !== null && strip(string(get(answer, 'question'))) && question !== null && strip(question)) {
            try {
                const sensitivity = fallback(answer, 'sensitivity', text('none'));
                const match = rankCandidates({ question: text(question), scope: scopeObject, fieldClass: fallback(result, 'fieldClass', text('general')),
                    sensitivity: string(sensitivity) !== 'none' ? sensitivity : text(get(result, 'sensitive') === true || string(get(result, 'state')) === 'sensitive' ? 'high' : 'none'),
                    candidates: [candidate(answer)], limit: integer(1n) })[0];
                set(result, 'matchConfidence', get(match, 'confidenceBand'));
                set(result, 'matchReasonCodes', get(match, 'reasonCodes'));
            }
            catch {
                throw new JobsError('pending field semantic match is invalid');
            }
        }
        else if (answer !== null) {
            set(result, 'matchConfidence', text('none'));
            set(result, 'matchReasonCodes', [text('no_semantic_match')]);
        }
        if (answer !== null)
            set(result, 'matchAnswerRevision', integer(answerRevision(answer)));
        const references = reusable.get(identity(result));
        return set(result, 'reference', text(references?.shift() ?? `pending_${randomUUID().replaceAll('-', '')}`));
    });
}
export function currentClaimApprovals(existing, pending, answers, attempt) {
    if (existing === null || !same(get(existing, 'attemptRevision'), attempt))
        return [];
    return fallback(existing, 'approvals', []).filter(value => {
        const approval = object(value, 'approval');
        const field = pending.find(item => same(get(item, 'reference'), get(approval, 'reference')));
        const fieldKey = field ? string(get(field, 'answerKey')) : null, approvalKey = string(get(approval, 'answerKey'));
        if (fieldKey === null || approvalKey === null)
            return false;
        const resolved = canonicalClaimAnswer(answers, fieldKey), answer = answerRecord(answers, text(resolved));
        return resolved === canonicalClaimAnswer(answers, approvalKey) && answer !== null && get(answer, 'deletedAt') === null
            && same(integer(answerRevision(answer)), get(approval, 'answerRevision'));
    }).map(clone);
}
