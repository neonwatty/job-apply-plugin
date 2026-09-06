import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pythonFilesystemError } from "../contracts/filesystem-error.js";
/** Load only an explicitly selected native artifact; no build or download fallback. */
export function loadPosixFlockProvider(absoluteAddonPath) {
    if (process.platform === "win32")
        throw new Error("POSIX flock is unavailable on native Windows");
    if (!isAbsolute(absoluteAddonPath))
        throw new TypeError("Native flock artifact path must be absolute");
    const native = createRequire(import.meta.url)(absoluteAddonPath);
    if (native === null || typeof native !== "object" || !("tryLock" in native) || !("unlock" in native)
        || typeof native.tryLock !== "function" || typeof native.unlock !== "function") {
        throw new TypeError("Native flock artifact has an invalid interface");
    }
    const tryLock = native.tryLock;
    const unlock = native.unlock;
    return {
        tryLock(descriptor) {
            try {
                const result = Reflect.apply(tryLock, native, [descriptor]);
                if (typeof result !== "boolean")
                    throw new TypeError("Native flock acquisition returned an invalid result");
                return result;
            }
            catch (error) {
                throw pythonFilesystemError(error);
            }
        },
        unlock(descriptor) {
            try {
                Reflect.apply(unlock, native, [descriptor]);
            }
            catch (error) {
                throw pythonFilesystemError(error);
            }
        },
    };
}
