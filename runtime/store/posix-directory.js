import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
function basename(name) {
    if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\0/]/u.test(name)
        || Buffer.from(name, 'utf8').toString('utf8') !== name)
        throw new TypeError('Directory basename is invalid');
}
/** Explicit artifact only; operations remain relative to the caller's pinned fd. */
export function loadPosixDirectoryProvider(absoluteAddonPath) {
    if (!['darwin', 'linux'].includes(process.platform))
        throw new Error('POSIX directory access is unavailable');
    if (!isAbsolute(absoluteAddonPath))
        throw new TypeError('Native directory artifact path must be absolute');
    const native = createRequire(import.meta.url)(absoluteAddonPath);
    if (native === null || typeof native !== 'object' || !('listNames' in native) || typeof native.listNames !== 'function'
        || !('inspect' in native) || typeof native.inspect !== 'function' || !('openFile' in native) || typeof native.openFile !== 'function')
        throw new TypeError('Native directory artifact has an invalid interface');
    const { listNames, inspect, openFile } = native;
    return {
        listNames(descriptor) {
            const result = listNames(descriptor);
            if (!Array.isArray(result) || result.some(name => !Buffer.isBuffer(name)))
                throw new TypeError('Native directory listing is invalid');
            return result;
        },
        inspect(descriptor, name) {
            basename(name);
            const result = inspect(descriptor, name);
            if (result === null || typeof result !== 'object' || !('dev' in result) || typeof result.dev !== 'bigint'
                || !('ino' in result) || typeof result.ino !== 'bigint' || !('size' in result) || typeof result.size !== 'bigint'
                || !('mode' in result) || typeof result.mode !== 'number')
                throw new TypeError('Native directory metadata is invalid');
            return result;
        },
        openFile(descriptor, name) {
            basename(name);
            const result = openFile(descriptor, name);
            if (typeof result !== 'number' || !Number.isInteger(result) || result < 0)
                throw new TypeError('Native directory descriptor is invalid');
            return result;
        },
    };
}
