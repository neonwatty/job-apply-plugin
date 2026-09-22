import { get, has, int, keys, object, set, string, text } from '../contracts/workspace/values.js';
import { attemptDocument, attemptHeartbeatMilliseconds, attemptSuccess } from './attempt-protocol.js';
const defaultTimers = {
    every: (callback, milliseconds) => setInterval(() => { void callback(); }, milliseconds),
    cancel: handle => clearInterval(handle),
};
function exact(request, expected) {
    if (keys(request).sort().join('\n') !== expected.sort().join('\n'))
        throw new Error('invalid request');
}
function projection(value, fields) {
    const input = object(value, 'projection'), output = attemptDocument({});
    for (const key of fields)
        if (has(input, key))
            set(output, key, get(input, key));
    return output;
}
export class AttemptAuthority {
    application;
    #service;
    #options;
    #timers;
    #timer;
    #token = null;
    #jobId = null;
    #revision = null;
    #closed = false;
    #pending = Promise.resolve();
    constructor(service, options = {}, application) {
        this.application = application;
        this.#service = service;
        this.#options = options;
        this.#timers = options.timers ?? defaultTimers;
    }
    /** Serialize timer and client mutations without exposing the private capability. */
    #serial(operation) {
        const result = this.#pending.then(operation);
        this.#pending = result.then(() => { }, () => { });
        return result;
    }
    acquire(request) {
        return this.#serial(async () => {
            if (this.#closed || this.#jobId !== null)
                throw new Error('attempt already acquired');
            const command = string(get(request, 'command'));
            exact(request, ['command', 'id', 'owner', 'expectedRevision', ...(command === 'restart-review' ? ['ownerConfirmedNotSubmitted'] : [])]);
            const id = string(get(request, 'id')), revision = int(get(request, 'expectedRevision'));
            if (!id || revision === null || !['start', 'restart-review'].includes(command ?? ''))
                throw new Error('invalid request');
            const acquired = object(command === 'start'
                ? await this.#service.acquire(id, get(request, 'owner'), revision)
                : await this.#service.restart(id, get(request, 'owner'), revision, get(request, 'ownerConfirmedNotSubmitted') === true), 'acquisition');
            this.#jobId = id;
            this.#token = get(acquired, 'token');
            this.#revision = int(get(object(get(acquired, 'job'), 'job'), 'revision'));
            const attempt = attemptDocument({});
            set(attempt, 'job', projection(get(acquired, 'job'), ['id', 'revision', 'url']));
            set(attempt, 'resume', projection(get(acquired, 'resume'), ['id', 'revision', 'contentRevision', 'digest', 'path']));
            this.#timer = this.#timers.every(async () => {
                try {
                    await this.#serial(() => this.#heartbeat());
                }
                catch {
                    await this.close();
                    this.#options.onHeartbeatFailure?.();
                }
            }, this.#options.heartbeatMilliseconds ?? attemptHeartbeatMilliseconds);
            return set(attemptSuccess('acquired'), 'attempt', attempt);
        });
    }
    #active() {
        if (this.#closed || this.#token === null || this.#jobId === null)
            throw new Error('attempt is not active');
    }
    async #heartbeat() {
        this.#active();
        await this.#service.heartbeat(this.#jobId, this.#token);
    }
    dispatch(request) {
        return this.#serial(async () => {
            this.#active();
            const command = string(get(request, 'command'));
            if (command === 'heartbeat') {
                exact(request, ['command']);
                await this.#heartbeat();
                return { response: attemptSuccess('heartbeat'), complete: false };
            }
            if (command === 'progress') {
                exact(request, ['command', 'session']);
                await this.#service.progress(this.#jobId, this.#token, object(get(request, 'session'), 'session'));
                return { response: attemptSuccess('progress_saved'), complete: false };
            }
            if (command === 'authority-evaluate') {
                exact(request, ['command', 'evaluation']);
                if (!this.application)
                    throw new Error('application authority is unavailable');
                const incoming = object(get(request, 'evaluation'), 'evaluation'), evaluation = attemptDocument({});
                for (const field of ['destinationUrl', 'operations', 'answerRefs', 'sensitiveAnswerRefs', 'interrupts']) {
                    if (!has(incoming, field))
                        throw new Error('invalid request');
                    set(evaluation, field, get(incoming, field));
                }
                if (incoming.size !== 5)
                    throw new Error('invalid request');
                set(evaluation, 'jobId', text(this.#jobId));
                set(evaluation, 'claimToken', this.#token);
                const response = attemptSuccess('authority_evaluated');
                set(response, 'decision', await this.application.evaluate(evaluation));
                return { response, complete: false };
            }
            if (command === 'handoff') {
                exact(request, ['command', 'status', 'session']);
                const status = string(get(request, 'status'));
                if (!['needs_info', 'awaiting_review'].includes(status ?? ''))
                    throw new Error('invalid request');
                await this.#service.handoff(this.#jobId, this.#token, status, object(get(request, 'session'), 'session'), this.#revision);
                await this.close();
                return { response: set(attemptSuccess('handed_off'), 'status', text(status)), complete: true };
            }
            throw new Error('invalid request');
        });
    }
    async close() {
        this.#closed = true;
        this.#token = null;
        if (this.#timer !== undefined) {
            this.#timers.cancel(this.#timer);
            this.#timer = undefined;
        }
        // A lost broker never releases a Store claim. Explicit recovery owns that decision.
    }
}
