import { AnswerMergeService } from './answer-merges.js';
import { AnswersService } from './answers.js';
import type { AnswerQuery, AnswerRepository } from './answers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { get, has, int, keys, object, parse, serialize, string, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';

const response = (value: Value) => ({ status: 200, body: serialize(value) });
function fields(payload: Document, allowed: string[], required: string[] = []): void {
  if (keys(payload).some(key => !allowed.includes(key)) || required.some(key => !has(payload, key))) throw new JobsError('answer body contains unsupported or missing fields');
}
function consent(payload: Document): boolean {
  const value = has(payload, 'rememberSensitive') ? get(payload, 'rememberSensitive') : false;
  if (typeof value !== 'boolean') throw new JobsError('rememberSensitive must be a boolean');
  return value;
}
function revision(payload: Document): bigint {
  const value = int(get(payload, 'expectedRevision'));
  if (value === null || value < 1n) throw new JobsError('expectedRevision must be a positive integer');
  return value;
}
function decodeKey(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new JobsError('encoded answer key is invalid');
  try {
    const result = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'base64url'));
    if (!result) throw new Error();
    return result;
  } catch { throw new JobsError('encoded answer key is invalid'); }
}
export async function answerHttp(repository: AnswerRepository, method: string, path: string, body: string): Promise<{ status: number; body: string } | null> {
  if (!path.startsWith('/api/answers')) return null;
  if (path === '/api/answers/cleanup-approve') {
    if (method !== 'POST') return null;
    const payload = object(parse(body), 'cleanup approval');
    fields(payload, ['approval', 'ownerConfirmed'], ['approval', 'ownerConfirmed']);
    if (get(payload, 'ownerConfirmed') !== true) throw new JobsError('cleanup requires an explicit owner-approved preview');
    return response(await new AnswerMergeService(repository).approve(get(payload, 'approval'), true));
  }
  const service = new AnswersService(repository);
  if (path === '/api/answers/cleanup-preview') return method === 'GET' ? response(await service.cleanupPreview()) : null;
  if (method === 'POST' && path === '/api/answers/semantic') return response(await service.semanticLookup(parse(body)));
  if (method === 'POST' && path === '/api/answers/query') {
    const payload = object(parse(body), 'body');
    fields(payload, ['query', 'state', 'reviewStatus', 'includeTrashed', 'trashedOnly', 'offset', 'limit']);
    const options: AnswerQuery = {};
    for (const field of ['query', 'state', 'reviewStatus'] as const) {
      if (!has(payload, field)) continue;
      const raw = get(payload, field), value = string(raw);
      if (value === null && (raw !== null || field === 'query')) throw new JobsError(`answer ${field} must be a string`);
      if (field === 'query') options.query = value!;
      else options[field] = value;
    }
    for (const field of ['includeTrashed', 'trashedOnly'] as const) {
      if (!has(payload, field)) continue;
      const value = get(payload, field);
      if (typeof value !== 'boolean') throw new JobsError('answer trash filters must be booleans');
      options[field] = value;
    }
    for (const field of ['offset', 'limit'] as const) {
      if (!has(payload, field)) continue;
      const value = int(get(payload, field));
      if (value === null || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new JobsError(`answer ${field} is invalid`);
      options[field] = Number(value);
    }
    return response(await service.query(options));
  }
  if (method === 'POST' && path === '/api/answers') {
    const payload = object(parse(body), 'body');
    fields(payload, ['answer', 'expectedRevision', 'rememberSensitive'], ['answer']);
    return response(await service.put(get(payload, 'answer'), consent(payload), has(payload, 'expectedRevision') ? revision(payload) : null));
  }
  if (method === 'POST' && path === '/api/answers/observe') {
    const payload = object(parse(body), 'body');
    fields(payload, ['answer'], ['answer']);
    return response(await service.observe(get(payload, 'answer')));
  }
  const match = /^\/api\/answers\/(?:by-key\/([^/]+)|([^/]+))(?:\/(reveal|accept|decline|merge))?$/.exec(path);
  if (!match) return null;
  const key = match[1] ? decodeKey(match[1]) : decodeURIComponent(match[2]!);
  if (method === 'GET' && !match[3]) {
    const answer = await service.get(key, false, true);
    if (answer === null) throw new JobsError('answer does not exist');
    return response(answer);
  }
  if (method === 'PATCH' && !match[3]) {
    const payload = object(parse(body), 'body');
    fields(payload, ['patch', 'expectedRevision', 'rememberSensitive'], ['patch', 'expectedRevision']);
    return response(await service.update(key, get(payload, 'patch'), revision(payload), consent(payload)));
  }
  if (method === 'POST' && match[3]) {
    const payload = object(parse(body), 'body');
    if (match[3] === 'merge') {
      fields(payload, ['winnerKey', 'expectedWinnerRevision', 'expectedSourceRevision'], ['winnerKey', 'expectedWinnerRevision', 'expectedSourceRevision']);
      return response(await new AnswerMergeService(repository).merge(string(get(payload, 'winnerKey'))!, key, int(get(payload, 'expectedWinnerRevision'))!, int(get(payload, 'expectedSourceRevision'))!));
    }
    if (match[3] === 'reveal') {
      fields(payload, []);
      const revealed = await service.get(key, true);
      if (revealed === null) throw new JobsError('answer does not exist');
      return response(revealed);
    }
    fields(payload, ['patch', 'expectedRevision', 'rememberSensitive'], ['expectedRevision']);
    return response(await service.update(key, has(payload, 'patch') ? get(payload, 'patch') : emptyObject(), revision(payload), consent(payload), match[3] === 'accept' ? 'accepted' : 'declined'));
  }
  return null;
}
