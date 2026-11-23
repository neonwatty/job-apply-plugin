import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { canonicalStoreSourceTreeLocked } from './native-store-clone.js';
import { nativePolicyTreeName } from './native-store-layout.js';
import type { PosixFlockProvider } from './posix-flock.js';
import { canonicalWindowsRoot } from './windows-activation.js';
import { requireWindowsPrivate, windowsFileIdentity, withWindowsStore } from './windows-store.js';

async function inspectLocked(root: string, provider: PosixFlockProvider, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  if ((await readdir(root)).includes(nativePolicyTreeName)) throw new JobsError('Windows legacy policy migration is unsupported');
  return canonicalStoreSourceTreeLocked(root, provider, signal);
}

/** Checks an explicitly selected source under its existing lock, without writing to it. */
export async function checkWindowsMigrationSource(source: string, addonPath: string,
  signal = AbortSignal.timeout(30_000)): Promise<void> {
  const root = await canonicalWindowsRoot(source);
  await withWindowsStore(root, addonPath, async provider => {
    const identity = () => windowsFileIdentity(requireWindowsPrivate(root, true));
    const before = identity();
    await withExclusiveFileLock(join(root, '.store.lock'), async () => {
      const digest = await inspectLocked(root, provider, signal);
      await createNativeStoreBootstrap(root, undefined, process.env, undefined, { importLegacyProfile: false }).validateExisting();
      if (await inspectLocked(root, provider, signal) !== digest || identity() !== before) {
        throw new JobsError('legacy Store changed during migration check');
      }
      signal.throwIfAborted();
    }, { provider, pathProfile: '3.12', signal, existingOnly: true });
  });
}
