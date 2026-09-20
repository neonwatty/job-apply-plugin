import { emptyObject } from '../contracts/workspace/jobs.js';
import { get, int, keys, object, same, set, string, text, integer, truth } from '../contracts/workspace/values.js';
import type { Document } from '../contracts/workspace/values.js';
import type { NativeResumeFiles } from '../store/native-resume-files.js';

/** Inspect documents already held by the caller's transaction, without acquiring another lock. */
export async function preflightJobRecord(job: Document, profileDocument: Document,
  resumesDocument: Document, files: NativeResumeFiles, factsDocument?: Document, requestsDocument?: Document): Promise<Document> {
  const errors: string[] = [], warnings: string[] = [];
  const profile = object(get(profileDocument, 'profile'), 'profile.profile');
  const resumes = object(get(resumesDocument, 'resumes'), 'resumes.resumes');
  let resumeId = get(job, 'resumeId');
  if (resumeId === null) {
    const defaultResume = resumes.entries().map(([, item]) => object(item, 'resume record'))
      .find(item => get(item, 'deletedAt') === null && truth(get(item, 'default')));
    resumeId = defaultResume ? get(defaultResume, 'id') : null;
  }
  const value = resumeId === null ? null : get(resumes, string(resumeId)!);
  const resume = value === null ? null : object(value, 'resume record');
  const scoped = factsDocument && resumeId !== null
    ? get(object(get(factsDocument, 'sets'), 'resume fact sets'), string(resumeId)!) : null;
  const scopedRequest = requestsDocument && resumeId !== null && object(get(requestsDocument, 'requests'), 'requests')
    .entries().some(([, item]) => string(get(object(item, 'request'), 'resumeId')) === string(resumeId)
      && string(get(object(item, 'request'), 'scope')) === 'resume');
  if (scoped !== null && scoped !== undefined) {
    const versions = get(object(scoped, 'resume fact set'), 'versions');
    const latest = Array.isArray(versions) && versions.length ? object(versions[versions.length - 1]!, 'resume facts') : null;
    const selectionValue = get(job, 'inputSelection');
    const selection = selectionValue === null ? null : object(selectionValue, 'job input selection');
    if (!selection || !latest || string(get(selection, 'resumeId')) !== string(resumeId)
      || string(get(job, 'resumeId')) !== string(resumeId) || int(get(selection, 'jobRevision')) !== int(get(job, 'revision'))
      || int(get(selection, 'factRevision')) !== int(get(latest, 'revision'))
      || string(get(latest, 'state')) !== 'confirmed'
      || string(get(selection, 'contentRevision')) !== string(get(latest, 'contentRevision'))
      || resume === null || string(get(latest, 'contentRevision')) !== string(get(resume, 'contentRevision'))) errors.push('resume_facts_unconfirmed');
  }
  else if (scopedRequest) errors.push('resume_facts_unconfirmed');
  if (!keys(profile).some(key => key !== 'preferences') && !scopedRequest && (scoped === null || scoped === undefined)) errors.push('profile_empty');
  if (resume === null || get(resume, 'deletedAt') !== null) errors.push('resume_missing');
  else {
    const managed = string(get(resume, 'storageKind')) === 'managed';
    const observation = managed ? await files.observation(resume)
      : await files.externalObservation(string(get(resume, 'path'))!);
    if (!observation.exists) errors.push('resume_file_missing');
    else if (!same(observation.size === null ? null : integer(BigInt(observation.size)), get(resume, 'observedSize'))
      || observation.modifiedAt !== string(get(resume, 'observedModifiedAt'))
      || managed && observation.digest !== string(get(resume, 'digest'))) {
      (managed ? errors : warnings).push('resume_file_changed');
    }
  }
  if (!truth(get(job, 'role'))) warnings.push('role_missing');
  if (!truth(get(job, 'company'))) warnings.push('company_missing');
  const result = emptyObject();
  set(result, 'id', get(job, 'id'));
  set(result, 'revision', get(job, 'revision'));
  set(result, 'ready', errors.length === 0);
  set(result, 'resumeId', resumeId);
  set(result, 'errors', errors.map(text));
  set(result, 'warnings', warnings.map(text));
  return result;
}
