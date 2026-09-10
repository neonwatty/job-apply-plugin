import { get, has, int, object, parse, string } from '../../../src/contracts/workspace/values';
import type { Document, Value } from '../../../src/contracts/workspace/values';
export const attentionReasons = {
  expired_agent_attempt: 'Expired agent attempt', claimless_interrupted_attempt: 'Interrupted agent attempt',
  awaiting_human_review: 'Awaiting your review', browser_action_required: 'Browser action required', needs_information: 'Needs information',
} as const;
export type AttentionReason = keyof typeof attentionReasons;
export const recoveryGuidance = {
  expired: 'Resume this attempt using the supported CLI claim-recover command for this job.',
  interrupted: 'This attempt was interrupted without an active claim. Recovery for this state is not available in the native workspace yet.',
};
export const attentionGuidance: Record<AttentionReason, string> = {
  expired_agent_attempt: recoveryGuidance.expired, claimless_interrupted_attempt: recoveryGuidance.interrupted,
  awaiting_human_review: 'Open Job details and personally review and submit on the third-party site. Recording Applied or Closed in the native workspace is deferred.',
  browser_action_required: 'Continue in the visible browser. Saved information is already known; do not create or re-enter an answer in Companion.',
  needs_information: 'Open Job details and resolve missing facts, resume, or answers. Run preflight, then mark the job Ready.',
};
function str(d: Document, key: string, fallback?: string): string {
  const value = get(d,key);
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  const result = string(value);
  if (result === null) throw Error('Invalid projection text');
  return result;
}
function revision(d: Document, key: string, minimum = 1n): bigint {
  const result = int(get(d,key));
  if (result === null || result < minimum) throw Error('Invalid projection revision');
  return result;
}
function array(d: Document, key: string, optional = false): Value[] {
  const value = get(d,key);
  if (!has(d,key) && optional) return [];
  if (!Array.isArray(value)) throw Error('Invalid projection list');
  return value;
}
function bool(d: Document, key: string, fallback?: boolean): boolean {
  const value = get(d,key);
  if (!has(d,key) && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw Error('Invalid projection eligibility');
  return value;
}
function nullableRecord(value: Value | undefined): Document | null {
  return value === null || value === undefined ? null : object(value,'projection');
}
export interface SessionSummary {
  readiness: string; blockers: {type:string;code:string}[]; handoff: string; handoffReason: string; attemptRevision?: bigint;
}
function summary(d: Document | null): SessionSummary {
  const readiness = d && nullableRecord(get(d,'readiness'));
  const handoff = d && nullableRecord(get(d,'browserHandoff'));
  return {
    readiness: readiness ? str(readiness,'status','Not recorded') : 'Not recorded',
    blockers: d ? array(d,'blockers',true).map(value=>{const item=object(value,'blocker');return {type:str(item,'type'),code:str(item,'code')};}) : [],
    handoff: handoff ? str(handoff,'state','Not recorded') : 'Not recorded',
    handoffReason: handoff ? str(handoff,'reasonCode','') : '',
    ...(d && has(d,'attemptRevision') && get(d,'attemptRevision') !== null ? {attemptRevision:revision(d,'attemptRevision')} : {}),
  };
}
export interface AttentionItem {
  jobId:string; status:string; revision:bigint; reasonCode:AttentionReason; attentionAt:string; missingInformationCount:bigint; session:SessionSummary;
}
export function attentionProjection(raw:string): {items:AttentionItem[]} {
  const doc=object(parse(raw),'attention');
  const items=array(doc,'items').map(value=>{
    const item=object(value,'attention item'), reasonCode=str(item,'reasonCode');
    if (!Object.hasOwn(attentionReasons,reasonCode)) throw Error('Invalid attention reason');
    return {jobId:str(item,'jobId'),status:str(item,'status'),revision:revision(item,'revision'),reasonCode:reasonCode as AttentionReason,
      attentionAt:str(item,'attentionAt'),missingInformationCount:revision(item,'missingInformationCount',0n),session:summary(nullableRecord(get(item,'session')))};
  });
  if (new Set(items.map(item=>item.jobId)).size !== items.length) throw Error('Duplicate attention job');
  // The server sorts by reason, descending priority, timestamp, then canonical id.
  return {items};
}
export function filterAttention(items:AttentionItem[],reason:string):AttentionItem[] { return reason ? items.filter(item=>item.reasonCode===reason) : items; }
export interface ActivityProjection {
  job:{status:string;revision:bigint};
  session:(SessionSummary & {revision:bigint;status:string;step:string;updatedAt:string;approvalCount:number;pending:{sensitive:boolean;eligible:boolean;approved:boolean;state:string;fieldClass:string}[]}) | null;
  claim:{state:string;acquiredAt:string;heartbeatAt:string;expiresAt:string}; history:{event:string;status:string;at:string}[];
}
export function activityProjection(raw:string):ActivityProjection {
  const doc=object(parse(raw),'activity'), job=object(get(doc,'job'),'job'), session=nullableRecord(get(doc,'session')), claim=object(get(doc,'claim'),'claim');
  const state=str(claim,'state');
  const approvals=session ? array(session,'approvals',true).map(value=>object(value,'approval')) : [];
  if (!['none','active','expired','interrupted'].includes(state)) throw Error('Invalid claim state');
  return {job:{status:str(job,'status'),revision:revision(job,'revision')},
    session:session ? {...summary(session),revision:revision(session,'revision'),status:str(session,'status','Not recorded'),step:str(session,'step','Not recorded'),updatedAt:str(session,'updatedAt','Not recorded'),approvalCount:approvals.length,
      pending:array(session,'pendingInformation',true).map(value=>{const field=object(value,'pending information');return {sensitive:bool(field,'sensitive',false)||str(field,'state','')==='sensitive',eligible:bool(field,'resolutionEligible'),approved:approvals.some(approval=>str(approval,'reference','')===str(field,'reference','') && str(field,'reference','')!==''),state:str(field,'state','Not recorded'),fieldClass:str(field,'fieldClass','general')};})} : null,
    claim:{state,acquiredAt:str(claim,'acquiredAt','Not recorded'),heartbeatAt:str(claim,'heartbeatAt','Not recorded'),expiresAt:str(claim,'expiresAt','Not recorded')},
    history:array(doc,'history').map(value=>{const event=object(value,'history event');return {event:str(event,'event','Event'),status:str(event,'status','Not recorded'),at:str(event,'at','Not recorded')};}),
  };
}
