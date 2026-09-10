import { fallback } from './answers.js';
import { canonicalJson } from './canonical-json.js';
import { safeAnswerSessionId, validateAnswerSession } from './answer-session-validation.js';
import { agentCodes, fields, member, requireCondition as check } from './answer-session-fields.js';
import { buildClaimPending, currentClaimApprovals, claimSessionObject } from './claim-session-pending.js';
import { recomputeClaimReadiness } from './claim-session-readiness.js';
import { get, has, object, parse, same, serialize, set, string, text, truth, fromJSON } from './values.js';
import type { Document, Value } from './values.js';

export interface ClaimSessionContext { now:string; attemptRevision:Value; ats:Value; existing:Document|null; answers:Document }
const clone = (value: Value): Value => parse(serialize(value));
function blockerType(code: string): string {
  if (code.includes('upload')) return 'upload';
  if (code.includes('validation')) return 'validation';
  if (code.includes('final')) return 'final_action';
  if (code.includes('inaccessible') || code === 'owner-upload-required') return 'browser_handoff';
  return 'readiness';
}
const agentTypes: Record<string,string> = Object.fromEntries(agentCodes.map(code => [code,code === 'consent-required' ? 'owner_review':code === 'owner-input-required' ? 'information':'browser_handoff']));
export function buildClaimSession(applicationId: string, incoming: Document, context: ClaimSessionContext): Document {
  check(fields(incoming,['applicationId','status','ats','company','role','url','step','answerKeys','pendingFields','createdAt','updatedAt','attemptRevision','readinessInput','blockers','browserHandoff']), 'session contains unsupported fields');
  safeAnswerSessionId(text(applicationId));
  check(same(fallback(incoming,'applicationId',text(applicationId)),text(applicationId)), 'session application id does not match path');
  const attempt = fallback(incoming,'attemptRevision',context.attemptRevision);
  check(context.attemptRevision === null || same(attempt,context.attemptRevision), 'session is not bound to the current attempt');
  const status = fallback(incoming,'status',text('active'));
  check(member(status,['active','review','completed','abandoned']), 'session status is unsupported');
  const answerKeys = fallback(incoming,'answerKeys',[]);
  check(Array.isArray(answerKeys) && answerKeys.every(item => string(item) !== null), 'session answerKeys must be strings');
  const existing = context.existing;
  if (existing) {
    validateAnswerSession(existing);
    check(string(get(existing,'applicationId')) === applicationId,'session application id does not match path');
  }
  const pending = buildClaimPending(incoming,existing,context.ats,context.answers);
  let readiness: Value = null;
  if (has(incoming,'readinessInput')) {
    check(attempt !== null,'readiness requires a current attempt revision');
    readiness = recomputeClaimReadiness(get(incoming,'readinessInput'),attempt,context.ats);
  } else if (existing !== null && same(get(existing,'attemptRevision'),attempt)) readiness = clone(get(existing,'readiness'));
  const blockers: Document[] = pending.map(field => {
    const sensitive = get(field,'sensitive') === true || string(get(field,'state')) === 'sensitive';
    const result = object(fromJSON({type:'information',code:sensitive ? 'sensitive-answer-required':'answer-required',sensitivity:sensitive ? 'high':'none'}),'blocker');
    set(result,'reference',get(field,'reference'));
    if (has(field,'fieldClass')) set(result,'fieldClass',get(field,'fieldClass'));
    return result;
  });
  if (readiness !== null) {
    const report = object(readiness,'readiness');
    for (const code of get(report,'blockerCodes') as Value[]) blockers.push(object(fromJSON({type:blockerType(string(code)!),code:string(code)}),'blocker'));
    if (get(report,'fallbackCode') !== null) blockers.push(object(fromJSON({type:'browser_handoff',code:string(get(report,'fallbackCode'))}),'blocker'));
  }
  const supplied = fallback(incoming,'blockers',[]);
  check(Array.isArray(supplied),'session blockers must be a list');
  for (const item of supplied as Value[]) {
    const blocker = claimSessionObject(item,'session blocker');
    check(fields(blocker,['type','code'],true),'agent blockers must contain only closed type and code');
    const code = string(get(blocker,'code'));
    check(code !== null && Object.hasOwn(agentTypes,code) && string(get(blocker,'type')) === agentTypes[code],'session blocker is invalid');
    blockers.push(object(clone(blocker),'blocker'));
  }
  const unique = [...new Map(blockers.map(item => [canonicalJson(item),item])).values()];
  const browserReasons = [...agentCodes,'none','owner-upload-required','final-review-required','form-observation-inaccessible','required-control-inaccessible'];
  const browserBlockers = unique.filter(item => string(get(item,'type')) === 'browser_handoff' && browserReasons.includes(string(get(item,'code'))!));
  let handoff = get(incoming,'browserHandoff');
  if (handoff === null) {
    const fallbackCode = readiness === null ? null : get(object(readiness,'readiness'),'fallbackCode');
    const reason = fallbackCode !== null ? string(fallbackCode) : browserBlockers.length ? string(get(browserBlockers[0]!,'code')) : null;
    handoff = fromJSON({state:reason !== null ? 'required':string(status) === 'review' ? 'ready_for_owner':'not_required',
      reasonCode:reason ?? (string(status) === 'review' ? 'final-review-required':'none'),revision:1});
  } else {
    handoff = clone(handoff);
    check(fields(claimSessionObject(handoff,'browser handoff'),['state','reasonCode','revision'],true),'browser handoff contains unsupported fields');
  }
  check(browserBlockers.length === 0 || string(get(object(handoff,'browser handoff'),'state')) === 'required','browser handoff contradicts browser blockers');
  let created = get(incoming,'createdAt');
  if (!truth(created) && existing) created = get(existing,'createdAt');
  const session = object(fromJSON({schemaVersion:1,applicationId,createdAt:context.now,updatedAt:context.now}),'session');
  for (const name of ['status','step']) if (has(incoming,name)) set(session,name,clone(get(incoming,name)));
  set(session,'ats',clone(context.ats));
  set(session,'status',status);
  set(session,'answerKeys',clone(answerKeys));
  set(session,'pendingFields',pending);
  set(session,'attemptRevision',attempt);
  set(session,'readiness',readiness);
  set(session,'blockers',unique);
  set(session,'browserHandoff',handoff);
  set(session,'approvals',currentClaimApprovals(existing,pending,context.answers,attempt));
  if (truth(created)) set(session,'createdAt',created);
  return validateAnswerSession(session);
}
export function validateClaimHandoff(session: Document, incoming: Document, target: string, attemptRevision: Value): void {
  check(['needs_info','awaiting_review'].includes(target),'claimed handoff status is unsupported');
  check(string(get(session,'status')) === (target === 'needs_info' ? 'active':'review'),'handoff session status does not match job status');
  if (target !== 'awaiting_review') return;
  check(has(incoming,'readinessInput'),'awaiting_review requires fresh current live readiness input');
  const readiness = get(session,'readiness');
  const complete = readiness !== null && (() => {
    const report = object(readiness,'readiness');
    return same(get(report,'attemptRevision'),attemptRevision) && string(get(report,'evidenceKind')) === 'agent_attested_current_attempt'
      && string(get(report,'status')) === 'ready' && !truth(get(report,'blockerCodes'))
      && object(get(report,'assertions'),'assertions').entries().every(([,value]) => string(value) === 'passed');
  })();
  check(complete && !truth(get(session,'pendingFields')) && !truth(get(session,'blockers'))
    && same(get(session,'browserHandoff'),fromJSON({state:'ready_for_owner',reasonCode:'final-review-required',revision:1})),
  'awaiting_review requires complete current agent-attested readiness');
}
