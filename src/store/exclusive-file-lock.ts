import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { filesystemEncode } from "../contracts/posix-path-bytes.js";
import { constructPosixPath, posixParent, validatePathProfile } from "../contracts/posix-path.js";
import type { PythonPathProfile } from "../contracts/posix-path.js";
import { withPythonFilesystemErrors } from "../contracts/filesystem-error.js";
import { createNativeAtomicWriteIO, ensurePrivateDirectory } from "./private-filesystem.js";
import type { PosixFlockProvider } from "./posix-flock.js";

export interface LockFileHandle {
  fd: number;
  close(): Promise<void>;
}
export interface ExclusiveLockIO {
  ensurePrivateDirectory(path: string): Promise<void>;
  open(path: string, flags: number, mode: number): Promise<LockFileHandle>;
  chmod(path: string, mode: number): Promise<void>;
}
export interface ExclusiveLockOptions {
  provider: PosixFlockProvider;
  pathProfile: PythonPathProfile;
  signal?: AbortSignal;
  retryMilliseconds?: number;
  io?: ExclusiveLockIO;
}

function nativeIO(profile: PythonPathProfile): ExclusiveLockIO {
  const filesystem = createNativeAtomicWriteIO(profile);
  return {
    ensurePrivateDirectory: (path) => ensurePrivateDirectory(path, filesystem),
    chmod: filesystem.chmod,
    async open(path, flags, mode) {
      const bytes = filesystemEncode(path);
      if (bytes.includes(0)) {
        const error = new Error("embedded null byte");
        error.name = "ValueError";
        throw error;
      }
      const handle = await withPythonFilesystemErrors(open(bytes, flags, mode));
      return { fd: handle.fd, close: () => withPythonFilesystemErrors(handle.close()) };
    },
  };
}

function contextual(error: unknown, previous: unknown): unknown {
  if (error instanceof Error && previous !== undefined && error !== previous && error.cause === undefined) {
    error.cause = previous;
  }
  return error;
}

/** Hold the owned descriptor until callback settlement, including after held cancellation. */
export async function withExclusiveFileLock<T>(
  path: string,
  callback: (signal: AbortSignal) => Promise<T>,
  options: ExclusiveLockOptions,
): Promise<T> {
  validatePathProfile(options.pathProfile);
  const retryMilliseconds = options.retryMilliseconds ?? 10;
  if (!Number.isSafeInteger(retryMilliseconds) || retryMilliseconds < 1 || retryMilliseconds > 2147483647) {
    throw new RangeError("retryMilliseconds must be a positive timer interval");
  }
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const io = options.io ?? nativeIO(options.pathProfile);
  path = constructPosixPath("", path);
  await io.ensurePrivateDirectory(posixParent(path));
  const handle = await io.open(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  // Baseline parity: chmod precedes the protected block. A chmod failure does
  // not explicitly close this descriptor; native FileHandle GC is not a receipt.
  await io.chmod(path, 0o600);
  let failure: unknown;
  try {
    while (true) {
      signal.throwIfAborted();
      if (options.provider.tryLock(handle.fd)) break;
      try { await delay(retryMilliseconds, undefined, { signal }); }
      catch (error) {
        signal.throwIfAborted();
        throw error;
      }
    }
    signal.throwIfAborted();
    return await callback(signal);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      // Baseline parity: failed acquisition still attempts unlock, and an
      // unlock failure prevents close. Do not present these paths as leak-free.
      options.provider.unlock(handle.fd);
      await handle.close();
    } catch (error) { throw contextual(error, failure); }
  }
}
