import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { NativeResumeFiles } from './native-resume-files.js';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { windowsLegacyStoreSourceTreeLocked } from './native-store-clone.js';
import { canonicalWindowsRoot } from './windows-activation.js';
import { requireWindowsPrivate, windowsFileIdentity, withWindowsStore } from './windows-store.js';

interface CheckedSource {
  root: string;
  digest: string;
  verify: () => Promise<void>;
}

/** Holds the legacy source lock through inspection and the caller's migration operation. */
export async function withCheckedWindowsMigrationSource<T>(source: string, addonPath: string,
  signal: AbortSignal, operation: (source: CheckedSource) => Promise<T>): Promise<T> {
  const root = await canonicalWindowsRoot(source);
  return withWindowsStore(root, addonPath, async provider => {
    const identity = () => windowsFileIdentity(requireWindowsPrivate(root, true));
    const before = identity();
    return withExclusiveFileLock(join(root, '.store.lock'), async () => {
      const digest = await windowsLegacyStoreSourceTreeLocked(root, provider, signal);
      await createNativeStoreBootstrap(root, undefined, process.env, undefined, { importLegacyProfile: false }).validateExisting();
      if ((await readdir(root)).includes('resume-files')) await new NativeResumeFiles(root).validate();
      const verify = async () => {
        if (await windowsLegacyStoreSourceTreeLocked(root, provider, signal) !== digest || identity() !== before) {
          throw new JobsError('legacy Store changed during migration');
        }
        signal.throwIfAborted();
      };
      return operation({ root, digest, verify });
    }, { provider, pathProfile: '3.12', signal, existingOnly: true });
  });
}

/** Checks an explicitly selected source under its existing lock, without writing to it. */
export function checkWindowsMigrationSource(source: string, addonPath: string,
  signal = AbortSignal.timeout(30_000)): Promise<void> {
  return withCheckedWindowsMigrationSource(source, addonPath, signal, checked => checked.verify());
}
