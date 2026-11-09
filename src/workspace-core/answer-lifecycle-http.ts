import { decodeAnswerKey } from '../contracts/workspace/answer-key.js';
import { PythonObject } from '../contracts/python-object.js';
import { fromJSON, get, int, integer, keys, object, parse, serialize, set, JobsError } from '../contracts/workspace/values.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import type { AnswerRepository } from './answers.js';
import { AnswerLifecycleError, AnswerLifecycleService } from './answer-lifecycle.js';

type Result = {status: number; body: string};
const failure = (status: number, code: string, message: string): Result => ({
  status, body: serialize(fromJSON({error: {code, message}})),
});
function lifecycleFailure(error: JobsError, operation: string): Result {
  const rules: [string, string, string][] = [
    ['revision conflict', 'revision_conflict', 'This record changed elsewhere. Refresh and review the latest revision.'],
    ['does not exist', 'not_found', 'This record no longer exists.'],
    ['referenced by an active session', 'session_reference_blocked', 'This answer is referenced by an active session and cannot be permanently deleted.'],
    ['referenced by application history', 'history_reference_blocked', 'This answer is referenced by protected application history and cannot be permanently deleted.'],
    ['answer is the target of an immutable redirect', 'redirect_target_blocked', 'This answer is a canonical redirect target and cannot be moved or deleted.'],
  ];
  const [, code, message] = rules.find(([fragment]) => error.message.includes(fragment))
    ?? ['', 'store_rejected', 'The canonical store rejected this lifecycle operation.'];
  const counts = emptyObject();
  if (error instanceof AnswerLifecycleError) {
    set(counts, 'sessions', integer(error.counts.sessions));
    set(counts, 'history', integer(error.counts.history));
  }
  const detail = object(fromJSON({code, message, recordType:'answer', operation}), 'lifecycle error');
  set(detail, 'counts', counts);
  return {status: code === 'not_found' ? 404 : code === 'store_rejected' ? 400 : 409,
    body: serialize(set(emptyObject(), 'error', detail))};
}
export async function answerLifecycleHttp(repository: AnswerRepository, method: string, path: string, body: string): Promise<Result | null> {
  const match = /^\/api\/answers\/(?:by-key\/([^/]+)|([^/]+))\/(trash|restore|delete)$/.exec(path);
  if (method !== 'POST' || !match) return null;
  const operation = match[3] as 'trash' | 'restore' | 'delete';
  let payload;
  try { payload = parse(body); }
  catch { return failure(400, 'request_error', 'request body must be valid JSON'); }
  if (!(payload instanceof PythonObject)) return failure(400, 'request_error', 'request body must be a JSON object');
  let key: string;
  try { key = match[1] ? decodeAnswerKey(match[1]) : decodeURIComponent(match[2]!); }
  catch { return failure(400, 'request_error', 'encoded answer key is invalid'); }
  if (keys(payload).length !== 1 || keys(payload)[0] !== 'expectedRevision') return failure(400, 'request_error', `${operation} body requires expectedRevision`);
  const revision = int(get(payload, 'expectedRevision'));
  if (revision === null || revision < 1n) return failure(400, 'request_error', 'expectedRevision must be a positive integer');
  try {
    const result = await new AnswerLifecycleService(repository)[operation](key, revision);
    return {status:200, body:serialize(result)};
  } catch (error) {
    if (error instanceof JobsError) return lifecycleFailure(error, operation);
    if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z]+$/.test(error.code)) {
      return failure(500, 'storage_error', 'storage operation failed');
    }
    throw error;
  }
}
