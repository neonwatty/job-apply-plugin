import { loadPosixFlockProvider } from './posix-flock.js';
import type { PosixFlockProvider } from './posix-flock.js';
import { withWindowsStore } from './windows-store.js';

/**
 * Run Store work with this host's lock provider. On Windows the operation also runs inside
 * the Windows Store scope, which limits private entry creation to `root`.
 */
export function withNativeStore<T>(root: string, addonPath: string,
  operation: (provider: PosixFlockProvider) => Promise<T>): Promise<T> {
  if (process.platform === 'win32') return withWindowsStore(root, addonPath, operation);
  return operation(loadPosixFlockProvider(addonPath));
}
