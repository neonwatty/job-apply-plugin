import type { ApplicationSnapshot } from './application-policy.js';
import type { Document } from './values.js';
import { get, int, object, string, JobsError } from './values.js';

type InputSnapshot = Pick<ApplicationSnapshot, 'resumes' | 'facts' | 'files'>;

export function latestRunFacts(snapshot: InputSnapshot, resumeId: string): Document | null {
  const value = snapshot.facts ? get(object(get(snapshot.facts, 'sets'), 'resume fact sets'), resumeId) : null;
  const versions = value === null ? null : get(object(value, 'resume fact set'), 'versions');
  return Array.isArray(versions) && versions.length ? object(versions[versions.length - 1]!, 'resume facts') : null;
}

/** Shared read guard for run-start execution and advisory preparation projections. */
export async function inspectRunInputs(snapshot: InputSnapshot, resumeId: string,
  expectedResume: bigint, expectedFacts: bigint): Promise<{ resume: Document; facts: Document }> {
  const value = get(object(get(snapshot.resumes, 'resumes'), 'resumes'), resumeId);
  if (value === null) throw new JobsError('resume does not exist');
  const resume = object(value, 'resume');
  if (get(resume, 'deletedAt') !== null || string(get(resume, 'storageKind')) !== 'managed'
    || int(get(resume, 'revision')) !== expectedResume) throw new JobsError('resume revision conflict');
  const observation = await snapshot.files.observation(resume);
  if (!observation.exists || observation.digest !== string(get(resume, 'digest'))) throw new JobsError('resume file changed');
  const facts = latestRunFacts(snapshot, resumeId);
  if (!facts || int(get(facts, 'revision')) !== expectedFacts || string(get(facts, 'state')) !== 'confirmed'
    || string(get(facts, 'contentRevision')) !== string(get(resume, 'contentRevision'))) {
    throw new JobsError('confirmed resume facts are unavailable or stale');
  }
  return { resume, facts };
}
