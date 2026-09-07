import { lstat, realpath } from "node:fs/promises";
import { filesystemDecode, filesystemEncode, FilesystemEncodeError } from "../contracts/posix-path-bytes.js";
import { constructPosixPath, PathLoopError, validatePathProfile } from "../contracts/posix-path.js";
import type { PythonPathProfile } from "../contracts/posix-path.js";
import { withPythonFilesystemErrors } from "../contracts/filesystem-error.js";

export class ArtifactVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemExit";
  }
}

class ArtifactPathValueError extends Error {
  constructor() {
    super("embedded null byte");
    this.name = "ValueError";
  }
}

export function artifactBytes(path: string): Buffer {
  const bytes = filesystemEncode(path);
  if (bytes.includes(0)) throw new ArtifactPathValueError();
  return bytes;
}

export function artifactOSError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "errno" in error && typeof error.errno === "number";
}

/** Only the declared root resolves symlinks; components below it are checked separately. */
export async function artifactRoot(root: string, profile: PythonPathProfile): Promise<string> {
  validatePathProfile(profile);
  if (process.platform === "win32") throw new Error("Native Windows artifact verification is not implemented");
  try {
    return filesystemDecode(await withPythonFilesystemErrors(realpath(artifactBytes(root || "."), { encoding: "buffer" })));
  } catch (error) {
    if (profile === "3.12" && artifactOSError(error) && error.code === "ELOOP") throw new PathLoopError();
    throw error;
  }
}

export async function checkedArtifactPath(root: string, relative: string): Promise<string> {
  const parts = relative.split("/").filter(part => part !== "" && part !== ".");
  if (!parts.length || relative.startsWith("/") || parts.includes("..")) {
    throw new ArtifactVerificationError(`invalid critical package path: ${relative}`);
  }
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = constructPosixPath(current, parts[index]!);
    let metadata;
    try {
      metadata = await withPythonFilesystemErrors(lstat(artifactBytes(current)));
    } catch (error) {
      if (!artifactOSError(error)) throw error;
      const message = error.code === "ENOENT" ? "critical package artifact is missing"
        : "unable to inspect critical package artifact";
      throw new ArtifactVerificationError(`${message}: ${relative}`);
    }
    if (metadata.isSymbolicLink()) {
      throw new ArtifactVerificationError(`critical package path contains a symlink: ${relative}`);
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      throw new ArtifactVerificationError(`critical package ancestor is not a directory: ${relative}`);
    }
  }
  return current;
}

export async function regularArtifactFile(root: string, relative: string): Promise<string> {
  const path = await checkedArtifactPath(root, relative);
  let metadata;
  try {
    metadata = await withPythonFilesystemErrors(lstat(artifactBytes(path)));
  } catch (error) {
    if (!artifactOSError(error)) throw error;
    throw new ArtifactVerificationError(`critical package artifact is missing: ${relative}`);
  }
  if (!metadata.isFile()) {
    throw new ArtifactVerificationError(`critical package artifact is not a regular file: ${relative}`);
  }
  return path;
}

/** pathlib's is_symlink error policy differs across the reference versions. */
export async function artifactIsSymlink(path: string, profile: PythonPathProfile): Promise<boolean> {
  try {
    return (await withPythonFilesystemErrors(lstat(artifactBytes(path)))).isSymbolicLink();
  } catch (error) {
    if (error instanceof ArtifactPathValueError || error instanceof FilesystemEncodeError) return false;
    if (artifactOSError(error) && (profile === "3.14" || error.code === "ENOENT"
      || error.code === "ENOTDIR" || error.code === "EBADF" || error.code === "ELOOP")) return false;
    throw error;
  }
}
