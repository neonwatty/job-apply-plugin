import { automationTransaction as runAutomationTransaction } from './native-automation.js';
import { accountOperation, emptyAccountOperationJournal, validateAccountOperationJournal } from '../contracts/workspace/account-operation.js';
import type { AccountOperationTransaction } from '../workspace-core/account-operation.js';
import type { AutomationTransaction } from '../workspace-core/automation.js';
import type { GroupedApprovalTransaction } from '../workspace-core/grouped-approvals.js';
import { NativeClaimJournal, claimOperationKinds, validateClaimJournal } from './native-claim-journal.js';
import { NativeClaimHistory } from './native-claim-history.js';
import { validateCoordinator, requireJobUnclaimed } from '../contracts/workspace/claims.js';
import type { ClaimTransaction } from '../workspace-core/claims.js';
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
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
import { projectStoredAnswerSession, validateAnswerSession } from "../contracts/workspace/answer-session-validation.js";
import type { AnswerMergeTransaction } from "../workspace-core/answer-merges.js";
import { NativeResumeFiles } from "./native-resume-files.js";
import { NativeExtractionJournal, closeRequestsForResumes, extractionJournalName, validateExtractionResumes } from "./native-extraction-journal.js";
import { validateExtractionRequests } from "../contracts/workspace/extraction-requests.js";
import { validateExtractions } from "../contracts/workspace/extraction-proposals.js";
import type { ExtractionTransaction } from "../workspace-core/extraction-context.js";
import type { ResumeLifecycleRepository, ResumeLifecycleTransaction } from "../workspace-core/resume-lifecycle.js";
import { validateTrustedFillDocument } from "../contracts/workspace/trusted-fill.js";
import type { TrustedFillRepository, TrustedFillTransaction } from "../workspace-core/trusted-fill.js";
import type { HistoryRepository, HistoryTransaction } from "../workspace-core/store-history.js";
import type { SessionRepository, SessionTransaction } from "../workspace-core/store-sessions.js";
import type { PreparednessRepository, PreparednessSnapshot } from "../workspace-core/profile-preparedness.js";
import type { ReplayTransitionRepository, ReplayTransitionTransaction } from '../workspace-core/replay-transition.js';
import { validateProfile } from "../contracts/workspace/profile.js";
import { validateResumeFacts } from "../contracts/workspace/resume-facts.js";
import { validateGroups } from "../contracts/workspace/fact-groups.js";
import { validateAnswers } from "../contracts/workspace/answers.js";
import type { AnswerReferenceCounts } from "../workspace-core/answers.js";
import { ResumeService } from '../workspace-core/resumes.js';
import { preparednessSnapshot, runHistoryTransaction, runReplayTransitionTransaction, runSessionTransaction, stateStorage } from './native-store-state-repository.js';
import { validateNativeJobsRoot } from './native-root-validation.js';
import { nativePendingAnswerState } from './native-pending-answer-state.js';
import type { ApplicationAuthorityRepository, ApplicationAuthorityTransaction } from '../workspace-core/application-authority.js';
import { applicationAuthorityTransaction as runApplicationAuthorityTransaction, loadApplicationAuthority } from './native-application-authority.js';
import { nativeResumeSummaries } from './native-resume-summaries.js';
const options = { pathProfile: "3.12", intMaxStrDigits: 4300 } as const;
const journalName = "resume-operation";
const documentOptions = { pathProfile: "3.12", intMaxStrDigits: 4300 } as const;
export interface ResumeTransaction {
  document: Document;
  files: NativeResumeFiles;
  save(document: Document): Promise<void>;
  saveJournal(operation: Value): Promise<void>;
}
export { initializeJobsFixture } from './native-jobs-fixture.js';

