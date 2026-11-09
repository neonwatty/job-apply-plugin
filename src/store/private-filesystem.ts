import { randomInt } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, stat, unlink } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { filesystemEncode, FilesystemEncodeError } from "../contracts/posix-path-bytes.js";
import { constructPosixPath, posixParent, validatePathProfile } from "../contracts/posix-path.js";
import type { PythonPathProfile } from "../contracts/posix-path.js";
import { linkLegacyContext } from "../contracts/persistence-exception.js";
import type { ContextLinker } from "../contracts/persistence-exception.js";
import { encodePersistedUtf8 } from "../contracts/persisted-json.js";
import { pythonFilesystemError, withPythonFilesystemErrors } from "../contracts/filesystem-error.js";

export interface DirectoryHandle {
  sync(): Promise<void>;
  close(): Promise<void>;
}
export interface TemporaryFileFor<T> extends DirectoryHandle {
  path: string;
  write(text: T): Promise<void>;
  flush(): Promise<void>;
}
export interface DirectoryOptions { mode: number; parents: boolean; existOk: boolean }
export interface TemporaryOptions { directory: string; prefix: string; suffix: string }
export type TemporaryTextFile = TemporaryFileFor<string>;
export interface AtomicWriteIOFor<T> {
  mkdir(path: string, options: DirectoryOptions): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  createTemporary(options: TemporaryOptions): Promise<TemporaryFileFor<T>>;
  replace(source: string, destination: string): Promise<void>;
  openDirectory(path: string): Promise<DirectoryHandle>;
  unlink(path: string): Promise<void>;
}

export type AtomicWriteIO = AtomicWriteIOFor<string>;

export function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}

class NullPathError extends Error {
  constructor() {
    super("embedded null byte");
    this.name = "ValueError";
  }
}
function nativePath(path: string): Buffer {
  const bytes = filesystemEncode(path);
  if (bytes.includes(0)) throw new NullPathError();
  return bytes;
}

export async function ensurePrivateDirectory<T>(path: string, io: AtomicWriteIOFor<T>): Promise<void> {
  await io.mkdir(path, { mode: 0o700, parents: true, existOk: true });
  await io.chmod(path, 0o700);
}

export async function fsyncDirectory<T>(path: string, io: AtomicWriteIOFor<T>, linkContext: ContextLinker = linkLegacyContext): Promise<void> {
  let handle: DirectoryHandle;
  try {
    handle = await io.openDirectory(path);
  } catch (error) {
    if (!isFilesystemError(error)) throw error;
    return;
  }
  let failure: unknown;
  try {
    try {
      await handle.sync();
    } catch (error) {
      if (!isFilesystemError(error)) throw error;
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      throw linkContext(error, failure);
    }
  }
}

/** POSIX native operations. No lock or live Store ownership is implied. */
export function createNativeAtomicWriteIO(profile: PythonPathProfile): AtomicWriteIO {
  return createNativeAtomicWriteIOFor(profile, encodePersistedUtf8, linkLegacyContext);
}

