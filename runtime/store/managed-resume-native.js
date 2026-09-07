import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { filesystemEncode, FilesystemEncodeError } from "../contracts/posix-path-bytes.js";
import { validatePathProfile } from "../contracts/posix-path.js";
import { statSecondsFromNanoseconds } from "../contracts/stat-time.js";
import { managedResumePath } from "./managed-resume-path.js";
import { privateFileDigest } from "./private-file-digest.js";
class NativePathValueError extends Error {
    constructor() {
        super("embedded null byte");
        this.name = "ValueError";
    }
}
function nativePath(path) {
    // Python encodes before checking NUL, including when both errors are present.
    const bytes = filesystemEncode(path);
    if (bytes.includes(0))
        throw new NativePathValueError();
    return bytes;
}
function isOSError(error) {
    return error instanceof Error && "errno" in error && typeof error.errno === "number";
}
/** Explicit POSIX integration; selecting a Python build profile remains the caller's job. */
export function createManagedResumeNativeIO(root, options) {
    if (process.platform === "win32") {
        throw new Error("Native Windows managed resume observation is not supported by this POSIX adapter");
    }
    const { pathProfile, statTimeMode, nowMicroseconds } = options;
    validatePathProfile(pathProfile);
    if (statTimeMode !== "fused" && statTimeMode !== "separate") {
        throw new TypeError("Unknown stat time arithmetic mode");
    }
    async function isSymlink(path) {
        try {
            return (await lstat(nativePath(path), { bigint: true })).isSymbolicLink();
        }
        catch (error) {
            if (error instanceof NativePathValueError || error instanceof FilesystemEncodeError)
                return false;
            if (isOSError(error) && (pathProfile === "3.14"
                || error.code === "ENOENT" || error.code === "ENOTDIR"
                || error.code === "EBADF" || error.code === "ELOOP"))
                return false;
            throw error;
        }
    }
    const digestIO = {
        noFollow: constants.O_NOFOLLOW ?? 0,
        isSymbolicLink: isSymlink,
        open: (path, flags) => open(nativePath(path), flags),
    };
    return {
        managedPath: (record) => managedResumePath(root, record, pathProfile),
        async lstat(path) {
            const metadata = await lstat(nativePath(path), { bigint: true });
            return {
                dev: metadata.dev,
                ino: metadata.ino,
                size: metadata.size,
                mtimeNs: metadata.mtimeNs,
                ctimeNs: metadata.ctimeNs,
                mtimeSeconds: statSecondsFromNanoseconds(metadata.mtimeNs, statTimeMode),
                isRegularFile: metadata.isFile(),
            };
        },
        isSymlink,
        privateFileDigest: (path) => privateFileDigest(path, digestIO),
        nowMicroseconds,
        cacheIdentity: (metadata) => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs],
    };
}
