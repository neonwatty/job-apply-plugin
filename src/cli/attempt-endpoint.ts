import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { filesystemEncode } from '../contracts/posix-path-bytes.js';

/**
 * Where the per-Store attempt broker listens and keeps its exclusion lock.
 *
 * POSIX: a Unix socket in a private `/tmp/job-apply-attempt-<uid>` directory, with the
 * lock beside it.
 *
 * Windows: a named pipe (Unix sockets have no `/tmp` or owner-mode equivalent). Pipe
 * names are machine-global, so the name binds the user and the Store root. The lock
 * lives in the per-user temp directory, which Windows already restricts to its owner.
 */
export interface AttemptEndpoint { path: string; lockPath: string; directory: string; namedPipe: boolean }

const digest = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');

export function attemptEndpoint(root: string, uid = process.getuid?.()): AttemptEndpoint {
  const rootHash = digest(filesystemEncode(root));
  if (process.platform === 'win32') {
    const user = digest(`${process.env.USERDOMAIN ?? ''}\\${userInfo().username}`).slice(0, 16);
    const directory = join(tmpdir(), `job-apply-attempt-${user}`);
    return { path: `\\\\.\\pipe\\job-apply-attempt-${user}-${rootHash}`, directory,
      lockPath: join(directory, `${rootHash}.sock.lock`), namedPipe: true };
  }
  if (uid === undefined) throw new Error('attempt transport unavailable');
  const path = `/tmp/job-apply-attempt-${uid}/${rootHash}.sock`;
  return { path, lockPath: `${path}.lock`, directory: dirname(path), namedPipe: false };
}

/** Windows equivalent of resolving each existing component's links for an absent Store. */
export function resolveWindowsAttemptRoot(configured: string): string {
  let current = resolve(configured);
  const missing: string[] = [];
  for (;;) {
    try { return join(realpathSync.native(current), ...missing.reverse()); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(current);
      if (parent === current) return resolve(configured);
      missing.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
}
