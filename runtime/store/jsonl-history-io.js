import { chmod, open, stat } from "node:fs/promises";
import { constants as bufferConstants } from "node:buffer";
import { filesystemEncode, FilesystemEncodeError } from "../contracts/posix-path-bytes.js";
import { validatePathProfile } from "../contracts/posix-path.js";
import { withPythonFilesystemErrors } from "../contracts/filesystem-error.js";
import { isFilesystemError } from "./private-filesystem.js";
class NullPathError extends Error {
    constructor() {
        super("embedded null byte");
        this.name = "ValueError";
    }
}
function nativePath(path) {
    const bytes = filesystemEncode(path);
    if (bytes.includes(0))
        throw new NullPathError();
    return bytes;
}
/** Native POSIX descriptor IO. Callers must separately own an exclusive lock. */
export function createNativeJsonlHistoryIO(profile) {
    validatePathProfile(profile);
    if (process.platform === "win32")
        throw new Error("Native Windows JSONL history IO is not supported by this POSIX adapter");
    return {
        async exists(path) {
            try {
                await withPythonFilesystemErrors(stat(nativePath(path)));
                return true;
            }
            catch (error) {
                if (error instanceof NullPathError || error instanceof FilesystemEncodeError)
                    return false;
                if (isFilesystemError(error) && (profile === "3.14"
                    || ["ENOENT", "ENOTDIR", "EBADF", "ELOOP"].includes(error.code ?? "")))
                    return false;
                throw error;
            }
        },
        chmod: (path, mode) => withPythonFilesystemErrors(chmod(nativePath(path), mode)),
        async open(path, flags, mode) {
            const handle = await withPythonFilesystemErrors(open(nativePath(path), flags, mode));
            return {
                stat: () => withPythonFilesystemErrors(handle.stat({ bigint: true })),
                async write(bytes) {
                    return (await withPythonFilesystemErrors(handle.write(bytes, 0, bytes.length, null))).bytesWritten;
                },
                async read(length) {
                    if (length < 0n || length > BigInt(bufferConstants.MAX_LENGTH)) {
                        throw new RangeError("History read exceeds the native Node buffer capacity");
                    }
                    const bytes = Buffer.alloc(Number(length));
                    const { bytesRead } = await withPythonFilesystemErrors(handle.read(bytes, 0, bytes.length, null));
                    return bytes.subarray(0, bytesRead);
                },
                truncate(size) {
                    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) {
                        throw new RangeError("History truncate size exceeds the native Node exact integer range");
                    }
                    return withPythonFilesystemErrors(handle.truncate(Number(size)));
                },
                sync: () => withPythonFilesystemErrors(handle.sync()),
                close: () => withPythonFilesystemErrors(handle.close()),
            };
        },
    };
}
