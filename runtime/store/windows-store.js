import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rmdir, unlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';
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
/** The addon is explicitly selected by our caller. Store mutations stay within the selected root. */
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
        || !('restrictToOwner' in addon) || typeof addon.restrictToOwner !== 'function') {
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
    const relative = win32.relative(root, path);
    if (!win32.isAbsolute(path) || win32.normalize(path) !== path
        || relative === '..' || relative.startsWith('..\\') || win32.isAbsolute(relative)) {
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
    if (await realpath(parent) !== parent)
        throw new Error('Windows Store directory parent must be canonical');
    try {
        await mkdir(windowsPath(path));
    }
    catch (error) {
        if (!existOk || error.code !== 'EEXIST')
            throw error;
        requireWindowsPrivate(path, true);
        return;
    }
    try {
        addon.restrictToOwner(path);
        requireWindowsPrivate(path, true);
    }
    catch (error) {
        await rmdir(path).catch(() => { });
        throw error;
    }
}
export async function openWindowsStoreFile(path, flags, privateFile = true) {
    const creating = Boolean(flags & constants.O_CREAT);
    const parent = win32.dirname(path);
    if (privateFile && await realpath(parent) !== parent)
        throw new Error('Windows Store file parent must be canonical');
    if (creating || flags & (constants.O_WRONLY | constants.O_RDWR)) {
        insideStore(path);
        requireWindowsPrivate(parent, true);
    }
    const initial = creating ? undefined : (privateFile ? requireWindowsPrivate(path, false) : windowsMetadata(path));
    if (initial?.directory)
        throw new Error('Windows Store entry must be a file');
    let handle;
    try {
        const access = flags & constants.O_WRONLY ? (flags & ~constants.O_WRONLY) | constants.O_RDWR : flags;
        handle = await open(windowsPath(path), (access & ~constants.O_TRUNC) | (creating ? constants.O_EXCL : 0));
    }
    catch (error) {
        if (!creating || (flags & constants.O_EXCL) || error.code !== 'EEXIST')
            throw error;
        return openWindowsStoreFile(path, flags & ~constants.O_CREAT, privateFile);
    }
    let opened;
    try {
        opened = windowsMetadata(handle.fd);
        if (opened.directory || (privateFile && opened.links !== 1))
            throw new Error('Windows Store entry must be a file without links');
        if (windowsFileIdentity(opened) !== windowsFileIdentity(initial ?? windowsMetadata(path))) {
            throw new Error('Windows Store file identity changed');
        }
        if (creating)
            store().addon.restrictToOwner(path);
        const checked = privateFile ? requireWindowsPrivate(handle.fd, false) : opened;
        if (windowsFileIdentity(windowsMetadata(path)) !== windowsFileIdentity(checked)) {
            throw new Error('Windows Store file identity changed');
        }
        if (flags & constants.O_TRUNC)
            await handle.truncate(0);
        return handle;
    }
    catch (error) {
        await handle.close();
        if (creating && opened) {
            try {
                if (windowsFileIdentity(windowsMetadata(path)) === windowsFileIdentity(opened))
                    await unlink(path);
            }
            catch { /* Preserve the original failure. */ }
        }
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
    }
    catch (error) {
        if (!missingWindowsEntry(error))
            throw error;
    }
}
