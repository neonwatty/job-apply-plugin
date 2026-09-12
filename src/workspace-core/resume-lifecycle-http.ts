import { PythonObject } from '../contracts/python-object.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { fromJSON, get, int, integer, keys, object, parse, serialize, set, JobsError } from '../contracts/workspace/values.js';
import { publicResume } from './resumes-http.js';
import { ResumeLifecycleError, ResumeLifecycleService } from './resume-lifecycle.js';
import type { ResumeLifecycleRepository } from './resume-lifecycle.js';

type Result = {status: number; body: string};
const failure = (status: number, code: string, message: string): Result => ({
  status, body: serialize(fromJSON({error: {code, message}})),
});
function lifecycleFailure(error: JobsError, operation: string): Result {
  const rules: [string, string, string][] = [
    ['revision conflict', 'revision_conflict', 'This record changed elsewhere. Refresh and review the latest revision.'],
    ['does not exist', 'not_found', 'This record no longer exists.'],
    ['still referenced by a job', 'job_reference_blocked', 'This resume is referenced by one or more jobs. Reassign or delete those jobs first.'],
    ['assigned to an active job', 'job_reference_blocked', 'This resume is assigned to an active job. Reassign that job first.'],
    ['default resume is used by an active job', 'default_reference_blocked', 'This default resume is in use by active jobs. Assign another default first.'],
    ['active resume file already exists', 'duplicate_active_blocked', 'An active resume with the same canonical file identity already exists.'],
  ];
  const [, code, message] = rules.find(([fragment]) => error.message.includes(fragment))
    ?? ['', 'store_rejected', 'The canonical store rejected this lifecycle operation.'];
  const counts = emptyObject();
  if (error instanceof ResumeLifecycleError) set(counts, 'jobReferences', integer(error.jobReferences));
  else if (code === 'duplicate_active_blocked') set(counts, 'duplicateActiveRecords', integer(1n));
  const detail = object(fromJSON({code, message, recordType:'resume', operation}), 'lifecycle error');
  set(detail, 'counts', counts);
  return {status: code === 'not_found' ? 404 : code === 'store_rejected' ? 400 : 409,
    body: serialize(set(emptyObject(), 'error', detail))};
}

export async function resumeLifecycleHttp(repository: ResumeLifecycleRepository,
  method: string, path: string, body: string): Promise<Result | null> {
  const match = /^\/api\/resumes\/([^/]+)\/(trash|restore|delete)$/.exec(path);
  if (method !== 'POST' || !match) return null;
  const operation = match[2] as 'trash' | 'restore' | 'delete';
  let payload;
  try { payload = parse(body); }
  catch { return failure(400, 'request_error', 'request body must be valid JSON'); }
  if (!(payload instanceof PythonObject)) return failure(400, 'request_error', 'request body must be a JSON object');
  if (keys(payload).length !== 1 || keys(payload)[0] !== 'expectedRevision') {
    return failure(400, 'request_error', `${operation} body requires expectedRevision`);
  }
  const revision = int(get(payload, 'expectedRevision'));
  if (revision === null || revision < 1n) return failure(400, 'request_error', 'expectedRevision must be a positive integer');
  try {
    const result = await new ResumeLifecycleService(repository)[operation](decodeURIComponent(match[1]!), revision);
    return {status: 200, body: serialize(publicResume(result))};
  } catch (error) {
    if (error instanceof URIError) return failure(400, 'request_error', 'encoded resume id is invalid');
    if (error instanceof JobsError) return lifecycleFailure(error, operation);
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
      return failure(500, 'storage_error', 'storage operation failed');
    }
    throw error;
  }
}
