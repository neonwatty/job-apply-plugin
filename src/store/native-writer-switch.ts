import { lstat, readFile, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { canonicalStoreCandidateTreeLocked, canonicalStoreSourceTreeLocked } from './native-store-clone.js';
import { nativeCloneMarkerName, nativeCloneTrees, nativeFixtureMarkerName, validateNativeStoreMarker } from './native-store-layout.js';
import { withNativePolicyTree } from './native-policy-tree.js';
import type { PosixFlockProvider } from './posix-flock.js';
import { syncDirectory } from './directory-sync.js';
import { isOwnedNotOthersWritable, isPrivateOwned } from './private-metadata.js';

export type NativeWriterSwitchBoundary =
  | 'before-source-rename' | 'after-source-rename' | 'after-candidate-rename'
  | 'before-native-rename' | 'after-native-rename' | 'after-python-rename';

export interface NativeWriterSwitchOptions {
  provider: PosixFlockProvider;
  signal?: AbortSignal;
  boundary?: (boundary: NativeWriterSwitchBoundary) => void | Promise<void>;
}

export interface NativeWriterSwitchPaths {
  active: string;
  candidate: string;
  pythonRollback: string;
  nativeRetained: string;
}

function paths(active: string, candidate = `${active}.native-candidate`): NativeWriterSwitchPaths {
  if (![active, candidate].every(path => isAbsolute(path) && path === resolve(path))
    || candidate !== `${active}.native-candidate` || dirname(active) !== dirname(candidate)) {
    throw new JobsError('writer switch paths are invalid');
  }
  return { active, candidate, pythonRollback: `${active}.python-rollback`, nativeRetained: `${active}.native-retained` };
}

async function kind(path: string): Promise<'missing' | 'python' | 'native'> {
  let metadata;
  try { metadata = await lstat(path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || await realpath(path) !== path
    || !isPrivateOwned(metadata)) throw new JobsError('writer switch Store is invalid');
  let ownership: 'clone' | null = null;
  for (const name of [nativeFixtureMarkerName, nativeCloneMarkerName]) {
    try {
      const marker = await lstat(join(path, name));
      if (!marker.isFile() || marker.isSymbolicLink()) throw new JobsError('writer switch marker is invalid');
      const value = validateNativeStoreMarker(name, await readFile(join(path, name)));
      if (ownership || value !== 'clone') throw new JobsError('writer switch ownership is invalid');
      ownership = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return ownership ? 'native' : 'python';
}


async function locked<T>(active: string, options: NativeWriterSwitchOptions, callback: () => Promise<T>): Promise<T> {
  const parent = dirname(active);
  const canonical = await realpath(parent).catch(() => null), metadata = await lstat(parent).catch(() => null);
  if (canonical !== parent || !metadata?.isDirectory() || metadata.isSymbolicLink()
    || !isOwnedNotOthersWritable(metadata)) throw new JobsError('writer switch parent must be owned and not writable by others');
  return withExclusiveFileLock(join(parent, `.${basename(active)}.writer-switch.lock`), async () => callback(), {
    provider: options.provider, pathProfile: '3.12', preserveParentPermissions: true,
    signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

/**
 * Hold both Store locks and both policy trees for `work`. POSIX keeps them across the
 * directory renames. Windows cannot rename a directory that has open handles inside it,
 * so there the caller renames after release and re-verifies under fresh locks.
 */
const holdLocksAcrossRename = process.platform !== 'win32';
type PolicyEntries = Parameters<typeof canonicalStoreSourceTreeLocked>[3];
async function underStoreLocks<T>(first: string, second: string, options: NativeWriterSwitchOptions,
  work: (firstPolicy: PolicyEntries, secondPolicy: PolicyEntries) => Promise<T>): Promise<T> {
  const lockOptions = { provider: options.provider, pathProfile: '3.12' as const, signal: options.signal ?? AbortSignal.timeout(30_000) };
  return withExclusiveFileLock(join(first, '.store.lock'), async () =>
    withExclusiveFileLock(join(second, '.store.lock'), async () =>
      withNativePolicyTree(first, options.provider, async firstPolicy =>
        withNativePolicyTree(second, options.provider, async secondPolicy => work(firstPolicy, secondPolicy),
          options.signal), options.signal), lockOptions), lockOptions);
}
async function moveDirectory(from: string, to: string): Promise<void> {
  await rename(from, to);
  await syncDirectory(dirname(to));
}

/** Atomically selects a prepared native clone by directory entry, retaining the Python Store for rollback. */
export async function activateNativeWriter(active: string, candidate: string,
  options: NativeWriterSwitchOptions): Promise<NativeWriterSwitchPaths> {
  const value = paths(active, candidate), boundary = options.boundary ?? (() => {});
  const verify = async (source: string, sourcePolicy: PolicyEntries, candidatePolicy: PolicyEntries): Promise<void> => {
    const expected = nativeCloneTrees(await readFile(join(value.candidate, nativeCloneMarkerName)));
    const sourceTree = await canonicalStoreSourceTreeLocked(source, options.provider, options.signal, sourcePolicy);
    const candidateTree = await canonicalStoreCandidateTreeLocked(
      value.candidate, options.provider, options.signal, candidatePolicy,
    );
    if (sourceTree !== expected.sourceTree) throw new JobsError('native candidate does not match the active Python Store');
    if (candidateTree !== expected.candidateTree) throw new JobsError('native candidate content changed after preparation');
  };
  const retainSource = async (): Promise<void> => {
    await boundary('before-source-rename');
    await moveDirectory(value.active, value.pythonRollback);
    await boundary('after-source-rename');
  };
  const selectCandidate = async (): Promise<NativeWriterSwitchPaths> => {
    await moveDirectory(value.candidate, value.active);
    await boundary('after-candidate-rename');
    return value;
  };
  return locked(active, options, async () => {
    if (await kind(value.active) !== 'python' || await kind(value.candidate) !== 'native'
      || await kind(value.pythonRollback) !== 'missing' || await kind(value.nativeRetained) !== 'missing') {
      throw new JobsError('writer switch activation state is invalid');
    }
    if (holdLocksAcrossRename) {
      return underStoreLocks(value.active, value.candidate, options, async (sourcePolicy, candidatePolicy) => {
        await verify(value.active, sourcePolicy, candidatePolicy);
        await retainSource();
        return selectCandidate();
      });
    }
    await underStoreLocks(value.active, value.candidate, options, (sourcePolicy, candidatePolicy) =>
      verify(value.active, sourcePolicy, candidatePolicy));
    // The rename fails while any writer still holds a handle inside the Store. A write
    // that finished between release and rename is caught here and the rename is undone.
    await retainSource();
    try {
      await underStoreLocks(value.pythonRollback, value.candidate, options, (sourcePolicy, candidatePolicy) =>
        verify(value.pythonRollback, sourcePolicy, candidatePolicy));
    } catch (error) {
      await moveDirectory(value.pythonRollback, value.active);
      throw error;
    }
    return selectCandidate();
  });
}

/** Restores the retained Python Store and keeps the post-write native Store for diagnosis. */
export async function rollbackNativeWriter(active: string, options: NativeWriterSwitchOptions): Promise<NativeWriterSwitchPaths> {
  const value = paths(active), boundary = options.boundary ?? (() => {});
  const renames = async (): Promise<NativeWriterSwitchPaths> => {
    await boundary('before-native-rename');
    await moveDirectory(value.active, value.nativeRetained);
    await boundary('after-native-rename');
    await moveDirectory(value.pythonRollback, value.active);
    await boundary('after-python-rename');
    return value;
  };
  return locked(active, options, async () => {
    if (await kind(value.active) !== 'native' || await kind(value.pythonRollback) !== 'python'
      || await kind(value.candidate) !== 'missing' || await kind(value.nativeRetained) !== 'missing') {
      throw new JobsError('writer switch rollback state is invalid');
    }
    // Windows: acquiring proves no writer is mid-transaction; the renames then refuse
    // to proceed while any handle remains open inside either Store.
    if (holdLocksAcrossRename) return underStoreLocks(value.active, value.pythonRollback, options, renames);
    await underStoreLocks(value.active, value.pythonRollback, options, async () => {});
    return renames();
  });
}

/** Resolves only incomplete rename states; completed transitions remain untouched. */
export async function recoverNativeWriterSwitch(active: string, options: NativeWriterSwitchOptions): Promise<'python' | 'native'> {
  const value = paths(active);
  return locked(active, options, async () => {
    const [activeKind, candidateKind, pythonKind, retainedKind] = await Promise.all([
      kind(value.active), kind(value.candidate), kind(value.pythonRollback), kind(value.nativeRetained),
    ]);
    if (activeKind === 'python' && candidateKind === 'native' && pythonKind === 'missing' && retainedKind === 'missing') return 'python';
    if (activeKind === 'native' && candidateKind === 'missing' && pythonKind === 'python' && retainedKind === 'missing') return 'native';
    if (activeKind === 'python' && candidateKind === 'missing' && pythonKind === 'missing' && retainedKind === 'native') return 'python';
    if (activeKind === 'missing' && candidateKind === 'native' && pythonKind === 'python' && retainedKind === 'missing') {
      await rename(value.pythonRollback, value.active); await syncDirectory(dirname(active)); return 'python';
    }
    if (activeKind === 'missing' && candidateKind === 'missing' && pythonKind === 'python' && retainedKind === 'native') {
      await rename(value.pythonRollback, value.active); await syncDirectory(dirname(active)); return 'python';
    }
    throw new JobsError('writer switch recovery state is ambiguous');
  });
}
