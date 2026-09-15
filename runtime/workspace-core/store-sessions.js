import { createHash, randomBytes } from 'node:crypto';
import { safeId } from '../contracts/workspace/jobs.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { casefold } from '../contracts/workspace/casefold.js';
import { copy, fromJSON, get, has, int, keys, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
const statuses = new Set(['active', 'review', 'completed', 'abandoned']);
const inputFields = new Set([
    'applicationId', 'status', 'ats', 'company', 'role', 'url', 'step', 'answerKeys', 'pendingFields',
    'createdAt', 'updatedAt', 'attemptRevision', 'readinessInput', 'blockers', 'browserHandoff',
]);
const legacyPendingFields = new Set(['question', 'state', 'answerKey', 'sensitive']);
const modernFields = new Set([...legacyPendingFields, 'reference', 'fieldClass', 'scopeFingerprint',
    'matchConfidence', 'matchReasonCodes', 'matchAnswerRevision', 'questionFingerprint']);
const agentBlockers = {
    'login-required': 'browser_handoff', 'captcha-required': 'browser_handoff',
    'mfa-required': 'browser_handoff', 'email-verification-required': 'browser_handoff',
    'account-creation-required': 'browser_handoff', 'unsupported-control': 'browser_handoff',
    'browser-state-uncertain': 'browser_handoff', 'consent-required': 'owner_review',
    'owner-input-required': 'information',
};
const handoffReasons = new Set([...Object.keys(agentBlockers), 'none', 'owner-upload-required',
    'final-review-required', 'external-upload-capability-unavailable']);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => canonicalJson(value);
function stringArray(value, error) {
    if (!Array.isArray(value) || value.some(item => string(item) === null))
        throw new JobsError(error);
    return value.map(item => string(item));
}
function jobAllowsMutation(job, deleting = false) {
    return job === null || job.deletedAt !== null || deleting && ['applied', 'closed'].includes(job.status);
}
function readinessBlockerType(code) {
    if (code.includes('upload'))
        return 'upload';
    if (code.includes('validation'))
        return 'validation';
    if (code.includes('final'))
        return 'final_action';
    if (code.includes('inaccessible') || code === 'owner-upload-required')
        return 'browser_handoff';
    return 'readiness';
}
function pendingReference(applicationId, value) {
    return `pending_${hash(JSON.stringify({ applicationId, pendingField: JSON.parse(canonical(value)) })).slice(0, 32)}`;
}
function projectPending(applicationId, raw, reference, legacy, ats) {
    const field = object(raw, 'pending field');
    const allowed = legacy ? legacyPendingFields : modernFields;
    if (keys(field).some(key => !allowed.has(key)))
        throw new JobsError('pending field contains unsupported fields');
    const result = copy(field), question = string(get(result, 'question'));
    if (has(result, 'question'))
        result.delete(text('question'));
    if (question?.trim())
        set(result, 'questionFingerprint', text(hash(casefold(question.trim().replace(/\s+/g, ' ')))));
    if (!has(result, 'scopeFingerprint') && ats) {
        set(result, 'scopeFingerprint', text(hash(canonical(fromJSON({ ats })))));
    }
    if (!has(result, 'reference'))
        set(result, 'reference', text(legacy ? pendingReference(applicationId, raw) : reference()));
    const opaque = string(get(result, 'reference'));
    if (!opaque || !/^pending_[A-Za-z0-9_-]{1,128}$/.test(opaque))
        throw new JobsError('pending field reference is invalid');
    return result;
}
function projectSession(value, expectedId, ats, reference = () => `pending_${randomBytes(16).toString('hex')}`) {
    const source = object(value, 'session'), id = safeId(string(get(source, 'applicationId')));
    if (id !== expectedId)
        throw new JobsError('session application id does not match path');
    const pending = get(source, 'pendingFields');
    if (!Array.isArray(pending))
        throw new JobsError('session pendingFields must be a list');
    const legacy = pending.some(item => !has(object(item, 'pending field'), 'reference'));
    if (legacy && pending.some(item => has(object(item, 'pending field'), 'reference'))) {
        throw new JobsError('legacy and modern pending fields cannot be mixed');
    }
    const result = copy(source);
    for (const key of ['company', 'role', 'url'])
        result.delete(text(key));
    if (ats !== undefined)
        set(result, 'ats', ats === null ? null : text(ats));
    set(result, 'pendingFields', pending.map(item => projectPending(id, item, reference, legacy, string(get(result, 'ats')))));
    return result;
}
export class SessionService {
    repository;
    now;
    reference;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), reference = () => `pending_${randomBytes(16).toString('hex')}`) {
        this.repository = repository;
        this.now = now;
        this.reference = reference;
    }
    save(id, value) {
        id = safeId(id);
        const input = object(value, 'session input');
        if (keys(input).some(key => !inputFields.has(key)))
            throw new JobsError('session contains unsupported fields');
        if (has(input, 'applicationId') && string(get(input, 'applicationId')) !== id)
            throw new JobsError('session application id does not match path');
        const status = has(input, 'status') ? string(get(input, 'status')) : 'active';
        if (!statuses.has(status))
            throw new JobsError('session status is unsupported');
        const answers = has(input, 'answerKeys') ? stringArray(get(input, 'answerKeys'), 'session answerKeys must be strings') : [];
        const pending = has(input, 'pendingFields') ? get(input, 'pendingFields') : [];
        if (!Array.isArray(pending))
            throw new JobsError('session pendingFields must be a list');
        return this.repository.sessionTransaction(async (transaction) => {
            const job = await transaction.canonicalJob(id);
            if (!jobAllowsMutation(job))
                throw new JobsError('canonical job sessions require a coordinator operation');
            const existing = await transaction.load(id), timestamp = this.now();
            const existingDocument = existing === null ? null : object(existing, 'session');
            const result = object(fromJSON({ schemaVersion: 1, applicationId: id, status, answerKeys: answers,
                pendingFields: [], attemptRevision: null, readiness: null, blockers: [], approvals: [],
                browserHandoff: status === 'review'
                    ? { state: 'ready_for_owner', reasonCode: 'final-review-required', revision: 1 }
                    : { state: 'not_required', reasonCode: 'none', revision: 1 },
                createdAt: timestamp, updatedAt: timestamp }), 'session');
            for (const [key, item] of input.entries())
                if (!['applicationId', 'company', 'role', 'url', 'answerKeys', 'pendingFields',
                    'createdAt', 'updatedAt', 'readinessInput', 'blockers', 'browserHandoff'].includes(string(key)))
                    result.set(key, item);
            if (existingDocument !== null) {
                set(result, 'createdAt', get(existingDocument, 'createdAt'));
                if (!has(input, 'ats') && has(existingDocument, 'ats'))
                    set(result, 'ats', get(existingDocument, 'ats'));
            }
            const projected = pending.map(item => projectPending(id, item, this.reference, false, string(get(result, 'ats'))));
            set(result, 'pendingFields', projected);
            const blockers = projected.map(field => {
                const sensitive = get(field, 'sensitive') === true || string(get(field, 'state')) === 'sensitive';
                const blocker = object(fromJSON({ type: 'information', code: sensitive ? 'sensitive-answer-required' : 'answer-required',
                    reference: string(get(field, 'reference')), sensitivity: sensitive ? 'high' : 'none' }), 'session blocker');
                if (has(field, 'fieldClass'))
                    set(blocker, 'fieldClass', get(field, 'fieldClass'));
                return blocker;
            });
            let readiness = null;
            if (has(input, 'readinessInput')) {
                const attempt = int(get(result, 'attemptRevision'));
                if (attempt === null || attempt < 1n)
                    throw new JobsError('readiness requires a current attempt revision');
                readiness = await transaction.recomputeReadiness(get(input, 'readinessInput'), attempt, string(get(result, 'ats')));
                const record = object(readiness, 'session readiness'), codes = get(record, 'blockerCodes');
                if (!Array.isArray(codes) || codes.some(code => string(code) === null))
                    throw new JobsError('session readiness is invalid');
                for (const code of codes.map(code => string(code)))
                    blockers.push(object(fromJSON({ type: readinessBlockerType(code), code }), 'session blocker'));
                const fallback = string(get(record, 'fallbackCode'));
                if (fallback !== null)
                    blockers.push(object(fromJSON({ type: 'browser_handoff', code: fallback }), 'session blocker'));
            }
            else if (existingDocument !== null && int(get(existingDocument, 'attemptRevision')) === int(get(result, 'attemptRevision'))) {
                readiness = get(existingDocument, 'readiness');
            }
            set(result, 'readiness', readiness);
            const supplied = has(input, 'blockers') ? get(input, 'blockers') : [];
            if (!Array.isArray(supplied))
                throw new JobsError('session blockers must be a list');
            for (const raw of supplied) {
                const blocker = object(raw, 'session blocker');
                if (blocker.size !== 2 || keys(blocker).some(key => !['type', 'code'].includes(key))) {
                    throw new JobsError('agent blockers must contain only closed type and code');
                }
                const code = string(get(blocker, 'code')), type = string(get(blocker, 'type'));
                if (code === null || agentBlockers[code] !== type)
                    throw new JobsError('session blocker is invalid');
                blockers.push(copy(blocker));
            }
            set(result, 'blockers', blockers);
            let handoff;
            if (has(input, 'browserHandoff')) {
                handoff = copy(object(get(input, 'browserHandoff'), 'browser handoff'));
                if (handoff.size !== 3 || keys(handoff).some(key => !['state', 'reasonCode', 'revision'].includes(key))) {
                    throw new JobsError('browser handoff contains unsupported fields');
                }
                if (!['not_required', 'required', 'ready_for_owner', 'complete'].includes(string(get(handoff, 'state')) ?? '')
                    || !handoffReasons.has(string(get(handoff, 'reasonCode')) ?? '') || (int(get(handoff, 'revision')) ?? 0n) < 1n) {
                    throw new JobsError('browser handoff is invalid');
                }
            }
            else {
                const fallback = readiness === null ? null : string(get(object(readiness, 'session readiness'), 'fallbackCode'));
                const browser = blockers.find(blocker => string(get(blocker, 'type')) === 'browser_handoff');
                handoff = object(fromJSON(fallback !== null
                    ? { state: 'required', reasonCode: fallback, revision: 1 }
                    : browser ? { state: 'required', reasonCode: string(get(browser, 'code')), revision: 1 }
                        : status === 'review' ? { state: 'ready_for_owner', reasonCode: 'final-review-required', revision: 1 }
                            : { state: 'not_required', reasonCode: 'none', revision: 1 }), 'browser handoff');
            }
            if (blockers.some(blocker => string(get(blocker, 'type')) === 'browser_handoff')
                && string(get(handoff, 'state')) !== 'required')
                throw new JobsError('browser handoff contradicts browser blockers');
            set(result, 'browserHandoff', handoff);
            await transaction.save(id, result);
            return copy(result);
        });
    }
    load(id) {
        id = safeId(id);
        return this.repository.sessionTransaction(async (transaction) => {
            const raw = await transaction.load(id);
            if (raw === null)
                throw new JobsError('session does not exist');
            const job = await transaction.canonicalJob(id);
            return projectSession(raw, id, job?.ats, this.reference);
        });
    }
    list() {
        return this.repository.sessionTransaction(async (transaction) => {
            const records = await transaction.list(), result = [];
            for (const [id, raw] of records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
                const job = await transaction.canonicalJob(id);
                result.push(projectSession(raw, id, job?.ats, this.reference));
            }
            return result;
        });
    }
    delete(id) {
        id = safeId(id);
        return this.repository.sessionTransaction(async (transaction) => {
            if (!jobAllowsMutation(await transaction.canonicalJob(id), true))
                throw new JobsError('canonical job sessions require a coordinator operation');
            return object(fromJSON({ deleted: await transaction.delete(id), applicationId: id }), 'session deletion');
        });
    }
}
