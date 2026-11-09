import { createHash } from 'node:crypto';
import { exact } from './automation.js';
import { fromJSON, get, int, object, string, JobsError } from './values.js';
import type { Document, Value } from './values.js';

const fingerprintPattern = /^sha256:[0-9a-f]{64}$/;
const realmPattern = /^[0-9a-f]{64}$/;
const requestFields = [
  'jobId', 'expectedJobRevision', 'expectedClaimId', 'realmRef', 'realmDescriptor',
  'expectedSettingsRevision', 'expectedAccountRevision', 'syntheticTargetUrl',
  'syntheticTargetFingerprint', 'observedFormFingerprint',
  'observedControlFingerprint', 'secureControlFingerprint',
];
const resultFields = [
  'lifecycleState', 'providerId', 'credentialRef', 'credentialVersion', 'reused',
  'retryAllowed', 'finalActionAuthorized', 'secureControlCleared',
];
export const terminalAccountLifecycles = new Set([
  'verification_required', 'reset_required', 'failed_definitive', 'ambiguous',
]);
const resultLifecycles = new Set(['active', ...terminalAccountLifecycles]);

export function fingerprint(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function operationFingerprint(target: string, realm: string, control: string): string {
  const url = new URL(target);
  const canonical = `${url.protocol}//${url.host}${url.pathname}`;
  return fingerprint(`protected-account:v1:${canonical}:${realm}:${control}`);
}

export function validateSyntheticAccountRequest(value: Value): Document {
  const request = object(value, 'account execution request');
  exact(request, requestFields, 'account execution request contains unsupported fields');
  for (const field of ['jobId', 'expectedClaimId', 'realmDescriptor']) {
    if (!string(get(request, field))) throw new JobsError('account execution binding is invalid');
  }
  const realm = string(get(request, 'realmRef'));
  if (!realm || !realmPattern.test(realm)) throw new JobsError('account realm binding is invalid');
  for (const field of ['expectedJobRevision', 'expectedSettingsRevision', 'expectedAccountRevision']) {
    const revision = int(get(request, field));
    if (revision === null || revision < 1n) throw new JobsError(`${field} must be a positive integer`);
  }
  for (const field of ['syntheticTargetFingerprint', 'observedFormFingerprint', 'observedControlFingerprint', 'secureControlFingerprint']) {
    if (!fingerprintPattern.test(string(get(request, field)) ?? '')) throw new JobsError('account execution fingerprint is invalid');
  }
  const target = string(get(request, 'syntheticTargetUrl'));
  let url: URL;
  try { url = new URL(target ?? ''); } catch { throw new JobsError('synthetic target is invalid'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.hash || url.pathname !== '/synthetic-account') throw new JobsError('only the loopback synthetic account portal is authorized');
  const operation = operationFingerprint(target!, realm, string(get(request, 'secureControlFingerprint'))!);
  if ([...url.searchParams.entries()].length !== 1 || url.searchParams.get('operation') !== operation.slice(7)) {
    throw new JobsError('synthetic operation binding is invalid');
  }
  if (string(get(request, 'syntheticTargetFingerprint')) !== fingerprint(target!)) throw new JobsError('synthetic account target proof mismatch');
  if (string(get(request, 'secureControlFingerprint')) !== fingerprint('native-secure-control:v1')) throw new JobsError('synthetic secure control proof mismatch');
  return request;
}

export function validateSyntheticAccountResult(value: Value): Document {
  const result = object(value, 'synthetic account executor result');
  exact(result, resultFields, 'synthetic account executor result is invalid');
  if (!resultLifecycles.has(string(get(result, 'lifecycleState')) ?? '')) throw new JobsError('synthetic account lifecycle is invalid');
  if (!/^[a-z][a-z0-9-]{2,63}$/.test(string(get(result, 'providerId')) ?? '')
    || !/^credential_[0-9a-f]{64}$/.test(string(get(result, 'credentialRef')) ?? '')
    || (int(get(result, 'credentialVersion')) ?? 0n) < 1n || typeof get(result, 'reused') !== 'boolean') {
    throw new JobsError('synthetic account credential metadata is invalid');
  }
  if (get(result, 'retryAllowed') !== false || get(result, 'finalActionAuthorized') !== false
    || get(result, 'secureControlCleared') !== true) throw new JobsError('synthetic account executor violated the reviewed effect contract');
  return result;
}

export function syntheticProofs(target: string): Value {
  return fromJSON({
    syntheticTargetFingerprint: fingerprint(target),
    observedFormFingerprint: fingerprint('account-form:v2'),
    observedControlFingerprint: fingerprint('account-controls:v2'),
    secureControlFingerprint: fingerprint('native-secure-control:v1'),
  });
}
