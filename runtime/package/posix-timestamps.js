import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { filesystemEncode } from "../contracts/posix-path-bytes.js";
import { pythonFilesystemError } from "../contracts/filesystem-error.js";
/** Explicit artifact loading only: never compile or download from a runtime call. */
export function loadPosixTimestampProvider(absoluteAddonPath) {
    if (!["darwin", "linux"].includes(process.platform))
        throw new Error("POSIX timestamps are unavailable on this platform");
    if (!isAbsolute(absoluteAddonPath))
        throw new TypeError("Native timestamp artifact path must be absolute");
    const native = createRequire(import.meta.url)(absoluteAddonPath);
    if (native === null || typeof native !== "object" || !("setTimes" in native)
        || typeof native.setTimes !== "function")
        throw new TypeError("Native timestamp artifact has an invalid interface");
    const setTimes = native.setTimes;
    return {
        async setTimes(path, atimeSeconds, atimeNanoseconds, mtimeSeconds, mtimeNanoseconds, followSymlinks) {
            try {
                const result = Reflect.apply(setTimes, native, [path, atimeSeconds, atimeNanoseconds, mtimeSeconds, mtimeNanoseconds, followSymlinks]);
                if (!(result instanceof Promise))
                    throw new TypeError("Native timestamp operation must return a Promise");
                if (await result !== undefined)
                    throw new TypeError("Native timestamp operation returned an invalid result");
            }
            catch (error) {
                throw pythonFilesystemError(error);
            }
        },
    };
}
function splitNanoseconds(value) {
    if (typeof value !== "bigint")
        throw new TypeError("Timestamp nanoseconds must be bigint");
    let seconds = value / 1000000000n;
    let remainder = value % 1000000000n;
    if (remainder < 0n) {
        seconds -= 1n;
        remainder += 1000000000n;
    }
    return [seconds, Number(remainder)];
}
/** Preserve exact nanoseconds and Python UTF-8/surrogateescape path bytes. */
export async function setTimesNs(provider, path, atimeNs, mtimeNs, followSymlinks) {
    const bytes = filesystemEncode(path);
    if (bytes.includes(0)) {
        const error = new Error("embedded null byte");
        error.name = "ValueError";
        throw error;
    }
    const [atimeSeconds, atimeNanoseconds] = splitNanoseconds(atimeNs);
    const [mtimeSeconds, mtimeNanoseconds] = splitNanoseconds(mtimeNs);
    await provider.setTimes(bytes, atimeSeconds, atimeNanoseconds, mtimeSeconds, mtimeNanoseconds, followSymlinks);
}
