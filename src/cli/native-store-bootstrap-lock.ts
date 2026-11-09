import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { withExclusiveFileLock } from '../store/exclusive-file-lock.js';
import type { ExclusiveLockIO, LockFileHandle } from '../store/exclusive-file-lock.js';
import type { PosixFlockProvider } from '../store/posix-flock.js';

async function validateParent(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path
    || metadata.uid !== process.getuid?.()) throw new JobsError('Store bootstrap lock parent is unsafe');
}
const io: ExclusiveLockIO = {
  ensurePrivateDirectory: validateParent,
  async open(path, flags, mode): Promise<LockFileHandle> {
    const handle = await open(path, flags | constants.O_NOFOLLOW, mode);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()) {
        throw new JobsError('Store bootstrap lock is unsafe');
      }
      return { fd: handle.fd, close: () => handle.close() };
    } catch (error) { await handle.close(); throw error; }
  },
  async chmod(path, mode) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.uid !== process.getuid?.()) {
      throw new JobsError('Store bootstrap lock is unsafe');
    }
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.chmod(mode); } finally { await handle.close(); }
  },
};

export function withStoreBootstrapLock<T>(root: string, provider: PosixFlockProvider,
  operation: () => Promise<T>): Promise<T> {
  const absolute = resolve(root), parent = dirname(absolute);
  const identity = createHash('sha256').update(absolute).digest('hex').slice(0, 32);
  return withExclusiveFileLock(join(parent, `.job-apply-bootstrap-${identity}.lock`), operation,
    { provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000), io });
}
