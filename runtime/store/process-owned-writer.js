import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { activateNativeWriter, recoverNativeWriterSwitch, rollbackNativeWriter } from './native-writer-switch.js';
function positiveMilliseconds(value, name) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
        throw new RangeError(`${name} must be a positive timer interval`);
    }
    return value;
}
function signalGroup(child, signal) {
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0)
        return;
    try {
        if (process.platform === 'win32')
            child.kill(signal);
        else
            process.kill(-child.pid, signal);
    }
    catch (error) {
        if (error.code !== 'ESRCH')
            throw error;
    }
}
function groupAlive(child) {
    if (!Number.isSafeInteger(child.pid) || (child.pid ?? 0) <= 0)
        return false;
    if (process.platform === 'win32')
        return child.exitCode === null && child.signalCode === null;
    try {
        process.kill(-child.pid, 0);
        return true;
    }
    catch (error) {
        if (error.code === 'ESRCH')
            return false;
        throw error;
    }
}
function childExit(child) {
    if (child.exitCode !== null || child.signalCode !== null)
        return Promise.resolve();
    return new Promise(resolve => child.once('exit', () => resolve()));
}
async function waitForGroupExit(child, timeoutMilliseconds) {
    const deadline = Date.now() + timeoutMilliseconds;
    while (groupAlive(child)) {
        if (Date.now() >= deadline)
            return false;
        await delay(10);
    }
    return true;
}
class WriterOwnershipLease {
    descriptor;
    #handle;
    #provider;
    #released = false;
    constructor(handle, provider) {
        this.#handle = handle;
        this.#provider = provider;
        this.descriptor = handle.fd;
    }
    static async acquire(active, provider, timeoutMilliseconds) {
        const parent = dirname(active);
        const [canonicalParent, parentMetadata, canonicalActive, activeMetadata] = await Promise.all([
            realpath(parent).catch(() => null), lstat(parent).catch(() => null),
            realpath(active).catch(() => null), lstat(active).catch(() => null),
        ]);
        if (!isAbsolute(active) || active !== resolve(active) || canonicalParent !== parent
            || !parentMetadata?.isDirectory() || parentMetadata.isSymbolicLink()
            || parentMetadata.uid !== process.getuid?.() || parentMetadata.mode & 0o077
            || canonicalActive !== active || !activeMetadata?.isDirectory() || activeMetadata.isSymbolicLink()
            || activeMetadata.uid !== process.getuid?.() || activeMetadata.mode & 0o077) {
            throw new Error('writer ownership Store is invalid');
        }
        const handle = await open(join(parent, `.${basename(active)}.writer-owner.lock`), constants.O_RDWR | constants.O_CREAT, 0o600);
        let locked = false;
        try {
            await handle.chmod(0o600);
            const signal = AbortSignal.timeout(timeoutMilliseconds);
            while (!(locked = provider.tryLock(handle.fd))) {
                signal.throwIfAborted();
                await delay(10, undefined, { signal });
            }
            return new WriterOwnershipLease(handle, provider);
        }
        catch (error) {
            if (locked)
                provider.unlock(handle.fd);
            await handle.close();
            throw error;
        }
    }
    async release() {
        if (this.#released)
            return;
        this.#provider.unlock(this.#handle.fd);
        await this.#handle.close();
        this.#released = true;
    }
}
class OwnedWriterProcess {
    startupLine;
    #child;
    #shutdownGraceMilliseconds;
    #stopped = false;
    constructor(child, startupLine, shutdownGraceMilliseconds) {
        this.#child = child;
        this.startupLine = startupLine;
        this.#shutdownGraceMilliseconds = shutdownGraceMilliseconds;
    }
    static async start(spec, shutdownGraceMilliseconds, ownershipDescriptor) {
        const timeout = positiveMilliseconds(spec.startupTimeoutMilliseconds ?? 30_000, 'startup timeout');
        const child = spawn(spec.command, [...spec.argv], {
            cwd: spec.cwd,
            ...(spec.env === undefined ? {} : { env: spec.env }),
            detached: process.platform !== 'win32',
            // fd 3 keeps the flock open in the writer if this controller dies.
            stdio: ['ignore', 'pipe', 'pipe', ownershipDescriptor],
        });
        child.stderr?.resume();
        let text = '';
        try {
            const line = await new Promise((resolve, reject) => {
                const timer = setTimeout(() => finish(new Error('owned writer startup timed out')), timeout);
                function finish(error, value) {
                    clearTimeout(timer);
                    child.stdout?.off('data', onData);
                    child.off('error', onError);
                    child.off('exit', onExit);
                    if (error)
                        reject(error);
                    else
                        resolve(value);
                }
                function onError() { finish(new Error('owned writer failed before readiness')); }
                function onExit() { finish(new Error('owned writer failed before readiness')); }
                function onData(bytes) {
                    text += bytes.toString('utf8');
                    if (text.length > 16_384) {
                        finish(new Error('owned writer startup response is invalid'));
                        return;
                    }
                    const newline = text.indexOf('\n');
                    if (newline < 0)
                        return;
                    const value = text.slice(0, newline);
                    try {
                        if (!spec.ready(value))
                            throw new Error();
                        finish(undefined, value);
                    }
                    catch {
                        finish(new Error('owned writer startup response is invalid'));
                    }
                }
                child.stdout?.on('data', onData);
                child.once('error', onError);
                child.once('exit', onExit);
            });
            child.stdout?.resume();
            return new OwnedWriterProcess(child, line, shutdownGraceMilliseconds);
        }
        catch (error) {
            signalGroup(child, 'SIGTERM');
            await Promise.race([childExit(child), delay(shutdownGraceMilliseconds)]);
            if (groupAlive(child))
                signalGroup(child, 'SIGKILL');
            if (!await waitForGroupExit(child, Math.max(1000, shutdownGraceMilliseconds))) {
                throw new AggregateError([error], 'owned writer startup failed and its process group did not stop');
            }
            throw error;
        }
    }
    async stop() {
        if (this.#stopped)
            return;
        signalGroup(this.#child, 'SIGTERM');
        await Promise.race([childExit(this.#child), delay(this.#shutdownGraceMilliseconds)]);
        if (groupAlive(this.#child))
            signalGroup(this.#child, 'SIGKILL');
        if (!await waitForGroupExit(this.#child, Math.max(1000, this.#shutdownGraceMilliseconds))) {
            throw new Error('owned writer process group did not stop');
        }
        this.#stopped = true;
    }
}
/** Owns writer process lifetime and never moves the Store until the complete owned group is gone. */
export class ProcessOwnedWriterController {
    #active;
    #candidate;
    #provider;
    #createSpec;
    #shutdownGraceMilliseconds;
    #ownershipTimeoutMilliseconds;
    #operationActive = false;
    #lease = null;
    #mode = null;
    #writer = null;
    constructor(options) {
        this.#active = options.active;
        this.#candidate = options.candidate ?? `${options.active}.native-candidate`;
        this.#provider = options.provider;
        this.#createSpec = options.createSpec;
        this.#shutdownGraceMilliseconds = positiveMilliseconds(options.shutdownGraceMilliseconds ?? 3000, 'shutdown grace');
        this.#ownershipTimeoutMilliseconds = positiveMilliseconds(options.ownershipTimeoutMilliseconds ?? 30_000, 'ownership timeout');
    }
    get mode() { return this.#mode; }
    get startupLine() { return this.#writer?.startupLine ?? null; }
    async #exclusive(operation) {
        if (this.#operationActive)
            throw new Error('writer lifecycle operation is already active');
        this.#operationActive = true;
        try {
            return await operation();
        }
        finally {
            this.#operationActive = false;
        }
    }
    async #acquireOwnership() {
        if (this.#lease)
            return;
        this.#lease = await WriterOwnershipLease.acquire(this.#active, this.#provider, this.#ownershipTimeoutMilliseconds);
    }
    async #releaseOwnership() {
        const lease = this.#lease;
        if (!lease)
            return;
        try {
            await lease.release();
        }
        finally {
            if (this.#lease === lease)
                this.#lease = null;
        }
    }
    async #start(mode) {
        if (this.#writer)
            throw new Error('owned writer is already running');
        if (!this.#lease)
            throw new Error('writer ownership lease is missing');
        const writer = await OwnedWriterProcess.start(await this.#createSpec(mode, this.#active), this.#shutdownGraceMilliseconds, this.#lease.descriptor);
        this.#writer = writer;
        this.#mode = mode;
    }
    async #quiesce() {
        if (!this.#writer || !this.#mode)
            throw new Error('owned writer is not running');
        const mode = this.#mode;
        await this.#writer.stop();
        this.#writer = null;
        this.#mode = null;
        return mode;
    }
    #switchOptions(options) {
        return { provider: this.#provider, ...options };
    }
    async #restorePython(cause) {
        try {
            const state = await recoverNativeWriterSwitch(this.#active, { provider: this.#provider });
            if (state === 'native')
                await rollbackNativeWriter(this.#active, { provider: this.#provider });
            await this.#start('python');
        }
        catch (recovery) {
            throw new AggregateError([cause, recovery], 'writer activation failed and Python recovery did not complete');
        }
        throw cause;
    }
    async start(mode) {
        return this.#exclusive(async () => {
            await this.#acquireOwnership();
            try {
                await this.#start(mode);
            }
            catch (error) {
                await this.#releaseOwnership();
                throw error;
            }
        });
    }
    /** Reserve the Store lifetime lease before preflight or clone preparation. */
    async prepare(operation) {
        return this.#exclusive(async () => {
            await this.#acquireOwnership();
            try {
                return await operation();
            }
            catch (error) {
                await this.#releaseOwnership();
                throw error;
            }
        });
    }
    async restart() {
        return this.#exclusive(async () => {
            const mode = await this.#quiesce();
            await this.#start(mode);
        });
    }
    async stop() {
        return this.#exclusive(async () => {
            if (this.#writer)
                await this.#quiesce();
            else
                this.#mode = null;
            await this.#releaseOwnership();
        });
    }
    async activate(options = {}) {
        return this.#exclusive(async () => {
            if (this.#mode !== 'python')
                throw new Error('Python writer must be owned before activation');
            await this.#quiesce();
            let result;
            try {
                result = await activateNativeWriter(this.#active, this.#candidate, this.#switchOptions(options));
            }
            catch (error) {
                return this.#restorePython(error);
            }
            try {
                await this.#start('native');
            }
            catch (error) {
                return this.#restorePython(error);
            }
            return result;
        });
    }
    async rollback(options = {}) {
        return this.#exclusive(async () => {
            if (this.#mode !== 'native')
                throw new Error('native writer must be owned before rollback');
            await this.#quiesce();
            try {
                const result = await rollbackNativeWriter(this.#active, this.#switchOptions(options));
                await this.#start('python');
                return result;
            }
            catch (error) {
                try {
                    const state = await recoverNativeWriterSwitch(this.#active, { provider: this.#provider });
                    await this.#start(state);
                }
                catch (recovery) {
                    throw new AggregateError([error, recovery], 'writer rollback failed and recovery did not complete');
                }
                throw error;
            }
        });
    }
}
