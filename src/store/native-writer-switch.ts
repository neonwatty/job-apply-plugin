import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { JobsError } from '../contracts/workspace/values.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import { canonicalStoreCandidateTreeLocked, canonicalStoreSourceTreeLocked } from './native-store-clone.js';
import { nativeCloneMarkerName, nativeCloneTrees, nativeFixtureMarkerName, validateNativeStoreMarker } from './native-store-layout.js';
import { withNativePolicyTree } from './native-policy-tree.js';
import type { PosixFlockProvider } from './posix-flock.js';

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
    || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) throw new JobsError('writer switch Store is invalid');
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

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function locked<T>(active: string, options: NativeWriterSwitchOptions, callback: () => Promise<T>): Promise<T> {
  const parent = dirname(active);
  const canonical = await realpath(parent).catch(() => null), metadata = await lstat(parent).catch(() => null);
  if (canonical !== parent || !metadata?.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) throw new JobsError('writer switch parent must be private and owned');
  return withExclusiveFileLock(join(parent, `.${basename(active)}.writer-switch.lock`), async () => callback(), {
    provider: options.provider, pathProfile: '3.12', signal: options.signal ?? AbortSignal.timeout(30_000),
  });
}

/** Atomically selects a prepared native clone by directory entry, retaining the Python Store for rollback. */
export async function activateNativeWriter(active: string, candidate: string,
  options: NativeWriterSwitchOptions): Promise<NativeWriterSwitchPaths> {
  const value = paths(active, candidate), boundary = options.boundary ?? (() => {});
  return locked(active, options, async () => {
    if (await kind(value.active) !== 'python' || await kind(value.candidate) !== 'native'
      || await kind(value.pythonRollback) !== 'missing' || await kind(value.nativeRetained) !== 'missing') {
      throw new JobsError('writer switch activation state is invalid');
    }
    return withExclusiveFileLock(join(value.active, '.store.lock'), async () =>
      withExclusiveFileLock(join(value.candidate, '.store.lock'), async () => {
        const expected = nativeCloneTrees(await readFile(join(value.candidate, nativeCloneMarkerName)));
        return withNativePolicyTree(value.active, options.provider, async sourcePolicy =>
          withNativePolicyTree(value.candidate, options.provider, async candidatePolicy => {
            const sourceTree = await canonicalStoreSourceTreeLocked(
              value.active, options.provider, options.signal, sourcePolicy,
            );
            const candidateTree = await canonicalStoreCandidateTreeLocked(
              value.candidate, options.provider, options.signal, candidatePolicy,
            );
            if (sourceTree !== expected.sourceTree) throw new JobsError('native candidate does not match the active Python Store');
            if (candidateTree !== expected.candidateTree) throw new JobsError('native candidate content changed after preparation');
            await boundary('before-source-rename');
            await rename(value.active, value.pythonRollback);
            await syncDirectory(dirname(active));
            await boundary('after-source-rename');
            await rename(value.candidate, value.active);
            await syncDirectory(dirname(active));
            await boundary('after-candidate-rename');
            return value;
          }, options.signal), options.signal);
      }, { provider: options.provider, pathProfile: '3.12', signal: options.signal ?? AbortSignal.timeout(30_000) }),
    { provider: options.provider, pathProfile: '3.12', signal: options.signal ?? AbortSignal.timeout(30_000) });
  });
}

/** Restores the retained Python Store and keeps the post-write native Store for diagnosis. */
export async function rollbackNativeWriter(active: string, options: NativeWriterSwitchOptions): Promise<NativeWriterSwitchPaths> {
  const value = paths(active), boundary = options.boundary ?? (() => {});
  return locked(active, options, async () => {
    if (await kind(value.active) !== 'native' || await kind(value.pythonRollback) !== 'python'
      || await kind(value.candidate) !== 'missing' || await kind(value.nativeRetained) !== 'missing') {
      throw new JobsError('writer switch rollback state is invalid');
    }
    return withExclusiveFileLock(join(value.active, '.store.lock'), async () =>
      withExclusiveFileLock(join(value.pythonRollback, '.store.lock'), async () => {
        return withNativePolicyTree(value.active, options.provider, async () =>
          withNativePolicyTree(value.pythonRollback, options.provider, async () => {
            await boundary('before-native-rename');
            await rename(value.active, value.nativeRetained);
            await syncDirectory(dirname(active));
            await boundary('after-native-rename');
            await rename(value.pythonRollback, value.active);
            await syncDirectory(dirname(active));
            await boundary('after-python-rename');
            return value;
          }, options.signal), options.signal);
      }, { provider: options.provider, pathProfile: '3.12', signal: options.signal ?? AbortSignal.timeout(30_000) }),
    { provider: options.provider, pathProfile: '3.12', signal: options.signal ?? AbortSignal.timeout(30_000) });
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
