import { fallback } from '../contracts/workspace/answers.js';
import { canonicalJson } from '../contracts/workspace/canonical-json.js';
import { fields, requireCondition as check } from '../contracts/workspace/answer-session-fields.js';
import { projectStoredAnswerSession, safeAnswerSessionId, validateAnswerSession } from '../contracts/workspace/answer-session-validation.js';
import { buildClaimPending, claimSessionObject, currentClaimApprovals } from '../contracts/workspace/claim-session-pending.js';
import { copy, fromJSON, get, has, int, object, parse, same, serialize, set, string, text, truth, JobsError } from '../contracts/workspace/values.js';
import type { Document, Value } from '../contracts/workspace/values.js';

type CanonicalJob = { status: string; deletedAt: string | null; ats?: string | null };
export interface SessionTransaction {
  load(id: string): Promise<Value | null>;
  list(): Promise<Array<[string, Value]>>;
  save(id: string, document: Document): Promise<void>;
  delete(id: string): Promise<boolean>;
  canonicalJob(id: string): Promise<CanonicalJob | null>;
  answers(): Promise<Document>;
  recomputeReadiness(input: Value, attemptRevision: bigint, ats?: string | null): Promise<Value>;
}
export interface SessionRepository {
  sessionTransaction<T>(operation: (transaction: SessionTransaction) => Promise<T>): Promise<T>;
}

const inputFields = ['applicationId', 'status', 'ats', 'company', 'role', 'url', 'step', 'answerKeys',
  'pendingFields', 'createdAt', 'updatedAt', 'attemptRevision', 'readinessInput', 'blockers', 'browserHandoff'];
const agentTypes: Record<string, string> = {
  'login-required': 'browser_handoff', 'captcha-required': 'browser_handoff',
  'mfa-required': 'browser_handoff', 'email-verification-required': 'browser_handoff',
  'account-creation-required': 'browser_handoff', 'unsupported-control': 'browser_handoff',
  'browser-state-uncertain': 'browser_handoff', 'consent-required': 'owner_review',
  'owner-input-required': 'information',
};
const clone = (value: Value): Value => parse(serialize(value));

