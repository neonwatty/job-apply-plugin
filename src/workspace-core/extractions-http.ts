import { ExtractionService } from './extraction.js';
import type { ExtractionRepository } from './extraction-context.js';
import { lookup, baseline, replacementScope } from '../contracts/workspace/extraction-pointers.js';
import { emptyObject } from '../contracts/workspace/jobs.js';
import { get, has, int, integer, keys, object, parse, serialize, set, string, text, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';
import type { ApiResult } from './jobs-http.js';

const response = (value: Value): ApiResult => ({ status: 200, body: serialize(value) });
const envelope = (key: string, value: Value) => set(emptyObject(), key, value);
function project(record: Document, fields: string[]): Document {
  const result = emptyObject();
  for (const field of fields) if (has(record, field)) set(result, field, get(record, field));
  return result;
}
export function publicExtractionRequest(record: Document): Document {
  return project(record, ['requestId', 'resumeId', 'revision', 'status', 'createdAt', 'updatedAt', 'closedAt', 'proposalId', 'failureReason', 'supersedesRequestId']);
}
export function publicProposalSummary(record: Document): Document {
  const result = project(record, ['id', 'resumeId', 'resumeRevision', 'profileRevision', 'resultProfileRevision', 'status', 'revision', 'createdAt', 'updatedAt', 'supersededBy', 'staleReasons']);
  for (const [field, paths] of [['autoFilledCount', 'autoFilledPaths'], ['pendingCount', 'pendingPaths']]) {
    const values = get(record, paths!);
    set(result, field!, integer(BigInt(Array.isArray(values) ? values.length : 0)));
  }
  return result;
}
function fields(payload: Document, allowed: string[], required = allowed): void {
  if (keys(payload).some(key => !allowed.includes(key)) || required.some(key => !has(payload, key))) throw new JobsError('extraction body contains unsupported or missing fields');
}
function revision(payload: Document, key: string): bigint {
  const value = int(get(payload, key));
  if (value === null || value < 1n) throw new JobsError(`${key} must be a positive integer`);
  return value;
}
async function detail(repository: ExtractionRepository, id: string): Promise<Document> {
  return repository.extractionTransaction(async transaction => {
    const service = new ExtractionService({ extractionTransaction: async operation => operation(transaction) });
    const record = await service.getProposal(id);
    if (!record) throw new JobsError('resume proposal does not exist');
    const result = publicProposalSummary(record);
    const profile = object(get(transaction.profile, 'profile'), 'profile');
    const metadata = object(get(transaction.profile, 'metadata'), 'profile metadata');
    set(result, 'candidate', get(record, 'candidate'));
    set(result, 'pendingPaths', get(record, 'pendingPaths'));
    set(result, 'liveProfileRevision', has(metadata, 'revision') ? get(metadata, 'revision') : integer(1n));
    const current = emptyObject(), replacements = emptyObject();
    for (const raw of get(record, 'pendingPaths') as Value[]) {
      const pointer = string(raw)!;
      const [exists, value] = lookup(profile, pointer);
      const entry = set(emptyObject(), 'exists', exists);
      set(entry, 'value', exists ? value : null);
      set(current, pointer, entry);
      const scope = replacementScope(baseline(profile, pointer));
      if (scope !== null) {
        const replacement = set(emptyObject(), 'path', text(scope));
        set(replacement, 'value', lookup(profile, scope)[1]);
        set(replacements, pointer, replacement);
      }
    }
    set(result, 'currentValues', current);
    set(result, 'replacementScopes', replacements);
    return result;
  });
}
export async function extractionHttp(repository: ExtractionRepository, method: string, path: string, body: string): Promise<ApiResult | null> {
  const service = new ExtractionService(repository);
  if (method === 'GET' && path === '/api/resume-extraction-requests') return response(envelope('requests', (await service.listRequests()).map(publicExtractionRequest)));
  if (method === 'GET' && path === '/api/resume-proposals') return response(envelope('proposals', (await service.listProposals()).map(publicProposalSummary)));
  if (method === 'POST' && path === '/api/resume-extraction-requests') {
    const payload = object(parse(body), 'body');
    fields(payload, ['resumeId', 'expectedResumeRevision']);
    const id = string(get(payload, 'resumeId'));
    if (id === null) throw new JobsError('resumeId must be a string');
    return response(publicExtractionRequest(await service.createRequest(id, revision(payload, 'expectedResumeRevision'))));
  }
  const request = /^\/api\/resume-extraction-requests\/([^/]+)\/(cancel|retry)$/.exec(path);
  if (method === 'POST' && request) {
    const payload = object(parse(body), 'body'), id = decodeURIComponent(request[1]!);
    fields(payload, request[2] === 'cancel' ? ['expectedRevision'] : ['expectedRevision', 'expectedResumeRevision']);
    const value = request[2] === 'cancel' ? await service.cancelRequest(id, revision(payload, 'expectedRevision'))
      : await service.retryRequest(id, revision(payload, 'expectedRevision'), revision(payload, 'expectedResumeRevision'));
    return response(publicExtractionRequest(value));
  }
  const proposal = /^\/api\/resume-proposals\/([^/]+)(?:\/(review))?$/.exec(path);
  if (method === 'GET' && proposal && !proposal[2]) return response(await detail(repository, decodeURIComponent(proposal[1]!)));
  if (method === 'POST' && proposal?.[2] === 'review') {
    const payload = object(parse(body), 'body');
    fields(payload, ['decisions', 'replacementConfirmations', 'expectedRevision', 'expectedProfileRevision'], ['decisions', 'expectedRevision', 'expectedProfileRevision']);
    const decisions = project(payload, ['decisions', 'replacementConfirmations']);
    return response(publicProposalSummary(await service.reviewProposal(decodeURIComponent(proposal[1]!), decisions, revision(payload, 'expectedRevision'), revision(payload, 'expectedProfileRevision'))));
  }
  return null;
}
