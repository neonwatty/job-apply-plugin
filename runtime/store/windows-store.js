import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { mkdir, open, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import { resolvePosixPath } from '../contracts/posix-path.js';
const scope = new AsyncLocalStorage();
export function windowsPath(path) {
    const native = path.replaceAll('/', '\\');
    const root = win32.parse(native).root;
    if (native.startsWith('\\\\?\\') || native.startsWith('\\\\.\\') || native.includes('\0')
        || native.slice(root.length).split('\\').some(part => part !== '.' && part !== '..' && /[: ]$|\.$|:/.test(part))) {
        throw new Error('Unsupported Windows Store path');
    }
    return path;
}
/** The addon is explicitly selected by our caller. Store data mutations stay within the selected root. */
export async function withWindowsStore(root, addonPath, operation) {
    if (process.platform !== 'win32' || process.arch !== 'x64')
        throw new Error('Windows x64 Store required');
    if (!win32.isAbsolute(root) || win32.resolve(root) !== root || !win32.isAbsolute(addonPath)) {
        throw new Error('An absolute Store root and addon path are required');
    }
    windowsPath(root);
    const addon = createRequire(import.meta.url)(addonPath);
    if (typeof addon !== 'object' || addon === null
        || !('tryLock' in addon) || typeof addon.tryLock !== 'function'
        || !('unlock' in addon) || typeof addon.unlock !== 'function'
        || !('storeMetadata' in addon) || typeof addon.storeMetadata !== 'function'
        || !('createStoreEntry' in addon) || typeof addon.createStoreEntry !== 'function') {
        throw new Error('Invalid Windows Store addon');
    }
    return scope.run({ root, addon: addon }, () => operation(addon));
}
function store() {
    const selected = scope.getStore();
    if (!selected)
        throw new Error('Windows Store requires an explicitly selected native addon');
    return selected;
}
function insideStore(path) {
    const { root } = store();
    const prefix = root.endsWith('\\') ? root : root + '\\';
    if (!win32.isAbsolute(path) || win32.normalize(path) !== path
        || (path !== root && !path.startsWith(prefix))) {
        throw new Error('Path is outside the selected Windows Store');
    }
}
export function windowsMetadata(path) {
    return store().addon.storeMetadata(typeof path === 'string' ? windowsPath(path) : path);
}
export function windowsFileIdentity(metadata) {
    return `${metadata.volume}:${metadata.id.toString('hex')}`;
}
export function requireWindowsPrivate(path, directory) {
    const metadata = windowsMetadata(path);
    if (!metadata.private || (directory !== undefined && metadata.directory !== directory)
        || (!metadata.directory && metadata.links !== 1)) {
        throw new Error('Windows Store entry must be private and owned, without links');
    }
    return metadata;
}
export function missingWindowsEntry(error) {
    return error?.code === 'ENOENT';
}
export async function ensureWindowsPrivateDirectory(path, existOk = true) {
    insideStore(path);
    const { root, addon } = store();
    const parent = win32.dirname(path);
    if (path !== root) {
        try {
            requireWindowsPrivate(parent, true);
        }
        catch (error) {
            if (!missingWindowsEntry(error))
                throw error;
            await ensureWindowsPrivateDirectory(parent);
        }
    }
    let canonicalParent;
    try {
        canonicalParent = await realpath(parent);
    }
    catch (error) {
        if (path !== root || !missingWindowsEntry(error))
            throw error;
        if (await resolvePosixPath(parent, '3.12') !== parent)
            throw new Error('Windows Store directory parent must be canonical');
        await mkdir(parent, { recursive: true });
        canonicalParent = await realpath(parent);
    }
    if (canonicalParent !== parent)
        throw new Error('Windows Store directory parent must be canonical');
    try {
        addon.createStoreEntry(windowsPath(path), true);
    }
    catch (error) {
        if (!existOk || error.code !== 'EEXIST')
            throw error;
    }
    requireWindowsPrivate(path, true);
}
export async function openWindowsStoreFile(path, flags, privateFile = true) {
    const writing = Boolean(flags & (constants.O_WRONLY | constants.O_RDWR));
    const parent = win32.dirname(path);
    if (privateFile && await realpath(parent) !== parent)
        throw new Error('Windows Store file parent must be canonical');
    if (writing || flags & constants.O_CREAT) {
        insideStore(path);
        requireWindowsPrivate(parent, true);
    }
    if (flags & constants.O_CREAT) {
        try {
            store().addon.createStoreEntry(windowsPath(path), false);
        }
        catch (error) {
            if ((flags & constants.O_EXCL) || error.code !== 'EEXIST')
                throw error;
        }
    }
    const initial = privateFile ? requireWindowsPrivate(path, false) : windowsMetadata(path);
    if (initial.directory)
        throw new Error('Windows Store entry must be a file');
    if (privateFile && await realpath(path) !== path) {
        const error = new Error('Windows Store file path must use its canonical spelling');
        throw writing ? error : Object.assign(error, { code: 'ENOENT' });
    }
    const access = flags & constants.O_WRONLY ? (flags & ~constants.O_WRONLY) | constants.O_RDWR : flags;
    const handle = await open(windowsPath(path), access & ~(constants.O_TRUNC | constants.O_CREAT | constants.O_EXCL));
    try {
        const checked = privateFile ? requireWindowsPrivate(handle.fd, false) : windowsMetadata(handle.fd);
        if (windowsFileIdentity(initial) !== windowsFileIdentity(checked)
            || windowsFileIdentity(windowsMetadata(path)) !== windowsFileIdentity(checked)) {
            throw new Error('Windows Store file identity changed');
        }
        if (flags & constants.O_TRUNC)
            await handle.truncate(0);
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
export async function checkWindowsStoreWrite(path) {
    insideStore(path);
    const parent = win32.dirname(path);
    if (await realpath(parent) !== parent)
        throw new Error('Windows Store file parent must be canonical');
    requireWindowsPrivate(parent, true);
    try {
        requireWindowsPrivate(path, false);
        if (await realpath(path) !== path)
            throw new Error('Windows Store file path must use its canonical spelling');
    }
    catch (error) {
        if (!missingWindowsEntry(error))
            throw error;
    }
}
