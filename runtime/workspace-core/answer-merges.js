import { randomUUID, timingSafeEqual } from 'node:crypto';
import { applyAnswerMerge } from '../contracts/workspace/answer-merge.js';
import { answerReferenceCounts, rewriteSessionAnswerKey } from '../contracts/workspace/answer-sessions.js';
import { validateAnswers } from '../contracts/workspace/answers.js';
import { parse, serialize, fromJSON, get, has, int, integer, keys, object, same, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { answerProjection } from './answers.js';
import { previewAnswerCleanup } from './answer-cleanup.js';
export class AnswerMergeService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    approve(incoming, ownerConfirmed) {
        const packet = object(incoming, 'answer cleanup approval');
        const fields = ['previewToken', 'winnerKey', 'duplicateKey', 'winnerRevision', 'duplicateRevision'];
        if (packet.size !== fields.length || keys(packet).some(key => !fields.includes(key)) || ownerConfirmed !== true || string(get(packet, 'previewToken')) === null)
            throw new JobsError('answer cleanup requires explicit owner approval');
        return this.merge(string(get(packet, 'winnerKey')), string(get(packet, 'duplicateKey')), int(get(packet, 'winnerRevision')), int(get(packet, 'duplicateRevision')), packet)
            .then(result => set(set(object(fromJSON({}), 'result'), 'approved', true), 'result', result));
    }
    async merge(winnerKey, sourceKey, winnerRevision, sourceRevision, approval = null) {
        if (typeof winnerKey !== 'string' || !winnerKey || typeof sourceKey !== 'string' || !sourceKey)
            throw new JobsError('answer merge keys must be non-empty strings');
        if (winnerKey === sourceKey)
            throw new JobsError('answer merge requires distinct records');
        if (typeof winnerRevision !== 'bigint' || winnerRevision < 1n || typeof sourceRevision !== 'bigint' || sourceRevision < 1n)
            throw new JobsError('answer merge revisions must be positive integers');
        if (!this.repository.answerMergeTransaction)
            throw new JobsError('answer merge requires coordinator support');
        return this.repository.answerMergeTransaction(async (transaction) => {
            const document = validateAnswers(transaction.document);
            if (approval) {
                const preview = object(previewAnswerCleanup(document), 'cleanup preview');
                const actual = Buffer.from(string(get(preview, 'previewToken')), 'utf8'), supplied = Buffer.from(string(get(approval, 'previewToken')), 'utf8');
                if (actual.length !== supplied.length || !timingSafeEqual(actual, supplied))
                    throw new JobsError('answer cleanup preview is stale');
                const selected = get(preview, 'proposals').some(proposal => ['winnerKey', 'duplicateKey', 'winnerRevision', 'duplicateRevision'].every(key => same(get(proposal, key), get(approval, key))));
                if (!selected)
                    throw new JobsError('answer cleanup selection is not in the preview');
            }
            const redirects = get(document, 'redirects');
            if (redirects !== null && (has(object(redirects, 'redirects'), winnerKey) || has(object(redirects, 'redirects'), sourceKey)))
                throw new JobsError('answer merge records must be canonical active records');
            const answers = object(get(document, 'answers'), 'answers');
            if (!has(answers, winnerKey) || !has(answers, sourceKey))
                throw new JobsError('answer merge record does not exist');
            const at = this.now();
            const operation = object(fromJSON({ kind: 'answer_merge', operationId: randomUUID().replaceAll('-', ''), at, winnerKey, sourceKey, sessions: [], resultClaim: null }), 'merge operation');
            set(operation, 'expectedWinnerRevision', integer(winnerRevision));
            set(operation, 'expectedSourceRevision', integer(sourceRevision));
            const projected = object(parse(serialize(document)), 'answers'), merged = applyAnswerMerge(projected, operation);
            const sessions = transaction.sessions.map(session => {
                const references = get(session, 'answerKeys'), pending = get(session, 'pendingFields');
                const used = Array.isArray(references) && references.some(key => string(key) === sourceKey)
                    || Array.isArray(pending) && pending.some(field => string(get(object(field, 'pending field'), 'answerKey')) === sourceKey);
                return used ? rewriteSessionAnswerKey(session, sourceKey, winnerKey, at) : session;
            });
            set(operation, 'sessions', sessions.filter((session, index) => session !== transaction.sessions[index]));
            const counts = answerReferenceCounts(projected, sessions, transaction.history);
            await transaction.commit(operation);
            return set(answerProjection(merged, counts), 'mergedFrom', text(sourceKey));
        });
    }
}
