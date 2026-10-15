import { exact, identifier, record, requireCondition, revision, snapshot } from '../../harness/validation.js';
import { recoveryActions, recoveryBudget } from './ats-recovery.js';
import type { RecoveryAction, RecoveryBudget } from './ats-recovery.js';
import { canonicalJson } from './canonical-json.js';
import { fromJSON, get, has, object, serialize } from './values.js';
import type { Document, Value } from './values.js';

export const recoveryMetadataKey = 'atsRecovery';
export interface RecoveryState { draftId: string; revision: string; ats: 'workday'; budget: RecoveryBudget }
interface RecoveryReceipt { fingerprint: string; next: RecoveryAction; state: RecoveryState }
interface RecoveryEntry { state: RecoveryState; receipts: Record<string, RecoveryReceipt> }
export interface RecoveryLedger { schemaVersion: 1; jobs: Record<string, RecoveryEntry> }
export interface RecoveryResult {
  next: RecoveryAction; state: RecoveryState | null; replayed: boolean; actionReserved: boolean;
  browserMutationAllowed: false; finalSubmissionAllowed: false;
}
const stateFields = ['draftId','revision','ats','budget'];
function state(raw: unknown): RecoveryState {
  const v=record(raw,'invalid_event'); exact(v,stateFields,'invalid_event');
  identifier(v.draftId,'invalid_event'); revision(v.revision,'invalid_event');
  requireCondition(v.ats === 'workday','invalid_event'); recoveryBudget(v.budget);
  return v as unknown as RecoveryState;
}
export function decodeRecoveryLedger(raw: Value): RecoveryLedger {
  const v=record(snapshot(JSON.parse(serialize(raw))),'invalid_event');
  exact(v,['schemaVersion','jobs'],'invalid_event'); requireCondition(v.schemaVersion === 1,'invalid_event');
  const jobs=record(v.jobs,'invalid_event'); requireCondition(Object.keys(jobs).length <= 256,'invalid_event');
  for (const [id,rawEntry] of Object.entries(jobs)) {
    identifier(id,'invalid_event');
    const entry=record(rawEntry,'invalid_event'); exact(entry,['state','receipts'],'invalid_event');
    const current=state(entry.state), receipts=record(entry.receipts,'invalid_event');
    requireCondition(Object.keys(receipts).length > 0 && Object.keys(receipts).length <= 32,'invalid_event');
    const ordered: {next: RecoveryAction; state: RecoveryState}[] = [];
    for (const [op,rawReceipt] of Object.entries(receipts)) {
      identifier(op,'invalid_event');
      const r=record(rawReceipt,'invalid_event'); exact(r,['fingerprint','next','state'],'invalid_event');
      requireCondition(typeof r.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(r.fingerprint)
        && recoveryActions.includes(r.next as RecoveryAction),'invalid_event');
      const saved=state(r.state);
      requireCondition(['draft_registered','retry_save_once','retry_after_sign_in','refresh_once'].includes(r.next as string),'invalid_event');
      ordered.push({next:r.next as RecoveryAction,state:saved});
    }
    ordered.sort((a,b)=>Number(BigInt(a.state.revision)-BigInt(b.state.revision)));
    for (let index=0;index<ordered.length;index++) {
      const item=ordered[index]!, previous=ordered[index-1];
      requireCondition(item.state.revision === String(index+1),'invalid_event');
      if (item.next === 'draft_registered') {
        requireCondition(Object.values(item.state.budget).every(n=>n === 0)
          && (!previous || item.state.draftId !== previous.state.draftId),'invalid_event');
      } else {
        requireCondition(previous && item.state.draftId === previous.state.draftId,'invalid_event');
        const key=item.next === 'retry_save_once' ? 'save' : item.next === 'refresh_once' ? 'refresh' : 'afterSignIn';
        for (const name of ['save','afterSignIn','refresh'] as const) {
          requireCondition(item.state.budget[name] === previous.state.budget[name] + (name === key ? 1 : 0),'invalid_event');
        }
      }
    }
    requireCondition(canonicalJson(fromJSON(current)) === canonicalJson(fromJSON(ordered.at(-1)!.state)),'invalid_event');
  }
  return v as unknown as RecoveryLedger;
}
export function recoveryLedger(jobs: Document): RecoveryLedger {
  const metadata=object(get(jobs,'metadata'),'metadata');
  return has(metadata,recoveryMetadataKey) ? decodeRecoveryLedger(get(metadata,recoveryMetadataKey)) : {schemaVersion:1,jobs:{}};
}
export function recoveryState(jobs: Document, jobId: string): RecoveryState | null {
  const entries=recoveryLedger(jobs).jobs;
  return Object.hasOwn(entries,jobId) ? structuredClone(entries[jobId]!.state) : null;
}
