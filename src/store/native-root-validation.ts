import { lstat, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { nativeFixtureMarkerName, nativeCloneMarkerName, nativeStoreAllowedEntries,
  nativeStoreRequiredEntries, validateNativeStoreMetadata } from './native-store-layout.js';

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
  if (locked && entries.some(name => !nativeStoreAllowedEntries.has(name))
    || nativeStoreRequiredEntries.some(name => !(allowMissingJobs && name === 'jobs.json') && !entries.includes(name))
    || markers.length !== 1)
    throw new JobsError('native Jobs cannot open unsupported state or recovery journals');
  await validateNativeStoreMetadata(root, markers[0]!, await read(markers[0]!));
  await read('.store.lock');
}
