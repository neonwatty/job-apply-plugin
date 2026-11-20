import { AsyncLocalStorage } from 'node:async_hooks';
import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { win32 } from 'node:path';
import { resolvePosixPath } from '../contracts/posix-path.js';
import type { PosixFlockProvider } from './posix-flock.js';

interface WindowsMetadata {
  id: Buffer;
  volume: bigint;
  links: number;
  directory: boolean;
  private: boolean;
}
interface WindowsAddon extends PosixFlockProvider {
  storeMetadata(path: string | number): WindowsMetadata;
  restrictToOwner(path: string): void;
}
const scope = new AsyncLocalStorage<{ root: string; addon: WindowsAddon }>();

export function windowsPath(path: string): string {
  const native = path.replaceAll('/', '\\');
  const root = win32.parse(native).root;
  if (native.startsWith('\\\\?\\') || native.startsWith('\\\\.\\') || native.includes('\0')
    || native.slice(root.length).split('\\').some(part => part !== '.' && part !== '..' && /[: ]$|\.$|:/.test(part))) {
    throw new Error('Unsupported Windows Store path');
  }
  return path;
}

/** The addon is explicitly selected by our caller. Store data mutations stay within the selected root. */
export async function withWindowsStore<T>(root: string, addonPath: string,
  operation: (provider: PosixFlockProvider) => Promise<T>): Promise<T> {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 Store required');
  if (!win32.isAbsolute(root) || win32.resolve(root) !== root || !win32.isAbsolute(addonPath)) {
    throw new Error('An absolute Store root and addon path are required');
  }
  windowsPath(root);
  const addon: unknown = createRequire(import.meta.url)(addonPath);
  if (typeof addon !== 'object' || addon === null
    || !('tryLock' in addon) || typeof addon.tryLock !== 'function'
    || !('unlock' in addon) || typeof addon.unlock !== 'function'
    || !('storeMetadata' in addon) || typeof addon.storeMetadata !== 'function'
    || !('restrictToOwner' in addon) || typeof addon.restrictToOwner !== 'function') {
    throw new Error('Invalid Windows Store addon');
  }
  return scope.run({ root, addon: addon as WindowsAddon }, () => operation(addon as WindowsAddon));
}

function store() {
  const selected = scope.getStore();
  if (!selected) throw new Error('Windows Store requires an explicitly selected native addon');
  return selected;
}

function insideStore(path: string): void {
  const { root } = store();
  const prefix = root.endsWith('\\') ? root : root + '\\';
  if (!win32.isAbsolute(path) || win32.normalize(path) !== path
    || (path !== root && !path.startsWith(prefix))) {
    throw new Error('Path is outside the selected Windows Store');
  }
}

export function windowsMetadata(path: string | number): WindowsMetadata {
  return store().addon.storeMetadata(typeof path === 'string' ? windowsPath(path) : path);
}

export function windowsFileIdentity(metadata: WindowsMetadata): string {
  return `${metadata.volume}:${metadata.id.toString('hex')}`;
}

export function requireWindowsPrivate(path: string | number, directory?: boolean): WindowsMetadata {
  const metadata = windowsMetadata(path);
  if (!metadata.private || (directory !== undefined && metadata.directory !== directory)
    || (!metadata.directory && metadata.links !== 1)) {
    throw new Error('Windows Store entry must be private and owned, without links');
  }
  return metadata;
}

export function missingWindowsEntry(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export async function ensureWindowsPrivateDirectory(path: string, existOk = true): Promise<void> {
  insideStore(path);
  const { root, addon } = store();
  const parent = win32.dirname(path);
  if (path !== root) {
    try { requireWindowsPrivate(parent, true); }
    catch (error) {
      if (!missingWindowsEntry(error)) throw error;
      await ensureWindowsPrivateDirectory(parent);
    }
  }
  let canonicalParent: string;
  try { canonicalParent = await realpath(parent); }
  catch (error) {
    if (path !== root || !missingWindowsEntry(error)) throw error;
    if (await resolvePosixPath(parent, '3.12') !== parent) throw new Error('Windows Store directory parent must be canonical');
    await mkdir(parent, { recursive: true });
    canonicalParent = await realpath(parent);
  }
  if (canonicalParent !== parent) throw new Error('Windows Store directory parent must be canonical');
  try { await mkdir(windowsPath(path)); }
  catch (error) {
    if (!existOk || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    requireWindowsPrivate(path, true);
    return;
  }
  addon.restrictToOwner(path);
  requireWindowsPrivate(path, true);
}

export async function openWindowsStoreFile(path: string, flags: number, privateFile = true): Promise<FileHandle> {
  const creating = Boolean(flags & constants.O_CREAT);
  const parent = win32.dirname(path);
  if (privateFile && await realpath(parent) !== parent) throw new Error('Windows Store file parent must be canonical');
  if (creating || flags & (constants.O_WRONLY | constants.O_RDWR)) {
    insideStore(path);
    requireWindowsPrivate(parent, true);
  }
  const initial = creating ? undefined : (privateFile ? requireWindowsPrivate(path, false) : windowsMetadata(path));
  if (initial?.directory) throw new Error('Windows Store entry must be a file');
  if (initial && privateFile && await realpath(path) !== path) {
    throw new Error('Windows Store file path must use its canonical spelling');
  }
  let handle: FileHandle;
  try {
    const access = flags & constants.O_WRONLY ? (flags & ~constants.O_WRONLY) | constants.O_RDWR : flags;
    handle = await open(windowsPath(path), (access & ~constants.O_TRUNC) | (creating ? constants.O_EXCL : 0));
  } catch (error) {
    if (!creating || (flags & constants.O_EXCL) || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return openWindowsStoreFile(path, flags & ~constants.O_CREAT, privateFile);
  }
  let opened: WindowsMetadata | undefined;
  try {
    opened = windowsMetadata(handle.fd);
    if (opened.directory || (privateFile && opened.links !== 1)) throw new Error('Windows Store entry must be a file without links');
    if (windowsFileIdentity(opened) !== windowsFileIdentity(initial ?? windowsMetadata(path))) {
      throw new Error('Windows Store file identity changed');
    }
    if (creating) store().addon.restrictToOwner(path);
    const checked = privateFile ? requireWindowsPrivate(handle.fd, false) : opened;
    if (windowsFileIdentity(windowsMetadata(path)) !== windowsFileIdentity(checked)) {
      throw new Error('Windows Store file identity changed');
    }
    if (flags & constants.O_TRUNC) await handle.truncate(0);
    return handle;
  } catch (error) {
    await handle.close();
    if (creating && opened) {
      try {
        if (windowsFileIdentity(windowsMetadata(path)) === windowsFileIdentity(opened)) await unlink(path);
      } catch { /* Preserve the original failure. */ }
    }
    throw error;
  }
}

export async function checkWindowsStoreWrite(path: string): Promise<void> {
  insideStore(path);
  const parent = win32.dirname(path);
  if (await realpath(parent) !== parent) throw new Error('Windows Store file parent must be canonical');
  requireWindowsPrivate(parent, true);
  try {
    requireWindowsPrivate(path, false);
    if (await realpath(path) !== path) throw new Error('Windows Store file path must use its canonical spelling');
  }
  catch (error) { if (!missingWindowsEntry(error)) throw error; }
}
