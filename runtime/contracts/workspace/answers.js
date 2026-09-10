import { createHash } from 'node:crypto';
import { PythonObject } from '../python-object.js';
import { emptyObject } from './jobs.js';
import { copy, get, has, int, integer, keys, object, same, serialize, set, string, text, JobsError } from './values.js';
export const answerStates = new Set(['confirmed', 'inferred', 'missing', 'sensitive']);
export const answerReviews = new Set(['accepted', 'pending', 'declined']);
export const answerSensitivities = new Set(['none', 'personal', 'high']);
export const answerPatchFields = new Set(['question', 'aliases', 'value', 'state', 'source', 'scope', 'fieldClass', 'sensitivity']);
export const fallback = (record, key, value) => has(record, key) ? get(record, key) : value;
export const answerRevision = (record) => int(fallback(record, 'revision', integer(1n)));
export const sensitiveAnswer = (record) => string(get(record, 'state')) === 'sensitive' || string(fallback(record, 'sensitivity', text('none'))) !== 'none';
const whitespace = /[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/u;
export function normalizeAnswerQuestion(question) {
    if (!question.split(whitespace).join(''))
        throw new JobsError('question must be a non-empty string');
    return question.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu, ' ').split(whitespace).filter(Boolean).join(' ');
}
export function answerKey(question, scope = emptyObject()) {
    const normalized = normalizeAnswerQuestion(question);
    if (/[\uD800-\uDFFF]/u.test(normalized))
        throw new JobsError('question contains invalid Unicode');
    return `question.${createHash('sha256').update(`v1\0${normalized}\0${serialize(scope)}`).digest('hex')}`;
}
/** Scope identity treats booleans distinctly while preserving Python numeric equality. */
export function sameAnswerScope(left, right) {
    if (typeof left === 'boolean' || typeof right === 'boolean')
        return left === right;
    if (left instanceof PythonObject && right instanceof PythonObject) {
        return left.size === right.size && left.entries().every(([key, value]) => right.has(key) && sameAnswerScope(value, right.get(key)));
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return left.length === right.length && left.every((value, index) => sameAnswerScope(value, right[index]));
    }
    return same(left, right);
}
export function answerNames(record) {
    const question = string(get(record, 'question'));
    const aliases = fallback(record, 'aliases', []);
    return [question, ...aliases.map(string)].filter((value) => value !== null && Boolean(value.split(whitespace).join(''))).map(normalizeAnswerQuestion);
}
export function normalizeAliases(value) {
    if (!Array.isArray(value) || value.some(alias => string(alias) === null))
        throw new JobsError('answer aliases must be strings');
    return [...new Set(value.map(alias => normalizeAnswerQuestion(string(alias))).filter(Boolean))].map(text);
}
export function validateAnswer(key, value) {
    const record = object(value, 'answer record');
    if (string(get(record, 'key')) !== key)
        throw new JobsError('answer record key does not match its index');
    if (!answerStates.has(string(get(record, 'state'))))
        throw new JobsError('answer record state is unsupported');
    if (!answerReviews.has(string(fallback(record, 'reviewStatus', text('accepted')))))
        throw new JobsError('answer record review status is unsupported');
    if (!answerSensitivities.has(string(fallback(record, 'sensitivity', text('none')))))
        throw new JobsError('answer record sensitivity is unsupported');
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(string(fallback(record, 'fieldClass', text('general'))) ?? ''))
        throw new JobsError('answer record field class is invalid');
    if (get(record, 'question') !== null && string(get(record, 'question')) === null)
        throw new JobsError('answer record question must be a string');
    const aliases = fallback(record, 'aliases', []);
    if (!Array.isArray(aliases) || aliases.some(alias => string(alias) === null))
        throw new JobsError('answer record aliases must be strings');
    object(fallback(record, 'scope', emptyObject()), 'answer record scope');
    const present = get(record, 'value') !== null;
    if (string(get(record, 'state')) === 'confirmed' && !present)
        throw new JobsError('confirmed answer record has no value');
    if (string(get(record, 'state')) === 'missing' && present)
        throw new JobsError('missing answer record contains a value');
    if (present && sensitiveAnswer(record) && !string(get(record, 'rememberedWithConsentAt')))
        throw new JobsError('sensitive answer record has no remember consent marker');
    for (const field of ['source', 'confirmedAt', 'createdAt', 'updatedAt', 'rememberedWithConsentAt', 'deletedAt', 'observedAt', 'lastObservedAt', 'reviewedAt']) {
        if (get(record, field) !== null && string(get(record, field)) === null)
            throw new JobsError(`answer record ${field} must be a string`);
    }
    const revision = int(fallback(record, 'revision', integer(1n)));
    if (revision === null || revision < 1n)
        throw new JobsError('answer revision must be a positive integer');
    const count = int(fallback(record, 'observationCount', integer(0n)));
    if (count === null || count < 0n)
        throw new JobsError('answer observation count must be a non-negative integer');
    return record;
}
export function validateAnswers(value) {
    const document = object(value, 'answers');
    if (int(get(document, 'schemaVersion')) !== 1n)
        throw new JobsError('answers version is unsupported');
    const answers = object(get(document, 'answers'), 'answers.answers');
    object(get(document, 'metadata'), 'answers.metadata');
    for (const key of keys(answers)) {
        if (!key)
            throw new JobsError('answer index keys must be non-empty strings');
        validateAnswer(key, get(answers, key));
    }
    const redirects = object(fallback(document, 'redirects', emptyObject()), 'answer redirects');
    for (const key of keys(redirects)) {
        const redirect = object(get(redirects, key), 'answer redirect');
        const target = string(get(redirect, 'targetKey'));
        if (!key || redirect.size !== 2 || !has(redirect, 'mergedAt') || !target || target === key || has(answers, key) || !has(answers, target) || has(redirects, target) || get(object(get(answers, target), 'answer'), 'deletedAt') !== null)
            throw new JobsError('answer redirect is not flattened to an active answer');
        if (!string(get(redirect, 'mergedAt')))
            throw new JobsError('answer redirect timestamp is invalid');
    }
    return document;
}
export function answerView(record) {
    const result = copy(record);
    for (const [key, value] of [['revision', integer(1n)], ['createdAt', get(record, 'updatedAt')], ['deletedAt', null], ['reviewStatus', text('accepted')], ['observationCount', integer(0n)]]) {
        if (!has(result, key))
            set(result, key, value);
    }
    return result;
}
