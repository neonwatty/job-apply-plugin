import { PythonObject } from '../python-object.js';
import { fallback } from './answers.js';
import { casefold } from './casefold.js';
import { normalizeMatcherText, matcherTokens } from './answer-match-unicode.js';
import { strip } from './job-url.js';
import { emptyObject } from './jobs.js';
import { get, serialize, string, text } from './values.js';
import { negations, stopWords, synonyms } from './answer-match-vocabulary.js';
export class AnswerMatchError extends Error {
}
export const bandOrder = { exact: 3, high: 2, uncertain: 1, none: 0 };
export function requireText(value, label) {
    const result = string(value);
    if (result === null || !strip(result))
        throw new AnswerMatchError(`${label} is invalid`);
    return result;
}
export function answerMatchKey(record) {
    return requireText(fallback(record, 'answerKey', get(record, 'key')), 'answer key');
}
export function fieldClass(value) {
    const result = string(value);
    if (result === null || !/^[a-z][a-z0-9_]{0,63}$/.test(result) || result.endsWith('\n'))
        throw new AnswerMatchError('field class is invalid');
    return result;
}
export function sensitivity(value) {
    const result = string(value);
    if (!['none', 'personal', 'high'].includes(result))
        throw new AnswerMatchError('sensitivity is invalid');
    return result;
}
export function scopeFingerprint(value) {
    if (!(value instanceof PythonObject))
        throw new AnswerMatchError('scope is invalid');
    try {
        return serialize(value);
    }
    catch {
        throw new AnswerMatchError('scope is invalid');
    }
}
export function rawTokens(question) {
    const normalized = casefold(normalizeMatcherText(requireText(text(question), 'question')));
    return matcherTokens(normalized);
}
export const normalizedText = (question) => rawTokens(question).join(' ');
export const hasNegation = (question) => rawTokens(question).some(token => negations.has(token));
export function features(question) {
    const result = new Set();
    for (const token of rawTokens(question)) {
        if (stopWords.has(token) || negations.has(token))
            continue;
        const canonical = Object.hasOwn(synonyms, token) ? synonyms[token] : token;
        if ([...canonical].length > 2)
            result.add(canonical);
    }
    return result;
}
export function similarity(left, right) {
    const shared = [...left].filter(item => right.has(item)).length;
    if (!left.size || !right.size || !shared)
        return [0, 0];
    return [0.65 * (shared / Math.min(left.size, right.size)) + 0.35 * (shared / new Set([...left, ...right]).size), shared];
}
export function candidateTexts(record) {
    const question = requireText(get(record, 'question'), 'candidate question');
    const aliases = fallback(record, 'aliases', []);
    if (!Array.isArray(aliases) || aliases.some(value => string(value) === null || !strip(string(value))))
        throw new AnswerMatchError('candidate aliases are invalid');
    return [question, ...aliases.map(value => string(value))];
}
export function metadataReasons(record, scope, observedClass, observedSensitivity) {
    const candidateSensitivity = string(fallback(record, 'sensitivity', text('none')));
    if (!['none', 'personal', 'high'].includes(candidateSensitivity))
        throw new AnswerMatchError('candidate sensitivity is invalid');
    return [scopeFingerprint(fallback(record, 'scope', emptyObject())) === scopeFingerprint(scope) ? 'scope_match' : 'scope_mismatch',
        string(get(record, 'fieldClass')) === observedClass ? 'field_class_match' : 'field_class_mismatch',
        candidateSensitivity === observedSensitivity ? 'sensitivity_match' : 'sensitivity_mismatch'];
}
