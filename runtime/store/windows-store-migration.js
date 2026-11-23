import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, readdir, realpath, rename, rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { syncDirectory } from './directory-sync.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { copyWindowsLegacyStoreLocked, finishWindowsLegacyStoreCloneLocked } from './native-store-clone.js';
import { nativeCloneMarkerName, nativeCloneTrees, nativeFixtureMarkerName, nativeStorePendingName } from './native-store-layout.js';
import { canonicalWindowsRoot } from './windows-activation.js';
import { withCheckedWindowsMigrationSource } from './windows-migration-source.js';
import { ensureWindowsPrivateDirectory, missingWindowsEntry, openWindowsStoreFile, requireWindowsPrivate, windowsFileIdentity, withWindowsStore } from './windows-store.js';
function includesPath(root, path) {
    root = root.toLowerCase();
    path = path.toLowerCase();
    return path === root || path.startsWith(root.endsWith('\\') ? root : root + '\\');
}
function overlaps(left, right) {
    return includesPath(left, right) || includesPath(right, left);
}
async function requireUnusedTarget(target) {
    const parent = win32.dirname(target);
    if (parent === target || await realpath(parent).catch(() => null) !== parent) {
        throw new JobsError('migration target must have an existing canonical parent');
    }
    const metadata = await lstat(target).catch(error => {
        if (missingWindowsEntry(error))
            return null;
        throw error;
    });
    if (metadata !== null)
        throw new JobsError('migration target already exists');
}
function publishWindowsStoreCopy(source, target, addonPath, { signal = AbortSignal.timeout(120_000), beforePublish }, expectedSourceTree) {
    return withCheckedWindowsMigrationSource(source, addonPath, signal, async (checked) => {
        if (expectedSourceTree !== undefined && checked.digest !== expectedSourceTree) {
            throw new JobsError('legacy Store differs from the migration receipt');
        }
        const destination = await canonicalWindowsRoot(target);
        if (overlaps(checked.root, destination))
            throw new JobsError('migration source and target must be separate');
        await requireUnusedTarget(destination);
        const parent = win32.dirname(destination);
        const staging = win32.join(parent, `.job-apply-migration-${randomUUID()}`);
        let identity;
        const stageIdentity = () => windowsFileIdentity(requireWindowsPrivate(staging, true));
        try {
            await withWindowsStore(staging, addonPath, async (provider) => {
                await ensureWindowsPrivateDirectory(staging, false);
                identity = stageIdentity();
                await withExclusiveFileLock(win32.join(staging, '.store.lock'), async () => {
                    const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
                    const original = await copyWindowsLegacyStoreLocked(checked.root, staging, checked.digest, signal);
                    await createNativeStoreBootstrap(staging, undefined, process.env, undefined, { clock: () => now, importLegacyProfile: false, recoverExisting: false }).initialize();
                    await beforePublish?.();
                    await checked.verify();
                    await finishWindowsLegacyStoreCloneLocked(staging, original, checked.digest, provider, signal, now);
                }, { provider, pathProfile: '3.12', signal });
                await syncDirectory(staging);
            });
            await requireUnusedTarget(destination);
            if (await realpath(staging) !== staging || stageIdentity() !== identity) {
                throw new JobsError('migration staging Store changed');
            }
            signal.throwIfAborted();
            // Publish after closing the staged Store lock. Windows directory renames refuse existing targets.
            await rename(staging, destination);
        }
        catch (error) {
            if (identity !== undefined) {
                await (async () => {
                    if (await realpath(staging) === staging && stageIdentity() === identity) {
                        await rm(staging, { recursive: true });
                    }
                })().catch(() => { });
            }
            throw error;
        }
    });
}
/** Publishes a verified native copy at an explicit unused path, keeping the legacy source intact. */
export function copyWindowsStoreForMigration(source, target, addonPath, options = {}) {
    return publishWindowsStoreCopy(source, target, addonPath, options);
}
async function readMigrationSourceTree(migrated, addonPath, signal) {
    return withWindowsStore(migrated, addonPath, async (provider) => {
        requireWindowsPrivate(migrated, true);
        return withExclusiveFileLock(win32.join(migrated, '.store.lock'), async () => {
            const entries = await readdir(migrated);
            if (entries.includes(nativeFixtureMarkerName) || entries.includes(nativeStorePendingName)) {
                throw new JobsError('migration receipt must be from an initialized native clone');
            }
            const handle = await openWindowsStoreFile(win32.join(migrated, nativeCloneMarkerName), constants.O_RDONLY);
            try {
                if ((await handle.stat()).size > 4096)
                    throw new JobsError('migration receipt is too large');
                return nativeCloneTrees(await handle.readFile()).sourceTree;
            }
            finally {
                await handle.close();
            }
        }, { provider, pathProfile: '3.12', signal, existingOnly: true });
    });
}
/** Reopens the migration-time data as a separate native Store, preserving both input Stores. */
export async function rollbackWindowsStoreMigration(source, migrated, target, addonPath, options = {}) {
    const signal = options.signal ?? AbortSignal.timeout(120_000);
    const [legacyRoot, migratedRoot, recoveryRoot] = await Promise.all([
        canonicalWindowsRoot(source), canonicalWindowsRoot(migrated), canonicalWindowsRoot(target),
    ]);
    if (overlaps(legacyRoot, migratedRoot) || overlaps(migratedRoot, recoveryRoot) || overlaps(legacyRoot, recoveryRoot)) {
        throw new JobsError('rollback Store paths must be separate');
    }
    const sourceTree = await readMigrationSourceTree(migratedRoot, addonPath, signal);
    await publishWindowsStoreCopy(legacyRoot, recoveryRoot, addonPath, { ...options, signal }, sourceTree);
}
