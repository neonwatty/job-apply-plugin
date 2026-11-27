import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath, rm, utimes } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { emptyAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import { fromJSON } from '../contracts/workspace/values.js';
import { JobsError } from '../contracts/workspace/values.js';
import { initialAutomationDocuments } from './native-automation.js';
import { withExclusiveFileLock } from './exclusive-file-lock.js';
import type { PosixFlockProvider } from './posix-flock.js';
import { syncDirectory } from './directory-sync.js';
import { atomicWritePointJson } from './point-persistence.js';
import { nativeApplicationAuthorityName, nativeCloneMarkerName, nativeLiveSubmissionName, nativePolicyTreeName, nativeStoreRequiredEntries } from './native-store-layout.js';
import { copyNativePolicyTree, updateNativePolicyDigest, withNativePolicyTree } from './native-policy-tree.js';
import type { NativePolicyTreeEntry } from './native-policy-tree.js';
import { ensureWindowsPrivateDirectory, openWindowsStoreFile, requireWindowsPrivate, windowsFileIdentity } from './windows-store.js';

const sourceFiles = new Set<string>([...nativeStoreRequiredEntries.filter(name => name !== 'resume-operation.json'),
  nativePolicyTreeName, nativeApplicationAuthorityName, nativeLiveSubmissionName, 'resume-facts.json']);
const coreFiles = ['.store.lock', 'jobs.json', 'profile.json', 'resumes.json', 'fact-groups.json',
  'answers.json', 'applications.jsonl', 'resume-files', 'sessions'];
const legacyCoreFiles = ['.store.lock', 'profile.json', 'answers.json', 'applications.jsonl', 'sessions'];
const directories = new Set(['resume-files', 'sessions']);
const options = { pathProfile: '3.12', intMaxStrDigits: 4300 } as const;
const windowsLegacyDigestPrefix = 'windows-legacy-store-tree-v1:';

const windows = process.platform === 'win32';

async function privateDirectory(path: string, label: string, parent = false): Promise<void> {
  if (windows) {
    // Windows: the owner-only ACL replaces the mode bits. Requires an active Windows Store scope.
    try { requireWindowsPrivate(path, true); } catch { throw new JobsError(`${label} has unsafe permissions or ownership`); }
    if (await realpath(path).catch(() => null) !== path) throw new JobsError(`${label} has unsafe permissions or ownership`);
    return;
  }
  const canonical = await realpath(path).catch(() => null);
  const metadata = await lstat(path).catch(() => null);
  if (canonical !== path || !metadata?.isDirectory() || metadata.isSymbolicLink()
    || metadata.uid !== process.getuid?.() || metadata.mode & (parent ? 0o022 : 0o077)) throw new JobsError(`${label} has unsafe permissions or ownership`);
}

async function windowsPrivateBytes(path: string, limit: number): Promise<Buffer> {
  const handle = await openWindowsStoreFile(path, constants.O_RDONLY);
  try {
    const identity = windowsFileIdentity(requireWindowsPrivate(handle.fd, false));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(limit)) throw new JobsError('canonical clone source file is unsupported');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (identity !== windowsFileIdentity(requireWindowsPrivate(path, false)) || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs) throw new JobsError('canonical clone source changed');
    return bytes;
  } finally { await handle.close(); }
}

async function privateBytes(path: string, limit = 32 * 1024 * 1024): Promise<Buffer> {
  if (windows) return windowsPrivateBytes(path, limit);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!())
      || before.mode & 0o077n || before.size > BigInt(limit)) throw new JobsError('canonical clone source file is unsupported');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new JobsError('canonical clone source changed');
    return bytes;
  } finally { await handle.close(); }
}

