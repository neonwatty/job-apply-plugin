import { object } from './contracts';

export type PasswordStrategy = 'unique_per_realm' | 'shared' | 'custom' | 'ask_each_time';
export type AutomationSettings = {
  enabled: boolean; automaticAccountCreation: boolean; signupEmailConfigured: boolean;
  passwordStrategy: PasswordStrategy; revision: number;
};
export type EmployerAccount = {
  realmRef: string; adapterId: 'workday' | 'oracle-recruiting'; lifecycleState: string;
  flowKind: string; credentialRequired: boolean; signupEmailOverrideConfigured: boolean;
  providerAssigned: boolean; revision: number;
};
export type AutomationProjection = {
  settings: AutomationSettings; accounts: EmployerAccount[]; profileRevision: number;
  capability: { reasonCode: string; accountFlowAutomation: {
    workdayPasswordAccountReady: boolean; greenhouseAccountlessClassificationReady: boolean;
    emailOnlyCandidateProfileReady: boolean; liveExecutionEnabled: boolean;
  } };
};
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
    || !['workdayPasswordAccountReady','greenhouseAccountlessClassificationReady','emailOnlyCandidateProfileReady','liveExecutionEnabled'].every(key => bool(flow[key]))) invalid();
  const accounts = value.accounts.map(entry => {
    if (!object(entry) || !/^[0-9a-f]{64}$/.test(String(entry.realmRef))
      || !['workday','oracle-recruiting'].includes(String(entry.adapterId)) || typeof entry.lifecycleState !== 'string'
      || typeof entry.flowKind !== 'string' || !bool(entry.credentialRequired) || !bool(entry.signupEmailOverrideConfigured)
      || !bool(entry.providerAssigned) || !positive(entry.revision)) invalid();
    return entry as EmployerAccount;
  });
  return { settings: settings as AutomationSettings, accounts, profileRevision: value.profileRevision,
    capability: value.capability as AutomationProjection['capability'] };
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
