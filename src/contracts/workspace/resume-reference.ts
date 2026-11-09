import { posix } from "node:path";
import { PythonText } from "../python-text.js";
import { safeId } from "./jobs.js";
import { strip } from "./job-url.js";
import { get, has, int, keys, object, string, JobsError } from "./values.js";
import type { Document, Value } from "./values.js";

const fields = new Set(["id", "label", "path", "storageKind", "managedFile", "originalFilename",
  "mediaType", "digest", "contentRevision", "tags", "default", "observedSize", "observedModifiedAt",
  "revision", "createdAt", "updatedAt", "deletedAt"]);
const media: Record<string, string> = { '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.txt': 'text/plain; charset=utf-8' };
const matches = (pattern: RegExp, value: Value): boolean => {
  const input = string(value), match = input === null ? null : pattern.exec(input);
  return match !== null && match[0] === input;
};

/** Registry validation only: selection never reads files or asserts upload readiness. */
export function validateResumeReferences(resumes: Document): void {
  let defaults = 0;
  for (const [key, value] of resumes.entries()) {
    const id = safeId(string(key)), record = object(value, "resume record");
    if (keys(record).some(key => !fields.has(key))) throw new JobsError("resume record contains unsupported fields");
    if (string(get(record, "id")) !== id) throw new JobsError("resume record id does not match its index");
    if (!strip(string(get(record, "label")) ?? "")) throw new JobsError("resume label must be a non-empty string");
    const storage = get(record, "storageKind");
    if (storage === null) {
      const path = string(get(record, "path"));
      const normalized = path?.startsWith("//") && !path.startsWith("///")
        ? '/' + posix.normalize(path) : path === null ? null : posix.normalize(path);
      if (!path || !posix.isAbsolute(path) || path.includes('\0') || strip(path) !== path || normalized !== path) {
        throw new JobsError("resume path is not normalized");
      }
      if (["managedFile", "originalFilename", "mediaType", "digest", "contentRevision"].some(field => has(record, field))) {
        throw new JobsError("legacy resume record contains managed storage fields");
      }
    } else if (string(storage) === "managed") {
      if (has(record, "path")) throw new JobsError("managed resume record must not contain a source path");
      const file = string(get(record, "managedFile"));
      if (!Object.keys(media).some(extension => file === id + extension)) throw new JobsError("managed resume file identity is invalid");
      const original = string(get(record, "originalFilename"));
      if (!original || original.includes('/') || original.includes('\0') || ['.', '..'].includes(original)) {
        throw new JobsError("managed resume original filename is invalid");
      }
      if (string(get(record, "mediaType")) !== media[posix.extname(file!)]) throw new JobsError("managed resume media type is invalid");
      if (!matches(/^[0-9a-f]{64}$/, get(record, "digest"))) throw new JobsError("managed resume digest is invalid");
      if (get(record, "contentRevision") !== null && !matches(/^content_[A-Za-z0-9_-]{32,128}$/, get(record, "contentRevision"))) {
        throw new JobsError("resume content revision is unverifiable");
      }
      if (get(record, "observedSize") === null || !string(get(record, "observedModifiedAt"))) throw new JobsError("managed resume observation is incomplete");
    } else throw new JobsError("resume storage kind is unsupported");
    const tags = has(record, "tags") ? get(record, "tags") : [];
    if (!Array.isArray(tags) || tags.some(tag => !strip(string(tag) ?? ""))) throw new JobsError("resume tags must be non-empty strings");
    if (new Set(tags.map(tag => (tag as PythonText).contentKey())).size !== tags.length) throw new JobsError("resume tags must be unique");
    if (typeof get(record, "default") !== "boolean") throw new JobsError("resume default must be a boolean");
    if (get(record, "default") === true && get(record, "deletedAt") === null) defaults++;
    if (get(record, "observedSize") !== null && (int(get(record, "observedSize")) === null || int(get(record, "observedSize"))! < 0n)) {
      throw new JobsError("resume observed size is invalid");
    }
    if (int(get(record, "revision")) === null || int(get(record, "revision"))! < 1n) throw new JobsError("resume revision must be a positive integer");
    for (const field of ["observedModifiedAt", "createdAt", "updatedAt", "deletedAt"]) {
      if (get(record, field) !== null && string(get(record, field)) === null) throw new JobsError(`resume record.${field} must be a string`);
    }
    if (!string(get(record, "createdAt"))) throw new JobsError("resume record has no creation timestamp");
    if (!string(get(record, "updatedAt"))) throw new JobsError("resume record has no update timestamp");
  }
  if (defaults > 1) throw new JobsError("resume store has more than one active default");
}
