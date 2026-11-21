import { loadPosixFlockProvider } from './posix-flock.js';
import { withWindowsStore } from './windows-store.js';
/**
 * Run Store work with this host's lock provider. On Windows the operation also runs inside
 * the Windows Store scope, which limits private entry creation to `root`.
 */
export function withNativeStore(root, addonPath, operation) {
    if (process.platform === 'win32')
        return withWindowsStore(root, addonPath, operation);
    return operation(loadPosixFlockProvider(addonPath));
}