async function writePrivate(path: string, bytes: Buffer): Promise<void> {
  const handle = windows ? await openWindowsStoreFile(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL)
    : await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

function digestFile(digest: ReturnType<typeof createHash>, name: string, bytes: Buffer): void {
  digest.update(`${name.length}:${name}:${bytes.length}:`).update(bytes);
}

async function copyDirectory(source: string, target: string, digest: ReturnType<typeof createHash>,
  signal?: AbortSignal, digestDirectory?: string): Promise<void> {
  if (windows) await ensureWindowsPrivateDirectory(target, false);
  else { await mkdir(target, { mode: 0o700 }); await chmod(target, 0o700); }
  const names = (await readdir(source)).sort();
  for (const name of names) {
    signal?.throwIfAborted();
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(name) || name === '.' || name === '..') {
      throw new JobsError('canonical clone directory entry is unsupported');
    }
    const path = join(source, name), metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new JobsError('canonical clone directories must contain regular files');
    const bytes = await privateBytes(path, 10 * 1024 * 1024);
    digestFile(digest, digestDirectory === undefined ? name : `${digestDirectory}/${name}`, bytes);
    const destination = join(target, name);
    await writePrivate(destination, bytes);
    await utimes(destination, metadata.atime, metadata.mtime);
  }
  await syncDirectory(target);
}

async function missingDocuments(target: string, names: Set<string>, now: string): Promise<void> {
  const documents: Record<string, ReturnType<typeof fromJSON>> = {
    'resume-operation.json': fromJSON({ schemaVersion: 1, operation: null }),
    'resume-extractions.json': fromJSON({ schemaVersion: 1, proposals: {}, metadata: { createdAt: now, updatedAt: now } }),
    'resume-extraction-requests.json': fromJSON({ schemaVersion: 1, requests: {}, metadata: { createdAt: now, updatedAt: now } }),
    'resume-extraction-journal.json': fromJSON({ schemaVersion: 1, operation: null }),
    'resume-facts.json': fromJSON({ schemaVersion: 1, sets: {}, metadata: { createdAt: now, updatedAt: now } }),
    'coordinator.json': fromJSON({ schemaVersion: 1, claim: null }),
    'coordinator-journal.json': fromJSON({ schemaVersion: 1, operation: null }),
    'account-operation-journal.json': emptyAccountOperationJournal(),
    'trusted-fill.json': fromJSON({ schemaVersion: 1, approvals: {}, metadata: { createdAt: now, updatedAt: now } }),
  };
  for (const [name, document] of Object.entries(initialAutomationDocuments(now))) {
    documents[`${name}.json`] = document;
  }
  for (const [name, document] of Object.entries(documents)) if (!names.has(name)) {
    await atomicWritePointJson(join(target, name), document, options); names.add(name);
  }
}

async function storeTreeLocked(source: string, entries: Set<string>, provider: PosixFlockProvider,
  candidate = false, signal = AbortSignal.timeout(30_000),
  policy?: NativePolicyTreeEntry[] | null, windowsLegacy = false): Promise<string> {
  for (const name of directories) {
    if (entries.has(name)) await privateDirectory(join(source, name), `canonical ${name}`);
  }
  const digest = createHash('sha256');
  if (windowsLegacy) digest.update(windowsLegacyDigestPrefix);
  for (const name of [...entries].sort()) {
    if (name === '.store.lock' || name === nativePolicyTreeName || (candidate && name === nativeCloneMarkerName)) continue;
    if (directories.has(name)) {
      digest.update(`directory:${name.length}:${name}:`);
      for (const child of (await readdir(join(source, name))).sort()) {
        if (!/^[A-Za-z0-9._-]{1,200}$/.test(child) || child === '.' || child === '..') {
          throw new JobsError('canonical clone directory entry is unsupported');
        }
        const bytes = await privateBytes(join(source, name, child), 10 * 1024 * 1024);
        digestFile(digest, windowsLegacy ? `${name}/${child}` : child, bytes);
      }
    } else {
      const bytes = await privateBytes(join(source, name));
      digestFile(digest, name, bytes);
    }
  }
  if (policy === undefined) {
    await withNativePolicyTree(source, provider, async snapshot => { updateNativePolicyDigest(digest, snapshot); }, signal);
  } else updateNativePolicyDigest(digest, policy);
  return `sha256:${digest.digest('hex')}`;
}

/** Computes the source digest. The caller must hold the source Store lock. */
export async function canonicalStoreSourceTreeLocked(source: string, provider: PosixFlockProvider,
  signal = AbortSignal.timeout(30_000), policy?: NativePolicyTreeEntry[] | null): Promise<string> {
  const entries = new Set(await readdir(source));
  requireSourceEntries(entries, coreFiles);
  return storeTreeLocked(source, entries, provider, false, signal, policy);
}