export function createNativeAtomicWriteIOFor<T>(
  profile: PythonPathProfile,
  encode: (text: T) => Buffer,
  linkContext: ContextLinker,
): AtomicWriteIOFor<T> {
  validatePathProfile(profile);
  if (process.platform === "win32") throw new Error("Native Windows atomic writes are not supported by this POSIX adapter");
  async function isDirectory(path: string): Promise<boolean> {
    try {
      return (await withPythonFilesystemErrors(stat(nativePath(path)))).isDirectory();
    } catch (error) {
      if (error instanceof NullPathError || error instanceof FilesystemEncodeError) return false;
      if (isFilesystemError(error) && (profile === "3.14"
        || ["ENOENT", "ENOTDIR", "EBADF", "ELOOP"].includes(error.code ?? ""))) return false;
      throw error;
    }
  }
  async function makeDirectory(path: string, options: DirectoryOptions): Promise<void> {
    try {
      await withPythonFilesystemErrors(mkdir(nativePath(path), { mode: options.mode }));
    } catch (error) {
      if (isFilesystemError(error) && error.code === "ENOENT") {
        const parent = posixParent(path);
        if (!options.parents || parent === path) throw error;
        await makeDirectory(parent, { mode: 0o777, parents: true, existOk: true });
        await makeDirectory(path, { ...options, parents: false });
      } else if (!isFilesystemError(error) || !options.existOk || !await isDirectory(path)) throw error;
    }
  }
  return {
    mkdir: makeDirectory,
    chmod: (path, mode) => withPythonFilesystemErrors(chmod(nativePath(path), mode)),
    replace: (source, destination) => withPythonFilesystemErrors(rename(nativePath(source), nativePath(destination))),
    async openDirectory(path) {
      const handle = await withPythonFilesystemErrors(open(nativePath(path), constants.O_RDONLY));
      return {
        sync: () => withPythonFilesystemErrors(handle.sync()),
        close: () => withPythonFilesystemErrors(handle.close()),
      };
    },
    unlink: (path) => withPythonFilesystemErrors(unlink(nativePath(path))),
    async createTemporary(options) {
      const maximumAttempts = process.platform === "darwin" ? 20 : 238328;
      for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
        const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789_";
        const token = Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]!).join("");
        const path = constructPosixPath(options.directory, options.prefix + token + options.suffix);
        let handle: FileHandle;
        try {
          handle = await withPythonFilesystemErrors(open(nativePath(path), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600));
        } catch (error) {
          if (isFilesystemError(error) && error.code === "EEXIST") continue;
          throw error;
        }
        let blockSize: number;
        try {
          blockSize = (await withPythonFilesystemErrors(handle.stat())).blksize;
        } catch (error) {
          let failure = error;
          try { await withPythonFilesystemErrors(handle.close()); }
          catch (closeError) {
            failure = linkContext(closeError, failure);
          }
          try { await withPythonFilesystemErrors(unlink(nativePath(path))); }
          catch (cleanupError) {
            throw linkContext(cleanupError, failure);
          }
          throw failure;
        }
        const bufferSize = profile === "3.14" ? Math.max(131072, Math.min(blockSize, 8388608))
          : blockSize > 1 ? blockSize : 8192;
        let pendingText: Buffer[] = [];
        let textCount = 0;
        let buffered: Buffer = Buffer.alloc(0);
        async function writeNative(bytes: Buffer): Promise<number> {
          const { bytesWritten } = await withPythonFilesystemErrors(handle.write(bytes, 0, bytes.length, null));
          if (bytesWritten <= 0) throw new Error("Temporary file write made no progress");
          return bytesWritten;
        }
        async function flushBuffer(): Promise<void> {
          while (buffered.length) {
            const written = await writeNative(buffered);
            buffered = buffered.subarray(written);
          }
        }
        async function bufferWrite(bytes: Buffer): Promise<void> {
          if (bytes.length < bufferSize - buffered.length
            || buffered.length > 0 && bytes.length === bufferSize - buffered.length) {
            buffered = Buffer.concat([buffered, bytes]);
            return;
          }
          await flushBuffer();
          while (bytes.length >= bufferSize) bytes = bytes.subarray(await writeNative(bytes));
          buffered = bytes;
        }
        async function flushText(): Promise<void> {
          if (!textCount) return;
          const bytes = Buffer.concat(pendingText, textCount);
          // TextIOWrapper relinquishes its pending chunk before BufferedWriter.write.
          pendingText = [];
          textCount = 0;
          await bufferWrite(bytes);
        }
        async function flush(): Promise<void> {
          await flushText();
          await flushBuffer();
        }
        return {
          path,
          async write(text) {
            const bytes = encode(text);
            if (bytes.length >= 8192 && textCount) await flushText();
            pendingText.push(bytes);
            textCount += bytes.length;
            if (textCount >= 8192) await flushText();
          },
          flush,
          sync: () => withPythonFilesystemErrors(handle.sync()),
          async close() {
            let failure: unknown;
            try { await flush(); } catch (error) { failure = error; throw error; }
            finally {
              try { await withPythonFilesystemErrors(handle.close()); }
              catch (error) {
                throw linkContext(error, failure);
              }
            }
          },
        };
      }
      const error: NodeJS.ErrnoException = new Error("No usable temporary file name found");
      error.code = "EEXIST";
      error.errno = -17;
      throw pythonFilesystemError(error);
    },
  };
}
