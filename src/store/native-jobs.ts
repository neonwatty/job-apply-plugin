import { NativeClaimJournal, claimOperationKinds, validateClaimJournal } from './native-claim-journal.js';
import { NativeClaimHistory } from './native-claim-history.js';
import { validateCoordinator, requireJobUnclaimed } from '../contracts/workspace/claims.js';
import type { ClaimTransaction } from '../workspace-core/claims.js';
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parsePythonPointJsonBytes } from "../contracts/raw-json/point-parser.js";
import { validateJobsDocument, safeId } from "../contracts/workspace/jobs.js";
import { validateResumeReferences } from "../contracts/workspace/resume-reference.js";
import { fromJSON, get, int, object, set, string, serialize, JobsError } from "../contracts/workspace/values.js";
import type { Document, Value } from "../contracts/workspace/values.js";
import type { JobsRepository, JobsTransaction } from "../workspace-core/jobs.js";
import { atomicWritePointJson } from "./point-persistence.js";
import { withExclusiveFileLock } from "./exclusive-file-lock.js";
import type { PosixFlockProvider } from "./posix-flock.js";
import { NativeAnswerResolutionJournal } from "./native-answer-resolution-journal.js";
import type { PendingAnswerTransaction } from "../workspace-core/pending-answers.js";
import { NativeAnswerJournal, answerJournalName } from "./native-answer-journal.js";
import { answerReferenceCounts } from "../contracts/workspace/answer-sessions.js";
import { validateAnswerSession } from "../contracts/workspace/answer-session-validation.js";
import type { AnswerMergeTransaction } from "../workspace-core/answer-merges.js";
import { NativeResumeFiles } from "./native-resume-files.js";
import { NativeExtractionJournal, closeRequestsForResumes, extractionJournalName, validateExtractionResumes } from "./native-extraction-journal.js";
import { validateExtractionRequests } from "../contracts/workspace/extraction-requests.js";
import { validateExtractions } from "../contracts/workspace/extraction-proposals.js";
import type { ExtractionTransaction } from "../workspace-core/extraction-context.js";

import { validateProfile } from "../contracts/workspace/profile.js";
import { validateGroups } from "../contracts/workspace/fact-groups.js";
import { validateAnswers } from "../contracts/workspace/answers.js";
import type { AnswerReferenceCounts } from "../workspace-core/answers.js";

const options = { pathProfile: "3.12", intMaxStrDigits: 4300 } as const;
const marker = '{"mode":"native-jobs-fixture","version":9}\n';
const allowed = new Set([".native-jobs-fixture", ".store.lock", "jobs.json", "profile.json", "resumes.json", "fact-groups.json", "answers.json", "resume-operation.json", "resume-files", "resume-extractions.json", "resume-extraction-requests.json", "resume-extraction-journal.json", "sessions", "applications.jsonl", "coordinator.json", "coordinator-journal.json"]);
const journalName = "resume-operation";
const documentOptions = { pathProfile: "3.12", intMaxStrDigits: 4300 } as const;

export interface ResumeTransaction {
  document: Document;
  files: NativeResumeFiles;
  save(document: Document): Promise<void>;
  saveJournal(operation: Value): Promise<void>;
}