function requireSourceEntries(entries: Set<string>, required: readonly string[]): void {
  if (required.some(name => !entries.has(name)) || [...entries].some(name => !sourceFiles.has(name))) {
    throw new JobsError('canonical clone source contains unsupported or incomplete state');
  }
}

async function windowsLegacySourceEntries(source: string, signal: AbortSignal): Promise<Set<string>> {
  signal.throwIfAborted();
  const entries = new Set(await readdir(source));
  requireSourceEntries(entries, legacyCoreFiles);
  if (entries.has(nativePolicyTreeName)) throw new JobsError('Windows legacy policy migration is unsupported');
  return entries;
}

/** Reads a pre-bootstrap Windows migration source while its existing Store lock is held. */
export async function windowsLegacyStoreSourceTreeLocked(source: string, provider: PosixFlockProvider,
  signal: AbortSignal): Promise<string> {
  const entries = await windowsLegacySourceEntries(source, signal);
  return storeTreeLocked(source, entries, provider, false, signal, null, true);
}

async function copyStoreEntries(source: string, target: string, entries: Set<string>,
  digest: ReturnType<typeof createHash>, signal?: AbortSignal, windowsLegacy = false): Promise<Set<string>> {
  const copied = new Set<string>();
  for (const name of [...entries].sort()) {
    signal?.throwIfAborted();
    if (name === '.store.lock' || name === nativePolicyTreeName) continue;
    if (directories.has(name)) {
      digest.update(`directory:${name.length}:${name}:`);
      await copyDirectory(join(source, name), join(target, name), digest, signal, windowsLegacy ? name : undefined);
    } else {
      const bytes = await privateBytes(join(source, name));
      digestFile(digest, name, bytes);
      await writePrivate(join(target, name), bytes);
    }
    copied.add(name);
  }
  return copied;
}

/** Copies legacy entries into the scoped private staging Store. Both Store locks are held by the caller. */
export async function copyWindowsLegacyStoreLocked(source: string, target: string, sourceTree: string,
  signal: AbortSignal): Promise<Set<string>> {
  const entries = await windowsLegacySourceEntries(source, signal);
  for (const name of directories) {
    if (entries.has(name)) await privateDirectory(join(source, name), `canonical ${name}`);
  }
  const digest = createHash('sha256').update(windowsLegacyDigestPrefix);
  await copyStoreEntries(source, target, entries, digest, signal, true);
  if (`sha256:${digest.digest('hex')}` !== sourceTree) throw new JobsError('legacy Store changed during copy');
  return entries;
}

/** Publishes the native marker after verifying the original files survived target bootstrap. */
export async function finishWindowsLegacyStoreCloneLocked(target: string, original: Set<string>, sourceTree: string,
  provider: PosixFlockProvider, signal: AbortSignal, now: string): Promise<void> {
  await missingDocuments(target, new Set(await readdir(target)), now);
  if (await storeTreeLocked(target, original, provider, false, signal, null, true) !== sourceTree) {
    throw new JobsError('migrated Store differs from the legacy source');
  }
  const candidateTree = await canonicalStoreCandidateTreeLocked(target, provider, signal);
  signal.throwIfAborted();
  await atomicWritePointJson(join(target, nativeCloneMarkerName),
    fromJSON({ mode: 'canonical-store-clone', version: 2, sourceTree, candidateTree }), options);
}

/** Computes the prepared candidate digest. The caller must hold the candidate Store lock. */
export async function canonicalStoreCandidateTreeLocked(root: string, provider: PosixFlockProvider,
  signal = AbortSignal.timeout(30_000), policy?: NativePolicyTreeEntry[] | null): Promise<string> {
  const entries = new Set(await readdir(root));
  const allowed = new Set<string>([...nativeStoreRequiredEntries, nativeCloneMarkerName, nativePolicyTreeName,
    nativeApplicationAuthorityName, nativeLiveSubmissionName, 'resume-facts.json']);
  if (nativeStoreRequiredEntries.some(name => !entries.has(name)) || [...entries].some(name => !allowed.has(name))) {
    throw new JobsError('canonical clone candidate contains unsupported or incomplete state');
  }
  return storeTreeLocked(root, entries, provider, true, signal, policy);
}

