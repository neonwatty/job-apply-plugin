import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";

export interface DigestHandle {
  stat(): Promise<{ size: number; isFile(): boolean }>;
  read(buffer: Buffer, offset: number, length: number, position: null): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface DigestIO {
  isSymbolicLink(path: string): Promise<boolean>;
  open(path: string, flags: number): Promise<DigestHandle>;
  noFollow: number;
}

const MAXIMUM_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024;

function isFilesystemError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}

const nativeIO: DigestIO = {
  noFollow: constants.O_NOFOLLOW ?? 0,
  async isSymbolicLink(path) {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch (error) {
      if (isFilesystemError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
        return false;
      }
      throw error;
    }
  },
  open,
};

/** Descriptor-based compatibility leaf, without containment or observation policy. */
export async function privateFileDigest(path: string, io: DigestIO = nativeIO): Promise<string | null> {
  let handle: DigestHandle | undefined;
  try {
    if (await io.isSymbolicLink(path)) return null;
    handle = await io.open(path, constants.O_RDONLY | io.noFollow);
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAXIMUM_BYTES) return null;
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      digest.update(buffer.subarray(0, bytesRead));
    }
    return digest.digest("hex");
  } catch (error) {
    if (isFilesystemError(error)) return null;
    throw error;
  } finally {
    if (handle !== undefined) await handle.close();
  }
}
