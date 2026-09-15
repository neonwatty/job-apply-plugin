import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { parsePythonPointJsonBytes } from '../contracts/raw-json/point-parser.js';
import { validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { validateAnswers } from '../contracts/workspace/answers.js';
import { canonicalClaimAnswer } from '../contracts/workspace/claim-session-pending.js';
import { recomputeClaimReadiness } from '../contracts/workspace/claim-session-readiness.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { validateExtractions } from '../contracts/workspace/extraction-proposals.js';
import { validateJobsDocument, safeId } from '../contracts/workspace/jobs.js';
import { validateProfile } from '../contracts/workspace/profile.js';
import { fromJSON, get, integer, object, string, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { PreparednessSnapshot } from '../workspace-core/profile-preparedness.js';
import type { HistoryTransaction } from '../workspace-core/store-history.js';
import type { SessionTransaction } from '../workspace-core/store-sessions.js';
import { NativeClaimHistory } from './native-claim-history.js';
import { validateExtractionResumes } from './native-extraction-journal.js';
import { NativeResumeFiles } from './native-resume-files.js';
import { atomicWritePointJson } from './point-persistence.js';

const pointOptions = { pathProfile: '3.12', intMaxStrDigits: 4300 } as const;
export interface NativeStoreStateStorage {
  root: string;
  read(name: string): Promise<Buffer>;
  document(name: string): Promise<Document>;
  write(path: string, document: Document): Promise<void>;
}

export async function runHistoryTransaction<T>(storage: NativeStoreStateStorage,
  operation: (transaction: HistoryTransaction) => Promise<T>): Promise<T> {
  const history = new NativeClaimHistory(storage.root), answers = validateAnswers(await storage.document('answers'));
  const records = object(get(answers, 'answers'), 'answers.answers');
  return operation({
    read: () => history.read(),
    answerExists: async key => {
      const value = get(records, canonicalClaimAnswer(answers, key));
      return value !== null && get(object(value, 'answer'), 'deletedAt') === null;
    },
    append: event => history.append(event),
  });
}

export async function runSessionTransaction<T>(storage: NativeStoreStateStorage,
  operation: (transaction: SessionTransaction) => Promise<T>): Promise<T> {
  const directory = join(storage.root, 'sessions'), metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || metadata.uid !== process.getuid?.() || metadata.mode & 0o077) {
    throw new JobsError('native sessions directory must be private and owned');
  }
  const load = async (id: string): Promise<Value | null> => {
    safeId(id);
    try {
      return object(parsePythonPointJsonBytes(await storage.read(`sessions/${id}.json`), {
        diagnosticProfile: '3.12', intMaxStrDigits: 4300,
      }), 'session');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };
  const jobs = validateJobsDocument(await storage.document('jobs'));
  return operation({
    load,
    list: async () => {
      const result: Array<[string, Value]> = [];
      for (const name of (await readdir(directory)).sort()) {
        if (!name.endsWith('.json')) continue;
        const id = safeId(name.slice(0, -5)), value = await load(id);
        if (value !== null) result.push([id, value]);
      }
      return result;
    },
    save: async (id, document) => {
      validateAnswerSession(document);
      await storage.write(join(directory, `${safeId(id)}.json`), document);
    },
    delete: async id => {
      try { await unlink(join(directory, `${safeId(id)}.json`)); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
    },
    canonicalJob: async id => {
      const value = get(object(get(jobs, 'jobs'), 'jobs.jobs'), safeId(id));
      if (value === null) return null;
      const record = object(value, 'job'), ats = get(record, 'ats');
      return { status: string(get(record, 'status'))!, deletedAt: string(get(record, 'deletedAt')),
        ...(ats === null || string(ats) !== null ? { ats: string(ats) } : {}) };
    },
    answers: () => storage.document('answers').then(validateAnswers),
    recomputeReadiness: async (input, attemptRevision, ats = null) =>
      recomputeClaimReadiness(input, integer(attemptRevision), ats === null ? null : fromJSON(ats)),
  });
}

export async function preparednessSnapshot(storage: NativeStoreStateStorage): Promise<PreparednessSnapshot> {
  const profile = validateProfile(await storage.document('profile'));
  const resumesDocument = validateExtractionResumes(await storage.document('resumes'));
  const requestsDocument = validateExtractionRequests(await storage.document('resume-extraction-requests'));
  const proposalsDocument = validateExtractions(await storage.document('resume-extractions'));
  const resumeRecords = new Map<string, Document>();
  const resumes = object(get(resumesDocument, 'resumes'), 'resumes.resumes').entries().map(([key, value]) => {
    const record = object(value, 'resume record'), id = safeId(string(key)); resumeRecords.set(id, record);
    const digest = get(record, 'digest');
    return { id, default: get(record, 'default') === true, deletedAt: string(get(record, 'deletedAt')),
      storageKind: string(get(record, 'storageKind'))!,
      ...(digest === null || string(digest) !== null ? { digest: string(digest) } : {}) };
  });
  const requests = object(get(requestsDocument, 'requests'), 'resume extraction requests').entries().map(([, value]) => {
    const record = object(value, 'resume extraction request'), failure = string(get(record, 'failureReason'));
    return { status: string(get(record, 'status'))!, resumeId: string(get(record, 'resumeId'))!,
      requestId: string(get(record, 'requestId'))!, ...(failure === null ? {} : { failureReason: failure }) };
  });
  const proposals = object(get(proposalsDocument, 'proposals'), 'resume extraction proposals').entries().map(([, value]) => {
    const record = object(value, 'resume extraction proposal');
    return { status: string(get(record, 'status'))!, resumeId: string(get(record, 'resumeId'))!, id: string(get(record, 'id'))!,
      pendingPaths: (get(record, 'pendingPaths') as Value[]).map(item => string(item)!) };
  });
  const metadata = object(get(profile, 'metadata'), 'profile.metadata');
  return { profile: get(profile, 'profile'), provenance: get(metadata, 'factProvenance'), resumes, requests, proposals,
    observeResume: async record => {
      const source = resumeRecords.get(record.id);
      if (!source) throw new JobsError('resume does not exist');
      const observed = await new NativeResumeFiles(storage.root).observation(source);
      return { exists: observed.exists, digest: observed.digest };
    } };
}

export function stateStorage(root: string, read: (name: string) => Promise<Buffer>,
  document: (name: string) => Promise<Document>, write = atomicWritePointJson): NativeStoreStateStorage {
  return { root, read, document, write: (path, value) => write(path, value, pointOptions) };
}
