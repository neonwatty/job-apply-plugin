const isWindows = process.platform === 'win32';
export function ownedByCurrentUser(metadata) {
    if (isWindows)
        return true;
    const uid = process.getuid?.();
    return uid !== undefined && BigInt(metadata.uid) === BigInt(uid);
}
/** Permission bits (`mode & 0o777`) with Windows reporting the inherited private mode. */
export function permissionBits(metadata) {
    if (isWindows)
        return metadata.isDirectory() ? 0o700 : 0o600;
    return Number(BigInt(metadata.mode) & 511n);
}
/** True when the entry is owned and grants no group/other access (`mode & 0o077` clear). */
export function isPrivateOwned(metadata) {
    return ownedByCurrentUser(metadata) && (permissionBits(metadata) & 0o077) === 0;
}
/** True when the entry is owned and not writable by group/other (`mode & 0o022` clear). */
export function isOwnedNotOthersWritable(metadata) {
    return ownedByCurrentUser(metadata) && (permissionBits(metadata) & 0o022) === 0;
}
/**
 * Device id for identity comparison. On Windows, Node reports `dev` 0 from path-based
 * `stat`/`lstat` but the volume serial from handle-based `fstat`, so the same file would
 * look different. Comparisons there rely on the per-volume file index (`ino`) alone.
 */
export function deviceId(metadata) {
    if (!isWindows)
        return metadata.dev;
    return (typeof metadata.dev === 'bigint' ? 0n : 0);
}