/** Creates a NEW synthetic root only. Never adopts or initializes an existing Store. */
export async function initializeJobsFixture(root: string): Promise<void> {
  if (!isAbsolute(root) || root !== resolve(root)) throw new JobsError("fixture root must be an absolute normalized path");
  await mkdir(root, { mode: 0o700 });
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const name of ["jobs", "profile", "resumes", "fact-groups", "answers"]) {
    const payload = name === "fact-groups" ? { schemaVersion: 1, groups: {}, metadata: { createdAt: now, updatedAt: now } }
      : name === "answers" ? { schemaVersion: 1, answers: {}, redirects: {}, metadata: { updatedAt: now } }
      : name === "profile" ? { schemaVersion: 1, profile: {}, metadata: { createdAt: now, updatedAt: now, revision: 1, factProvenance: {} } }
      : { schemaVersion: 1, [name]: {}, metadata: { updatedAt: now } };
    await atomicWritePointJson(join(root, `${name}.json`), fromJSON(payload), options);
  }
  await atomicWritePointJson(join(root, `${journalName}.json`), fromJSON({ schemaVersion: 1, operation: null }), options);
  for (const [name, key] of [["resume-extractions", "proposals"], ["resume-extraction-requests", "requests"]]) {
    await atomicWritePointJson(join(root, `${name}.json`), fromJSON({ schemaVersion: 1, [key!]: {},
      metadata: { createdAt: now, updatedAt: now } }), options);
  }
  await atomicWritePointJson(join(root, `${extractionJournalName}.json`), fromJSON({ schemaVersion: 1, operation: null }), options);
  await mkdir(join(root, "resume-files"), { mode: 0o700 });
  await chmod(join(root, "resume-files"), 0o700);
  await mkdir(join(root, "sessions"), { mode: 0o700 });
  await atomicWritePointJson(join(root, "coordinator.json"), fromJSON({ schemaVersion: 1, claim: null }), options);
  await atomicWritePointJson(join(root, "coordinator-journal.json"), fromJSON({ schemaVersion: 1, operation: null }), options);
  const history = await open(join(root, "applications.jsonl"), "wx", 0o600);
  await history.sync();
  await history.close();
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
    private readonly write = atomicWritePointJson,
    private readonly checkpoint: (stage:string)=>Promise<void> = async () => {}) {}

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

  private async journal(name = journalName): Promise<Document> {
    const value = object(parsePythonPointJsonBytes(await this.read(`${name}.json`), {
      diagnosticProfile: "3.12", intMaxStrDigits: 4300,
    }), name);
    if (int(get(value, "schemaVersion")) !== 1n) throw new JobsError("resume recovery schema version is unsupported");
    return value;
  }

  private async saveJournal(operation: Value): Promise<void> {
    const journal = fromJSON({ schemaVersion: 1, operation: null }) as Document;
    set(journal, "operation", operation);
    await this.write(join(this.root, `${journalName}.json`), journal, documentOptions);
  }

  private extractionJournal(): NativeExtractionJournal {
    return new NativeExtractionJournal(() => this.journal(extractionJournalName),
      (name, document) => this.write(join(this.root, `${name}.json`), document, documentOptions));
  }

  private async saveResumes(document: Document): Promise<void> {
    validateExtractionResumes(document);
    const requests = validateExtractionRequests(await this.document("resume-extraction-requests"));
    const closed = closeRequestsForResumes(requests, document);
    if (closed) await this.extractionJournal().commit("resume-request-close", { requests: closed, resumes: document });
    else await this.write(join(this.root, "resumes.json"), document, documentOptions);
  }

  private async recoverResumes(): Promise<Document> {
    // The extraction journal can contain the resume document intended by the file
    // journal. Finish it first so subsequent file recovery never restores an older
    // extraction snapshot over a newly installed resume. Validate before file I/O.
    await this.recoverAnswers();
    await this.extractionJournal().recover();
    const files = new NativeResumeFiles(this.root);
    const journal = await this.journal();
    if (journal.size !== 2) throw new JobsError("invalid resume recovery journal");
    let resumes = await this.document("resumes");
    const operation = get(journal, "operation");
    await files.recover(operation === null ? null : object(operation, "resume recovery operation"), resumes,
      async document => {
        await this.saveResumes(document);
        resumes = document;
      }, async () => this.saveJournal(null));
    return resumes;
  }

  async transaction<T>(operation: (transaction: JobsTransaction) => Promise<T>): Promise<T> {
    await this.validateRoot();
    return withExclusiveFileLock(join(this.root, ".store.lock"), async () => {
      await this.validateRoot(true);
      const resumesDocument = await this.recoverResumes();
      const document = validateJobsDocument(await this.document("jobs"));
      // Read-only projections: no Python initialization, repair, extraction or preflight.
      object(get(await this.document("profile"), "profile"), "profile.profile");
      const resumes = object(get(resumesDocument, "resumes"), "resumes.resumes");
      validateResumeReferences(resumes);
      const coordinator = validateCoordinator(await this.journal('coordinator'));
      const claim = get(coordinator,'claim');
      const claimedId = claim === null ? null : string(get(object(claim,'claim'),'jobId'));
      const originalClaimed = claimedId === null ? null : serialize(get(object(get(document,'jobs'),'jobs'),claimedId));
      return operation({ document,
        requireUnclaimed: id => requireJobUnclaimed(coordinator,id),
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
          if (claimedId !== null && serialize(get(object(get(value,'jobs'),'jobs'),claimedId)) !== originalClaimed) throw new JobsError('claimed job requires a coordinator operation');
          await this.write(join(this.root, "jobs.json"), value, options);
        },
      });
    }, { provider: this.provider, pathProfile: "3.12", signal: AbortSignal.timeout(30_000) });
  }

  async upsertTransaction<T>(operation: (transaction: Pick<JobsTransaction, "document" | "save">) => Promise<T>): Promise<T> {
    return this.transaction(async ({ document }) => operation({ document,
      // Python ingestion may update claimed jobs without changing claim/session evidence.
      // Keep that authority separate from the ordinary Jobs save guard.
      save: async value => {
        validateJobsDocument(value);
        await this.write(join(this.root, "jobs.json"), value, options);
      },
    }));
  }

  async resumeTransaction<T>(operation: (transaction: ResumeTransaction) => Promise<T>): Promise<T> {
    await this.validateRoot();
    return withExclusiveFileLock(join(this.root, ".store.lock"), async () => {
      await this.validateRoot(true);
      const files = new NativeResumeFiles(this.root);
      const document = await this.recoverResumes();
      validateResumeReferences(object(get(document, "resumes"), "resumes.resumes"));
      return operation({ document, files,
        save: async value => {
          await this.saveResumes(value);
        },
        saveJournal: async value => this.saveJournal(value),
      });
    }, { provider: this.provider, pathProfile: "3.12", signal: AbortSignal.timeout(30_000) });
  }

  async extractionTransaction<T>(operation: (transaction: ExtractionTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => operation({
      profile: validateProfile(await this.document("profile")),
      resumes: validateExtractionResumes(await this.document("resumes")),
      requests: validateExtractionRequests(await this.document("resume-extraction-requests")),
      proposals: validateExtractions(await this.document("resume-extractions")),
      files: new NativeResumeFiles(this.root),
      commit: (kind, updates) => this.extractionJournal().commit(kind, updates),
    }));
  }

  async profileTransaction<T>(operation: (document: Document, save: (document: Document) => Promise<void>) => Promise<T>): Promise<T> {
    return this.transaction(async () => operation(validateProfile(await this.document("profile")), async document => {
      validateProfile(document);
      await this.write(join(this.root, "profile.json"), document, options);
    }));
  }

  async groupsTransaction<T>(operation: (document: Document, save: (document: Document) => Promise<void>) => Promise<T>): Promise<T> {
    return this.transaction(async () => operation(validateGroups(await this.document("fact-groups")), async document => {
      validateGroups(document);
      await this.write(join(this.root, "fact-groups.json"), document, options);
    }));
  }

  async answerTransaction<T>(operation: (document: Document, save: (document: Document) => Promise<void>, references: AnswerReferenceCounts) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const document = validateAnswers(await this.document("answers"));
      return operation(document, async next => {
        validateAnswers(next);
        await this.write(join(this.root, "answers.json"), next, options);
      }, answerReferenceCounts(document, await this.answerSessions(), await this.answerHistory()));
    });
  }

  private answerJournal(): NativeAnswerJournal {
    return new NativeAnswerJournal((name, document) => this.write(join(this.root, `${name}.json`), document, options));
  }

  private async answerSessions(): Promise<Document[]> {
    const directory = join(this.root, "sessions"), stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) throw new JobsError("native sessions directory must be private and owned");
    const sessions: Document[] = [];
    for (const name of (await readdir(directory)).sort()) {
      if (!name.endsWith('.json')) throw new JobsError("native sessions contains unsupported state");
      const id = safeId(name.slice(0, -5));
      const session = validateAnswerSession(parsePythonPointJsonBytes(await this.read(`sessions/${name}`), { diagnosticProfile: "3.12", intMaxStrDigits: 4300 }));
      if (string(get(session, "applicationId")) !== id) throw new JobsError("session identity does not match its file");
      sessions.push(session);
    }
    return sessions;
  }

  private history(): NativeClaimHistory { return new NativeClaimHistory(this.root); }
  private async answerHistory(): Promise<Document[]> { return this.history().read(); }
  private claimJournal(): NativeClaimJournal {
    return new NativeClaimJournal((name,document) => this.write(join(this.root,`${name}.json`),document,options),this.history(),this.checkpoint);
  }
  private async recoverAnswers(): Promise<void> {
    const coordinator = validateCoordinator(await this.journal('coordinator'));
    const sessions = await this.answerSessions();
    const journal = await this.journal(answerJournalName), operation = get(journal,'operation');
    if (operation !== null && claimOperationKinds.has(string(get(object(operation,'coordinator operation'),'kind'))!)) {
      validateClaimJournal(journal);
      await this.history().repairPendingTail();
      await this.claimJournal().recover(journal,validateJobsDocument(await this.document('jobs')));
      return;
    }
    await this.answerHistory();
    if (operation !== null && get(coordinator,'claim') !== null) throw new JobsError('answer recovery requires an idle coordinator');
    if (operation !== null && string(get(object(operation,'coordinator operation'),'kind')) === 'answer_resolution') {
      await this.resolutionJournal().recover(journal,validateJobsDocument(await this.document('jobs')),sessions);
    } else await this.answerJournal().recover(journal,validateAnswers(await this.document('answers')),sessions);
  }

  async claimTransaction<T>(operation:(transaction:ClaimTransaction)=>Promise<T>):Promise<T> {
    return this.transaction(async () => {
      const jobs = validateJobsDocument(await this.document('jobs'));
      return operation({jobs,coordinator:validateCoordinator(await this.journal('coordinator')),
        sessions:await this.answerSessions(), history:await this.answerHistory(), answers:validateAnswers(await this.document('answers')),
        profile:validateProfile(await this.document('profile')),resumes:validateExtractionResumes(await this.document('resumes')),
        files:new NativeResumeFiles(this.root),
        saveJobs:async document => { validateJobsDocument(document);await this.write(join(this.root,'jobs.json'),document,options); },
        saveCoordinator:async document => { validateCoordinator(document);await this.write(join(this.root,'coordinator.json'),document,options); },
        saveSession:async document => { validateAnswerSession(document);await this.write(join(this.root,`sessions/${safeId(string(get(document,'applicationId')))}.json`),document,options); },
        commit:operation => this.claimJournal().commit(operation,jobs)});
    });
  }

  async answerMergeTransaction<T>(operation: (transaction: AnswerMergeTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const document = validateAnswers(await this.document('answers'));
      const sessions = await this.answerSessions(), history = await this.answerHistory();
      const coordinator = validateCoordinator(await this.journal('coordinator'));
      return operation({document,sessions,history,commit:value => {
        if (get(coordinator,'claim') !== null) throw new JobsError('answer merge requires an idle coordinator');
        return this.answerJournal().commit(value,document,sessions);
      }});
    });
  }

  private resolutionJournal(): NativeAnswerResolutionJournal {
    return new NativeAnswerResolutionJournal((name, document) => this.write(join(this.root, `${name}.json`), document, options));
  }

  async pendingAnswerTransaction<T>(operation: (transaction: PendingAnswerTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const jobs = validateJobsDocument(await this.document('jobs')), sessions = await this.answerSessions();
      const coordinator = validateCoordinator(await this.journal('coordinator'));
      return operation({ jobs, sessions, answers: validateAnswers(await this.document('answers')),
        profile: validateProfile(await this.document('profile')), resumes: validateExtractionResumes(await this.document('resumes')),
        files: new NativeResumeFiles(this.root), requireUnclaimed: id => requireJobUnclaimed(coordinator,id), commit: value => {
          if (get(coordinator,'claim') !== null) throw new JobsError('answer resolution requires an idle coordinator');
          return this.resolutionJournal().commit(value,jobs,sessions);
        } });
    });
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