function jobAllowsMutation(job: CanonicalJob | null, deleting = false): boolean {
  return job === null || job.deletedAt !== null || deleting && ['applied', 'closed'].includes(job.status);
}
function blockerType(code: string): string {
  if (code.includes('upload')) return 'upload';
  if (code.includes('validation')) return 'validation';
  if (code.includes('final')) return 'final_action';
  if (code.includes('inaccessible') || code === 'owner-upload-required') return 'browser_handoff';
  return 'readiness';
}
export class SessionService {
  constructor(readonly repository: SessionRepository,
    private readonly now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')) {}

  save(id: string, value: Value): Promise<Document> {
    id = safeAnswerSessionId(text(id)); const incoming = object(value, 'session input');
    check(fields(incoming, inputFields), 'session contains unsupported fields');
    check(!has(incoming, 'applicationId') || string(get(incoming, 'applicationId')) === id,
      'session application id does not match path');
    const status = fallback(incoming, 'status', text('active'));
    check(['active', 'review', 'completed', 'abandoned'].includes(string(status) ?? ''), 'session status is unsupported');
    const answerKeys = fallback(incoming, 'answerKeys', []);
    check(Array.isArray(answerKeys) && answerKeys.every(item => string(item) !== null), 'session answerKeys must be strings');
    return this.repository.sessionTransaction(async transaction => {
      if (!jobAllowsMutation(await transaction.canonicalJob(id))) throw new JobsError('canonical job sessions require a coordinator operation');
      const stored = await transaction.load(id), existing = stored === null ? null : projectStoredAnswerSession(stored, id);
      const answers = await transaction.answers(), timestamp = this.now();
      const atsPresent = has(incoming, 'ats') || existing !== null && has(existing, 'ats');
      const ats = has(incoming, 'ats') ? get(incoming, 'ats')
        : existing !== null && has(existing, 'ats') ? get(existing, 'ats') : null;
      const pending = buildClaimPending(incoming, existing, ats, answers);
      const attempt = fallback(incoming, 'attemptRevision', null);
      let readiness: Value = null;
      if (has(incoming, 'readinessInput')) {
        const revision = int(attempt);
        if (revision === null) throw new JobsError('readiness requires a current attempt revision');
        readiness = await transaction.recomputeReadiness(get(incoming, 'readinessInput'), revision, string(ats));
      } else if (existing !== null && same(get(existing, 'attemptRevision'), attempt)) readiness = clone(get(existing, 'readiness'));
      const blockers: Document[] = pending.map(field => {
        const sensitive = get(field, 'sensitive') === true || string(get(field, 'state')) === 'sensitive';
        const blocker = object(fromJSON({ type: 'information', code: sensitive ? 'sensitive-answer-required' : 'answer-required',
          reference: string(get(field, 'reference')), sensitivity: sensitive ? 'high' : 'none' }), 'session blocker');
        if (has(field, 'fieldClass')) set(blocker, 'fieldClass', get(field, 'fieldClass'));
        return blocker;
      });
      if (readiness !== null) {
        const report = object(readiness, 'session readiness'), codes = get(report, 'blockerCodes');
        check(Array.isArray(codes), 'session readiness blockers are invalid');
        for (const item of codes as Value[]) blockers.push(object(fromJSON({ type: blockerType(string(item)!), code: string(item) }), 'session blocker'));
        if (get(report, 'fallbackCode') !== null) blockers.push(object(fromJSON({ type: 'browser_handoff', code: string(get(report, 'fallbackCode')) }), 'session blocker'));
      }
      const supplied = fallback(incoming, 'blockers', []);
      check(Array.isArray(supplied), 'session blockers must be a list');
      for (const item of supplied as Value[]) {
        const blocker = claimSessionObject(item, 'session blocker');
        check(fields(blocker, ['type', 'code'], true), 'agent blockers must contain only closed type and code');
        const code = string(get(blocker, 'code'));
        check(code !== null && agentTypes[code] === string(get(blocker, 'type')), 'session blocker is invalid');
        blockers.push(object(clone(blocker), 'session blocker'));
      }
      const unique = [...new Map(blockers.map(item => [canonicalJson(item), item])).values()];
      const browser = unique.find(item => string(get(item, 'type')) === 'browser_handoff');
      let handoff = get(incoming, 'browserHandoff');
      if (handoff === null) {
        const fallbackCode = readiness === null ? null : get(object(readiness, 'session readiness'), 'fallbackCode');
        const reason = fallbackCode !== null ? string(fallbackCode) : browser ? string(get(browser, 'code')) : null;
        handoff = fromJSON({ state: reason !== null ? 'required' : string(status) === 'review' ? 'ready_for_owner' : 'not_required',
          reasonCode: reason ?? (string(status) === 'review' ? 'final-review-required' : 'none'), revision: 1 });
      } else handoff = clone(handoff);
      check(browser === undefined || string(get(object(handoff, 'browser handoff'), 'state')) === 'required',
        'browser handoff contradicts browser blockers');
      const result = object(fromJSON({ schemaVersion: 1, applicationId: id, status: string(status), answerKeys: [],
        pendingFields: [], attemptRevision: null, readiness: null, blockers: [], approvals: [],
        browserHandoff: null, createdAt: timestamp, updatedAt: timestamp }), 'session');
      for (const key of ['status', 'step']) if (has(incoming, key)) set(result, key, clone(get(incoming, key)));
      if (atsPresent) set(result, 'ats', clone(ats));
      set(result, 'status', status); set(result, 'answerKeys', clone(answerKeys)); set(result, 'pendingFields', pending);
      set(result, 'attemptRevision', attempt); set(result, 'readiness', readiness); set(result, 'blockers', unique);
      set(result, 'browserHandoff', handoff);
      set(result, 'approvals', currentClaimApprovals(existing, pending, answers, attempt));
      const created = get(incoming, 'createdAt');
      if (truth(created)) set(result, 'createdAt', created);
      else if (existing !== null && truth(get(existing, 'createdAt'))) set(result, 'createdAt', get(existing, 'createdAt'));
      validateAnswerSession(result); await transaction.save(id, result); return copy(result);
    });
  }

  load(id: string): Promise<Document> {
    id = safeAnswerSessionId(text(id));
    return this.repository.sessionTransaction(async transaction => {
      const raw = await transaction.load(id);
      if (raw === null) throw new JobsError('session does not exist');
      return projectStoredAnswerSession(raw, id, (await transaction.canonicalJob(id))?.ats);
    });
  }
  list(): Promise<Value[]> {
    return this.repository.sessionTransaction(async transaction => {
      const records = await transaction.list(), result: Value[] = [];
      for (const [id, raw] of records.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
        result.push(projectStoredAnswerSession(raw, id, (await transaction.canonicalJob(id))?.ats));
      }
      return result;
    });
  }
  delete(id: string): Promise<Document> {
    id = safeAnswerSessionId(text(id));
    return this.repository.sessionTransaction(async transaction => {
      if (!jobAllowsMutation(await transaction.canonicalJob(id), true)) throw new JobsError('canonical job sessions require a coordinator operation');
      return object(fromJSON({ deleted: await transaction.delete(id), applicationId: id }), 'session deletion');
    });
  }
}
