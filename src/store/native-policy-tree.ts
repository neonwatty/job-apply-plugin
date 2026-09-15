import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import type { Hash } from 'node:crypto';
import { JobsError } from '../contracts/workspace/values.js';
import type { PosixFlockProvider } from './posix-flock.js';

const policyName = 'auto-submit';
const maximumEntries = 4096;
const maximumFileBytes = 16 * 1024 * 1024;
const maximumTreeBytes = 32 * 1024 * 1024;
const hexadecimalName = /^[0-9a-f]{64}\.json$/;

export interface NativePolicyTreeEntry {
  relative: string;
  type: 'directory' | 'file';
  mode: number;
  bytes?: Buffer;
}

interface DirectoryIdentity {
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mode: number;
}

function failure(message = 'native policy tree is unsupported'): JobsError {
  return new JobsError(message);
}

function ownedPrivate(metadata: BigIntStats): boolean {
  return metadata.uid === BigInt(process.getuid!()) && (metadata.mode & 0o077n) === 0n;
}

function ownedStructural(metadata: BigIntStats): boolean {
  return metadata.uid === BigInt(process.getuid!()) && (metadata.mode & 0o022n) === 0n;
}

async function privateDirectory(path: string, structural = false): Promise<DirectoryIdentity> {
  const canonical = await realpath(path).catch(() => null);
  const metadata = await lstat(path, { bigint: true }).catch(() => null);
  if (canonical !== path || !metadata?.isDirectory() || metadata.isSymbolicLink()
    || !(structural ? ownedStructural(metadata) : ownedPrivate(metadata))) throw failure();
  return { dev: metadata.dev, ino: metadata.ino, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs,
    mode: Number(metadata.mode & 0o777n) };
}

async function unchangedDirectory(path: string, before: DirectoryIdentity, structural = false): Promise<void> {
  const after = await lstat(path, { bigint: true }).catch(() => null);
  if (!after?.isDirectory() || after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino
    || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs
    || Number(after.mode & 0o777n) !== before.mode
    || !(structural ? ownedStructural(after) : ownedPrivate(after))) throw failure('native policy tree changed');
}

function validateFile(metadata: BigIntStats): void {
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n || !ownedPrivate(metadata)
    || metadata.size > BigInt(maximumFileBytes)) throw failure();
}

async function privateBytes(path: string): Promise<{ bytes: Buffer; mode: number }> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw failure(); }
  try {
    const before = await handle.stat({ bigint: true }); validateFile(before);
    const linked = await lstat(path, { bigint: true }).catch(() => null);
    if (!linked || linked.dev !== before.dev || linked.ino !== before.ino) throw failure('native policy tree changed');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const final = await lstat(path, { bigint: true }).catch(() => null);
    if (!final || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || final.dev !== after.dev || final.ino !== after.ino) throw failure('native policy tree changed');
    return { bytes, mode: Number(after.mode & 0o777n) };
  } finally { await handle.close(); }
}

