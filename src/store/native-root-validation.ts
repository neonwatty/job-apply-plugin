import { constants } from 'node:fs';
import { lstat, readdir, realpath, open, unlink } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { nativeFixtureMarkerName, nativeCloneMarkerName, nativeStoreAllowedEntries,
  nativeStoreRequiredEntries, validateNativeStoreMetadata, workflowTemporaryPattern } from './native-store-layout.js';

/** Root checks shared by every native Jobs transaction before touching records. */
export async function validateNativeJobsRoot(root: string, read: (name: string) => Promise<Buffer>,
  locked = false, allowMissingJobs = false): Promise<void> {
  if (!isAbsolute(root) || root !== resolve(root) || await realpath(root) !== root)
    throw new JobsError('native fixture root must be a real absolute directory');
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())
    throw new JobsError('native fixture root must be private and owned');
  const entries = await readdir(root);
  const markers = [nativeFixtureMarkerName, nativeCloneMarkerName].filter(name => entries.includes(name));
  if (locked && entries.some(name => !nativeStoreAllowedEntries.has(name) && !workflowTemporaryPattern.test(name))
    || nativeStoreRequiredEntries.some(name => !(allowMissingJobs && name === 'jobs.json') && !entries.includes(name))
    || markers.length !== 1)
    throw new JobsError('native Jobs cannot open unsupported state or recovery journals');
  await validateNativeStoreMetadata(root, markers[0]!, await read(markers[0]!));
  await read('.store.lock');
  if (locked) await discardWorkflowTemporaries(root, entries);
}

/** Only the experimental atomic writer uses these names. Under the Store lock a remaining
 * temporary was never committed, so jobs.json remains authoritative even for partial JSON.
 */
async function discardWorkflowTemporaries(root: string, entries: string[]): Promise<void> {
  const names = entries.filter(name => workflowTemporaryPattern.test(name));
  for (const name of names) {
    const path = join(root, name);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat(), current = await lstat(path);
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.()
        || (info.mode & 0o777) !== 0o600 || info.size > 32 * 1024 * 1024
        || current.dev !== info.dev || current.ino !== info.ino || current.isSymbolicLink()) {
        throw new JobsError('workflow temporary must be private, owned and bounded');
      }
      await unlink(path);
    } finally { await handle.close(); }
  }
  if (names.length) {
    const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
}
