import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { JobsError } from '../contracts/workspace/values.js';
import { openWindowsStoreFile, requireWindowsPrivate } from './windows-store.js';
export async function requirePrivateStoreDirectory(path, message) {
    if (process.platform === 'win32') {
        requireWindowsPrivate(path, true);
        return;
    }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || stat.mode & 0o077) {
        throw new JobsError(message);
    }
}
export async function openPrivateStoreFile(path, flags, message) {
    if (process.platform === 'win32')
        return openWindowsStoreFile(path, flags);
    const handle = await open(path, flags | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
            throw new JobsError(message);
        }
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
