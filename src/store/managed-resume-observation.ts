import type { PythonJson } from "../contracts/raw-json/value.js";
import type { NumericAtom } from "../contracts/raw-json/numeric-atom.js";
import { resumeModifiedAt } from "./resume-modified-at.js";

export interface ObservationMetadata {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  mtimeSeconds: number;
  isRegularFile: boolean;
}

export type ObservationIdentity = readonly [bigint, bigint, bigint, bigint, bigint];
export type CachedIdentityValue = bigint | number | boolean | NumericAtom | string | null;
export interface ObservationCacheEntry {
  identity?: readonly CachedIdentityValue[] | null;
  checkedAt?: bigint;
  digest?: string | null;
}

/** Explicit dependencies: a native metadata adapter must supply Python st_mtime. */
export interface ManagedObservationIO {
  managedPath(record: Map<string, PythonJson>): Promise<string>;
  lstat(path: string): Promise<ObservationMetadata>;
  isSymlink(path: string): Promise<boolean>;
  privateFileDigest(path: string): Promise<string | null>;
  nowMicroseconds(): bigint;
  cacheIdentity(metadata: ObservationMetadata): ObservationIdentity | null;
}

export type ManagedObservation =
  | { exists: false; size: null; modifiedAt: null; digest: null }
  | { exists: true; size: bigint; modifiedAt: string; digest: string | null };

export class ObservationKeyError extends Error {
  constructor(key: string) {
    super(key);
    this.name = "KeyError";
  }
}

function identity(metadata: ObservationMetadata): ObservationIdentity {
  return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs];
}

function sameIdentity(left: readonly CachedIdentityValue[] | null | undefined, right: ObservationIdentity): boolean {
  if (left === null || left === undefined || left.length !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    // A sparse JavaScript array is not a Python tuple with five values.
    if (!Object.hasOwn(left, index)) return false;
    const value = left[index];
    const numeric = typeof value === "bigint" || typeof value === "number" ? value
      : typeof value === "boolean" ? (value ? 1n : 0n)
      : value !== null && typeof value === "object" ? value.value : undefined;
    if (numeric === undefined) return false;
    if (typeof numeric === "bigint") {
      if (numeric !== right[index]) return false;
    } else if (!Number.isInteger(numeric) || BigInt(numeric) !== right[index]) return false;
  }
  return true;
}

function osError(error: unknown): boolean {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}

type Hashable = null | boolean | string | NumericAtom;
function hashable(value: PythonJson): Hashable {
  if (Array.isArray(value) || value instanceof Map) throw new TypeError("unhashable type");
  return value;
}

function numericKey(value: Hashable): bigint | number | undefined {
  if (typeof value === "boolean") return value ? 1n : 0n;
  return value !== null && typeof value === "object" ? value.value : undefined;
}

function sameKey(left: Hashable, right: Hashable): boolean {
  if (left === right) return true;
  const first = numericKey(left);
  const second = numericKey(right);
  if (first === undefined || second === undefined) return false;
  if (typeof first === typeof second) return first === second;
  const integer = typeof first === "bigint" ? first : second;
  const floating = typeof first === "number" ? first : second;
  return typeof floating === "number" && Number.isInteger(floating) && integer === BigInt(floating);
}

function existingKey(cache: Map<PythonJson, ObservationCacheEntry | null>, key: Hashable): PythonJson {
  for (const candidate of cache.keys()) {
    if (sameKey(hashable(candidate), key)) return candidate;
  }
  return key;
}

/** Inert observation flow. Only its explicitly supplied cache may be mutated. */
export async function managedResumeObservation(
  record: Map<string, PythonJson>,
  io: ManagedObservationIO,
  digestCache: Map<PythonJson, ObservationCacheEntry | null> | null = null,
): Promise<ManagedObservation> {
  const path = await io.managedPath(record);
  if (!record.has("id")) throw new ObservationKeyError("id");
  const cacheKey = record.get("id")!;
  const missing: ManagedObservation = { exists: false, size: null, modifiedAt: null, digest: null };
  let metadata: ObservationMetadata;
  try {
    metadata = await io.lstat(path);
  } catch (error) {
    if (!osError(error)) throw error;
    return missing;
  }
  if (await io.isSymlink(path) || !metadata.isRegularFile || metadata.size > 10_485_760n) return missing;
  const beforeIdentity = identity(metadata);
  const cacheIdentity = io.cacheIdentity(metadata);
  const now = io.nowMicroseconds();
  const key = digestCache === null ? cacheKey : existingKey(digestCache, hashable(cacheKey));
  const cached = digestCache === null ? undefined : digestCache.get(key);
  if (cacheIdentity !== null && cached !== undefined && cached !== null && sameIdentity(cached.identity, cacheIdentity)) {
    if (!("checkedAt" in cached)) throw new ObservationKeyError("checkedAt");
    const elapsed = now - cached.checkedAt!;
    if (elapsed >= 0n && elapsed < 30_000_000n) {
      const size = metadata.size;
      const modifiedAt = resumeModifiedAt(metadata.mtimeSeconds);
      if (!("digest" in cached)) throw new ObservationKeyError("digest");
      return { exists: true, size, modifiedAt, digest: cached.digest! };
    }
  }
  const digest = await io.privateFileDigest(path);
  if (digest === null) return missing;
  let after: ObservationMetadata;
  try {
    after = await io.lstat(path);
  } catch (error) {
    if (!osError(error)) throw error;
    return missing;
  }
  const afterIdentity = identity(after);
  if (!sameIdentity(afterIdentity, beforeIdentity) || !after.isRegularFile) return missing;
  const observation: ManagedObservation = {
    exists: true, size: after.size, modifiedAt: resumeModifiedAt(after.mtimeSeconds), digest,
  };
  const afterCacheIdentity = io.cacheIdentity(after);
  if (digestCache !== null && afterCacheIdentity !== null) {
    digestCache.set(existingKey(digestCache, hashable(cacheKey)), {
      identity: afterCacheIdentity, digest, checkedAt: now,
    });
  }
  return observation;
}
