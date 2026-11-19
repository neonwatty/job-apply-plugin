/**
 * Ownership and permission predicates over `fs.Stats`/`fs.BigIntStats`.
 *
 * POSIX: these read `uid` and the permission bits exactly as the Store always has.
 *
 * Windows: Node synthesizes `uid` (0) and permission bits (0o666/0o444) that do not
 * describe access. Privacy is instead enforced by an owner-only, protected DACL on the
 * Store root (see `windows-acl.ts`), which every Store entry inherits, and is verified
 * where the root is validated. Inside that boundary these predicates report the
 * POSIX-equivalent private state so the shared checks keep one meaning.
 */
type Metadata = { uid: number | bigint; mode: number | bigint; isDirectory(): boolean };

const isWindows = process.platform === 'win32';

export function ownedByCurrentUser(metadata: Metadata): boolean {
  if (isWindows) return true;
  const uid = process.getuid?.();
  return uid !== undefined && BigInt(metadata.uid) === BigInt(uid);
}

/** Permission bits (`mode & 0o777`) with Windows reporting the inherited private mode. */
export function permissionBits(metadata: Metadata): number {
  if (isWindows) return metadata.isDirectory() ? 0o700 : 0o600;
  return Number(BigInt(metadata.mode) & 0o777n);
}

/** True when the entry is owned and grants no group/other access (`mode & 0o077` clear). */
export function isPrivateOwned(metadata: Metadata): boolean {
  return ownedByCurrentUser(metadata) && (permissionBits(metadata) & 0o077) === 0;
}

/** True when the entry is owned and not writable by group/other (`mode & 0o022` clear). */
export function isOwnedNotOthersWritable(metadata: Metadata): boolean {
  return ownedByCurrentUser(metadata) && (permissionBits(metadata) & 0o022) === 0;
}

/**
 * Device id for identity comparison. On Windows, Node reports `dev` 0 from path-based
 * `stat`/`lstat` but the volume serial from handle-based `fstat`, so the same file would
 * look different. Comparisons there rely on the per-volume file index (`ino`) alone.
 */
export function deviceId<T extends number | bigint>(metadata: { dev: T }): T {
  if (!isWindows) return metadata.dev;
  return (typeof metadata.dev === 'bigint' ? 0n : 0) as T;
}
