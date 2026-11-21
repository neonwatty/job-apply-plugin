import { constants } from 'node:fs';
import { readdir, realpath, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { adoptFreshNativeStoreLocked } from './native-store-clone.js';
import { nativeCloneMarkerName, nativeFixtureMarkerName, nativeStorePendingName, nativeStoreRequiredEntries } from './native-store-layout.js';
import { validateNativeJobsRoot } from './native-root-validation.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { syncDirectory } from './directory-sync.js';
import { checkWindowsStoreWrite, ensureWindowsPrivateDirectory, openWindowsStoreFile, requireWindowsPrivate, windowsPath, withWindowsStore } from './windows-store.js';
export class UnrecognizedStoreError extends Error {
    constructor(empty = false) {
        super((empty ? 'The selected empty Store directory must be owned by and accessible only to your account. '
            : 'The selected Store root contains data that is not a native Job Apply Store. It was left unchanged. ')
            + 'Choose a separate Store path that does not exist yet with --root or JOB_APPLY_STORE_DIR.');
        this.name = 'UnrecognizedStoreError';
    }
}
const markers = [nativeFixtureMarkerName, nativeCloneMarkerName];
const lockName = '.store.lock';
const partialEntries = new Set([...nativeStoreRequiredEntries, 'resume-facts.json', nativeStorePendingName]);
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
/** Classify without writing, including when a marker exists but cannot validate. */
async function inspectRoot(root, names) {
    if (!names.length) {
        try {
            requireWindowsPrivate(root, true);
        }
        catch {
            throw new UnrecognizedStoreError(true);
        }
        return 'fresh';
    }
    const pending = names.includes(nativeStorePendingName);
    try {
        if (!names.includes(lockName))
            throw new UnrecognizedStoreError();
        requireWindowsPrivate(root, true);
        if (pending)
            await requireEmptyPrivateFile(join(root, nativeStorePendingName));
        if (names.some(name => markers.includes(name))) {
            await validateNativeJobsRoot(root, name => readStoreFile(join(root, name)), true, false, pending);
            return pending ? 'completed-with-pending' : 'completed';
        }
        await requireEmptyPrivateFile(join(root, lockName));
        if (names.length === 1)
            return 'fresh';
        if (!pending || names.some(name => !partialEntries.has(name)))
            throw new UnrecognizedStoreError();
        for (const name of ['sessions', 'resume-files'])
            if (names.includes(name)) {
                const path = join(root, name);
                requireWindowsPrivate(path, true);
                if ((await readdir(path)).length)
                    throw new UnrecognizedStoreError();
            }
        return 'partial';
    }
    catch {
        throw new UnrecognizedStoreError();
    }
}
async function initializeLocked(root, provider, options, signal, state) {
    if (state === 'fresh') {
        const pending = await openWindowsStoreFile(join(root, nativeStorePendingName), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL);
        await pending.close();
        await syncDirectory(root);
    }
    // First-time activation only adds missing files. Running Store-journal recovery here
    // would let an unexpected journal mutate data in a partially initialized directory.
    const bootstrap = createNativeStoreBootstrap(root, options.legacyProfile, process.env, undefined, { ...(options.now ? { clock: options.now } : {}), importLegacyProfile: options.legacyProfile !== undefined, recoverExisting: false });
    await bootstrap.initialize();
    signal.throwIfAborted();
    await adoptFreshNativeStoreLocked(root, provider, options.now?.(), signal, [nativeStorePendingName]);
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
    await inspectRoot(root, before ?? await readdir(root));
    return withExclusiveFileLock(join(root, lockName), async () => {
        const state = await inspectRoot(root, await readdir(root));
        if (state === 'completed')
            return 'reopened';
        if (state !== 'completed-with-pending') {
            await initializeLocked(root, provider, options, signal, state);
        }
        if (await inspectRoot(root, await readdir(root)) !== 'completed-with-pending')
            throw new UnrecognizedStoreError();
        await finishInitialization(root);
        return state === 'completed-with-pending' ? 'reopened' : 'initialized';
    }, { provider, pathProfile: '3.12', signal });
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