export class NativeJobsRepository implements JobsRepository, ResumeLifecycleRepository, TrustedFillRepository,
  HistoryRepository, SessionRepository, PreparednessRepository, ReplayTransitionRepository, ApplicationAuthorityRepository {
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

  private async validateRoot(locked = false, allowMissingJobs = false): Promise<void> {
    await validateNativeJobsRoot(this.root, name => this.read(name), locked, allowMissingJobs);
  }

  private async document(name: string): Promise<Document> {
    const value = object(parsePythonPointJsonBytes(await this.read(`${name}.json`), {
      diagnosticProfile: "3.12", intMaxStrDigits: 4300,
    }), name);
    if (int(get(value, "schemaVersion")) !== 1n) throw new JobsError(`${name} schema version is unsupported`);
    object(get(value, "metadata"), `${name}.metadata`);
    return value;
  }

  private async resumeFactsDocument(): Promise<Document> {
    try { return validateResumeFacts(await this.document('resume-facts')); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      return object(fromJSON({ schemaVersion: 1, sets: {}, metadata: { createdAt: now, updatedAt: now } }), 'resume facts');
    }
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

  private async saveResumeDocument(document: Document): Promise<void> {
    validateExtractionResumes(document);
    await this.write(join(this.root, "resumes.json"), document, documentOptions);
  }

  private async saveResumes(document: Document): Promise<void> {
    validateExtractionResumes(document);
    const requests = validateExtractionRequests(await this.document("resume-extraction-requests"));
    const closed = closeRequestsForResumes(requests, document);
    if (closed) await this.extractionJournal().commit("resume-request-close", { requests: closed, resumes: document });
    else await this.saveResumeDocument(document);
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

  async legacyTransaction<T>(operation: (transaction: {
    snapshot(): Promise<{document: Document; snapshot: Value}>;
    save(document: Document): Promise<void>;
  }) => Promise<T>): Promise<T> {
    await this.validateRoot(false, true);
    return withExclusiveFileLock(join(this.root, ".store.lock"), async () => {
      await this.validateRoot(true, true);
      // A preview must stay read-only; defer imports until existing recovery work is complete.
      for (const name of [journalName, extractionJournalName, answerJournalName]) {
        if (get(await this.journal(name), "operation") !== null) {
          throw new JobsError("native legacy import requires completed fixture recovery");
        }
      }
      return operation({
        snapshot: async () => {
          try {
            const document = validateJobsDocument(await this.document("jobs"));
            return {document, snapshot: document};
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const document = object(fromJSON({schemaVersion:1,jobs:{},metadata:{
              createdAt:'1970-01-01T00:00:00Z',updatedAt:'1970-01-01T00:00:00Z',
            }}), 'jobs');
            return {document,snapshot:fromJSON({state:'missing'})};
          }
        },
        save: async document => {
          validateJobsDocument(document);
          await this.write(join(this.root, "jobs.json"), document, options);
        },
      });
    }, {provider:this.provider,pathProfile:"3.12",signal:AbortSignal.timeout(30_000)});
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

  async resumeLifecycleTransaction<T>(operation: (transaction: ResumeLifecycleTransaction) => Promise<T>): Promise<T> {
    await this.validateRoot();
    return withExclusiveFileLock(join(this.root, ".store.lock"), async () => {
      await this.validateRoot(true);
      const files = new NativeResumeFiles(this.root, this.checkpoint);
      const resumes = await this.recoverResumes();
      validateResumeReferences(object(get(resumes, "resumes"), "resumes.resumes"));
      const saveResumes = async (document: Document, closeRequests: boolean) => closeRequests
        ? this.saveResumes(document) : this.saveResumeDocument(document);
      return operation({ resumes, files, saveResumes,
        jobs: () => this.document("jobs"),
        requests: () => this.document("resume-extraction-requests"),
        deleteManaged: (record, previous, document) => files.delete(
          record, previous, document, value => this.saveJournal(value),
          value => this.saveResumeDocument(value),
          () => this.document("resumes")),
      });
    }, { provider: this.provider, pathProfile: "3.12", signal: AbortSignal.timeout(30_000) });
  }

  async extractionTransaction<T>(operation: (transaction: ExtractionTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => operation({
      profile: validateProfile(await this.document("profile")),
      resumes: validateExtractionResumes(await this.document("resumes")),
      requests: validateExtractionRequests(await this.document("resume-extraction-requests")),
      proposals: validateExtractions(await this.document("resume-extractions")),
      facts: await this.resumeFactsDocument(),
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
      if (!name.endsWith('.json')) continue;
      const id = safeId(name.slice(0, -5));
      const session = projectStoredAnswerSession(parsePythonPointJsonBytes(await this.read(`sessions/${name}`), { diagnosticProfile: "3.12", intMaxStrDigits: 4300 }), id);
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
        authority:await loadApplicationAuthority(name => this.document(name), () => new Date().toISOString().replace(/\.\d{3}Z$/u,'Z')),
        sessions:await this.answerSessions(), history:await this.answerHistory(), answers:validateAnswers(await this.document('answers')),
        profile:validateProfile(await this.document('profile')),resumes:validateExtractionResumes(await this.document('resumes')),
        facts:await this.resumeFactsDocument(),
        requests:validateExtractionRequests(await this.document('resume-extraction-requests')),
        files:new NativeResumeFiles(this.root),
        saveJobs:async document => { validateJobsDocument(document);await this.write(join(this.root,'jobs.json'),document,options); },
        saveCoordinator:async document => { validateCoordinator(document);await this.write(join(this.root,'coordinator.json'),document,options); },
        saveSession:async document => { validateAnswerSession(document);await this.write(join(this.root,`sessions/${safeId(string(get(document,'applicationId')))}.json`),document,options); },
        commit:operation => this.claimJournal().commit(operation,jobs)});
    });
  }

  async groupedApprovalTransaction<T>(operation: (transaction: GroupedApprovalTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => operation({
      jobs: validateJobsDocument(await this.document('jobs')),
      sessions: await this.answerSessions(), answers: validateAnswers(await this.document('answers')),
      saveSession: async document => {
        validateAnswerSession(document);
        await this.write(join(this.root, `sessions/${safeId(string(get(document, 'applicationId')))}.json`), document, options);
      },
    }));
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
      const {coordinator,...state} = await nativePendingAnswerState(
        name => name === 'resume-facts' ? this.resumeFactsDocument() : this.document(name),
        name => this.journal(name), () => this.answerSessions(), this.root);
      return operation({ ...state, requireUnclaimed: id => requireJobUnclaimed(coordinator,id), commit: value => {
          if (get(coordinator,'claim') !== null) throw new JobsError('answer resolution requires an idle coordinator');
          return this.resolutionJournal().commit(value,state.jobs,state.sessions);
        } });
    });
  }

  async automationTransaction<T>(operation: (tx: AutomationTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => runAutomationTransaction({
      read: name => name === 'automation-settings' ? this.journal(name) : this.document(name),
      write: (name, document) => this.write(join(this.root, `${name}.json`), document, options),
    }, operation));
  }

  async applicationAuthorityTransaction<T>(operation: (tx: ApplicationAuthorityTransaction) => Promise<T>): Promise<T> {
    return this.transaction(() => runApplicationAuthorityTransaction({ root:this.root, document:name => this.document(name),
      journal:name => this.journal(name), facts:() => this.resumeFactsDocument(), now:() => new Date().toISOString().replace(/\.\d{3}Z$/u,'Z'),
      save:document => this.write(join(this.root,'application-authority.json'),document,options) }, operation));
  }

  async accountOperationTransaction<T>(operation: (tx: AccountOperationTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const jobs = validateJobsDocument(await this.document('jobs'));
      const journal = validateAccountOperationJournal(await this.journal('account-operation-journal'));
      const accounts = await this.document('employer-accounts');
      const settings = await this.journal('automation-settings');
      return operation({ journal, accounts, settings, jobs,
        coordinator: validateCoordinator(await this.journal('coordinator')),
        sessions: await this.answerSessions(), answers: validateAnswers(await this.document('answers')),
        saveAccounts: document => this.write(join(this.root, 'employer-accounts.json'), document, options),
        saveOperation: async (expected, value) => {
          const current = accountOperation(validateAccountOperationJournal(await this.journal('account-operation-journal')));
          const currentId = current === null ? null : string(get(current, 'operationId'));
          if (currentId !== expected) throw new JobsError('account operation journal changed before completion');
          const next = emptyAccountOperationJournal();
          if (value !== null) set(next, 'operation', value);
          await this.write(join(this.root, 'account-operation-journal.json'), validateAccountOperationJournal(next), options);
        },
        commitClaim: value => this.claimJournal().commit(value, jobs),
        clearOperation: async expected => {
          const current = accountOperation(validateAccountOperationJournal(await this.journal('account-operation-journal')));
          if (current === null || string(get(current, 'operationId')) !== expected) throw new JobsError('account operation journal changed before completion');
          await this.write(join(this.root, 'account-operation-journal.json'), emptyAccountOperationJournal(), options);
        },
      });
    });
  }

  async trustedFillTransaction<T>(operation: (tx: TrustedFillTransaction) => Promise<T>): Promise<T> {
    return this.transaction(async () => {
      const jobs = validateJobsDocument(await this.document('jobs'));
      return operation({ approvals: validateTrustedFillDocument(await this.document('trusted-fill')), jobs,
        coordinator: validateCoordinator(await this.journal('coordinator')), profile: validateProfile(await this.document('profile')),
        resumes: validateExtractionResumes(await this.document('resumes')), facts: await this.resumeFactsDocument(),
        requests: validateExtractionRequests(await this.document('resume-extraction-requests')),
        answers: validateAnswers(await this.document('answers')),
        settings: await this.journal('automation-settings'), accounts: await this.document('employer-accounts'),
        sessions: await this.answerSessions(), files: new NativeResumeFiles(this.root),
        saveApprovals: document => this.write(join(this.root, 'trusted-fill.json'), validateTrustedFillDocument(document), options),
        commitClaim: value => this.claimJournal().commit(value, jobs) });
    });
  }

  private async stateTransaction<T>(operation: () => Promise<T>): Promise<T> {
    await this.validateRoot();
    return withExclusiveFileLock(join(this.root, '.store.lock'), async () => {
      await this.validateRoot(true);
      await this.recoverResumes();
      return operation();
    }, { provider: this.provider, pathProfile: '3.12', signal: AbortSignal.timeout(30_000) });
  }

  async historyTransaction<T>(operation: (transaction: HistoryTransaction) => Promise<T>): Promise<T> {
    return this.stateTransaction(() => runHistoryTransaction(
      stateStorage(this.root, name => this.read(name), name => this.document(name), this.write), operation));
  }

  async sessionTransaction<T>(operation: (transaction: SessionTransaction) => Promise<T>): Promise<T> {
    return this.stateTransaction(() => runSessionTransaction(
      stateStorage(this.root, name => this.read(name), name => this.document(name), this.write), operation));
  }

  async preparednessSnapshot(): Promise<PreparednessSnapshot> {
    return this.stateTransaction(() => preparednessSnapshot(
      stateStorage(this.root, name => this.read(name), name => this.document(name), this.write)));
  }

  async replayTransitionTransaction<T>(operation: (transaction: ReplayTransitionTransaction) => Promise<T>): Promise<T> {
    return this.stateTransaction(() => runReplayTransitionTransaction(
      stateStorage(this.root, name => this.read(name), name => this.document(name), this.write), operation));
  }
  async resumeImport(metadata: Value, filename: string, content: Buffer, preserveFilename: boolean): Promise<Document> {
    return new ResumeService(this).import(metadata, filename, content, preserveFilename);
  }

  async resumeSummaries(): Promise<Value[]> {
    // Reuse the lock and all root checks for projections too.
    return this.transaction(() => nativeResumeSummaries(() => this.document('resumes')));
  }
}
export { serialize };
