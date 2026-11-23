import { randomUUID } from 'node:crypto';
import { lstat, realpath, rename, rm } from 'node:fs/promises';
import { win32 } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { syncDirectory } from './directory-sync.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { copyWindowsLegacyStoreLocked, finishWindowsLegacyStoreCloneLocked } from './native-store-clone.js';
import { canonicalWindowsRoot } from './windows-activation.js';
import { withCheckedWindowsMigrationSource } from './windows-migration-source.js';
import { ensureWindowsPrivateDirectory, missingWindowsEntry, requireWindowsPrivate, windowsFileIdentity,
  withWindowsStore } from './windows-store.js';

function includesPath(root: string, path: string): boolean {
  root = root.toLowerCase();
  path = path.toLowerCase();
  return path === root || path.startsWith(root.endsWith('\\') ? root : root + '\\');
}

async function requireUnusedTarget(target: string): Promise<void> {
  const parent = win32.dirname(target);
  if (parent === target || await realpath(parent).catch(() => null) !== parent) {
    throw new JobsError('migration target must have an existing canonical parent');
  }
  const metadata = await lstat(target).catch(error => {
    if (missingWindowsEntry(error)) return null;
    throw error;
  });
  if (metadata !== null) throw new JobsError('migration target already exists');
}

interface WindowsMigrationOptions {
  signal?: AbortSignal;
  beforePublish?: () => Promise<void>;
}

/** Publishes a verified native copy at an explicit unused path, keeping the legacy source intact. */
export function copyWindowsStoreForMigration(source: string, target: string, addonPath: string,
  { signal = AbortSignal.timeout(120_000), beforePublish }: WindowsMigrationOptions = {}): Promise<void> {
  return withCheckedWindowsMigrationSource(source, addonPath, signal, async checked => {
    const destination = await canonicalWindowsRoot(target);
    if (includesPath(checked.root, destination) || includesPath(destination, checked.root)) {
      throw new JobsError('migration source and target must be separate');
    }
    await requireUnusedTarget(destination);
    const parent = win32.dirname(destination);
    const staging = win32.join(parent, `.job-apply-migration-${randomUUID()}`);
    let identity: string | undefined;
    const stageIdentity = () => windowsFileIdentity(requireWindowsPrivate(staging, true));
    try {
      await withWindowsStore(staging, addonPath, async provider => {
        await ensureWindowsPrivateDirectory(staging, false);
        identity = stageIdentity();
        await withExclusiveFileLock(win32.join(staging, '.store.lock'), async () => {
          const original = await copyWindowsLegacyStoreLocked(checked.root, staging, checked.digest, signal);
          await createNativeStoreBootstrap(staging, undefined, process.env, undefined,
            { importLegacyProfile: false, recoverExisting: false }).initialize();
          await beforePublish?.();
          await checked.verify();
          await finishWindowsLegacyStoreCloneLocked(staging, original, checked.digest, provider, signal);
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
    } catch (error) {
      if (identity !== undefined) {
        await (async () => {
          if (await realpath(staging) === staging && stageIdentity() === identity) {
            await rm(staging, { recursive: true });
          }
        })().catch(() => {});
      }
      throw error;
    }
  });
}
