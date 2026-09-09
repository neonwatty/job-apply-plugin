import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parsePythonPointJsonBytes } from "../contracts/raw-json/point-parser.js";
import { validateJobsDocument, safeId } from "../contracts/workspace/jobs.js";
import { validateResumeReferences } from "../contracts/workspace/resume-reference.js";
import { fromJSON, get, int, object, string, serialize, JobsError } from "../contracts/workspace/values.js";
import type { Document, Value } from "../contracts/workspace/values.js";
import type { JobsRepository, JobsTransaction } from "../workspace-core/jobs.js";
import { atomicWritePointJson } from "./point-persistence.js";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";
import type { PosixFlockProvider } from "./posix-flock.js";

const options = { pathProfile: "3.12", intMaxStrDigits: 4300 } as const;
const marker = '{"mode":"native-jobs-fixture","version":1}\n';
const allowed = new Set([".native-jobs-fixture", ".store.lock", "jobs.json", "profile.json", "resumes.json"]);

/** Creates a NEW synthetic root only. Never adopts or initializes an existing Store. */
export async function initializeJobsFixture(root: string): Promise<void> {
  if (!isAbsolute(root) || root !== resolve(root)) throw new JobsError("fixture root must be an absolute normalized path");
  await mkdir(root, { mode: 0o700 });
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const name of ["jobs", "profile", "resumes"]) {
    const payload = name === "profile" ? { schemaVersion: 1, profile: {}, metadata: { updatedAt: now } }
      : { schemaVersion: 1, [name]: {}, metadata: { updatedAt: now } };
    await atomicWritePointJson(join(root, `${name}.json`), fromJSON(payload), options);
  }
  const lock = await open(join(root, ".store.lock"), "wx", 0o600);
  await lock.close();
  // The readiness marker is written last; partial initialization is never adopted.
  const handle = await open(join(root, ".native-jobs-fixture"), "wx", 0o600);
  try { await handle.writeFile(marker); await handle.sync(); } finally { await handle.close(); }
  const directory = await open(root, constants.O_RDONLY);
  try { await directory.sync(); } finally { await directory.close(); }
}

export class NativeJobsRepository implements JobsRepository {
  constructor(readonly root: string, private readonly provider: PosixFlockProvider,
    private readonly write = atomicWritePointJson) {}

  private async read(name: string): Promise<Buffer> {
    const handle = await open(join(this.root, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
        throw new JobsError("native fixture file must be private and owned, without links");
      }
      if (stat.size > 32 * 1024 * 1024) throw new JobsError("native fixture document exceeds supported size");
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  private async validateRoot(locked = false): Promise<void> {
    if (!isAbsolute(this.root) || this.root !== resolve(this.root) || await realpath(this.root) !== this.root) {
      throw new JobsError("native fixture root must be a real absolute directory");
    }
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) {
      throw new JobsError("native fixture root must be private and owned");
    }
    const entries = await readdir(this.root);
    if (locked && entries.some(name => !allowed.has(name)) || [...allowed].some(name => !entries.includes(name))) {
      throw new JobsError("native Jobs cannot open unsupported state or recovery journals");
    }
    if ((await this.read(".native-jobs-fixture")).toString("utf8") !== marker) {
      throw new JobsError("native Jobs requires an explicitly initialized synthetic fixture");
    }
    await this.read(".store.lock");
  }

  private async document(name: string): Promise<Document> {
    const value = object(parsePythonPointJsonBytes(await this.read(`${name}.json`), {
      diagnosticProfile: "3.12", intMaxStrDigits: 4300,
    }), name);
    if (int(get(value, "schemaVersion")) !== 1n) throw new JobsError(`${name} schema version is unsupported`);
    object(get(value, "metadata"), `${name}.metadata`);
    return value;
  }

  async transaction<T>(operation: (transaction: JobsTransaction) => Promise<T>): Promise<T> {
    await this.validateRoot();
    return withExclusiveFileLock(join(this.root, ".store.lock"), async () => {
      await this.validateRoot(true);
      const document = validateJobsDocument(await this.document("jobs"));
      // Read-only projections: no Python initialization, repair, extraction or preflight.
      object(get(await this.document("profile"), "profile"), "profile.profile");
      const resumes = object(get(await this.document("resumes"), "resumes"), "resumes.resumes");
      validateResumeReferences(resumes);
      return operation({ document,
        requireResume: async (id: Value) => {
          if (id === null) return;
          const value = string(id);
          if (value === null) throw new JobsError("job resume id must be a string");
          safeId(value);
          const record = get(resumes, value);
          if (record === null || get(object(record, "resume record"), "deletedAt") !== null) {
            throw new JobsError("assigned resume does not exist");
          }
          if (string(get(object(record, "resume record"), "id")) !== value) throw new JobsError("resume record id does not match its index");
        },
        save: async value => {
          validateJobsDocument(value);
          await this.write(join(this.root, "jobs.json"), value, options);
        },
      });
    }, { provider: this.provider, pathProfile: "3.12", signal: AbortSignal.timeout(30_000) });
  }

  async resumeSummaries(): Promise<Value[]> {
    // Reuse the lock and all root checks for projections too.
    return this.transaction(async () => {
      const resumes = object(get(await this.document("resumes"), "resumes"), "resumes.resumes");
      return resumes.entries().flatMap(([key, value]) => {
        const record = object(value, "resume record");
        if (get(record, "deletedAt") !== null) return [];
        const id = safeId(string(key)), label = string(get(record, "label"));
        if (string(get(record, "id")) !== id || !label || typeof get(record, "default") !== "boolean") {
          throw new JobsError("resume projection is invalid");
        }
        return [fromJSON({ id, label, default: get(record, "default") })];
      });
    });
  }
}

export function fixtureError(error: unknown): string {
  return error instanceof JobsError ? error.message : "native fixture operation failed; inspect the Store before retrying";
}
export { serialize };
