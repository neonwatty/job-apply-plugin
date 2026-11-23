import { join } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { createNativeStoreBootstrap } from './native-store-bootstrap.js';
import { windowsLegacyStoreSourceTreeLocked } from './native-store-clone.js';
import { canonicalWindowsRoot } from './windows-activation.js';
import { requireWindowsPrivate, windowsFileIdentity, withWindowsStore } from './windows-store.js';
/** Checks an explicitly selected source under its existing lock, without writing to it. */
export async function checkWindowsMigrationSource(source, addonPath, signal = AbortSignal.timeout(30_000)) {
    const root = await canonicalWindowsRoot(source);
    await withWindowsStore(root, addonPath, async (provider) => {
        const identity = () => windowsFileIdentity(requireWindowsPrivate(root, true));
        const before = identity();
        await withExclusiveFileLock(join(root, '.store.lock'), async () => {
            const digest = await windowsLegacyStoreSourceTreeLocked(root, provider, signal);
            await createNativeStoreBootstrap(root, undefined, process.env, undefined, { importLegacyProfile: false }).validateExisting();
            if (await windowsLegacyStoreSourceTreeLocked(root, provider, signal) !== digest || identity() !== before) {
                throw new JobsError('legacy Store changed during migration check');
            }
            signal.throwIfAborted();
        }, { provider, pathProfile: '3.12', signal, existingOnly: true });
    });
}
