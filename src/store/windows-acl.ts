import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';

/**
 * Windows replacement for the Store's `chmod 0700` and "private and owned" root checks.
 * Every function is a no-op elsewhere, where POSIX modes already carry this meaning.
 *
 * The packaged native lock exports `restrictToOwner` (protected, inheritable DACL that
 * allows only the current user) and `isOwnerOnly`. Entries created inside a restricted
 * directory inherit that DACL, which is why per-entry checks can rely on the root.
 */
interface WindowsAcl { restrictToOwner(path: string): void; isOwnerOnly(path: string): boolean }

let loaded: Promise<WindowsAcl> | undefined;

async function acl(): Promise<WindowsAcl> {
  loaded ??= (async () => {
    const pluginRoot = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
    const native: unknown = createRequire(import.meta.url)(await resolvePackagedNativeLock(pluginRoot));
    if (native === null || typeof native !== 'object' || !('restrictToOwner' in native) || !('isOwnerOnly' in native)
      || typeof native.restrictToOwner !== 'function' || typeof native.isOwnerOnly !== 'function') {
      throw new TypeError('Native Windows ACL artifact has an invalid interface');
    }
    return native as WindowsAcl;
  })();
  return loaded;
}

/** Make `path` private to the current user (Windows equivalent of chmod 0700). */
export async function restrictToOwner(path: string): Promise<void> {
  if (process.platform !== 'win32') return;
  const native = await acl();
  if (!native.isOwnerOnly(path)) native.restrictToOwner(path);
}

/** True when `path` is owned by and only accessible to the current user. POSIX: always true. */
export async function isOwnerOnly(path: string): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  return (await acl()).isOwnerOnly(path);
}
