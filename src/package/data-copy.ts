import { validatePathProfile } from "../contracts/posix-path.js";
import type { PythonPathProfile } from "../contracts/posix-path.js";
import type { DataCopyIO, DataCopyReader, DataCopyWriter } from "./data-copy-io.js";

export interface DataCopyOptions {
  profile: PythonPathProfile;
  /** Only the observed POSIX single-accelerator protocol is implemented. */
  platform: "darwin";
  followSymlinks: boolean;
  io: DataCopyIO;
}

class DataCopyError extends Error {
  constructor(name: string, message: string) {
    super(message);
    this.name = name;
  }
}
type ContextualError = Error & { pythonContext?: unknown; pythonSuppressContext?: boolean };
function contextual(error: unknown, previous: unknown, explicit = false): unknown {
  if (error instanceof Error && previous !== undefined && error !== previous) {
    // Python breaks a previous implicit chain before linking a reused exception.
    const visited = new Set<Error>();
    let cursor: unknown = previous;
    while (cursor instanceof Error && !visited.has(cursor)) {
      visited.add(cursor);
      const prior = cursor as ContextualError;
      if (prior.pythonContext === error) {
        delete prior.pythonContext;
        break;
      }
      cursor = prior.pythonContext;
    }
    (error as ContextualError).pythonContext = previous;
    if (explicit) {
      error.cause = previous;
      (error as ContextualError).pythonSuppressContext = true;
    }
  }
  return error;
}

/** Actual copyfileobj protocol: a single write per read, without short-write retry. */
export async function copyFileObjects(source: DataCopyReader, target: DataCopyWriter, length: number): Promise<void> {
  if (!Number.isSafeInteger(length) || length <= 0) throw new RangeError("Copy buffer length must be a positive safe integer");
  for (;;) {
    const bytes = await source.read(length);
    if (bytes.length === 0) return;
    await target.write(bytes);
  }
}

/** Inert copyfile control flow. The caller explicitly supplies every IO operation. */
export async function copyFileData(source: string, target: string, options: DataCopyOptions): Promise<string> {
  validatePathProfile(options.profile);
  if (options.platform !== "darwin") throw new RangeError("Only the observed macOS data-copy protocol is implemented");
  const io = options.io;
  let same = false;
  try { same = await io.sameFile(source, target); }
  catch (error) { if (!io.isOSError(error)) throw error; }
  if (same) throw new DataCopyError("SameFileError", `${io.pathRepr(source)} and ${io.pathRepr(target)} are the same file`);
  for (const path of [source, target]) {
    let metadata;
    try { metadata = await io.stat(path); }
    catch (error) { if (!io.isOSError(error)) throw error; }
    if (metadata?.isFIFO()) throw new DataCopyError("SpecialFileError", `\`${path}\` is a named pipe`);
  }
  if (!options.followSymlinks && await io.isLink(source)) {
    await io.symlink(await io.readLink(source), target);
    return target;
  }
  const reader = await io.openSource(source);
  let outerFailure: unknown;
  try {
    try {
      const writer = await io.openTarget(target);
      let innerFailure: unknown;
      try {
        const result = io.accelerate === undefined ? "give-up" : await io.accelerate(reader, writer);
        if (result !== "copied" && result !== "give-up") throw new TypeError("Invalid data-copy accelerator result");
        if (result === "give-up") await copyFileObjects(reader, writer, options.profile === "3.14" ? 262144 : 65536);
      } catch (error) {
        innerFailure = error;
        throw error;
      } finally {
        try { await writer.close(); }
        catch (error) { throw contextual(error, innerFailure); }
      }
    } catch (error) {
      if (io.isDirectoryError(error)) {
        let exists: boolean;
        try { exists = await io.exists(target); }
        catch (inspectionError) { throw contextual(inspectionError, error); }
        if (!exists) throw contextual(new DataCopyError("FileNotFoundError", `Directory does not exist: ${target}`), error, true);
      }
      throw error;
    }
  } catch (error) {
    outerFailure = error;
    throw error;
  } finally {
    try { await reader.close(); }
    catch (error) { throw contextual(error, outerFailure); }
  }
  return target;
}
