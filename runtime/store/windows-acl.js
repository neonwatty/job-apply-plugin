import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolvePackagedNativeLock } from '../package/native-lock-artifact.js';
let loaded;
async function acl() {
    loaded ??= (async () => {
        const pluginRoot = await realpath(fileURLToPath(new URL('../../', import.meta.url)));
        const native = createRequire(import.meta.url)(await resolvePackagedNativeLock(pluginRoot));
        if (native === null || typeof native !== 'object' || !('restrictToOwner' in native) || !('isOwnerOnly' in native)
            || typeof native.restrictToOwner !== 'function' || typeof native.isOwnerOnly !== 'function') {
            throw new TypeError('Native Windows ACL artifact has an invalid interface');
        }
        return native;
    })();
    return loaded;
}
/** Make `path` private to the current user (Windows equivalent of chmod 0700). */
export async function restrictToOwner(path) {
    if (process.platform !== 'win32')
        return;
    const native = await acl();
    if (!native.isOwnerOnly(path))
        native.restrictToOwner(path);
}
/** True when `path` is owned by and only accessible to the current user. POSIX: always true. */
export async function isOwnerOnly(path) {
    if (process.platform !== 'win32')
        return true;
    return (await acl()).isOwnerOnly(path);
}
