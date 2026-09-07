import { constructPosixPath, posixParent, resolvePosixPath, validatePathProfile } from "../contracts/posix-path.js";
import type { PythonPathProfile } from "../contracts/posix-path.js";
import type { PythonJson } from "../contracts/raw-json/value.js";
import { StoreValidationError } from "./validation.js";

export interface ManagedPathIO {
  resolve(path: string, profile: PythonPathProfile): Promise<string>;
}

export class MissingManagedFileError extends Error {
  constructor() {
    super("managedFile");
    this.name = "KeyError";
  }
}

const nativeIO: ManagedPathIO = { resolve: resolvePosixPath };

/** Inert parent identity check; final-file and race policies belong to callers. */
export async function managedResumePath(
  root: string,
  record: Map<string, PythonJson>,
  profile: PythonPathProfile,
  io: ManagedPathIO = nativeIO,
): Promise<string> {
  validatePathProfile(profile);
  if (record.get("storageKind") !== "managed") throw new StoreValidationError("resume is not managed");
  if (!record.has("managedFile")) throw new MissingManagedFileError();
  const file = record.get("managedFile");
  if (typeof file !== "string") throw new TypeError("managedFile must be a path string");
  const candidate = constructPosixPath(root, file);
  try {
    if (await io.resolve(posixParent(candidate), profile) !== await io.resolve(root, profile)) {
      throw new StoreValidationError("managed resume file identity is invalid");
    }
  } catch (error) {
    if (!(error instanceof Error) || !("errno" in error) || typeof error.errno !== "number") throw error;
    throw new StoreValidationError("managed resume file identity is invalid");
  }
  return candidate;
}
