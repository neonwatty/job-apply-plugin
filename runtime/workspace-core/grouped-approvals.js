import { createHash, timingSafeEqual } from 'node:crypto';
import { answerRevision, fallback } from '../contracts/workspace/answers.js';
import { sessionRevision } from '../contracts/workspace/answer-resolution.js';
import { matches, pendingReference } from '../contracts/workspace/answer-session-fields.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { evaluateReuse } from '../contracts/workspace/answer-match-reuse.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { canonicalClaimAnswer, claimSessionObject, currentClaimApprovals } from '../contracts/workspace/claim-session-pending.js';
import { emptyObject, safeId } from '../contracts/workspace/jobs.js';
import { get, integer, keys, object, parse, same, serialize, set, string, text, truth, JobsError } from '../contracts/workspace/values.js';
import { semanticCandidate } from './answer-match.js';
const decisionFields = ['reference', 'answerKey', 'currentUse', 'remember', 'policyMode', 'useAuthority', 'allowedSensitiveFieldClasses'];
const clone = (value) => parse(serialize(value));
const fingerprint = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');
function equalToken(left, right) {
    const a = Buffer.from(left), b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}
function answerRecord(answers, key) {
    const value = get(object(get(answers, 'answers'), 'answers'), canonicalClaimAnswer(answers, key));
    if (value === null)
        return null;
    const answer = object(value, 'answer');
    return get(answer, 'deletedAt') === null ? answer : null;
}
function pendingFields(session) {
    return new Map(fallback(session, 'pendingFields', []).map(field => [string(get(field, 'reference')), field]));
}
function projectDecision(raw, pending, answers, seen) {
    const decision = claimSessionObject(raw, 'grouped approval decision');
    if (decision.size !== decisionFields.length || keys(decision).some(key => !decisionFields.includes(key))) {
        throw new JobsError('grouped approval decision contains unsupported fields');
    }
    const answerKey = string(get(decision, 'answerKey'));
    if (!answerKey)
        throw new JobsError('grouped approval answer key is invalid');
    const reference = string(get(decision, 'reference'));
    if (reference === null || !matches(get(decision, 'reference'), pendingReference) || seen.has(reference) || !pending.has(reference)) {
        throw new JobsError('grouped approval reference is invalid');
    }
    seen.add(reference);
    const currentUse = get(decision, 'currentUse'), remember = get(decision, 'remember');
    if (typeof currentUse !== 'boolean' || typeof remember !== 'boolean')
        throw new JobsError('grouped approval decisions must be booleans');
    if (!currentUse && string(get(decision, 'useAuthority')) !== 'none')
        throw new JobsError('denied current use cannot carry reuse authority');
    const answer = answerRecord(answers, answerKey);
    if (answer === null)
        throw new JobsError('grouped approval answer is unavailable');
    const field = pending.get(reference), boundKey = string(get(field, 'answerKey'));
    if (boundKey === null || canonicalClaimAnswer(answers, boundKey) !== string(get(answer, 'key'))) {
        throw new JobsError('grouped approval answer does not match pending field');
    }
    const answerSensitivity = fallback(answer, 'sensitivity', text('none'));
    const sensitivity = string(answerSensitivity) !== 'none' ? answerSensitivity
        : text(get(field, 'sensitive') === true || string(get(field, 'state')) === 'sensitive' ? 'high' : 'none');
    if (!same(get(field, 'matchAnswerRevision'), integer(answerRevision(answer))))
        throw new JobsError('pending field semantic match is stale');
    const candidate = semanticCandidate(answer), match = emptyObject();
    set(match, 'answerKey', get(answer, 'key'));
    set(match, 'confidenceBand', fallback(field, 'matchConfidence', text('none')));
    set(match, 'reasonCodes', truth(get(field, 'matchReasonCodes')) ? get(field, 'matchReasonCodes') : [text('no_semantic_match')]);
    let policy;
    try {
        policy = evaluateReuse({ match, candidate, scope: fallback(answer, 'scope', emptyObject()),
            fieldClass: fallback(field, 'fieldClass', text('general')), sensitivity,
            mode: get(decision, 'policyMode'), useAuthority: get(decision, 'useAuthority'),
            allowedSensitiveFieldClasses: get(decision, 'allowedSensitiveFieldClasses') });
    }
    catch {
        throw new JobsError('grouped approval policy is invalid');
    }
    let reasons = get(policy, 'reasonCodes');
    if (!equalToken(fingerprint(fallback(answer, 'scope', emptyObject())), string(fallback(field, 'scopeFingerprint', text(fingerprint(emptyObject())))))) {
        reasons = reasons.filter(code => !['reuse_eligible', 'scope_match'].includes(string(code)));
        if (!reasons.some(code => string(code) === 'scope_mismatch'))
            reasons.push(text('scope_mismatch'));
    }
    const result = emptyObject();
    for (const name of ['reference', 'currentUse', 'remember', 'policyMode', 'useAuthority'])
        set(result, name, get(decision, name));
    set(result, 'answerKey', get(answer, 'key'));
    set(result, 'eligible', currentUse && reasons.some(code => string(code) === 'reuse_eligible'));
    set(result, 'confidenceBand', get(policy, 'confidenceBand'));
    set(result, 'reasonCodes', reasons);
    return set(result, 'answerRevision', integer(answerRevision(answer)));
}
/** Field-scoped reuse decisions expose metadata only and write only the bound session. */
export class GroupedApprovalsService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    preview(jobId, jobRevision, expectedSessionRevision, decisions) {
        safeId(jobId);
        if (!Array.isArray(decisions) || !decisions.length)
            throw new JobsError('grouped approval requires at least one field decision');
        return this.repository.groupedApprovalTransaction(async (transaction) => {
            const rawJob = get(object(get(transaction.jobs, 'jobs'), 'jobs'), jobId);
            if (rawJob === null || get(object(rawJob, 'job'), 'deletedAt') !== null)
                throw new JobsError('grouped approval job does not exist');
            if (answerRevision(object(rawJob, 'job')) !== jobRevision)
                throw new JobsError('job revision conflict');
            const session = transaction.sessions.find(item => string(get(item, 'applicationId')) === jobId);
            if (!session)
                throw new JobsError('grouped approval session does not exist');
            if (sessionRevision(session) !== expectedSessionRevision)
                throw new JobsError('session revision conflict');
            const pending = pendingFields(session), seen = new Set();
            const approvals = decisions.map(raw => projectDecision(raw, pending, transaction.answers, seen));
            approvals.sort((a, b) => string(get(a, 'reference')) < string(get(b, 'reference')) ? -1 : 1);
            const result = set(emptyObject(), 'jobRevision', integer(jobRevision));
            set(result, 'sessionRevision', integer(expectedSessionRevision));
            set(result, 'approvals', approvals);
            set(result, 'previewToken', text(`grouped-approval-v1.${fingerprint(result)}`));
            return set(result, 'mutated', false);
        });
    }
    async approve(jobId, jobRevision, expectedSessionRevision, decisions, previewToken, ownerConfirmed = false) {
        if (ownerConfirmed !== true)
            throw new JobsError('grouped approval requires explicit owner confirmation');
        const preview = await this.preview(jobId, jobRevision, expectedSessionRevision, decisions);
        if (typeof previewToken !== 'string' || !equalToken(previewToken, string(get(preview, 'previewToken'))))
            throw new JobsError('grouped approval preview is stale');
        // Reacquire the lock and recheck every bound identity before applying the preview.
        return this.repository.groupedApprovalTransaction(async (transaction) => {
            const rawJob = get(object(get(transaction.jobs, 'jobs'), 'jobs'), jobId);
            const session = transaction.sessions.find(item => string(get(item, 'applicationId')) === jobId);
            if (rawJob === null || answerRevision(object(rawJob, 'job')) !== jobRevision || !session)
                throw new JobsError('grouped approval state changed');
            if (sessionRevision(session) !== expectedSessionRevision)
                throw new JobsError('session revision conflict');
            const pending = pendingFields(session), projected = get(preview, 'approvals');
            const byReference = new Map(projected.map(approval => [string(get(approval, 'reference')), approval]));
            for (const decision of decisions) {
                const reference = string(get(decision, 'reference')), field = pending.get(reference);
                const answer = answerRecord(transaction.answers, string(get(decision, 'answerKey')));
                if (!field || !answer)
                    throw new JobsError('grouped approval state changed');
                const boundKey = string(get(field, 'answerKey'));
                if (boundKey === null || canonicalClaimAnswer(transaction.answers, boundKey) !== string(get(answer, 'key'))
                    || !same(integer(answerRevision(answer)), get(byReference.get(reference), 'answerRevision')))
                    throw new JobsError('grouped approval state changed');
            }
            const updated = object(clone(session), 'session');
            const approvals = new Map(currentClaimApprovals(session, [...pending.values()], transaction.answers, get(session, 'attemptRevision'))
                .map(value => [string(get(object(value, 'approval'), 'reference')), value]));
            for (const approval of projected)
                approvals.set(string(get(approval, 'reference')), clone(approval));
            set(updated, 'approvals', [...approvals.keys()].sort().map(reference => approvals.get(reference)));
            set(updated, 'updatedAt', text(this.now()));
            validateAnswerSession(updated);
            await transaction.saveSession(updated);
            const result = set(emptyObject(), 'approved', true);
            set(result, 'sessionRevision', integer(sessionRevision(updated)));
            return set(result, 'approvals', clone(get(updated, 'approvals')));
        });
    }
}
