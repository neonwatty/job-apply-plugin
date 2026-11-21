import { constants } from 'node:fs';
import { readdir, realpath, rm, unlink } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { adoptFreshNativeStoreLocked } from './native-store-clone.js';
import { nativeCloneMarkerName, nativeFixtureMarkerName, nativeStorePendingName } from './native-store-layout.js';
import { validateNativeJobsRoot } from './native-root-validation.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { syncDirectory } from './directory-sync.js';
import { ensureWindowsPrivateDirectory, openWindowsStoreFile, requireWindowsPrivate, withWindowsStore } from './windows-store.js';
export class UnrecognizedStoreError extends Error {
    constructor() {
        super('The selected Store root contains data that is not a native Job Apply Store. It was left unchanged. '
            + 'Choose a separate, empty Store root with --root or JOB_APPLY_STORE_DIR.');
        this.name = 'UnrecognizedStoreError';
    }
}
const markers = [nativeFixtureMarkerName, nativeCloneMarkerName];
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
/** Native, empty, or interrupted by this module before its marker was written. */
function recognized(names) {
    return names.length === 0 || names.some(name => markers.includes(name)) || names.includes(nativeStorePendingName);
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
async function initializeLocked(root, provider, options, signal) {
    const names = await readdir(root);
    if (names.includes(nativeStorePendingName)) {
        // An earlier fresh initialization stopped before writing its marker. Only this module
        // creates the pending entry, and only in an empty root, so the partial tree is ours.
        for (const name of names)
            if (name !== '.store.lock' && name !== nativeStorePendingName) {
                await rm(join(root, name), { recursive: true, force: true });
            }
    }
    else if (names.some(name => name !== '.store.lock'))
        throw new UnrecognizedStoreError();
    else
        await (await openWindowsStoreFile(join(root, nativeStorePendingName), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL)).close();
    await syncDirectory(root);
    const bootstrap = createNativeStoreBootstrap(root, options.legacyProfile, process.env, undefined, options.now ? { clock: options.now } : {});
    await bootstrap.initialize();
    signal.throwIfAborted();
    await adoptFreshNativeStoreLocked(root, provider, options.now?.(), signal, [nativeStorePendingName]);
    await unlink(join(root, nativeStorePendingName));
    await syncDirectory(root);
}
/** Runs inside an active Windows Store scope for `root`. */
export async function activateWindowsStoreScoped(root, provider, options = {}) {
    const signal = options.signal ?? AbortSignal.timeout(30_000);
    const parent = win32.dirname(root);
    if (parent === root || await realpath(parent).catch(() => null) !== parent)
        throw new Error('Store root parent must exist and be canonical');
    const before = await entries(root);
    if (before !== null && !recognized(before))
        throw new UnrecognizedStoreError();
    if (before === null)
        await ensureWindowsPrivateDirectory(root, false);
    else {
        requireWindowsPrivate(root, true);
        if (await realpath(root) !== root)
            throw new Error('Store root must use its canonical spelling');
    }
    return withExclusiveFileLock(join(root, '.store.lock'), async () => {
        const names = await readdir(root);
        if (names.some(name => markers.includes(name)) && !names.includes(nativeStorePendingName)) {
            await validateNativeJobsRoot(root, name => readStoreFile(join(root, name)), true);
            return 'reopened';
        }
        await initializeLocked(root, provider, options, signal);
        await validateNativeJobsRoot(root, name => readStoreFile(join(root, name)), true);
        return 'initialized';
    }, { provider, pathProfile: '3.12', signal });
}
export function activateWindowsStore(root, addonPath, options = {}) {
    return withWindowsStore(root, addonPath, provider => activateWindowsStoreScoped(root, provider, options));
}
/** The canonical spelling of a Store root: its own if it exists, otherwise its parent's plus its name. */
export async function canonicalWindowsRoot(root) {
    const resolved = win32.resolve(root);
    try {
        return await realpath(resolved);
    }
    catch (error) {
        if (error.code !== 'ENOENT')
            throw error;
        const parent = await realpath(win32.dirname(resolved)).catch(() => win32.dirname(resolved));
        return win32.join(parent, win32.basename(resolved));
    }
}