async function acquirePolicyLock(path: string, provider: PosixFlockProvider, signal: AbortSignal): Promise<FileHandle> {
  let handle: FileHandle;
  try { handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch { throw failure('native policy tree is unsupported: lock is unavailable'); }
  try {
    const metadata = await handle.stat({ bigint: true }); validateFile(metadata);
    while (true) {
      signal.throwIfAborted();
      if (provider.tryLock(handle.fd)) break;
      await delay(10, undefined, { signal });
    }
    const linked = await lstat(path, { bigint: true }).catch(() => null);
    const locked = await handle.stat({ bigint: true });
    if (!linked || linked.dev !== locked.dev || linked.ino !== locked.ino) throw failure('native policy lock changed');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function snapshot(policyRoot: string): Promise<NativePolicyTreeEntry[]> {
  const rootIdentity = await privateDirectory(policyRoot);
  const entries: NativePolicyTreeEntry[] = [{ relative: policyName, type: 'directory', mode: rootIdentity.mode }];
  let aggregate = 0;
  const addFile = async (relative: string): Promise<void> => {
    const { bytes, mode } = await privateBytes(join(dirname(policyRoot), relative));
    aggregate += bytes.length;
    entries.push({ relative, type: 'file', mode, bytes });
    if (entries.length > maximumEntries || aggregate > maximumTreeBytes) throw failure('native policy tree is unbounded');
  };
  const addDirectory = async (relative: string): Promise<DirectoryIdentity> => {
    const identity = await privateDirectory(join(dirname(policyRoot), relative), true);
    entries.push({ relative, type: 'directory', mode: identity.mode });
    if (entries.length > maximumEntries) throw failure('native policy tree is unbounded');
    return identity;
  };

  const rootNames = (await readdir(policyRoot)).sort();
  if (!rootNames.includes('.lock') || rootNames.some(name => !['.lock', 'campaign.json', 'campaigns', 'applications', 'receipts.jsonl'].includes(name))) {
    throw failure();
  }
  for (const name of rootNames) {
    const relative = `${policyName}/${name}`;
    if (name === 'campaigns') {
      const identity = await addDirectory(relative);
      const names = (await readdir(join(policyRoot, name))).sort();
      if (names.some(child => !hexadecimalName.test(child))) throw failure();
      for (const child of names) await addFile(`${relative}/${child}`);
      await unchangedDirectory(join(policyRoot, name), identity, true);
    } else if (name === 'applications') {
      const identity = await addDirectory(relative);
      const campaigns = (await readdir(join(policyRoot, name))).sort();
      if (campaigns.some(child => !/^[0-9a-f]{64}$/.test(child))) throw failure();
      for (const campaign of campaigns) {
        const campaignRelative = `${relative}/${campaign}`;
        const campaignIdentity = await addDirectory(campaignRelative);
        const applications = (await readdir(join(policyRoot, name, campaign))).sort();
        if (applications.some(child => !hexadecimalName.test(child))) throw failure();
        for (const application of applications) await addFile(`${campaignRelative}/${application}`);
        await unchangedDirectory(join(policyRoot, name, campaign), campaignIdentity, true);
      }
      await unchangedDirectory(join(policyRoot, name), identity, true);
    } else await addFile(relative);
  }
  await unchangedDirectory(policyRoot, rootIdentity);
  return entries;
}

/** Runs with the exact optional policy tree snapshotted under its private lock. */
export async function withNativePolicyTree<T>(storeRoot: string, provider: PosixFlockProvider,
  operation: (entries: NativePolicyTreeEntry[] | null) => Promise<T>, signal = AbortSignal.timeout(30_000)): Promise<T> {
  const policyRoot = join(storeRoot, policyName);
  let metadata;
  try { metadata = await lstat(policyRoot); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return operation(null);
    throw failure();
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw failure();
  const rootIdentity = await privateDirectory(policyRoot);
  const handle = await acquirePolicyLock(join(policyRoot, '.lock'), provider, signal);
  let failureValue: unknown;
  try {
    await unchangedDirectory(policyRoot, rootIdentity);
    return await operation(await snapshot(policyRoot));
  } catch (error) {
    failureValue = error;
    throw error;
  } finally {
    try { provider.unlock(handle.fd); await handle.close(); }
    catch (error) {
      if (error instanceof Error && failureValue !== undefined && error.cause === undefined) error.cause = failureValue;
      throw error;
    }
  }
}

export function updateNativePolicyDigest(digest: Hash, entries: NativePolicyTreeEntry[] | null): void {
  if (!entries) return;
  for (const entry of entries) {
    const path = Buffer.from(entry.relative, 'utf8');
    digest.update(`policy:${entry.type}:${entry.mode.toString(8)}:${path.length}:`).update(path);
    if (entry.type === 'file') digest.update(`:${entry.bytes!.length}:`).update(entry.bytes!);
    else digest.update(':');
  }
}

async function writePrivate(path: string, bytes: Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Copies a validated snapshot into a target Store using canonical private modes. */
export async function copyNativePolicyTree(targetRoot: string, entries: NativePolicyTreeEntry[] | null): Promise<void> {
  if (!entries) return;
  for (const entry of entries.filter(item => item.type === 'directory')) {
    const path = join(targetRoot, entry.relative);
    await mkdir(path, { mode: 0o700 }); await chmod(path, 0o700);
  }
  for (const entry of entries.filter(item => item.type === 'file')) {
    await writePrivate(join(targetRoot, entry.relative), entry.bytes!);
  }
  for (const entry of entries.filter(item => item.type === 'directory').reverse()) {
    await syncDirectory(join(targetRoot, entry.relative));
  }
}
