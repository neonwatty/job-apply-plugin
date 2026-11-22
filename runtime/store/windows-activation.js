import { constants } from 'node:fs';
import { readdir, realpath, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { adoptFreshNativeStoreLocked } from './native-store-clone.js';
import { nativeCloneMarkerName, nativeFixtureMarkerName, nativeStorePendingName, nativeStoreAllowedEntries, nativeStoreRequiredEntries } from './native-store-layout.js';
import { validateNativeJobsRoot } from './native-root-validation.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { syncDirectory } from './directory-sync.js';
import { checkWindowsStoreWrite, ensureWindowsPrivateDirectory, openWindowsStoreFile, requireWindowsPrivate, windowsPath, withWindowsStore } from './windows-store.js';
export class UnrecognizedStoreError extends Error {
    constructor(empty = false) {
        super((empty ? 'The selected empty Store directory must be owned by and accessible only to your account. '
            : 'The selected Store root contains data that is not a native Job Apply Store. It was left unchanged. ')
            + 'Choose a separate Store path that does not exist yet under an existing directory with --root or JOB_APPLY_STORE_DIR.');
        this.name = 'UnrecognizedStoreError';
    }
}
const markers = [nativeFixtureMarkerName, nativeCloneMarkerName];
const lockName = '.store.lock';
const partialEntries = new Set([...nativeStoreRequiredEntries, 'resume-facts.json', nativeStorePendingName]);
const initializationDocuments = new Set([...partialEntries].filter(name => name.endsWith('.json')).concat(nativeCloneMarkerName));
const storeDocuments = new Set([...nativeStoreAllowedEntries].filter(name => name.endsWith('.json')));
function stagedDocuments(names, documents) {
    return names.filter(name => {
        const match = /^\.(.+)\.[a-z0-9_]{8}\.tmp$/.exec(name);
        return match !== null && documents.has(match[1]);
    });
}
async function checkStaging(root, staging) {
    for (const name of staging) {
        const path = join(root, name);
        requireWindowsPrivate(path, false);
        await checkWindowsStoreWrite(path);
    }
}
async function discardStaging(root, staging, signal) {
    for (const name of staging) {
        signal.throwIfAborted();
        const path = join(root, name);
        await checkWindowsStoreWrite(path);
        await unlink(path);
    }
    if (staging.length)
        await syncDirectory(root);
}
async function entries(root) {
    try {
        return await readdir(root);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function readStoreFile(path) {
    const handle = await openWindowsStoreFile(path, constants.O_RDONLY);
    try {
        return await handle.readFile();
    }
    finally {
        await handle.close();
    }
}
async function requireEmptyPrivateFile(path) {
    const handle = await openWindowsStoreFile(path, constants.O_RDONLY);
    try {
        if ((await handle.stat()).size !== 0)
            throw new UnrecognizedStoreError();
    }
    finally {
        await handle.close();
    }
}
/** Classify stable entries under the existing Store lock before making any recovery writes. */
async function inspectRoot(root, names) {
    const pending = names.includes(nativeStorePendingName);
    try {
        if (!names.includes(lockName))
            throw new UnrecognizedStoreError();
        requireWindowsPrivate(root, true);
        if (pending)
            await requireEmptyPrivateFile(join(root, nativeStorePendingName));
        if (names.some(name => markers.includes(name))) {
            const staging = stagedDocuments(names, storeDocuments);
            const activationEntries = pending ? [nativeStorePendingName, ...staging] : staging;
            await validateNativeJobsRoot(root, name => readStoreFile(join(root, name)), true, false, activationEntries);
            await checkStaging(root, staging);
            return { kind: pending ? 'completed-with-pending' : 'completed', staging };
        }
        await requireEmptyPrivateFile(join(root, lockName));
        if (names.length === 1)
            return { kind: 'fresh', staging: [] };
        const staging = stagedDocuments(names, initializationDocuments);
        if (!pending || names.some(name => !partialEntries.has(name) && !staging.includes(name))) {
            throw new UnrecognizedStoreError();
        }
        await checkStaging(root, staging);
        for (const name of ['sessions', 'resume-files'])
            if (names.includes(name)) {
                const path = join(root, name);
                requireWindowsPrivate(path, true);
                if ((await readdir(path)).length)
                    throw new UnrecognizedStoreError();
            }
        return { kind: 'partial', staging };
    }
    catch {
        throw new UnrecognizedStoreError();
    }
}
async function initializeLocked(root, provider, options, signal, state, staging) {
    if (state === 'fresh') {
        const pending = await openWindowsStoreFile(join(root, nativeStorePendingName), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
        await pending.close();
        await syncDirectory(root);
    }
    // First-time activation only adds missing files. Running Store-journal recovery here
    // would let an unexpected journal mutate data in a partially initialized directory.
    const bootstrap = createNativeStoreBootstrap(root, options.legacyProfile, process.env, undefined, { ...(options.now ? { clock: options.now } : {}), importLegacyProfile: options.legacyProfile !== undefined, recoverExisting: false });
    const receipt = await bootstrap.initialize();
    signal.throwIfAborted();
    await discardStaging(root, staging, signal);
    await adoptFreshNativeStoreLocked(root, provider, options.now?.(), signal, [nativeStorePendingName]);
    return receipt;
}
async function finishInitialization(root) {
    const path = join(root, nativeStorePendingName);
    await requireEmptyPrivateFile(path);
    await checkWindowsStoreWrite(path);
    await unlink(path);
    await syncDirectory(root);
}
/** Runs inside an active Windows Store scope for `root`. */
export async function activateWindowsStoreScoped(root, provider, options = {}) {
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    const parent = win32.dirname(root);
    if (parent === root || await realpath(parent).catch(() => null) !== parent)
        throw new Error('Store root parent must exist and be canonical');
    const before = await entries(root);
    signal.throwIfAborted();
    if (before === null)
        await ensureWindowsPrivateDirectory(root);
    if (await realpath(root) !== root)
        throw new Error('Store root must use its canonical spelling');
    const names = before ?? await readdir(root);
    const existingOnly = names.includes(lockName);
    // This pre-lock check only decides whether we may create a lock. Pending markers
    // and temporary files may change while another process owns the lock.
    if (names.length && (!existingOnly || names.length > 1
        && !names.includes(nativeStorePendingName) && !names.some(name => markers.includes(name)))) {
        throw new UnrecognizedStoreError();
    }
    try {
        requireWindowsPrivate(root, true);
    }
    catch {
        throw new UnrecognizedStoreError(names.length === 0);
    }
    return withExclusiveFileLock(join(root, lockName), async () => {
        const { kind, staging } = await inspectRoot(root, await readdir(root));
        if (kind === 'completed' || kind === 'completed-with-pending') {
            // Holding the same lock as Store writers distinguishes orphaned staging from a live save.
            // The installed document and any durable recovery journal remain authoritative.
            await discardStaging(root, staging, signal);
            if (kind === 'completed-with-pending')
                await finishInitialization(root);
            return { state: 'reopened' };
        }
        const receipt = await initializeLocked(root, provider, options, signal, kind, staging);
        if ((await inspectRoot(root, await readdir(root))).kind !== 'completed-with-pending')
            throw new UnrecognizedStoreError();
        await finishInitialization(root);
        return { state: 'initialized', receipt };
    }, { provider, pathProfile: '3.12', signal, existingOnly });
}
export function activateWindowsStore(root, addonPath, options = {}) {
    return withWindowsStore(root, addonPath, provider => activateWindowsStoreScoped(root, provider, options));
}
/** The canonical spelling of a Store root: its own if it exists, otherwise its parent's plus its name. */
export async function canonicalWindowsRoot(root) {
    const resolved = windowsPath(win32.resolve(windowsPath(root)));
    const sameSpelling = (path, canonical) => {
        if (path.toLowerCase() !== canonical.toLowerCase())
            throw new Error('Store root must be selected without directory aliases');
        return canonical;
    };
    try {
        return sameSpelling(resolved, await realpath(resolved));
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        const parent = await realpath(win32.dirname(resolved)).catch(() => win32.dirname(resolved));
        return win32.join(sameSpelling(win32.dirname(resolved), parent), win32.basename(resolved));
    }
}
