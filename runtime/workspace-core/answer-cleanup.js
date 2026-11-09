import { createHash } from 'node:crypto';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fallback } from '../contracts/workspace/answers.js';
import { proposeCleanup } from '../contracts/workspace/answer-match-cleanup.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { strip } from '../contracts/workspace/job-url.js';
import { copy, get, integer, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { semanticCandidate } from './answer-match.js';
/** Called under the repository lock with a validated canonical Answers document. */
export function previewAnswerCleanup(document) {
    const records = object(get(document, 'answers'), 'answers');
    const candidates = records.entries().map(([, value]) => object(value, 'answer'))
        .filter(record => string(get(record, 'key')) !== null && Boolean(strip(string(get(record, 'key'))))
        && string(get(record, 'question')) !== null && Boolean(strip(string(get(record, 'question')))))
        .map(semanticCandidate);
    let proposed;
    try {
        proposed = proposeCleanup(candidates);
    }
    catch {
        throw new JobsError('answer cleanup preview is invalid');
    }
    const revisions = emptyObject();
    for (const [key, value] of records.entries()) {
        revisions.set(key, fallback(object(value, 'answer'), 'revision', integer(1n)));
    }
    const proposals = proposed.map(proposal => {
        const result = copy(proposal);
        for (const side of ['winner', 'duplicate']) {
            const key = string(get(proposal, `${side}Key`));
            set(result, `${side}Revision`, get(revisions, key));
            set(result, `${side}Question`, get(object(get(records, key), 'answer'), 'question'));
        }
        return result;
    });
    const tokenInput = set(set(emptyObject(), 'proposals', proposals), 'revisions', revisions);
    const token = `answer-cleanup-v1.${createHash('sha256').update(canonicalJson(tokenInput, 'answer cleanup preview is invalid'), 'utf8').digest('hex')}`;
    return set(set(set(emptyObject(), 'proposals', proposals), 'previewToken', text(token)), 'mutated', false);
}
