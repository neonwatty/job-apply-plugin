import { randomUUID } from 'node:crypto';
import { activeApplicationRun, currentRunJobIds } from '../contracts/workspace/application-runs.js';
import { activeApplicationAuthority, applicationAuthorityInterrupt, applicationAuthorityModes, applicationAuthorityOperations, applicationAuthorityProjection, applicationOrigin, replaceAuthority, validateApplicationAuthority, validateApplicationAuthorityDocument, validateBoundSensitiveAnswer } from '../contracts/workspace/application-authority.js';
import { answerRevision, sensitiveAnswer } from '../contracts/workspace/answers.js';
import { claimTime } from '../contracts/workspace/claim-time.js';
import { requireClaim } from '../contracts/workspace/claims.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { fromJSON, get, has, int, integer, keys, object, set, string, text, JobsError } from '../contracts/workspace/values.js';
import { preflightJobRecord } from './job-preflight.js';
const doc = (value) => object(fromJSON(value), 'application authority value');
const positive = (value, label, zero = false) => {
    const result = int(value);
    if (result === null || result < (zero ? 0n : 1n))
        throw new JobsError(`${label} must be ${zero ? 'a non-negative' : 'a positive'} integer`);
    return result;
};
function strings(value, label) {
    if (!Array.isArray(value))
        throw new JobsError(`${label} must be a list`);
    const result = value.map(item => string(item));
    if (result.some(item => !item) || new Set(result).size !== result.length)
        throw new JobsError(`${label} is invalid`);
    return result;
}
function exact(record, fields, label) {
    if (record.size !== fields.length || keys(record).some(key => !fields.includes(key)))
        throw new JobsError(`${label} contains unsupported fields`);
}
function currentAnswer(answers, ref) {
    const raw = get(object(get(answers, 'answers'), 'answers'), ref);
    if (raw === null)
        return null;
    const answer = object(raw, 'answer');
    return get(answer, 'deletedAt') === null && string(has(answer, 'reviewStatus') ? get(answer, 'reviewStatus') : text('accepted')) === 'accepted'
        && string(get(answer, 'state')) === 'confirmed' && get(answer, 'value') !== null ? answer : null;
}
export class ApplicationAuthorityService {
    repository;
    now;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z')) {
        this.repository = repository;
        this.now = now;
    }
    status() {
        return this.repository.applicationAuthorityTransaction(async (tx) => applicationAuthorityProjection(tx.authority, this.now()));
    }
    progress() {
        return this.repository.applicationAuthorityTransaction(async (tx) => {
            const projection = applicationAuthorityProjection(tx.authority, this.now()), record = activeApplicationAuthority(tx.authority);
            const result = doc({ mode: string(get(projection, 'mode')), status: string(get(projection, 'status')),
                revision: null, nextJob: null, counts: { ready: 0, inProgress: 0, needsAttention: 0, awaitingReview: 0, unavailable: 0 }, jobs: [] });
            set(result, 'revision', get(projection, 'revision'));
            if (record === null || string(get(projection, 'mode')) === 'guided')
                return result;
            const records = object(get(tx.jobs, 'jobs'), 'jobs'), jobs = [];
            const counts = object(get(result, 'counts'), 'campaign counts');
            const fields = new Map([['ready', 'ready'], ['in_progress', 'inProgress'], ['needs_info', 'needsAttention'], ['awaiting_review', 'awaitingReview']]);
            let next = null;
            for (const binding of get(record, 'jobBindings')) {
                const id = string(get(object(binding, 'job binding'), 'jobId')), raw = get(records, id);
                const status = raw === null ? 'unavailable' : string(get(object(raw, 'job'), 'status'));
                const key = fields.get(status) ?? 'unavailable';
                set(counts, key, integer(int(get(counts, key)) + 1n));
                const item = doc({ jobId: id, status, revision: null });
                if (raw !== null)
                    set(item, 'revision', get(object(raw, 'job'), 'revision'));
                jobs.push(item);
                if (next === null && status === 'ready')
                    next = item;
            }
            set(result, 'jobs', jobs);
            if (next !== null)
                set(result, 'nextJob', next);
            return result;
        });
    }
    set(value, expectedRevision) {
        const input = object(value, 'application authority request');
        exact(input, ['mode', 'runId', 'jobIds', 'sensitiveAnswerRefs', 'durationMinutes'], 'application authority request');
        const mode = string(get(input, 'mode'));
        if (!applicationAuthorityModes.has(mode ?? ''))
            throw new JobsError('application authority mode is invalid');
        const runId = safeId(string(get(input, 'runId'))), ids = strings(get(input, 'jobIds'), 'application authority jobs').map(safeId);
        const sensitiveRefs = strings(get(input, 'sensitiveAnswerRefs'), 'sensitive answer references');
        const duration = positive(get(input, 'durationMinutes'), 'application authority duration');
        if (!ids.length || ids.length > 50 || mode === 'autofill_to_review' && ids.length !== 1 || duration > 1440n) {
            throw new JobsError('application authority scope is invalid');
        }
        return this.repository.applicationAuthorityTransaction(async (tx) => {
            const authority = validateApplicationAuthorityDocument(tx.authority);
            const metadata = object(get(authority, 'metadata'), 'application authority metadata');
            if (int(get(metadata, 'revision')) !== expectedRevision)
                throw new JobsError('application authority revision conflict');
            const run = activeApplicationRun(tx.jobs);
            if (run === null || string(get(run, 'runId')) !== runId)
                throw new JobsError('application authority requires the active application run');
            const runRevision = int(get(run, 'revision')), queue = new Set(currentRunJobIds(run));
            if (ids.some(id => !queue.has(id)))
                throw new JobsError('application authority jobs must belong to the active application run');
            const selection = object(get(run, 'selection'), 'application run selection');
            const resumeId = string(get(selection, 'resumeId')), resumeValue = get(object(get(tx.resumes, 'resumes'), 'resumes'), resumeId);
            if (resumeValue === null)
                throw new JobsError('application authority requires a current managed resume');
            const resume = object(resumeValue, 'resume'), bindings = [];
            if (string(get(resume, 'storageKind')) !== 'managed' || get(resume, 'deletedAt') !== null) {
                throw new JobsError('application authority requires a current managed resume');
            }
            const jobs = object(get(tx.jobs, 'jobs'), 'jobs');
            for (const id of ids) {
                const raw = get(jobs, id);
                if (raw === null)
                    throw new JobsError('application authority job is unavailable');
                const job = object(raw, 'job');
                if (!['ready', 'in_progress'].includes(string(get(job, 'status')))
                    || get(await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs), 'ready') !== true) {
                    throw new JobsError('application authority requires selected Ready or In Progress jobs');
                }
                const binding = doc({ jobId: id, destinationOrigin: applicationOrigin(get(job, 'normalizedUrl')), resumeId,
                    resumeRevision: null, contentRevision: string(get(selection, 'contentRevision')), factRevision: null });
                set(binding, 'resumeRevision', get(resume, 'revision'));
                set(binding, 'factRevision', get(selection, 'factRevision'));
                bindings.push(binding);
            }
            const sensitive = [];
            for (const ref of sensitiveRefs) {
                const answer = currentAnswer(tx.answers, ref);
                if (answer === null || !sensitiveAnswer(answer))
                    throw new JobsError('sensitive answer authority requires an accepted confirmed answer');
                const binding = doc({ answerRef: ref, answerRevision: null });
                set(binding, 'answerRevision', integer(answerRevision(answer)));
                sensitive.push(binding);
            }
            const now = this.now(), expires = new Date(Date.parse(now) + Number(duration) * 60_000).toISOString().replace(/\.\d{3}Z$/u, 'Z');
            const record = doc({ authorizationId: `application-authority-${randomUUID()}`, mode, status: 'active', revision: 1,
                issuedAt: now, expiresAt: expires, terminalAt: null, runId, runRevision: null, jobBindings: [],
                sensitiveAnswerBindings: [] });
            set(record, 'runRevision', integer(runRevision));
            set(record, 'jobBindings', bindings);
            set(record, 'sensitiveAnswerBindings', sensitive);
            validateApplicationAuthority(record);
            const next = replaceAuthority(authority, record, now), revision = expectedRevision + 1n;
            set(metadata, 'revision', integer(revision));
            set(metadata, 'updatedAt', text(now));
            await tx.saveAuthority(next);
            return applicationAuthorityProjection(next, now);
        });
    }
    revoke(expectedRevision) {
        return this.repository.applicationAuthorityTransaction(async (tx) => {
            const authority = validateApplicationAuthorityDocument(tx.authority), metadata = object(get(authority, 'metadata'), 'authority metadata');
            if (int(get(metadata, 'revision')) !== expectedRevision)
                throw new JobsError('application authority revision conflict');
            const record = activeApplicationAuthority(authority);
            if (record === null)
                throw new JobsError('application authority is already Guided');
            const now = this.now();
            set(record, 'status', text('revoked'));
            set(record, 'terminalAt', text(now));
            set(record, 'revision', integer(int(get(record, 'revision')) + 1n));
            set(authority, 'activeAuthorityId', null);
            set(metadata, 'revision', integer(expectedRevision + 1n));
            set(metadata, 'updatedAt', text(now));
            await tx.saveAuthority(authority);
            return applicationAuthorityProjection(authority, now);
        });
    }
    control(action, expectedRevision) {
        return this.repository.applicationAuthorityTransaction(async (tx) => {
            const authority = validateApplicationAuthorityDocument(tx.authority), metadata = object(get(authority, 'metadata'), 'authority metadata');
            if (int(get(metadata, 'revision')) !== expectedRevision)
                throw new JobsError('application authority revision conflict');
            const record = activeApplicationAuthority(authority);
            if (record === null || string(get(record, 'mode')) !== 'campaign_to_review')
                throw new JobsError('campaign authority is not active');
            const current = string(get(record, 'status')), now = this.now();
            if (action === 'pause' && current !== 'active' || action === 'resume' && current !== 'paused'
                || action === 'stop' && !['active', 'paused'].includes(current))
                throw new JobsError(`campaign cannot ${action} from its current state`);
            set(record, 'status', text(action === 'pause' ? 'paused' : action === 'resume' ? 'active' : 'stopped'));
            set(record, 'revision', integer(int(get(record, 'revision')) + 1n));
            if (action === 'stop') {
                set(record, 'terminalAt', text(now));
                set(authority, 'activeAuthorityId', null);
            }
            set(metadata, 'revision', integer(expectedRevision + 1n));
            set(metadata, 'updatedAt', text(now));
            await tx.saveAuthority(authority);
            return applicationAuthorityProjection(authority, now);
        });
    }
    evaluate(value) {
        const input = object(value, 'application authority evaluation');
        exact(input, ['jobId', 'claimToken', 'destinationUrl', 'operations', 'answerRefs', 'sensitiveAnswerRefs', 'interrupts'], 'application authority evaluation');
        const interrupt = applicationAuthorityInterrupt(get(input, 'interrupts'));
        if (interrupt !== null)
            return Promise.resolve(doc({ authorized: false, mode: 'guided', reasonCode: interrupt, interrupt: true }));
        const id = safeId(string(get(input, 'jobId'))), token = get(input, 'claimToken');
        const operations = strings(get(input, 'operations'), 'application authority operations');
        if (operations.some(operation => !applicationAuthorityOperations.has(operation)))
            throw new JobsError('application authority operations are invalid');
        const answerRefs = strings(get(input, 'answerRefs'), 'application answer references');
        const sensitiveRefs = strings(get(input, 'sensitiveAnswerRefs'), 'sensitive answer references');
        return this.repository.applicationAuthorityTransaction(async (tx) => {
            const authority = validateApplicationAuthorityDocument(tx.authority), record = activeApplicationAuthority(authority), now = this.now();
            if (record === null)
                return doc({ authorized: false, mode: 'guided', reasonCode: 'granular_confirmation_required', interrupt: true });
            if (string(get(record, 'status')) !== 'active')
                return doc({ authorized: false, mode: 'guided', reasonCode: 'authority_not_active', interrupt: true });
            if (claimTime(now) >= claimTime(string(get(record, 'expiresAt'))))
                return doc({ authorized: false, mode: 'guided', reasonCode: 'authority_expired', interrupt: true });
            const run = activeApplicationRun(tx.jobs);
            if (run === null || string(get(run, 'runId')) !== string(get(record, 'runId'))
                || int(get(run, 'revision')) !== int(get(record, 'runRevision'))) {
                return doc({ authorized: false, mode: 'guided', reasonCode: 'application_run_changed', interrupt: true });
            }
            const binding = get(record, 'jobBindings').map(item => object(item, 'job binding'))
                .find(item => string(get(item, 'jobId')) === id);
            if (!binding)
                return doc({ authorized: false, mode: 'guided', reasonCode: 'job_out_of_scope', interrupt: true });
            if (applicationOrigin(get(input, 'destinationUrl')) !== string(get(binding, 'destinationOrigin'))) {
                return doc({ authorized: false, mode: 'guided', reasonCode: 'unexpected_destination', interrupt: true });
            }
            try {
                requireClaim(tx.coordinator, tx.jobs, id, token, now);
            }
            catch {
                return doc({ authorized: false, mode: 'guided', reasonCode: 'claim_missing_or_expired', interrupt: true });
            }
            const job = object(get(object(get(tx.jobs, 'jobs'), 'jobs'), id), 'job');
            const ready = await preflightJobRecord(job, tx.profile, tx.resumes, tx.files, tx.facts, tx.requests, tx.jobs);
            const resume = object(get(object(get(tx.resumes, 'resumes'), 'resumes'), string(get(binding, 'resumeId'))), 'resume');
            if (get(ready, 'ready') !== true || int(get(resume, 'revision')) !== int(get(binding, 'resumeRevision'))
                || string(get(resume, 'contentRevision')) !== string(get(binding, 'contentRevision'))) {
                return doc({ authorized: false, mode: 'guided', reasonCode: 'canonical_data_changed', interrupt: true });
            }
            for (const ref of answerRefs) {
                const answer = currentAnswer(tx.answers, ref);
                if (answer === null || sensitiveAnswer(answer))
                    return doc({ authorized: false, mode: 'guided', reasonCode: 'answer_not_confirmed_non_sensitive', interrupt: true });
            }
            const bound = new Map(get(record, 'sensitiveAnswerBindings').map(item => {
                const binding = object(item, 'sensitive answer binding');
                return [string(get(binding, 'answerRef')), binding];
            }));
            for (const ref of sensitiveRefs) {
                const answer = currentAnswer(tx.answers, ref), binding = bound.get(ref);
                if (answer === null || !sensitiveAnswer(answer) || !binding || !validateBoundSensitiveAnswer(answer, binding)) {
                    return doc({ authorized: false, mode: 'guided', reasonCode: 'sensitive_current_use_not_approved', interrupt: true });
                }
            }
            const result = doc({ authorized: true, mode: string(get(record, 'mode')), reasonCode: 'authorized_to_review_boundary',
                interrupt: false, authorizationId: string(get(record, 'authorizationId')), revision: null, operations: operations });
            set(result, 'revision', get(object(get(authority, 'metadata'), 'authority metadata'), 'revision'));
            return result;
        });
    }
}
