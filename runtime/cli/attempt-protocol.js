import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, isAbsolute } from 'node:path';
import { filesystemEncode } from '../contracts/posix-path-bytes.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fromJSON, integer, object, parse, set } from '../contracts/workspace/values.js';
import { parseTaskRevision } from './task-protocol.js';
export const attemptFrameLimit = 1024 * 1024;
export const attemptHeartbeatMilliseconds = 60_000;
export const attemptIdleMilliseconds = 10_000;
export class AttemptInvocationError extends Error {
    constructor() { super('invalid invocation'); }
}
export class AttemptHelp extends Error {
    command;
    constructor(command) {
        super('attempt help requested');
        this.command = command;
    }
}
export const attemptDocument = (value) => object(fromJSON(value), 'attempt');
export const attemptError = (code) => attemptDocument({ ok: false, error: { code } });
export const attemptSuccess = (event) => attemptDocument({ ok: true, event });
/** Resolve existing parent symlinks too, matching Path.resolve for an absent Store. */
export function resolveAttemptRoot(root, env, home) {
    let configured = root || env.JOB_APPLY_STORE_DIR || join(home, '.job-apply');
    if (configured === '~' || configured.startsWith('~/'))
        configured = home + configured.slice(1);
    const absolute = isAbsolute(configured) ? configured : process.cwd() + '/' + configured;
    let current = '/';
    for (const component of absolute.split('/')) {
        if (!component || component === '.')
            continue;
        if (component === '..') {
            current = dirname(current);
            continue;
        }
        current = join(current, component);
        try {
            current = realpathSync(current);
        }
        catch (error) {
            if (!['ENOENT', 'ENOTDIR'].includes(error.code ?? ''))
                throw error;
        }
    }
    return current;
}
export function attemptSocketPath(root, uid) {
    return `/tmp/job-apply-attempt-${uid}/${createHash('sha256').update(filesystemEncode(root)).digest('hex')}.sock`;
}
const fields = {
    start: ['--id', '--owner', '--expected-revision'],
    'restart-review': ['--id', '--owner', '--expected-revision', '--owner-confirmed-not-submitted'],
    heartbeat: [], progress: ['--input'], handoff: ['--status', '--input'],
};
function optionValue(value) {
    return !value.startsWith('-') || value === '-' || value.includes(' ')
        || /^-(?:\p{Decimal_Number}+|\p{Decimal_Number}*\.\p{Decimal_Number}+)$/u.test(value);
}
export function parseAttemptArgs(args, env, home) {
    let command;
    const options = new Map();
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (!arg.startsWith('-')) {
            if (command || !Object.hasOwn(fields, arg))
                throw new AttemptInvocationError();
            command = arg;
            continue;
        }
        const equals = arg.indexOf('=');
        const raw = equals < 0 ? arg : arg.slice(0, equals);
        const supported = [...(command ? fields[command] : ['--root']), '--help', '-h'];
        const matches = supported.includes(raw) ? [raw] : supported.filter(key => raw.startsWith('--') && key.startsWith(raw));
        if (matches.length !== 1)
            throw new AttemptInvocationError();
        const key = matches[0];
        if (key === '--help' || key === '-h') {
            if (equals >= 0)
                throw new AttemptInvocationError();
            throw new AttemptHelp(command);
        }
        if (key === '--owner-confirmed-not-submitted') {
            if (equals >= 0)
                throw new AttemptInvocationError();
            options.set(key, 'true');
            continue;
        }
        const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
        if (value === undefined || (equals < 0 && !optionValue(value)))
            throw new AttemptInvocationError();
        if (key === '--expected-revision') {
            try {
                parseTaskRevision(value);
            }
            catch {
                throw new AttemptInvocationError();
            }
        }
        if (key === '--status' && value !== 'needs_info' && value !== 'awaiting_review')
            throw new AttemptInvocationError();
        options.set(key, value);
    }
    if (!command)
        throw new AttemptInvocationError();
    for (const field of fields[command]) {
        if (field !== '--owner-confirmed-not-submitted' && !options.has(field))
            throw new AttemptInvocationError();
    }
    const root = resolveAttemptRoot(options.get('--root'), env, home);
    if (command === 'start' || command === 'restart-review') {
        const common = { root, id: options.get('--id'), owner: options.get('--owner'), expectedRevision: parseTaskRevision(options.get('--expected-revision')) };
        return command === 'start' ? { kind: command, ...common }
            : { kind: command, ...common, ownerConfirmedNotSubmitted: options.has('--owner-confirmed-not-submitted') };
    }
    if (command === 'heartbeat')
        return { kind: command, root };
    if (command === 'progress')
        return { kind: command, root, input: options.get('--input') };
    const status = options.get('--status');
    if (status !== 'needs_info' && status !== 'awaiting_review')
        throw new AttemptInvocationError();
    return { kind: 'handoff', root, status, input: options.get('--input') };
}
export async function attemptRequest(invocation) {
    const request = attemptDocument({ command: invocation.kind });
    if (invocation.kind === 'start' || invocation.kind === 'restart-review') {
        const result = attemptDocument({ command: invocation.kind, id: invocation.id, owner: invocation.owner });
        set(result, 'expectedRevision', integer(invocation.expectedRevision));
        if (invocation.kind === 'restart-review')
            set(result, 'ownerConfirmedNotSubmitted', invocation.ownerConfirmedNotSubmitted);
        return result;
    }
    if ('input' in invocation) {
        const bytes = await readFile(invocation.input);
        set(request, 'session', object(parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)), 'session'));
    }
    if (invocation.kind === 'handoff')
        set(request, 'status', fromJSON(invocation.status));
    return request;
}
export function encodeAttemptFrame(value) {
    const bytes = Buffer.from(canonicalJson(value) + '\n');
    if (bytes.length > attemptFrameLimit)
        throw new Error('attempt frame too large');
    return bytes;
}
export class AttemptFrameDecoder {
    #bytes = Buffer.alloc(0);
    #complete = false;
    push(bytes) {
        if (this.#complete)
            throw new Error('trailing attempt frame');
        this.#bytes = Buffer.concat([this.#bytes, bytes]);
        if (this.#bytes.length > attemptFrameLimit)
            throw new Error('attempt frame too large');
        const newline = this.#bytes.indexOf(10);
        if (newline < 0)
            return null;
        if (newline === 0 || newline !== this.#bytes.length - 1)
            throw new Error('invalid attempt framing');
        this.#complete = true;
        return object(parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(this.#bytes.subarray(0, newline))), 'attempt frame');
    }
}
