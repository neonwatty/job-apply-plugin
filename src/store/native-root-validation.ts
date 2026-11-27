import { readdir, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { requirePrivateStoreDirectory } from './private-store-entry.js';
import { validateCollectionCompatibility } from './native-collection-compatibility.js';
import { nativeFixtureMarkerName, nativeCloneMarkerName, nativeStoreAllowedEntries,
  nativeStoreRequiredEntries, validateNativeStoreMetadata } from './native-store-layout.js';

/** Root checks shared by every native Jobs transaction before touching records. */
export async function validateNativeJobsRoot(root: string, read: (name: string) => Promise<Buffer>,
  locked = false, allowMissingJobs = false, activationEntries: readonly string[] = []): Promise<void> {
  if (!isAbsolute(root) || root !== resolve(root) || await realpath(root) !== root)
    throw new JobsError('native fixture root must be a real absolute directory');
  await requirePrivateStoreDirectory(root, 'native fixture root must be private and owned');
  const entries = await readdir(root);
  const markers = [nativeFixtureMarkerName, nativeCloneMarkerName].filter(name => entries.includes(name));
  if (locked && entries.some(name => !nativeStoreAllowedEntries.has(name)
    && !activationEntries.includes(name))
    || nativeStoreRequiredEntries.some(name => !(allowMissingJobs && name === 'jobs.json') && !entries.includes(name))
    || markers.length !== 1)
    throw new JobsError('native Jobs cannot open unsupported state or recovery journals');
  await validateNativeStoreMetadata(root, markers[0]!, await read(markers[0]!));
  await read('.store.lock');
  if (locked) await validateCollectionCompatibility(root, new Set(entries));
}
