import { buildClaimSession } from '../contracts/workspace/claim-session.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { safeId } from '../contracts/workspace/jobs.js';
import { randomUUID } from 'node:crypto';
import { validateHistoryRecord } from './store-history.js';
import { get, object, string, text, fromJSON, JobsError } from '../contracts/workspace/values.js';
const transitions = new Set(['started', 'reviewed']);
const providers = new Set(['ashby', 'greenhouse', 'lever', 'linkedin-easy-apply']);
const lifecycle = new Set(['started', 'progressed', 'reviewed', 'completed', 'abandoned', 'failed',
    'job-started', 'job-restarted', 'legacy-review-rebuild', 'claim-recovered', 'job-blocked']);
function event(value) { return validateHistoryRecord(value); }
function matching(events, id) {
    return events.map(event).filter(item => string(get(item, 'applicationId')) === id && lifecycle.has(string(get(item, 'event'))));
}
function record(id, transition, ats, now, eventId) {
    return validateHistoryRecord(fromJSON({ schemaVersion: 1, eventId, applicationId: id, event: transition,
        ats, status: transition === 'started' ? 'active' : 'review', answerKeys: [], at: now }), true);
}
export class ReplayTransitionService {
    repository;
    now;
    id;
    constructor(repository, now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), id = () => randomUUID()) {
        this.repository = repository;
        this.now = now;
        this.id = id;
    }
    record(applicationId, transition, ats) {
        const id = safeId(applicationId);
        if (!transitions.has(transition))
            throw new JobsError('replay transition is unsupported');
        if (!providers.has(ats))
            throw new JobsError('replay ATS is unsupported');
        return this.repository.replayTransitionTransaction(async (transaction) => {
            const events = matching(await transaction.history(), id);
            if (events.some(item => get(item, 'ats') !== null && string(get(item, 'ats')) !== ats)) {
                throw new JobsError('replay lifecycle ATS does not match');
            }
            const names = events.map(item => string(get(item, 'event')));
            if (names.some(name => ['completed', 'abandoned', 'failed'].includes(name)))
                throw new JobsError('replay lifecycle is terminal');
            const started = names.indexOf('started'), reviewed = names.indexOf('reviewed');
            if (reviewed >= 0 && (started < 0 || reviewed < started))
                throw new JobsError('replay lifecycle is out of order');
            if (transition === 'reviewed' && started < 0)
                throw new JobsError('replay lifecycle has not started');
            const loaded = await transaction.loadSession(id), existing = loaded === null ? null : validateAnswerSession(loaded);
            if (existing !== null) {
                if (get(existing, 'ats') !== null && string(get(existing, 'ats')) !== ats)
                    throw new JobsError('replay session ATS does not match');
                if (['completed', 'abandoned'].includes(string(get(existing, 'status')) ?? ''))
                    throw new JobsError('replay session is terminal');
            }
            const changed = !names.includes(transition);
            if (changed)
                await transaction.appendHistory(record(id, transition, ats, this.now(), this.id()));
            if (existing !== null && transition === 'started' && string(get(existing, 'status')) === 'review') {
                return fromJSON({ applicationId: id, transition, changed });
            }
            const incoming = object(fromJSON({ status: transition === 'reviewed' ? 'review' : 'active', ats,
                step: transition === 'reviewed' ? 'review' : 'application', answerKeys: [], pendingFields: [] }), 'replay session');
            const session = buildClaimSession(id, incoming, { now: this.now(), attemptRevision: null, ats: text(ats), existing,
                answers: await transaction.answers() });
            await transaction.saveSession(id, session);
            return fromJSON({ applicationId: id, transition, changed });
        });
    }
}
