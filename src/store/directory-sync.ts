import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

/**
 * Persist a directory's entries after create, rename, or unlink (POSIX `fsync(dirfd)`).
 *
 * Windows has no equivalent: a directory handle cannot be flushed (FlushFileBuffers
 * needs write access and fails with EPERM), and NTFS journals directory metadata
 * itself. File contents are still flushed through their own handles everywhere.
 */
export async function syncDirectory(path: string, flags: number = constants.O_RDONLY): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, flags);
  try { await handle.sync(); } finally { await handle.close(); }
}
