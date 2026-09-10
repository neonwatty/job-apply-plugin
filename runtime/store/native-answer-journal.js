import { validateAnswers } from '../contracts/workspace/answers.js';
import { applyAnswerMerge } from '../contracts/workspace/answer-merge.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { parse, serialize, fromJSON, get, int, keys, object, string, text, JobsError } from '../contracts/workspace/values.js';
export const answerJournalName = 'coordinator-journal';
/** This synthetic fixture supports answer merges, with no active application claim. */
export function validateIdleCoordinator(value) {
    if (value.size !== 2 || int(get(value, 'schemaVersion')) !== 1n || !value.has(text('claim')) || get(value, 'claim') !== null) {
        throw new JobsError('native fixture requires an idle coordinator');
    }
    return value;
}
export function validateAnswerJournal(document) {
    if (document.size !== 2 || int(get(document, 'schemaVersion')) !== 1n || !document.has(text('operation')))
        throw new JobsError('invalid coordinator journal');
    if (get(document, 'operation') === null)
        return document;
    const operation = object(get(document, 'operation'), 'answer merge operation');
    const fields = ['kind', 'operationId', 'at', 'winnerKey', 'sourceKey', 'expectedWinnerRevision', 'expectedSourceRevision', 'sessions', 'resultClaim'];
    if (operation.size !== fields.length || keys(operation).some(key => !fields.includes(key)) || string(get(operation, 'kind')) !== 'answer_merge' || get(operation, 'resultClaim') !== null)
        throw new JobsError('unsupported coordinator operation');
    for (const field of ['operationId', 'at', 'winnerKey', 'sourceKey'])
        if (!string(get(operation, field)))
            throw new JobsError('coordinator answer merge operation is invalid');
    if (string(get(operation, 'winnerKey')) === string(get(operation, 'sourceKey')))
        throw new JobsError('coordinator answer merge identity is invalid');
    for (const field of ['expectedWinnerRevision', 'expectedSourceRevision']) {
        const revision = int(get(operation, field));
        if (revision === null || revision < 1n)
            throw new JobsError('coordinator answer merge revision is invalid');
    }
    const sessions = get(operation, 'sessions');
    if (!Array.isArray(sessions))
        throw new JobsError('coordinator answer merge sessions are invalid');
    const identities = new Set();
    for (const value of sessions) {
        const session = validateAnswerSession(value), id = string(get(session, 'applicationId'));
        if (identities.has(id))
            throw new JobsError('coordinator answer merge sessions are duplicated');
        identities.add(id);
    }
    return document;
}
export class NativeAnswerJournal {
    write;
    constructor(write) {
        this.write = write;
    }
    async recover(journal, answers, sessions) {
        validateAnswerJournal(journal);
        if (get(journal, 'operation') === null)
            return;
        const operation = object(get(journal, 'operation'), 'answer merge operation');
        const next = object(parse(serialize(answers)), 'answers');
        applyAnswerMerge(next, operation);
        validateAnswers(next);
        const known = new Set(sessions.map(session => string(get(session, 'applicationId'))));
        const targets = get(operation, 'sessions');
        for (const session of targets)
            if (!known.has(string(get(session, 'applicationId'))))
                throw new JobsError('coordinator merge references a missing session');
        // Validate all destinations before writing any file. The shared Store lock
        // excludes other native operations until replay and journal clearing finish.
        await this.write('answers', next);
        for (const session of targets)
            await this.write(`sessions/${string(get(session, 'applicationId'))}`, session);
        await this.write('coordinator', object(fromJSON({ schemaVersion: 1, claim: null }), 'coordinator'));
        await this.write(answerJournalName, object(fromJSON({ schemaVersion: 1, operation: null }), 'journal'));
    }
    async commit(operation, answers, sessions) {
        const journal = object(fromJSON({ schemaVersion: 1, operation: null }), 'journal');
        journal.set(text('operation'), operation);
        validateAnswerJournal(journal);
        const known = new Set(sessions.map(session => string(get(session, 'applicationId'))));
        for (const session of get(operation, 'sessions'))
            if (!known.has(string(get(session, 'applicationId'))))
                throw new JobsError('coordinator merge references a missing session');
        // Semantic validation must happen before the journal becomes durable.
        validateAnswers(applyForValidation(answers, operation));
        await this.write(answerJournalName, journal);
        await this.recover(journal, answers, sessions);
    }
}
function applyForValidation(answers, operation) {
    const document = object(parse(serialize(answers)), 'answers');
    applyAnswerMerge(document, operation);
    return document;
}
