import { PythonObject } from '../python-object.js';
import { fallback } from './answers.js';
import { get, object, set, string, text } from './values.js';
import { validateAnswerSession } from './answer-session-validation.js';
export { validateAnswerSession, safeAnswerSessionId } from './answer-session-validation.js';
function clone(value) {
    if (Array.isArray(value))
        return value.map(clone);
    if (value instanceof PythonObject) {
        const result = new PythonObject();
        for (const [key, item] of value.entries())
            result.set(key, clone(item));
        return result;
    }
    return value;
}
/** Invalidate source-bound decisions; no approval transfers to the winner. */
export function rewriteSessionAnswerKey(session, source, winner, at) {
    validateAnswerSession(session);
    const rewritten = clone(session);
    const keys = fallback(rewritten, 'answerKeys', []).map(key => string(key) === source ? winner : string(key));
    set(rewritten, 'answerKeys', [...new Set(keys)].map(text));
    for (const item of fallback(rewritten, 'pendingFields', [])) {
        const field = object(item, 'pending field');
        if (string(get(field, 'answerKey')) === source) {
            set(field, 'answerKey', text(winner));
            for (const key of ['matchConfidence', 'matchReasonCodes', 'matchAnswerRevision'])
                field.delete(text(key));
        }
    }
    set(rewritten, 'approvals', fallback(rewritten, 'approvals', []).filter(item => string(get(object(item, 'session approval'), 'answerKey')) !== source));
    set(rewritten, 'updatedAt', text(at));
    return validateAnswerSession(rewritten);
}
export function answerReferenceCounts(document, sessions, history) {
    const counts = new Map();
    const redirects = object(fallback(document, 'redirects', new PythonObject()), 'answer redirects');
    const add = (keys, kind) => {
        for (const key of keys) {
            const redirect = get(redirects, key);
            const resolved = redirect === null ? key : string(get(object(redirect, 'answer redirect'), 'targetKey'));
            const count = counts.get(resolved) ?? { sessions: 0n, history: 0n };
            count[kind] += 1n;
            counts.set(resolved, count);
        }
    };
    for (const session of sessions) {
        const keys = new Set(fallback(session, 'answerKeys', []).map(key => string(key)));
        for (const item of fallback(session, 'pendingFields', [])) {
            const key = string(get(object(item, 'pending field'), 'answerKey'));
            if (key !== null)
                keys.add(key);
        }
        add(keys, 'sessions');
    }
    for (const event of history)
        add(new Set(fallback(event, 'answerKeys', []).map(key => string(key))), 'history');
    return counts;
}
