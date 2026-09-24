import { object } from './contracts';

export type PasswordStrategy = 'unique_per_realm' | 'shared' | 'custom' | 'ask_each_time';
export type AutomationSettings = {
  enabled: boolean; automaticAccountCreation: boolean; signupEmailConfigured: boolean;
  passwordStrategy: PasswordStrategy; revision: number;
};
export type EmployerAccount = {
  realmRef: string; adapterId: 'workday' | 'oracle-recruiting' | 'mygreenhouse'; lifecycleState: string;
  flowKind: string; credentialRequired: boolean; signupEmailOverrideConfigured: boolean;
  providerAssigned: boolean; revision: number;
};
export type AutomationProjection = {
  settings: AutomationSettings; accounts: EmployerAccount[]; profileRevision: number;
  applicationAuthority: ApplicationAuthority;
  capability: { reasonCode: string; accountFlowAutomation: {
    workdayPasswordAccountReady: boolean; greenhouseAccountlessClassificationReady: boolean;
    emailOnlyCandidateProfileReady: boolean; myGreenhousePasswordlessConfigurationReady:boolean;
    myGreenhousePasswordlessExecutionReady:boolean; liveExecutionEnabled: boolean;
  } };
};
export type ApplicationAuthority = {
  mode:'guided'|'autofill_to_review'|'campaign_to_review'; status:string; revision:number;
  authorizationId:string|null; expiresAt:string|null; runId:string|null; jobIds:string[]; sensitiveAnswerRefs:string[];
};
export type CampaignProgress = {mode:string;status:string;revision:number;nextJob:{jobId:string;status:string;revision:number}|null;
  counts:{ready:number;inProgress:number;needsAttention:number;awaitingReview:number;unavailable:number};
  jobs:Array<{jobId:string;status:string;revision:number|null}>};
export type AccountOperationStatus = { status: 'idle'; operation: null } | {
  status: 'recovery_required'; operation: { stage: string; realmRef: string };
};
export type TrustedFillStatus = { status: 'missing' } | {
  status: string; jobId: string; approvalRevision: number; expiresAt: string;
};

const positive = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const bool = (value: unknown) => typeof value === 'boolean';
function invalid(): never { throw Error('The workspace returned an invalid automation response.'); }
export function automationProjection(value: unknown): AutomationProjection {
  if (!object(value) || !object(value.settings) || !Array.isArray(value.accounts)
    || !object(value.capability) || !object(value.capability.accountFlowAutomation) || !positive(value.profileRevision)) invalid();
  const settings = value.settings, flow = value.capability.accountFlowAutomation;
  if (!bool(settings.enabled) || !bool(settings.automaticAccountCreation) || !bool(settings.signupEmailConfigured)
    || !positive(settings.revision) || !['unique_per_realm','shared','custom','ask_each_time'].includes(String(settings.passwordStrategy))
    || typeof value.capability.reasonCode !== 'string'
    || !['workdayPasswordAccountReady','greenhouseAccountlessClassificationReady','emailOnlyCandidateProfileReady','myGreenhousePasswordlessConfigurationReady','myGreenhousePasswordlessExecutionReady','liveExecutionEnabled'].every(key => bool(flow[key]))) invalid();
  const accounts = value.accounts.map(entry => {
    if (!object(entry) || !/^[0-9a-f]{64}$/.test(String(entry.realmRef))
      || !['workday','oracle-recruiting','mygreenhouse'].includes(String(entry.adapterId)) || typeof entry.lifecycleState !== 'string'
      || typeof entry.flowKind !== 'string' || !bool(entry.credentialRequired) || !bool(entry.signupEmailOverrideConfigured)
      || !bool(entry.providerAssigned) || !positive(entry.revision)) invalid();
    return entry as EmployerAccount;
  });
  return { settings: settings as AutomationSettings, accounts, profileRevision: value.profileRevision,
    applicationAuthority: applicationAuthority(value.applicationAuthority),
    capability: value.capability as AutomationProjection['capability'] };
}
export function applicationAuthority(value:unknown):ApplicationAuthority {
  if(!object(value)||!['guided','autofill_to_review','campaign_to_review'].includes(String(value.mode))
    ||typeof value.status!=='string'||!Number.isSafeInteger(value.revision)||Number(value.revision)<0
    ||value.authorizationId!==null&&typeof value.authorizationId!=='string'||value.expiresAt!==null&&typeof value.expiresAt!=='string'
    ||value.runId!==null&&typeof value.runId!=='string'||!Array.isArray(value.jobIds)||value.jobIds.some(id=>typeof id!=='string')
    ||!Array.isArray(value.sensitiveAnswerRefs)||value.sensitiveAnswerRefs.some(id=>typeof id!=='string')) invalid();
  return value as ApplicationAuthority;
}
export function campaignProgress(value:unknown):CampaignProgress {
  if(!object(value)||typeof value.mode!=='string'||typeof value.status!=='string'||!Number.isSafeInteger(value.revision)||!object(value.counts)||!Array.isArray(value.jobs)) invalid();
  const counts=value.counts;
  if(!['ready','inProgress','needsAttention','awaitingReview','unavailable'].every(key=>Number.isSafeInteger(counts[key])))invalid();
  const jobs=value.jobs.map(item=>{if(!object(item)||typeof item.jobId!=='string'||typeof item.status!=='string'
    ||item.revision!==null&&!positive(item.revision))invalid();return item as CampaignProgress['jobs'][number];});
  let nextJob:null|CampaignProgress['jobs'][number]=null;
  if(value.nextJob!==null){if(!object(value.nextJob)||typeof value.nextJob.jobId!=='string'||typeof value.nextJob.status!=='string'||!positive(value.nextJob.revision))invalid();nextJob=value.nextJob as CampaignProgress['jobs'][number];}
  return {mode:value.mode,status:value.status,revision:value.revision as number,nextJob:nextJob as CampaignProgress['nextJob'],
    counts:counts as CampaignProgress['counts'],jobs};
}
export function accountOperationStatus(value: unknown): AccountOperationStatus {
  if (!object(value)) return invalid();
  if (value.status === 'idle' && value.operation === null) return { status:'idle', operation:null };
  if (value.status === 'recovery_required' && object(value.operation) && typeof value.operation.stage === 'string'
    && /^[0-9a-f]{64}$/.test(String(value.operation.realmRef))) return value as AccountOperationStatus;
  return invalid();
}
export function trustedFillStatus(value: unknown): TrustedFillStatus {
  if (!object(value) || typeof value.status !== 'string') return invalid();
  if (value.status === 'missing') return { status:'missing' };
  if (typeof value.jobId !== 'string' || !positive(value.approvalRevision) || typeof value.expiresAt !== 'string') return invalid();
  return value as TrustedFillStatus;
}
