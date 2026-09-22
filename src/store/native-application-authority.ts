import { applicationOrigin, initialApplicationAuthorityDocument, validateApplicationAuthorityDocument } from '../contracts/workspace/application-authority.js';
import { validateAnswers } from '../contracts/workspace/answers.js';
import { validateCoordinator } from '../contracts/workspace/claims.js';
import { validateExtractionRequests } from '../contracts/workspace/extraction-requests.js';
import { validateJobsDocument } from '../contracts/workspace/jobs.js';
import { validateProfile } from '../contracts/workspace/profile.js';
import { validateResumeFacts } from '../contracts/workspace/resume-facts.js';
import { get, int, keys, object, set, string } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { ApplicationAuthorityTransaction } from '../workspace-core/application-authority.js';
import { validateExtractionResumes } from './native-extraction-journal.js';
import { NativeResumeFiles } from './native-resume-files.js';

export interface NativeApplicationAuthorityAccess {
  root: string;
  document(name: string): Promise<Document>;
  journal(name: string): Promise<Document>;
  facts(): Promise<Document>;
  save(document: Document): Promise<void>;
  now(): string;
}

const exact = (value: Document, fields: string[]): boolean =>
  value.size === fields.length && keys(value).every(key => fields.includes(key));
const stringList = (value: Value): boolean => Array.isArray(value)
  && value.every(item => Boolean(string(item))) && new Set(value.map(string)).size === value.length;

// A short-lived Python branch wrote this v1 shape before the TypeScript cutover.
// It granted broad worker/category authority, so compatibility intentionally
// projects it to Guided and only carries its document revision forward.
function guidedFromLegacyAuthority(value: Document, now: string): Document | null {
  if (!exact(value, ['schemaVersion', 'activeAuthorityId', 'authorities', 'metadata']) || int(get(value, 'schemaVersion')) !== 1n) return null;
  try {
    const authorities = object(get(value, 'authorities'), 'legacy authorities');
    for (const [key, raw] of authorities.entries()) {
      const record = object(raw, 'legacy authority');
      if (!exact(record, ['authorizationId','mode','status','revision','issuedAt','expiresAt','revokedAt',
        'jobBindings','workerIds','sensitiveFieldClasses']) || string(key) !== string(get(record, 'authorizationId'))
        || !['fill_to_review','campaign'].includes(string(get(record, 'mode')) ?? '')
        || !['active','revoked','replaced','consumed'].includes(string(get(record, 'status')) ?? '')
        || int(get(record, 'revision')) === null || int(get(record, 'revision'))! < 1n
        || !string(get(record, 'issuedAt')) || !string(get(record, 'expiresAt'))
        || !stringList(get(record, 'workerIds')) || !stringList(get(record, 'sensitiveFieldClasses'))) return null;
      const bindings = get(record, 'jobBindings');
      if (!Array.isArray(bindings) || bindings.length === 0 || !bindings.every(item => {
        const binding = object(item, 'legacy authority binding');
        return exact(binding, ['jobId','approvedJobRevision','destinationOrigin','resumeId','resumeRevision'])
          && Boolean(string(get(binding, 'jobId'))) && Boolean(string(get(binding, 'resumeId')))
          && int(get(binding, 'approvedJobRevision')) !== null && int(get(binding, 'approvedJobRevision'))! > 0n
          && int(get(binding, 'resumeRevision')) !== null && int(get(binding, 'resumeRevision'))! > 0n
          && applicationOrigin(get(binding, 'destinationOrigin')) === string(get(binding, 'destinationOrigin'));
      })) return null;
    }
    const active = string(get(value, 'activeAuthorityId'));
    if (get(value, 'activeAuthorityId') !== null && (!active || get(authorities, active) === null
      || string(get(object(get(authorities, active), 'legacy active authority'), 'status')) !== 'active')) return null;
    const metadata = object(get(value, 'metadata'), 'legacy authority metadata'), revision = int(get(metadata, 'revision'));
    if (!exact(metadata, ['revision','createdAt','updatedAt']) || revision === null || revision < 0n
      || !string(get(metadata, 'createdAt')) || !string(get(metadata, 'updatedAt'))) return null;
    const guided = initialApplicationAuthorityDocument(now), next = object(get(guided, 'metadata'), 'authority metadata');
    set(next, 'revision', get(metadata, 'revision')); set(next, 'createdAt', get(metadata, 'createdAt'));
    set(next, 'updatedAt', get(metadata, 'updatedAt')); return guided;
  } catch { return null; }
}

export async function loadApplicationAuthority(
  read: (name: string) => Promise<Document>, now: () => string): Promise<Document> {
  try {
    const value = await read('application-authority');
    try { return validateApplicationAuthorityDocument(value); }
    catch (error) {
      const legacy = guidedFromLegacyAuthority(value, now());
      if (legacy !== null) return legacy;
      throw error;
    }
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return initialApplicationAuthorityDocument(now());
  }
}

export async function applicationAuthorityTransaction<T>(access: NativeApplicationAuthorityAccess,
  operation: (transaction: ApplicationAuthorityTransaction) => Promise<T>): Promise<T> {
  const authority = await loadApplicationAuthority(access.document, access.now);
  return operation({ authority, jobs: validateJobsDocument(await access.document('jobs')),
    coordinator: validateCoordinator(await access.journal('coordinator')), profile: validateProfile(await access.document('profile')),
    resumes: validateExtractionResumes(await access.document('resumes')), facts: validateResumeFacts(await access.facts()),
    requests: validateExtractionRequests(await access.document('resume-extraction-requests')),
    answers: validateAnswers(await access.document('answers')), files: new NativeResumeFiles(access.root),
    saveAuthority: document => access.save(validateApplicationAuthorityDocument(document)) });
}
