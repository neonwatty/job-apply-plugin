import { createHash } from 'node:crypto';
import { emailFlow } from './account-realm.js';
import { exact } from './automation.js';
import { fingerprint } from './synthetic-account.js';
import { get, int, object, string, JobsError } from './values.js';
import type { Document, Value } from './values.js';

const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const realmPattern = /^[0-9a-f]{64}$/;
const requestFields = [
  'jobId', 'jobRevision', 'expectedClaimId', 'realmRef', 'realmDescriptor', 'flowKind',
  'accountRevision', 'settingsRevision', 'portalUrl', 'accountFormFingerprint',
  'emailControlFingerprint', 'termsControlFingerprint', 'termsDocumentFingerprint',
  'nextControlFingerprint', 'passwordControlFingerprint', 'createAccountControlFingerprint',
  'accountCreationControlsFingerprint',
];
const resultFields = [
  'providerId', 'outcome', 'retryAllowed', 'finalActionAuthorized', 'emailRemoved',
  'termsAccepted', 'nextActivations', 'credentialProviderInvocations',
];
export const emailOnlyOutcomes = new Set(['active', 'verification_required', 'failed_definitive', 'ambiguous']);

function aggregateControls(request: Document): string {
  return fingerprint(['accountFormFingerprint', 'emailControlFingerprint', 'termsControlFingerprint',
    'termsDocumentFingerprint', 'nextControlFingerprint'].map(field => string(get(request, field))!).join(':'));
}

export function validateEmailOnlyAccountRequest(value: Value): Document {
  const request = object(value, 'email-only flow request');
  exact(request, requestFields, 'email-only flow request contains unsupported fields');
  if (string(get(request, 'flowKind')) !== emailFlow) throw new JobsError('email-only flow kind is invalid');
  if (!string(get(request, 'jobId')) || !string(get(request, 'expectedClaimId'))) throw new JobsError('email-only job binding is invalid');
  const descriptor = string(get(request, 'realmDescriptor'));
  const realm = string(get(request, 'realmRef'));
  if (!descriptor?.startsWith('oracle-recruiting:v1:')) throw new JobsError('email-only realm descriptor is invalid');
  if (!realm || !realmPattern.test(realm)
    || createHash('sha256').update(descriptor).digest('hex') !== realm) throw new JobsError('email-only realm identity mismatch');
  for (const field of ['jobRevision', 'accountRevision', 'settingsRevision']) {
    const revision = int(get(request, field));
    if (revision === null || revision < 1n) throw new JobsError('email-only revision binding is invalid');
  }
  for (const field of ['accountFormFingerprint', 'emailControlFingerprint', 'termsControlFingerprint',
    'termsDocumentFingerprint', 'nextControlFingerprint', 'accountCreationControlsFingerprint']) {
    if (!fingerprintPattern.test(string(get(request, field)) ?? '')) throw new JobsError('email-only control binding is invalid');
  }
  if (get(request, 'passwordControlFingerprint') !== null || get(request, 'createAccountControlFingerprint') !== null) {
    throw new JobsError('email-only flow forbids password and create-account controls');
  }
  if (aggregateControls(request) !== string(get(request, 'accountCreationControlsFingerprint'))) {
    throw new JobsError('email-only aggregate control binding mismatch');
  }
  let portal: URL;
  try { portal = new URL(string(get(request, 'portalUrl')) ?? ''); } catch { throw new JobsError('email-only portal is invalid'); }
  const entries = [...portal.searchParams.entries()];
  if (portal.protocol !== 'http:' || portal.hostname !== '127.0.0.1' || !portal.port
    || portal.username || portal.password || portal.hash || entries.length !== 1
    || entries[0]?.[0] !== 'operation' || !/^[0-9a-f]{64}$/.test(entries[0]?.[1] ?? '')) {
    throw new JobsError('email-only synthetic operation binding is invalid');
  }
  return request;
}

export function validateEmailOnlyAccountResult(value: Value, providerId: string): Document {
  const result = object(value, 'email-only provider attestation');
  exact(result, resultFields, 'email-only provider attestation is invalid');
  if (string(get(result, 'providerId')) !== providerId || !emailOnlyOutcomes.has(string(get(result, 'outcome')) ?? '')) {
    throw new JobsError('email-only provider attestation is invalid');
  }
  if (get(result, 'retryAllowed') !== false || get(result, 'finalActionAuthorized') !== false
    || get(result, 'emailRemoved') !== true || get(result, 'termsAccepted') !== true
    || int(get(result, 'nextActivations')) !== 1n || int(get(result, 'credentialProviderInvocations')) !== 0n) {
    throw new JobsError('email-only provider violated the reviewed effect contract');
  }
  return result;
}