/** Computes the clone marker digest while holding the canonical Store lock. */
export async function canonicalStoreSourceTree(source: string, provider: PosixFlockProvider,
  signal = AbortSignal.timeout(30_000)): Promise<string> {
  await privateDirectory(source, 'canonical clone source');
  return withExclusiveFileLock(join(source, '.store.lock'), async () => canonicalStoreSourceTreeLocked(source, provider, signal), {
    provider, pathProfile: '3.12', signal,
  });
}

/** Copies an existing canonical Store into a new native-owned migration target. */
export async function prepareCanonicalStoreClone(source: string, target: string,
  provider: PosixFlockProvider, now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')): Promise<void> {
  if (![source, target].every(path => isAbsolute(path) && path === resolve(path)) || source === target
    || await realpath(dirname(target)).catch(() => null) !== dirname(target)) throw new JobsError('canonical clone paths are invalid');
  await privateDirectory(source, 'canonical clone source');
  await privateDirectory(dirname(target), 'canonical clone target parent', true);
  let created = false;
  try {
    await withExclusiveFileLock(join(source, '.store.lock'), async () => {
      const entries = new Set(await readdir(source));
      requireSourceEntries(entries, coreFiles);
      for (const name of directories) await privateDirectory(join(source, name), `canonical ${name}`);
      await mkdir(target, { mode: 0o700 }); created = true; await chmod(target, 0o700);
      const digest = createHash('sha256');
      const copied = await copyStoreEntries(source, target, entries, digest);
      await withNativePolicyTree(source, provider, async policy => {
        updateNativePolicyDigest(digest, policy);
        await copyNativePolicyTree(target, policy);
        if (policy) copied.add(nativePolicyTreeName);
      });
      await writePrivate(join(target, '.store.lock'), Buffer.alloc(0)); copied.add('.store.lock');
      await missingDocuments(target, copied, now);
      if (nativeStoreRequiredEntries.some(name => !copied.has(name))) throw new JobsError('canonical clone target is incomplete');
      const sourceTree = `sha256:${digest.digest('hex')}`;
      await withExclusiveFileLock(join(target, '.store.lock'), async () => {
        const candidateTree = await canonicalStoreCandidateTreeLocked(target, provider);
        const marker = Buffer.from(JSON.stringify({ mode: 'canonical-store-clone', version: 2,
          sourceTree, candidateTree }) + '\n');
        await writePrivate(join(target, nativeCloneMarkerName), marker);
      }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000) });
      await syncDirectory(target);
    }, { provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    if (created) await rm(target, { recursive: true, force: true });
    throw error;
  }
}

/**
 * Gives a freshly bootstrapped Store native ownership in place. Used where no Python-era
 * Store exists to clone from, so the result matches a completed activation: the marker
 * records the bootstrapped tree as its source and the completed native tree as its
 * candidate. The caller must hold the Store lock.
 */
export async function adoptFreshNativeStoreLocked(root: string, provider: PosixFlockProvider,
  now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), signal = AbortSignal.timeout(30_000),
  transient: readonly string[] = []): Promise<void> {
  await privateDirectory(root, 'native Store root');
  const listed = async () => new Set((await readdir(root)).filter(name => !transient.includes(name)));
  const source = await listed();
  const allowed = new Set<string>([...sourceFiles, ...nativeStoreRequiredEntries]);
  if (coreFiles.some(name => !source.has(name)) || [...source].some(name => !allowed.has(name))) {
    throw new JobsError('fresh native Store contains unsupported or incomplete state');
  }
  const sourceTree = await storeTreeLocked(root, source, provider, false, signal);
  await missingDocuments(root, new Set(source), now);
  const candidate = await listed();
  if (nativeStoreRequiredEntries.some(name => !candidate.has(name))
    || [...candidate].some(name => !source.has(name) && !nativeStoreRequiredEntries.includes(name as never))) {
    throw new JobsError('fresh native Store is incomplete');
  }
  const candidateTree = await storeTreeLocked(root, candidate, provider, true, signal);
  await atomicWritePointJson(join(root, nativeCloneMarkerName),
    fromJSON({ mode: 'canonical-store-clone', version: 2, sourceTree, candidateTree }), options);
}
